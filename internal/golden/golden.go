//go:build integration

// Package golden provides a tiny golden-file assertion helper for tests.
package golden

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Assert compares got against the golden file at path. When update is true it
// (re)writes the golden file (creating parent dirs) instead of comparing.
func Assert(t *testing.T, update bool, path string, got []byte) {
	t.Helper()
	if len(got) == 0 || got[len(got)-1] != '\n' {
		got = append(got, '\n')
	}
	if update {
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "missing golden file %s (run the test with -update)", path)
	require.Equal(t, string(want), string(got))
}
