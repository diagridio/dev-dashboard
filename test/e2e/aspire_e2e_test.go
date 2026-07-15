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

// TestAspireDiscovery runs a real .NET Aspire AppHost that launches Redis, a
// .NET Dapr workflow app, and the dashboard binary in aspire mode. It asserts
// the dashboard discovers the app (via the env contract), its component, and
// the workflow instance, and that gated routes are absent.
func TestAspireDiscovery(t *testing.T) {
	requireDotnet(t)
	requireDocker(t)

	bin := dashboardBinary(t)
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

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
