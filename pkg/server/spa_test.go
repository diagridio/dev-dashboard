//go:build unit

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/require"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><head><title>shell</title></head>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
}

func get(t *testing.T, h http.Handler, path string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:9090" // httptest defaults to example.com, which requestGuard(false) rejects
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return res, string(b)
}

func TestSPAServesExistingFile(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())
	res, body := get(t, h, "/assets/app.js")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "console.log")
}

func TestSPAFallsBackToIndex(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())
	res, body := get(t, h, "/workflows/order/abc123")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
}

func TestSPARespectsBasePath(t *testing.T) {
	h := SPAHandler(testFS(), "/dashboard", true, "v1.2.3", FullCapabilities())
	res, body := get(t, h, "/dashboard/anything")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestSPADirectoryRequestDoesNotListContents(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())

	// An embedded directory must not produce an http.FileServer auto-index
	// (or a redirect toward one); it is a client-route miss → SPA shell.
	for _, p := range []string{"/assets", "/assets/"} {
		res, body := get(t, h, p)
		require.Equal(t, http.StatusOK, res.StatusCode, "path %s", p)
		require.Contains(t, body, "shell", "path %s", p)
		require.NotContains(t, body, "app.js", "path %s must not list directory contents", p)
	}
}

func TestSPAMissingAssetReturns404(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())
	res, body := get(t, h, "/assets/missing.js")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.NotContains(t, body, "shell")
}

func TestSPAInjectsTelemetryEnabledTrue(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())
	_, body := get(t, h, "/")
	require.Contains(t, body, "window.__DASH_TELEMETRY_ENABLED__=true;")
}

func TestSPAInjectsTelemetryEnabledFalse(t *testing.T) {
	h := SPAHandler(testFS(), "", false, "v1.2.3", FullCapabilities())
	_, body := get(t, h, "/")
	require.Contains(t, body, "window.__DASH_TELEMETRY_ENABLED__=false;")
}

func TestSPAInjectsVersion(t *testing.T) {
	h := SPAHandler(testFS(), "", true, "v1.2.3", FullCapabilities())
	_, body := get(t, h, "/")
	require.Contains(t, body, `window.__DASH_VERSION__="v1.2.3";`)
}

func TestServeIndexInjectsCapabilities(t *testing.T) {
	fsys := fstest.MapFS{"index.html": {Data: []byte("<html><head></head><body></body></html>")}}
	h := SPAHandler(fsys, "", false, "v1.2.3", Capabilities{Workflows: true})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(rec, req)
	body := rec.Body.String()
	want := `window.__DASH_CAPABILITIES__={"lifecycle":false,"controlPlane":false,"logs":false,"workflows":true,"mode":""}`
	if !strings.Contains(body, want) {
		t.Fatalf("body missing %q:\n%s", want, body)
	}
}
