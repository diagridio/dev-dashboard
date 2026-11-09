//go:build integration

package cmd

import (
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/stretchr/testify/require"
)

// closedAddr returns a loopback host:port with nothing listening, so a gRPC
// dial fails fast instead of reaching whatever runs on daprd's default 50001.
func closedAddr(t *testing.T) string {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	addr := l.Addr().String()
	require.NoError(t, l.Close())
	return addr
}

// TestComposeContainerPostureEndToEnd wires the real server via
// assembleOptions in compose container posture (env-contract discovery with
// SourceCompose, no state store, capabilities from containerCapabilities)
// against a stub daprd, then drives the real HTTP surface: the app is listed
// as compose, the SPA is told it runs in container posture, Workflows is
// routable without a store, and every runtime-dependent surface is absent
// (unroutable, not merely flagged off).
func TestComposeContainerPostureEndToEnd(t *testing.T) {
	daprd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(http.StatusNoContent)
		case "/v1.0/metadata":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"order-processor","runtimeVersion":"1.19.1","extended":{}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer daprd.Close()

	t.Setenv("DEVDASHBOARD_APP_COUNT", "1")
	t.Setenv("DEVDASHBOARD_APP_0_ID", "order-processor")
	t.Setenv("DEVDASHBOARD_APP_0_DAPR_HTTP", daprd.URL)
	t.Setenv("DEVDASHBOARD_APP_0_DAPR_GRPC", closedAddr(t))

	scan, err := discovery.NewContractScanner(os.Getenv, contractSource(ModeCompose))
	require.NoError(t, err)
	appsSvc := discovery.New(scan, daprd.Client())
	caps := containerCapabilities(ModeCompose, false, scan)

	dist := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html><head></head><body>spa</body></html>")},
	}
	opts, closers := assembleOptions(t.Context(), serveDeps{
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

	// The app is listed from the contract and framed as compose, with a
	// non-loopback Host accepted.
	req, err := http.NewRequest(http.MethodGet, srv.URL+"/api/apps/", nil)
	require.NoError(t, err)
	req.Host = "dev-dashboard:8080"
	res, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	require.NoError(t, res.Body.Close())
	require.Equalf(t, http.StatusOK, res.StatusCode, "apps: %s", b)
	body := string(b)
	require.Contains(t, body, `"appId":"order-processor"`)
	require.Contains(t, body, `"source":"compose"`)
	require.Contains(t, body, `"health":"healthy"`)

	// The SPA is told it runs in compose container posture.
	_, index := httpGet(t, srv.URL+"/")
	require.Contains(t, index, `"workflows":true`)
	require.Contains(t, index, `"lifecycle":false`)
	require.Contains(t, index, `"mode":"compose"`)
	require.Contains(t, index, `"containerPosture":true`)

	// Workflows is routable with no store: the sidecar source stands in.
	r, wfBody := httpGet(t, srv.URL+"/api/workflows/")
	require.Equalf(t, http.StatusOK, r.StatusCode, "workflows: %s", wfBody)

	// Runtime-dependent surfaces and the store-only State page are absent.
	for _, path := range []string{"/api/controlplane/", "/api/apps/order-processor/logs", "/api/state/"} {
		r, _ := httpGet(t, srv.URL+path)
		require.Equalf(t, http.StatusNotFound, r.StatusCode, "%s", path)
	}
	post, err := http.Post(srv.URL+"/api/apps/order-processor/daprd/stop", "application/json", strings.NewReader(`{}`))
	require.NoError(t, err)
	_ = post.Body.Close()
	require.Equal(t, http.StatusNotFound, post.StatusCode, "lifecycle action route must be unregistered")
}
