//go:build unit

package selfupdate

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestAssetName(t *testing.T) {
	require.Equal(t, "dev-dashboard_1.2.0_linux_amd64.tar.gz", assetName("v1.2.0", "linux", "amd64"))
	require.Equal(t, "dev-dashboard_1.2.0_linux_arm64.tar.gz", assetName("1.2.0", "linux", "arm64"))
	require.Equal(t, "dev-dashboard_1.2.0_darwin_amd64.tar.gz", assetName("v1.2.0", "darwin", "amd64"))
	require.Equal(t, "dev-dashboard_1.2.0_darwin_arm64.tar.gz", assetName("v1.2.0", "darwin", "arm64"))
	require.Equal(t, "dev-dashboard_1.2.0_windows_amd64.zip", assetName("v1.2.0", "windows", "amd64"))
}
