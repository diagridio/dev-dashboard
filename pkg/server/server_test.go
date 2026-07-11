//go:build unit

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

func newTestRouter(basePath string) http.Handler {
	return NewRouter(Options{
		BasePath: basePath,
		DistFS:   fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Version:  version.Info{Version: "test"},
		Apps:     newFakeApps(),
		Backend:  newFakeBackend(fakeWF{}),
	})
}

// buildTestOptions constructs an Options with every optional service wired to
// a real (fake) implementation, following the same inline-literal pattern as
// newTestRouter above, so capability gating can be exercised against routes
// that would otherwise actually work rather than routes that are merely
// nil-guarded already.
func buildTestOptions() Options {
	return Options{
		DistFS:  fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Version: version.Info{Version: "test"},
		Apps:    newFakeApps(),
		ContainerLogs: func(_ context.Context, _ string) (<-chan string, error) {
			ch := make(chan string)
			close(ch)
			return ch, nil
		},
		Lifecycle:    &fakeLifecycle{},
		Backend:      newFakeBackend(fakeWF{}),
		ControlPlane: &fakeManager{},
		UpdateCheck:  fakeUpdateCheck{},
	}
}

func TestRouterServesAPIAndSPA(t *testing.T) {
	h := newTestRouter("")

	res, body := get(t, h, "/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "ok")

	res, body = get(t, h, "/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestUnknownAPIIs404NotIndex(t *testing.T) {
	h := newTestRouter("")
	res, body := get(t, h, "/api/does-not-exist")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.NotContains(t, body, "shell")
}

func TestRouterUnderBasePath(t *testing.T) {
	h := newTestRouter("/dashboard")
	res, _ := get(t, h, "/dashboard/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)
}

func TestRouterServesApps(t *testing.T) {
	h := NewRouter(Options{
		DistFS:  fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Version: version.Info{Version: "test"},
		Apps:    newFakeApps(),
		Backend: newFakeBackend(fakeWF{}),
	})
	res, body := get(t, h, "/api/apps")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "appId")
}

func TestRouterCapabilityGating(t *testing.T) {
	limited := Capabilities{Workflows: true} // aspire-with-store shape
	opts := buildTestOptions()
	opts.Capabilities = &limited
	srv := httptest.NewServer(NewRouter(opts))
	defer srv.Close()

	get := func(path string) int {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := get("/api/controlplane/"); got != http.StatusNotFound {
		t.Fatalf("controlplane: got %d want 404", got)
	}
	if got := get("/api/apps/some-app/logs"); got != http.StatusNotFound {
		t.Fatalf("logs: got %d want 404", got)
	}
	resp, err := http.Post(srv.URL+"/api/apps/some-app/app/stop", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("lifecycle: got %d want 404/405", resp.StatusCode)
	}
	if got := get("/api/workflows/"); got == http.StatusNotFound {
		t.Fatal("workflows should be mounted")
	}
	// nil Capabilities keeps everything mounted (host default).
	opts2 := buildTestOptions()
	srv2 := httptest.NewServer(NewRouter(opts2))
	defer srv2.Close()
	resp2, _ := http.Get(srv2.URL + "/api/controlplane/")
	if resp2.StatusCode == http.StatusNotFound {
		t.Fatal("nil capabilities must keep controlplane mounted")
	}
	resp2.Body.Close()
}

func TestRouterInjectsTelemetryFlag(t *testing.T) {
	h := NewRouter(Options{
		DistFS:           fstest.MapFS{"index.html": {Data: []byte("<!doctype html><head></head>")}},
		Version:          version.Info{Version: "test"},
		Apps:             newFakeApps(),
		Backend:          newFakeBackend(fakeWF{}),
		TelemetryEnabled: true,
	})
	_, body := get(t, h, "/")
	require.Contains(t, body, "window.__DASH_TELEMETRY_ENABLED__=true;")
}
