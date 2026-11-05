//go:build unit

package resources

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/require"
)

// symlinkedDir returns a real dir and a symlink pointing at it, skipping the
// test where symlinks can't be created (e.g. Windows without privileges).
func symlinkedDir(t *testing.T) (real, link string) {
	t.Helper()
	base := t.TempDir()
	real = filepath.Join(base, "real")
	link = filepath.Join(base, "link")
	require.NoError(t, os.MkdirAll(real, 0o700))
	if err := os.Symlink(real, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}
	return real, link
}

func TestCanonicalPathResolvesSymlinks(t *testing.T) {
	real, link := symlinkedDir(t)
	require.NoError(t, os.WriteFile(filepath.Join(real, "cfg.yaml"), cfgNamed("c"), 0o600))
	require.Equal(t, CanonicalPath(filepath.Join(real, "cfg.yaml")), CanonicalPath(filepath.Join(link, "cfg.yaml")))
}

func TestCanonicalPathWindowsFoldsCase(t *testing.T) {
	require.Equal(t, canonicalPath(`C:\Proj\Config.yaml`, "windows"), canonicalPath(`c:\proj\config.yaml`, "windows"))
	require.NotEqual(t, canonicalPath("/Proj/A.yaml", "linux"), canonicalPath("/proj/a.yaml", "linux"))
}

func TestCanonicalPathMissingFileIsCleaned(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix path")
	}
	require.Equal(t, "/no/file.yaml", CanonicalPath("/no/such/../file.yaml"))
	require.Empty(t, CanonicalPath(""))
}
