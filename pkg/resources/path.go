package resources

import (
	"path/filepath"
	"runtime"
	"strings"
)

// CanonicalPath returns the form of a file path used to tell whether two
// paths name the same file: cleaned, with symlinks resolved when the path
// exists (daprd's cwd comes back symlink-resolved, e.g. /private/var on
// macOS, while CLI-reported paths are not), and lower-cased on Windows, whose
// file system is case-insensitive. It is a comparison key only; keep showing
// the original path to users. "" stays "".
func CanonicalPath(p string) string {
	return canonicalPath(p, runtime.GOOS)
}

func canonicalPath(p, goos string) string {
	if p == "" {
		return ""
	}
	p = filepath.Clean(p)
	if resolved, err := filepath.EvalSymlinks(p); err == nil {
		p = resolved
	}
	if goos == "windows" {
		p = strings.ToLower(p)
	}
	return p
}
