//go:build unit

package server

import (
	"bufio"
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func newStreamServer(t *testing.T, h http.Handler) *httptest.Server {
	t.Helper()
	ts := httptest.NewServer(h)
	t.Cleanup(ts.Close)
	return ts
}

func readSSEData(t *testing.T, body interface{ Read([]byte) (int, error) }, n int) []string {
	t.Helper()
	reader := bufio.NewReader(body)
	var lines []string
	for len(lines) < n {
		line, err := reader.ReadString('\n')
		if err != nil {
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "data: ") {
			lines = append(lines, strings.TrimPrefix(line, "data: "))
		}
	}
	return lines
}

// withChiParam injects a chi URL parameter into the request context so that
// chi.URLParam(req, key) works without a full chi router.
func withChiParam(req *http.Request, key, value string) *http.Request {
	rctx := chi.NewRouteContext()
	rctx.URLParams.Add(key, value)
	return req.WithContext(context.WithValue(req.Context(), chi.RouteCtxKey, rctx))
}

func TestLogsSSEStreamsLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "daprd.log")
	require.NoError(t, os.WriteFile(logPath, []byte("hello\nworld\n"), 0o600))

	svc := &fakeApps{instances: []discovery.Instance{{AppID: "order", DaprdLogPath: logPath}}}
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc, nil))

	ts := newStreamServer(t, r)

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/order/logs?source=daprd", nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/event-stream")

	got := readSSEData(t, resp.Body, 2)
	require.Equal(t, []string{"hello", "world"}, got)
}

func TestLogsNoFile404(t *testing.T) {
	svc := &fakeApps{instances: []discovery.Instance{{AppID: "order"}}} // no DaprdLogPath
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc, nil))
	res, _ := get(t, r, "/order/logs?source=daprd")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestLogsHandler_LogsSourceUnavailable(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })

	svc := &fakeApps{instances: []discovery.Instance{{AppID: "order"}}} // no DaprdLogPath
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc, nil))
	res, _ := get(t, r, "/order/logs?source=daprd")
	require.Equal(t, http.StatusNotFound, res.StatusCode)

	if !strings.Contains(buf.String(), "log stream source unavailable") {
		t.Fatalf("expected 'log stream source unavailable' WARN, got %q", buf.String())
	}
}

func TestLogsComposeStreamsFromContainer(t *testing.T) {
	app := discovery.Instance{
		AppID: "primes-go", Source: discovery.SourceCompose,
		DaprdContainerID: "aaa", AppContainerID: "bbb",
	}
	var gotID string
	containerLogs := func(_ context.Context, id string) (<-chan string, error) {
		gotID = id
		ch := make(chan string, 2)
		ch <- "hello from container"
		close(ch)
		return ch, nil
	}
	h := logsHandler(&fakeApps{instances: []discovery.Instance{app}}, containerLogs)
	req := httptest.NewRequest("GET", "/api/apps/primes-go/logs?source=app", nil)
	req = withChiParam(req, "appId", "primes-go")
	rec := httptest.NewRecorder()
	h(rec, req)
	if gotID != "bbb" {
		t.Fatalf("source=app must stream the app container, got %q", gotID)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type: %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "data: hello from container\n\n") {
		t.Fatalf("body: %q", rec.Body.String())
	}
}

func TestLogsComposeDaprdDefault(t *testing.T) {
	app := discovery.Instance{
		AppID: "primes-go", Source: discovery.SourceCompose,
		DaprdContainerID: "aaa", AppContainerID: "bbb",
	}
	var gotID string
	containerLogs := func(_ context.Context, id string) (<-chan string, error) {
		gotID = id
		ch := make(chan string, 2)
		ch <- "hello from daprd container"
		close(ch)
		return ch, nil
	}
	h := logsHandler(&fakeApps{instances: []discovery.Instance{app}}, containerLogs)
	req := httptest.NewRequest("GET", "/api/apps/primes-go/logs", nil)
	req = withChiParam(req, "appId", "primes-go")
	rec := httptest.NewRecorder()
	h(rec, req)
	if gotID != "aaa" {
		t.Fatalf("no ?source param must stream the daprd container, got %q", gotID)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type: %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "data: hello from daprd container\n\n") {
		t.Fatalf("body: %q", rec.Body.String())
	}
}

func TestLogsComposeNoRuntime404(t *testing.T) {
	app := discovery.Instance{AppID: "x", Source: discovery.SourceCompose, DaprdContainerID: "aaa"}
	h := logsHandler(&fakeApps{instances: []discovery.Instance{app}}, nil) // no container runtime wired
	req := httptest.NewRequest("GET", "/api/apps/x/logs", nil)
	req = withChiParam(req, "appId", "x")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 when no container runtime, got %d", rec.Code)
	}
}

func TestNormalizeLine(t *testing.T) {
	t.Run("dcp daprd line -> standard daprd format", func(t *testing.T) {
		in := `3 2026-06-30T19:51:27.797Z time="2026..." level=info msg="hi" app_id=pr-digest`
		want := `time="2026..." level=info msg="hi" app_id=pr-digest`
		require.Equal(t, want, normalizeLine(in, "dcp"))
	})
	t.Run("dcp app line -> ansi stripped", func(t *testing.T) {
		in := "1 2026-06-30T19:51:31.768Z \x1b[33mwarn\x1b[39m: Dapr.Workflow"
		require.Equal(t, "warn: Dapr.Workflow", normalizeLine(in, "dcp"))
	})
	t.Run("plain strips ansi only, keeps content", func(t *testing.T) {
		require.Equal(t, "level=info msg=x", normalizeLine("level=info msg=x", "plain"))
		require.Equal(t, "hello", normalizeLine("\x1b[31mhello\x1b[0m", "plain"))
	})
	t.Run("empty format treated as plain", func(t *testing.T) {
		require.Equal(t, "abc", normalizeLine("abc", ""))
	})
}
