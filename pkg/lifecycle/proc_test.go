package lifecycle

import (
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestProcControllerLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-only smoke test")
	}
	cmd := exec.Command("sleep", "30")
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	pc := NewProcController()
	require.True(t, pc.Alive(pid))

	snap, err := pc.Snapshot(pid)
	require.NoError(t, err)
	require.Equal(t, pid, snap.PID)
	require.NotEmpty(t, snap.Argv)

	require.NoError(t, pc.Terminate(pid))
	_, _ = cmd.Process.Wait() // reap
	require.Eventually(t, func() bool { return !pc.Alive(pid) }, 3*time.Second, 50*time.Millisecond)
}
