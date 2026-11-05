//go:build unit

package discovery

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestConfigFromArgs(t *testing.T) {
	cases := []struct {
		name string
		args []string
		cwd  string
		want string
	}{
		{"run template, absolute", []string{"daprd", "--app-id", "party-api", "--config", "/proj/config/party-api.yaml", "--resources-path", "/proj/resources"}, "/proj/party-api", "/proj/config/party-api.yaml"},
		{"equals form", []string{"daprd", "--config=/proj/config.yaml"}, "", "/proj/config.yaml"},
		{"single dash", []string{"daprd", "-config", "/proj/config.yaml"}, "", "/proj/config.yaml"},
		{"relative resolved against cwd", []string{"daprd", "--config", "../config/party-api.yaml"}, "/proj/party-api", "/proj/config/party-api.yaml"},
		{"absent", []string{"daprd", "--app-id", "a"}, "/proj", ""},
		{"flag without value", []string{"daprd", "--config"}, "/proj", ""},
		{"similar flag ignored", []string{"daprd", "--config-other", "/x.yaml"}, "", ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			require.Equal(t, tc.want, configFromArgs(tc.args, tc.cwd))
		})
	}
}

func TestGopsutilDaprdConfigReadsLiveProcess(t *testing.T) {
	dir := t.TempDir()
	// The trailing "; true" keeps sh from exec-ing sleep, so the process
	// keeps the --config args on its command line.
	cmd := exec.Command("/bin/sh", "-c", "sleep 30; true", "sh", "--config", "config/app.yaml")
	cmd.Dir = dir
	require.NoError(t, cmd.Start())
	t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })

	// cwd comes back with symlinks resolved (e.g. /private/var on macOS).
	realDir, err := filepath.EvalSymlinks(dir)
	require.NoError(t, err)
	require.Eventually(t, func() bool {
		got := gopsutilDaprdConfig(cmd.Process.Pid)
		return got == filepath.Join(realDir, "config", "app.yaml") || got == filepath.Join(dir, "config", "app.yaml")
	}, 5e9, 1e8)

	require.Empty(t, gopsutilDaprdConfig(0))
	require.Empty(t, gopsutilDaprdConfig(os.Getpid()))
}
