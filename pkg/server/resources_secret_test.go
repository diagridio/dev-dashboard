//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"

	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/stretchr/testify/require"
)

type revealResources struct {
	fakeResources
	value string
	err   error
}

func (r revealResources) RevealSecret(_ context.Context, _, _ string) (string, error) {
	return r.value, r.err
}

func revealServer(t *testing.T, res resources.Service, allowNonLoopback bool) http.Handler {
	t.Helper()
	return NewRouter(Options{
		DistFS:           fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Resources:        res,
		AllowNonLoopback: allowNonLoopback,
		ListenPort:       9090,
	})
}

func postReveal(t *testing.T, h http.Handler, body string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/api/resources/component/abc123/secret-value", strings.NewReader(body))
	req.Host = "127.0.0.1:9090"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestRevealReturnsValueOnLoopback(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, false)
	rec := postReveal(t, h, `{"field":"redisPassword"}`)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))

	var body struct {
		Value string `json:"value"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, "s3cr3t", body.Value)
}

func TestRevealForbiddenWhenServedOffHost(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, true)
	rec := postReveal(t, h, `{"field":"redisPassword"}`)

	require.Equal(t, http.StatusForbidden, rec.Code)
	require.NotContains(t, rec.Body.String(), "s3cr3t")
}

func TestRevealNotFoundForUnknownField(t *testing.T) {
	h := revealServer(t, revealResources{err: resources.ErrNoSecretValue}, false)
	rec := postReveal(t, h, `{"field":"nope"}`)
	require.Equal(t, http.StatusNotFound, rec.Code)
}

func TestRevealRejectsGet(t *testing.T) {
	h := revealServer(t, revealResources{value: "s3cr3t"}, false)
	req := httptest.NewRequest(http.MethodGet, "/api/resources/component/abc123/secret-value", nil)
	req.Host = "127.0.0.1:9090"
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	require.Equal(t, http.StatusMethodNotAllowed, rec.Code)
	require.NotContains(t, rec.Body.String(), "s3cr3t")
}

func TestCapabilitiesReportSecretReveal(t *testing.T) {
	require.True(t, FullCapabilities().SecretReveal)
}
