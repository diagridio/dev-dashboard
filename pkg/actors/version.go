package actors

import (
	"errors"
	"strings"

	"golang.org/x/mod/semver"
)

// Feature is a sidecar capability that depends on the Dapr runtime version.
type Feature int

const (
	// FeatureReminderList is the gRPC ListActorReminders call (Dapr 1.17+).
	FeatureReminderList Feature = iota
	// FeatureTimerList is the gRPC ListActorTimers call (Dapr 1.19+).
	FeatureTimerList
)

// ErrUnsupportedVersion is matched (errors.Is) by every error Supports returns.
var ErrUnsupportedVersion = errors.New("unsupported Dapr version")

// versionError carries the user-facing reason as its message while still
// matching ErrUnsupportedVersion.
type versionError string

func (e versionError) Error() string        { return string(e) }
func (e versionError) Is(target error) bool { return target == ErrUnsupportedVersion }

var gates = map[Feature]struct{ min, reason string }{
	FeatureReminderList: {"v1.17.0", "requires Dapr 1.17+"},
	FeatureTimerList:    {"v1.19.0", "requires Dapr 1.19+"},
}

// Supports reports whether a sidecar running runtimeVersion supports f. An
// empty or unparsable version counts as unknown and is allowed (the feature
// is tried, not hidden). Prereleases of the minimum version are allowed.
func Supports(runtimeVersion string, f Feature) error {
	g, ok := gates[f]
	if !ok || runtimeVersion == "" {
		return nil
	}
	v := "v" + runtimeVersion
	if !semver.IsValid(v) {
		return nil
	}
	// Compare on major.minor.patch so 1.19.0-rc.1 satisfies 1.19+.
	core := v
	if i := strings.IndexAny(v, "-+"); i >= 0 {
		core = v[:i]
	}
	if semver.Compare(core, g.min) < 0 {
		return versionError(g.reason)
	}
	return nil
}
