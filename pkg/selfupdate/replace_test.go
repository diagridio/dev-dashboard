//go:build unit

package selfupdate

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestReplaceExecutable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "diagrid-dev-dashboard")
	require.NoError(t, os.WriteFile(path, []byte("old-binary"), 0o755))

	require.NoError(t, replaceExecutable(path, []byte("new-binary")))

	got, err := os.ReadFile(path)
	require.NoError(t, err)
	require.Equal(t, []byte("new-binary"), got)

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		require.NoError(t, err)
		require.Equal(t, os.FileMode(0o755), info.Mode().Perm())
	}
}

func TestReplaceExecutableBadDir(t *testing.T) {
	err := replaceExecutable(filepath.Join("definitely-missing-dir-xyz", "bin"), []byte("x"))
	require.Error(t, err)
}
