//go:build e2e

package e2e_test

import (
	"bufio"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestTestcontainersDiscovery builds the wfapp image, launches the
// testcontainers fixture session, then boots the dashboard in test-containers
// mode and asserts it discovers the sidecar, the tar-extracted component, and
// the workflow instance through the real HTTP API.
func TestTestcontainersDiscovery(t *testing.T) {
	requireDocker(t)

	// Build the wfapp image the fixture references (context = test/e2e).
	build := exec.Command("docker", "build",
		"-t", "tcfixture-wfapp",
		"-f", "fixtures/compose/Dockerfile.wfapp",
		".")
	out, err := build.CombinedOutput()
	require.NoErrorf(t, err, "docker build wfapp: %s", out)

	// Build the fixture into a real binary and run it directly, rather than
	// via `go run .`: `go run` spawns the compiled binary as a *child*
	// process and does not reliably forward signals to it, so a SIGTERM
	// aimed at the `go run` wrapper can leave the actual fixture process
	// (and therefore its containers) running well past test cleanup.
	// Running the binary directly means the signal below reaches the
	// fixture's own signal handler, which explicitly terminates its
	// containers and network.
	fixBinDir := t.TempDir()
	fixBin := filepath.Join(fixBinDir, "tcfixture")
	buildFix := exec.Command("go", "build", "-o", fixBin, ".")
	buildFix.Dir = "fixtures/testcontainers"
	out, err = buildFix.CombinedOutput()
	require.NoErrorf(t, err, "build tcfixture: %s", out)

	// Deliberately plain exec.Command, not CommandContext: a context tied to
	// this test function would have its cancel() fire (via defer, as soon as
	// the test function returns) *before* the SIGTERM sent by the t.Cleanup
	// below runs, and os/exec reacts to context cancellation by SIGKILLing
	// the process immediately — pre-empting the fixture's own graceful
	// container-termination handler and leaving stray containers behind.
	// t.Cleanup's SIGTERM below is the only shutdown signal this process
	// gets; the test's own -timeout is the backstop against a hang.
	fix := exec.Command(fixBin)
	fix.Dir = "fixtures/testcontainers"
	fix.Stderr = os.Stderr
	stdout, err := fix.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, fix.Start())
	t.Cleanup(func() {
		_ = fix.Process.Signal(syscall.SIGTERM)
		_ = fix.Wait()
	})

	// Wait for the fixture to report ready.
	ready := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if strings.Contains(sc.Text(), "TCFIXTURE_READY") {
				close(ready)
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(3 * time.Minute):
		t.Fatal("fixture did not become ready")
	}

	base := bootDashboard(t, "test-containers", nil)

	// Apps: sidecar discovered with source=testcontainers.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"source":"testcontainers"`)
	})

	// Components: statestore tar-extracted from the running container.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/resources/?kind=component")
		return strings.Contains(body, "e2etcstatestore")
	})

	// Workflows: instance visible through the store read path. Generous
	// timeout because the fixture reports ready as soon as the containers
	// have started, not once the workflow has actually completed inside
	// wfapp.
	waitFor(t, 90*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})
}
