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
//   - ModeCompose: Docker Compose only. With the DEVDASHBOARD_APP_* env
//     contract present the dashboard is a service inside the user's compose
//     project (container posture, discovery restricted to the contract);
//     without it the dashboard runs on the host and scans compose containers
//     via the container runtime.
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

// containerPosture reports whether the dashboard serves as a container inside
// the orchestrator it is inspecting. Aspire: the DEVDASHBOARD_APP_* env
// contract is present (the AppHost integration may run the dashboard outside
// a container, so presence alone decides). Compose: the contract is present
// AND the process runs in a container, so a DEVDASHBOARD_APP_COUNT left
// exported in a host shell can't turn a host `--mode compose` run (Docker
// scan, loopback, port 9090) into container posture. Either mode without the
// contract is a host-run dashboard filtered to that source.
func containerPosture(mode Mode, getenv func(string) string, inContainer bool) bool {
	switch mode {
	case ModeAspire:
		return discovery.ContractPresent(getenv)
	case ModeCompose:
		return discovery.ContractPresent(getenv) && inContainer
	}
	return false
}

// inContainer reports whether this process runs inside a container: the
// dashboard image sets DEVDASHBOARD_IN_CONTAINER=true (also a manual override
// for runtimes that leave no marker), Docker creates /.dockerenv and Podman
// /run/.containerenv in every container.
func inContainer(getenv func(string) string, exists func(string) bool) bool {
	if strings.EqualFold(strings.TrimSpace(getenv("DEVDASHBOARD_IN_CONTAINER")), "true") {
		return true
	}
	return exists("/.dockerenv") || exists("/run/.containerenv")
}

// fileExists reports whether path exists (inContainer's default probe).
func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// postureNotice is the startup line that says which posture the dashboard
// chose and why, or "" when there is nothing to explain (plain host runs).
// In aspire container posture it also points compose users at
// DEVDASHBOARD_MODE, because the image defaults to aspire and the wrong mode
// otherwise fails silently (workflows then need a store; apps are labelled
// Aspire).
func postureNotice(mode Mode, posture, inContainer bool, getenv func(string) string) string {
	count := strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT"))
	apps := count + " apps declared via DEVDASHBOARD_APP_*"
	if count == "1" {
		apps = "1 app declared via DEVDASHBOARD_APP_*"
	}
	switch {
	case posture && mode == ModeCompose:
		return "Running in compose container posture: " + apps + "."
	case posture && mode == ModeAspire:
		return "Running in aspire container posture: " + apps + ". Inside a Docker Compose project, set DEVDASHBOARD_MODE=compose (the image defaults to aspire)."
	case mode == ModeCompose && !inContainer && discovery.ContractPresent(getenv):
		return "DEVDASHBOARD_APP_* is set, but the dashboard is not running in a container: scanning compose containers from the host instead. Set DEVDASHBOARD_IN_CONTAINER=true to use compose container posture."
	}
	return ""
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

// contractSource maps a container-posture mode to the discovery Source the
// contract scanner stamps on its results.
func contractSource(mode Mode) string {
	if mode == ModeCompose {
		return discovery.SourceCompose
	}
	return discovery.SourceAspire
}
