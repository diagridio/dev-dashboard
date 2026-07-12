//go:build e2e

package e2e_test

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// TestDaprWorkflowReadBack runs the wfapp under `dapr run`, waits for its
// workflow to complete, then reads the instance back through the dashboard's
// real statestore + workflow packages and asserts the runtime-authored state
// is decoded correctly. Skipped unless dapr/daprd are on PATH or in ~/.dapr/bin.
func TestDaprWorkflowReadBack(t *testing.T) {
	if _, err := exec.LookPath("dapr"); err != nil {
		t.Skip("dapr CLI not on PATH; skipping e2e")
	}
	if _, err := exec.LookPath("daprd"); err != nil {
		home, _ := os.UserHomeDir()
		if home == "" {
			t.Skip("daprd not found; skipping e2e")
		}
		if _, statErr := os.Stat(filepath.Join(home, ".dapr", "bin", "daprd")); statErr != nil {
			t.Skip("daprd not found on PATH or in ~/.dapr/bin; skipping e2e")
		}
	}

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "actors.db")
	resDir := filepath.Join(dir, "resources")
	require.NoError(t, os.MkdirAll(resDir, 0o755))

	// SQLite state store flagged as the actor state store (required for workflows).
	comp := "apiVersion: dapr.io/v1alpha1\n" +
		"kind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbPath + "\n" +
		"  - name: actorStateStore\n    value: \"true\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "statestore.yaml"), []byte(comp), 0o644))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "dapr", "run",
		"--app-id", "ordersvc",
		"--resources-path", resDir,
		"--", "go", "run", ".")
	cmd.Dir = "wfapp" // relative to this test package (test/e2e)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	done := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			t.Log(line)
			if strings.HasPrefix(line, "WORKFLOW_DONE ") {
				done <- strings.TrimSpace(strings.TrimPrefix(line, "WORKFLOW_DONE "))
				return
			}
		}
	}()

	var instanceID string
	select {
	case instanceID = <-done:
	case <-ctx.Done():
		t.Fatal("workflow did not complete within timeout")
	}
	require.Equal(t, "e2e-order-1", instanceID)

	// Give the runtime a moment to flush final state.
	time.Sleep(1 * time.Second)

	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	svc := workflow.New(store, "default")

	ex, err := svc.Get(context.Background(), "ordersvc", instanceID)
	require.NoError(t, err)
	require.Equal(t, workflow.StatusCompleted, ex.Status)
	require.NotEmpty(t, ex.History)
}
