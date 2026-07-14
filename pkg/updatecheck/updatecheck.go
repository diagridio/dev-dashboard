// Package updatecheck reports whether a newer diagrid-dev-dashboard release exists.
package updatecheck

import (
	"strings"

	"golang.org/x/mod/semver"
)

// Result is the update-availability payload shared by the CLI notice and the
// GET /api/update-check endpoint. When UpdateAvailable is true, Current and
// Latest are normalized with a leading "v" and ReleaseURL points at the release.
type Result struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseURL      string `json:"releaseUrl"`
}

// IsReleaseVersion reports whether v is a real released version (valid semver
// once a leading "v" is ensured). A source/dev build ("dev") is not.
func IsReleaseVersion(v string) bool {
	return semver.IsValid(withV(v))
}

// evaluate compares current against latest and builds the Result. An update is
// available only when both are valid semver and latest is strictly greater.
func evaluate(current, latest, repo string) Result {
	cur := withV(current)
	lat := withV(latest)
	if semver.IsValid(cur) && semver.IsValid(lat) && semver.Compare(lat, cur) > 0 {
		return Result{
			Current:         cur,
			Latest:          lat,
			UpdateAvailable: true,
			ReleaseURL:      "https://github.com/" + repo + "/releases/tag/" + lat,
		}
	}
	return Result{Current: current, Latest: latest}
}

// withV normalizes a version to a single leading "v" (trimming space). Empty
// stays empty. "1.2.0" -> "v1.2.0"; "v1.2.0" -> "v1.2.0".
func withV(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}
