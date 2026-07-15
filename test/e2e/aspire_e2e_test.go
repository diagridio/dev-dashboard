//go:build e2e

package e2e_test

import (
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// requireDaprCLI skips the test if the `dapr` CLI is not on PATH. The Aspire
// CommunityToolkit Dapr integration shells out to `dapr run` to launch the
// sidecar, and workflows additionally need the placement/scheduler services
// a prior `dapr init` starts — a dependency surface broader than
// requireDotnet/requireDocker, so without this guard a machine lacking the
// dapr CLI would hang rather than skip.
func requireDaprCLI(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("dapr"); err != nil {
		t.Skip("dapr CLI not on PATH; skipping aspire e2e")
	}
}

// TestAspireDiscovery runs a real .NET Aspire AppHost that launches Redis, a
// .NET Dapr workflow app, and the dashboard binary in aspire mode. It asserts
// the dashboard discovers the app (via the env contract), its component, and
// the workflow instance, and that gated routes are absent.
func TestAspireDiscovery(t *testing.T) {
	requireDotnet(t)
	requireDocker(t)
	requireDaprCLI(t)

	bin := dashboardBinary(t)
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	// All host-facing ports are OS-assigned at runtime (like the compose and
	// testcontainers fixtures), never hardcoded: the dashboard port, the Redis
	// host port, and the orderservice daprd HTTP port. They are handed to the
	// AppHost via env vars, which pins its resources to them.
	redisPort := freePort(t)
	daprHTTPPort := freePort(t)
	for daprHTTPPort == redisPort || daprHTTPPort == port || redisPort == port {
		// freePort closes its listener before returning, so two calls can
		// (rarely) hand back the same ephemeral port; re-roll on any clash.
		redisPort = freePort(t)
		daprHTTPPort = freePort(t)
	}

	// The Dapr state-store component, written at test time with the chosen
	// Redis port. The daprd sidecar loads it (via DaprSidecarOptions
	// ResourcesPaths) and the dashboard reads it (DEVDASHBOARD_RESOURCES_PATH);
	// both point at this temp dir. Component name is distinctive so the store
	// election keys on it.
	componentsDir := t.TempDir()
	component := fmt.Sprintf(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: e2easpirestatestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: localhost:%d
  - name: actorStateStore
    value: "true"
`, redisPort)
	require.NoError(t, os.WriteFile(
		filepath.Join(componentsDir, "e2easpirestatestore.yaml"), []byte(component), 0o644))

	// Build first, then run the compiled native apphost binary directly rather
	// than `dotnet run --project AppHost`: `dotnet run` spawns the apphost as a
	// *child* process and does not reliably forward signals to it (the same
	// wrapper-process problem as `go run`, see testcontainers_e2e_test.go). A
	// SIGTERM aimed at the `dotnet run` wrapper would leave the actual
	// AppHost process — and everything it orchestrates (daprd, OrderService,
	// the Redis container) — running well past test cleanup.
	build := exec.Command("dotnet", "build", "AppHost")
	build.Dir = "fixtures/aspire"
	out, err := build.CombinedOutput()
	require.NoErrorf(t, err, "dotnet build AppHost: %s", out)

	apphostBin, err := filepath.Abs("fixtures/aspire/AppHost/bin/Debug/net10.0/AppHost")
	require.NoError(t, err)
	require.FileExistsf(t, apphostBin, "expected the AppHost build to produce a native launcher at %s", apphostBin)

	apphost := exec.Command(apphostBin)
	apphost.Dir = "fixtures/aspire/AppHost"
	apphost.Env = append(os.Environ(),
		"DASH_BIN="+bin,
		"DASH_PORT="+fmt.Sprint(port),
		"REDIS_PORT="+fmt.Sprint(redisPort),
		"ORDERSERVICE_DAPR_HTTP_PORT="+fmt.Sprint(daprHTTPPort),
		"COMPONENTS_DIR="+componentsDir,
	)
	apphost.Stdout = os.Stdout
	apphost.Stderr = os.Stderr
	require.NoError(t, apphost.Start())
	t.Cleanup(func() {
		_ = apphost.Process.Signal(syscall.SIGTERM)
		_ = apphost.Wait()
	})

	// Wait for the dashboard (launched by Aspire) to answer. NuGet restore +
	// build + Dapr sidecar/placement handshake can take several minutes on a
	// cold cache.
	waitFor(t, 5*time.Minute, func() bool {
		res, err := http.Get(base + "/api/health")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})

	// Apps: orderservice discovered via the env contract, source=aspire.
	waitFor(t, 60*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"appId":"orderservice"`) &&
			strings.Contains(body, `"source":"aspire"`)
	})

	// The daprd sidecar must actually be up before workflows can run — its
	// health is enriched from a live /v1.0/metadata call. Assert it here (with
	// a generous window for the placement/scheduler handshake) so a sidecar
	// that never initializes its actor/workflow runtime fails at this
	// diagnostic point rather than silently timing out at the workflow step
	// below. App discovery above is satisfied by the env contract alone and
	// does not prove the sidecar works.
	waitFor(t, 3*time.Minute, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"health":"healthy"`)
	})

	// Components: e2easpirestatestore from DEVDASHBOARD_RESOURCES_PATH.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/resources/?kind=component")
		return strings.Contains(body, "e2easpirestatestore")
	})

	// Workflows: instance from the Aspire-managed Redis.
	waitFor(t, 90*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})

	// Negative: controlplane and per-app logs are gated off in aspire mode.
	_, status := getJSON(t, base, "/api/controlplane/")
	require.Equal(t, http.StatusNotFound, status)
	_, status = getJSON(t, base, "/api/apps/orderservice/logs")
	require.Equal(t, http.StatusNotFound, status)
}
