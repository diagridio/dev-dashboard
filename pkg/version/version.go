// Package version exposes build-stamped version information.
package version

// Overridable at build time with -ldflags "-X github.com/diagridio/dev-dashboard/pkg/version.Version=..."
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// Info is the version payload returned by the API.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}

// Get returns the current build's version info.
func Get() Info {
	return Info{Version: Version, Commit: Commit, Date: Date}
}
