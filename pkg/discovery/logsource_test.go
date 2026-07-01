//go:build unit

package discovery

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestDcpSessionDir(t *testing.T) {
	t.Run("space-separated flag", func(t *testing.T) {
		cmd := "/x/.nuget/packages/aspire.hosting.orchestration.osx-arm64/13.4.6/tools/dcp run-controllers --kubeconfig /var/folders/4c/T/aspire-dcpZOY2Ea/kubeconfig --monitor 82529"
		dir, ok := dcpSessionDir(cmd)
		require.True(t, ok)
		require.Equal(t, "/var/folders/4c/T/aspire-dcpZOY2Ea", dir)
	})

	t.Run("equals form", func(t *testing.T) {
		dir, ok := dcpSessionDir("dcp run-controllers --kubeconfig=/tmp/aspire-dcpABC/kubeconfig")
		require.True(t, ok)
		require.Equal(t, "/tmp/aspire-dcpABC", dir)
	})

	t.Run("no kubeconfig flag", func(t *testing.T) {
		_, ok := dcpSessionDir("daprd --app-id x")
		require.False(t, ok)
	})
}

func TestResolveDCPLogs(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(name, content string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}

	// daprd sidecar resource (guid AAA) — app-id "pr-digest", resource name "pr-digest-dapr-cli-yuha".
	writeFile("resource-executable-AAA.log",
		`2026-06-30T21:51:26Z	info	ExecutableReconciler	Starting process...	{"Executable": "/pr-digest-dapr-cli-yuha", "Cmd": "/usr/local/bin/dapr", "Args": ["run","--app-id","pr-digest","--app-port","5090"]}`+"\n")
	writeFile("AAA_out", "daprd log line\n")

	// app resource (guid BBB) — same base "pr-digest", a dotnet process.
	writeFile("resource-executable-BBB.log",
		`2026-06-30T21:51:30Z	info	ExecutableReconciler	Starting process...	{"Executable": "/pr-digest-zfzg", "Cmd": "/opt/homebrew/bin/dotnet", "Args": ["run","--project","App.csproj"]}`+"\n")
	writeFile("BBB_out", "app log line\n")

	// unrelated container resource (must be ignored — not resource-executable-*).
	writeFile("resource-container-CCC.log", "irrelevant\n")

	daprdPath, appPath := resolveDCPLogs(dir, "pr-digest")
	require.Equal(t, filepath.Join(dir, "AAA_out"), daprdPath)
	require.Equal(t, filepath.Join(dir, "BBB_out"), appPath)
}

func TestResolveDCPLogs_AppIdDiffersFromResourceName(t *testing.T) {
	dir := t.TempDir()
	writeFile := func(name, content string) {
		require.NoError(t, os.WriteFile(filepath.Join(dir, name), []byte(content), 0o600))
	}
	// Resource name "myapi" but Dapr app-id "different-id".
	writeFile("resource-executable-AAA.log",
		`x	info	r	Starting process...	{"Executable": "/myapi-dapr-cli-xx", "Cmd": "/usr/local/bin/dapr", "Args": ["run","--app-id","different-id"]}`+"\n")
	writeFile("AAA_out", "d\n")
	writeFile("resource-executable-BBB.log",
		`x	info	r	Starting process...	{"Executable": "/myapi-yy", "Cmd": "/usr/bin/node", "Args": ["server.js"]}`+"\n")
	writeFile("BBB_out", "a\n")

	daprdPath, appPath := resolveDCPLogs(dir, "different-id")
	require.Equal(t, filepath.Join(dir, "AAA_out"), daprdPath)
	require.Equal(t, filepath.Join(dir, "BBB_out"), appPath)
}

func TestParseLsofStdout(t *testing.T) {
	t.Run("regular file", func(t *testing.T) {
		out := []byte("p58324\nf1\ntREG\nn/private/tmp/lsoftest.out\n")
		require.Equal(t, "/private/tmp/lsoftest.out", parseLsofStdout(out))
	})
	t.Run("pipe -> empty", func(t *testing.T) {
		out := []byte("p82640\nf1\ntPIPE\nn->0x4652e99aa6990ec3\n")
		require.Equal(t, "", parseLsofStdout(out))
	})
	t.Run("tty -> empty", func(t *testing.T) {
		out := []byte("p61604\nf1\ntCHR\nn/dev/ttys014\n")
		require.Equal(t, "", parseLsofStdout(out))
	})
	t.Run("empty input -> empty", func(t *testing.T) {
		require.Equal(t, "", parseLsofStdout(nil))
	})
}
