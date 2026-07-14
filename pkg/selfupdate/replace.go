package selfupdate

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// replaceExecutable atomically replaces the file at path with newBin (mode
// 0755). On Unix it renames a temp file (written in the same directory) over
// the target, which is permitted even while the binary is running. On Windows
// the in-use target cannot be overwritten, so it is moved aside first and
// restored if the install fails.
func replaceExecutable(path string, newBin []byte) error {
	dir := filepath.Dir(path)
	tmp, err := os.CreateTemp(dir, ".diagrid-dev-dashboard-update-*")
	if err != nil {
		return fmt.Errorf("create temp file in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName) // no-op once renamed away

	if _, err := tmp.Write(newBin); err != nil {
		tmp.Close()
		return fmt.Errorf("write temp binary: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp binary: %w", err)
	}
	if err := os.Chmod(tmpName, 0o755); err != nil {
		return fmt.Errorf("chmod temp binary: %w", err)
	}

	if runtime.GOOS == "windows" {
		old := path + ".old"
		_ = os.Remove(old)
		if err := os.Rename(path, old); err != nil {
			return fmt.Errorf("move current binary aside: %w", err)
		}
		if err := os.Rename(tmpName, path); err != nil {
			_ = os.Rename(old, path) // restore the original on failure
			return fmt.Errorf("install new binary: %w", err)
		}
		_ = os.Remove(old) // best effort; may be locked while running
		return nil
	}

	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("install new binary: %w", err)
	}
	return nil
}
