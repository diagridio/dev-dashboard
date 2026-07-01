//go:build unit

package discovery

import (
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
