//go:build unit

package discovery

import "testing"
import "github.com/stretchr/testify/require"

func TestParseDaprdArgs(t *testing.T) {
	args := []string{
		"daprd", "--app-id", "order", "--dapr-http-port=3500",
		"--dapr-grpc-port", "50001", "--app-port=8080",
		"--resources-path", "/a", "--resources-path", "/b",
		"--config", "/cfg.yaml",
	}
	got := ParseDaprdArgs(args)
	require.Equal(t, "order", got.AppID)
	require.Equal(t, 3500, got.HTTPPort)
	require.Equal(t, 50001, got.GRPCPort)
	require.Equal(t, 8080, got.AppPort)
	require.Equal(t, []string{"/a", "/b"}, got.ResourcePaths)
	require.Equal(t, "/cfg.yaml", got.ConfigPath)
}
