//go:build unit

package server

import (
	"bufio"
	"context"
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

func TestLogsSSEStreamsLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "daprd.log")
	require.NoError(t, os.WriteFile(logPath, []byte("hello\nworld\n"), 0o600))

	svc := &fakeApps{instances: []discovery.Instance{{AppID: "order", DaprdLogPath: logPath}}}
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc))

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
	r.Get("/{appId}/logs", logsHandler(svc))
	res, _ := get(t, r, "/order/logs?source=daprd")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}
