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
		"index.html":      {Data: []byte("<!doctype html><title>shell</title>")},
		"assets/app.js":   {Data: []byte("console.log(1)")},
	}
}

func get(t *testing.T, h http.Handler, path string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
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
}

func TestSPARespectsBasePath(t *testing.T) {
	h := SPAHandler(testFS(), "/dashboard")
	res, body := get(t, h, "/dashboard/anything")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}
