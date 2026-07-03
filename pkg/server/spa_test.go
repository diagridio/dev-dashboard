//go:build unit

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/require"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><title>shell</title>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
}

func get(t *testing.T, h http.Handler, path string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	req.Host = "127.0.0.1:9090" // httptest defaults to example.com, which localhostGuard rejects
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return res, string(b)
}

func TestSPAServesExistingFile(t *testing.T) {
	h := SPAHandler(testFS(), "")
	res, body := get(t, h, "/assets/app.js")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "console.log")
}

func TestSPAFallsBackToIndex(t *testing.T) {
	h := SPAHandler(testFS(), "")
	res, body := get(t, h, "/workflows/order/abc123")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
}

func TestSPARespectsBasePath(t *testing.T) {
	h := SPAHandler(testFS(), "/dashboard")
	res, body := get(t, h, "/dashboard/anything")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestSPADirectoryRequestDoesNotListContents(t *testing.T) {
	h := SPAHandler(testFS(), "")

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
	h := SPAHandler(testFS(), "")
	res, body := get(t, h, "/assets/missing.js")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.NotContains(t, body, "shell")
}
