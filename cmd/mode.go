package cmd

import "fmt"

// Mode selects the dashboard's discovery and serving posture. ModeDefault
// (the zero value, mode unset) is the complete scan across all discovery
// sources with today's host behavior; ModeAspire restricts discovery to the
// DEVDASHBOARD_APP_* env contract and switches to container posture.
// "dapr" and "compose" are reserved for future single-source filter modes.
type Mode string

const (
	ModeDefault Mode = ""
	ModeAspire  Mode = "aspire"
)

// resolveMode picks the mode from the --mode flag value and the
// DEVDASHBOARD_MODE env var (flag wins; both empty means ModeDefault).
func resolveMode(flagValue string, getenv func(string) string) (Mode, error) {
	v := flagValue
	if v == "" {
		v = getenv("DEVDASHBOARD_MODE")
	}
	switch Mode(v) {
	case ModeDefault, ModeAspire:
		return Mode(v), nil
	}
	return ModeDefault, fmt.Errorf("unknown mode %q: supported values are \"aspire\", or unset for the complete scan", v)
}
