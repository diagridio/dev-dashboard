//go:build integration

package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/stretchr/testify/require"
)

// TestAspireModeEndToEnd wires the real server via assembleOptions in
// aspire-mode configuration (env-contract discovery, non-loopback guard
// relaxed, restricted capabilities) against a stub daprd, then drives the
// real HTTP surface end to end: apps listed+enriched, non-loopback Host
// accepted, gated routes absent.
func TestAspireModeEndToEnd(t *testing.T) {
	// Stub daprd: healthz + minimal metadata.
	daprd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(http.StatusNoContent)
		case "/v1.0/metadata":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"orders","runtimeVersion":"1.16.0","extended":{}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer daprd.Close()

	t.Setenv("DEVDASHBOARD_APP_COUNT", "1")
	t.Setenv("DEVDASHBOARD_APP_0_ID", "orders")
	t.Setenv("DEVDASHBOARD_APP_0_DAPR_HTTP", daprd.URL)

	scan, err := discovery.NewAspireScanner(os.Getenv)
	require.NoError(t, err)
	appsSvc := discovery.New(scan, daprd.Client())
	caps := &server.Capabilities{Workflows: false}

	dist := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")},
	}

	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace:        "default",
		Apps:             appsSvc,
		HTTPClient:       &http.Client{Timeout: 5 * time.Second},
		AllowNonLoopback: true,
		Capabilities:     caps,
		QuietRegistry:    true,
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// Apps listed from env contract, enriched from the stub daprd, with a
	// non-loopback Host accepted (aspire/container mode drops the loopback
	// guard in favor of AllowNonLoopback).
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/apps/", nil)
	require.NoError(t, err)
	req.Host = "dashboard.internal:8080"
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	require.NoError(t, res.Body.Close())
	require.Equalf(t, http.StatusOK, res.StatusCode, "apps: %s", b)
	body := string(b)
	require.Contains(t, body, `"appId":"orders"`)
	require.Contains(t, body, `"health":"healthy"`)
	require.Contains(t, body, `"source":"aspire"`)

	// Gated surfaces are absent: workflows via caps.Workflows=false,
	// controlplane and logs are never mounted for aspire-mode wiring.
	for _, path := range []string{"/api/controlplane/", "/api/workflows/", "/api/apps/orders/logs"} {
		r, _ := httpGet(t, srv.URL+path)
		require.Equalf(t, http.StatusNotFound, r.StatusCode, "%s", path)
	}
}
