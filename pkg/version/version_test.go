//go:build unit

package version

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetDefaults(t *testing.T) {
	got := Get()
	require.Equal(t, "dev", got.Version)
	require.Equal(t, "none", got.Commit)
	require.Equal(t, "unknown", got.Date)
}

func TestGetReflectsVars(t *testing.T) {
	Version, Commit, Date = "1.2.3", "abc123", "2026-06-25"
	t.Cleanup(func() { Version, Commit, Date = "dev", "none", "unknown" })
	got := Get()
	require.Equal(t, "1.2.3", got.Version)
	require.Equal(t, "abc123", got.Commit)
	require.Equal(t, "2026-06-25", got.Date)
}
