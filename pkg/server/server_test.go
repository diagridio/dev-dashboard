//go:build unit

package server

import (
	"net/http"
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
