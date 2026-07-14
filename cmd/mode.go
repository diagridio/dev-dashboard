package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// Mode selects the dashboard's discovery and serving posture. ModeDefault
// (the zero value, mode unset) is the complete scan across all discovery
// sources with today's host behavior. Every other value is an exclusive
// single-source filter — they are never combined:
//
//   - ModeDaprRun: host `dapr run` process scan only.
//   - ModeCompose: Docker Compose container discovery only.
//   - ModeTestcontainers: Testcontainers container discovery only.
//   - ModeAspire: Aspire resources only. With the DEVDASHBOARD_APP_* env
//     contract present the dashboard is the AppHost-managed container
//     (container posture); without it the dashboard runs on the host and
//     filters the process scan to Aspire-managed instances.
//
// CLI values ("dapr-run", "test-containers") are user-facing names and
// intentionally differ from the discovery Source wire values ("standalone",
// "testcontainers") — do not unify them.
type Mode string

const (
	ModeDefault        Mode = ""
	ModeAspire         Mode = "aspire"
	ModeDaprRun        Mode = "dapr-run"
	ModeCompose        Mode = "compose"
	ModeTestcontainers Mode = "test-containers"
)

// resolveMode picks the mode from the --mode flag value and the
// DEVDASHBOARD_MODE env var (flag wins; both empty means ModeDefault).
func resolveMode(flagValue string, getenv func(string) string) (Mode, error) {
	v := flagValue
	if v == "" {
		v = getenv("DEVDASHBOARD_MODE")
	}
	switch Mode(v) {
	case ModeDefault, ModeAspire, ModeDaprRun, ModeCompose, ModeTestcontainers:
		return Mode(v), nil
	}
	return ModeDefault, fmt.Errorf("unknown mode %q: supported values are \"dapr-run\", \"compose\", \"test-containers\", \"aspire\" (or unset for the complete scan)", v)
}

// containerPosture reports whether the dashboard serves as the
// AppHost-managed container: aspire mode with the DEVDASHBOARD_APP_* env
// contract present. Aspire mode without the contract is a host-run dashboard
// filtered to Aspire resources and keeps host serving defaults.
func containerPosture(mode Mode, getenv func(string) string) bool {
	return mode == ModeAspire && discovery.AspireContractPresent(getenv)
}

// serveSettings is the fully resolved serve configuration: flag > env >
// posture default, per the spec's precedence rule.
type serveSettings struct {
	Port           int
	Bind           string
	StateStore     string
	Namespace      string
	ResourcesPaths []string
	// AllowedHosts restricts the Host header in container posture
	// (DEVDASHBOARD_ALLOWED_HOSTS, comma-separated; env-only, no flag).
	AllowedHosts []string
}

// resolveServeSettings applies the flag > env > posture-default precedence.
// flagChanged reports whether the named cobra flag was set explicitly; port,
// bind, stateStore, namespace carry the flag values (which hold cobra
// defaults when unchanged).
func resolveServeSettings(containerPosture bool, flagChanged func(string) bool, port int, bind, stateStore, namespace string, getenv func(string) string) (serveSettings, error) {
	s := serveSettings{Port: port, Bind: bind, StateStore: stateStore, Namespace: namespace}

	if !flagChanged("port") {
		if v := getenv("DEVDASHBOARD_PORT"); v != "" {
			p, err := strconv.Atoi(v)
			if err != nil || p < 1 || p > 65535 {
				return s, fmt.Errorf("DEVDASHBOARD_PORT: expected a port number, got %q", v)
			}
			s.Port = p
		} else if containerPosture {
			s.Port = 8080
		}
	}
	if !flagChanged("bind") {
		if v := getenv("DEVDASHBOARD_BIND"); v != "" {
			s.Bind = v
		} else if containerPosture {
			s.Bind = "0.0.0.0"
		}
	}
	if s.StateStore == "" {
		s.StateStore = getenv("DEVDASHBOARD_STATESTORE_FILE")
	}
	if !flagChanged("namespace") {
		if v := getenv("DEVDASHBOARD_NAMESPACE"); v != "" {
			s.Namespace = v
		}
	}
	if v := getenv("DEVDASHBOARD_RESOURCES_PATH"); v != "" {
		for _, p := range strings.Split(v, string(os.PathListSeparator)) {
			if p = strings.TrimSpace(p); p != "" {
				s.ResourcesPaths = append(s.ResourcesPaths, p)
			}
		}
	} else if containerPosture && s.StateStore != "" {
		s.ResourcesPaths = []string{filepath.Dir(s.StateStore)}
	}
	if v := getenv("DEVDASHBOARD_ALLOWED_HOSTS"); v != "" {
		for _, h := range strings.Split(v, ",") {
			if h = strings.TrimSpace(h); h != "" {
				s.AllowedHosts = append(s.AllowedHosts, h)
			}
		}
	}
	return s, nil
}
