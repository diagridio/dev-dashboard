//go:build e2e

package e2e_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// repoRoot returns the absolute path to the repository root (two levels up
// from test/e2e).
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	require.NoError(t, err)
	return root
}

// dashboardBinary returns the path to the built dashboard binary, skipping the
// test if it is absent (build it with `make build`).
func dashboardBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(repoRoot(t), "bin", "diagrid-dev-dashboard")
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("dashboard binary not built at %s; run `make build`", bin)
	}
	return bin
}

// freePort asks the kernel for a free TCP port and returns it.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

// bootDashboard starts the dashboard binary in the given mode, waits for
// /api/health to return 200, and returns the base URL. The process is killed
// on test cleanup.
func bootDashboard(t *testing.T, mode string, extraEnv []string, args ...string) string {
	t.Helper()
	bin := dashboardBinary(t)
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	full := append([]string{
		"--mode", mode,
		"--port", fmt.Sprint(port),
		"--no-open",
	}, args...)

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin, full...)
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})

	waitFor(t, 30*time.Second, func() bool {
		res, err := http.Get(base + "/api/health")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})
	return base
}

// getJSON performs a GET and returns the raw body and status code.
func getJSON(t *testing.T, baseURL, path string) (string, int) {
	t.Helper()
	res, err := http.Get(baseURL + path)
	require.NoError(t, err)
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return string(b), res.StatusCode
}

// waitFor polls cond every 500ms until it returns true or the deadline elapses,
// failing the test on timeout.
func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

// requireDocker skips the test if the docker CLI is not on PATH.
func requireDocker(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not on PATH; skipping e2e")
	}
}

// requireDotnet skips the test if the dotnet CLI is not on PATH.
func requireDotnet(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("dotnet"); err != nil {
		t.Skip("dotnet not on PATH; skipping e2e")
	}
}

// requireDapr skips the test if daprd is not available on PATH or in ~/.dapr/bin.
func requireDapr(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("daprd"); err == nil {
		return
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		if _, err := os.Stat(filepath.Join(home, ".dapr", "bin", "daprd")); err == nil {
			return
		}
	}
	t.Skip("daprd not found on PATH or in ~/.dapr/bin; skipping e2e")
}
