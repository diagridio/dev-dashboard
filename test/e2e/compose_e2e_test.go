//go:build e2e

package e2e_test

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestComposeDiscovery brings up a real compose project (redis + wfapp + daprd
// sidecar + placement), then boots the dashboard in compose mode and asserts it
// discovers the app, its component, and the completed workflow instance through
// the real HTTP API. The workflow assertion proves host->container Redis
// address translation.
func TestComposeDiscovery(t *testing.T) {
	requireDocker(t)

	dir := filepath.Join("fixtures", "compose")
	compose := func(args ...string) *exec.Cmd {
		c := exec.Command("docker", append([]string{"compose"}, args...)...)
		c.Dir = dir
		return c
	}

	// Register teardown before bringing the project up: if `up` partially
	// starts services and then errors, the require below aborts the test
	// immediately, and cleanup must still run to avoid leaking containers
	// and networks from the partial start.
	t.Cleanup(func() {
		down := compose("down", "-v")
		_, _ = down.CombinedOutput()
	})

	upCtx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	up := exec.CommandContext(upCtx, "docker", "compose", "up", "-d", "--build")
	up.Dir = dir
	out, err := up.CombinedOutput()
	require.NoErrorf(t, err, "compose up: %s", out)

	// Wait for wfapp to schedule and complete its workflow (marker line).
	waitFor(t, 90*time.Second, func() bool {
		logs := compose("logs", "wfapp")
		b, _ := logs.CombinedOutput()
		return strings.Contains(string(b), "WORKFLOW_DONE")
	})

	base := bootDashboard(t, "compose", nil)

	// Apps: wfapp discovered from the compose sidecar.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"appId":"wfapp"`) &&
			strings.Contains(body, `"source":"compose"`)
	})
	body, _ := getJSON(t, base, "/api/apps/")
	require.Contains(t, body, `"health":"healthy"`)

	// Components: the actor state store read from the mounted -resources-path.
	body, _ = getJSON(t, base, "/api/resources/?kind=component")
	require.Contains(t, body, "e2ecomposestatestore")

	// Workflows: the completed instance is visible — proves host->container
	// Redis translation (redis:6379 -> localhost:<publishedPort>).
	waitFor(t, 30*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})
}
