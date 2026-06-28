//go:build unit

package selfupdate

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeVersion(t *testing.T) {
	require.Equal(t, "v1.2.0", normalizeVersion("1.2.0"))
	require.Equal(t, "v1.2.0", normalizeVersion("v1.2.0"))
	require.Equal(t, "v1.2.0", normalizeVersion(" v1.2.0 "))
	require.Equal(t, "", normalizeVersion(""))
}

func TestVersionsEqual(t *testing.T) {
	require.True(t, versionsEqual("1.2.0", "v1.2.0"))
	require.True(t, versionsEqual("v1.2.0", "v1.2.0"))
	require.False(t, versionsEqual("1.2.0", "1.2.1"))
	require.False(t, versionsEqual("dev", "v1.2.0"))
}
