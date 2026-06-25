//go:build unit

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

func TestHealthEndpoint(t *testing.T) {
	srv := httptest.NewServer(apiRouter(version.Info{Version: "test"}, newFakeApps()))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/health")
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(t, "ok", body["status"])
}

func TestVersionEndpoint(t *testing.T) {
	srv := httptest.NewServer(apiRouter(version.Info{Version: "1.2.3", Commit: "abc", Date: "d"}, newFakeApps()))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/version")
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	var got version.Info
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	require.Equal(t, "1.2.3", got.Version)
}
