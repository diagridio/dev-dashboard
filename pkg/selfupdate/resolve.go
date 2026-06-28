// Package selfupdate updates the dev-dashboard binary in place from GitHub Releases.
package selfupdate

import "strings"

// normalizeVersion ensures a single leading "v" and trims surrounding space.
// "1.2.0" -> "v1.2.0"; " v1.2.0 " -> "v1.2.0"; "" -> "".
func normalizeVersion(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}

// versionsEqual reports whether a and b name the same version, ignoring a
// leading "v" and surrounding space.
func versionsEqual(a, b string) bool {
	return strings.TrimPrefix(strings.TrimSpace(a), "v") ==
		strings.TrimPrefix(strings.TrimSpace(b), "v")
}
