//go:build unit

package updatecheck

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsReleaseVersion(t *testing.T) {
	require.True(t, IsReleaseVersion("1.2.0"))
	require.True(t, IsReleaseVersion("v1.2.0"))
	require.False(t, IsReleaseVersion("dev"))
	require.False(t, IsReleaseVersion(""))
	require.False(t, IsReleaseVersion("garbage"))
}

func TestEvaluate(t *testing.T) {
	const repo = "diagridio/dev-dashboard"

	t.Run("newer available", func(t *testing.T) {
		r := evaluate("1.2.0", "v1.3.0", repo)
		require.True(t, r.UpdateAvailable)
		require.Equal(t, "v1.2.0", r.Current)
		require.Equal(t, "v1.3.0", r.Latest)
		require.Equal(t, "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0", r.ReleaseURL)
	})

	t.Run("equal", func(t *testing.T) {
		r := evaluate("v1.3.0", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
		require.Empty(t, r.ReleaseURL)
	})

	t.Run("current newer than latest", func(t *testing.T) {
		r := evaluate("v1.4.0", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
	})

	t.Run("dev current is never an update", func(t *testing.T) {
		r := evaluate("dev", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
		require.Empty(t, r.ReleaseURL)
	})
}
