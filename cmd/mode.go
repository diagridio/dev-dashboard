package cmd

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

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

// serveSettings is the fully resolved serve configuration: flag > env > mode
// default, per the spec's precedence rule.
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

// resolveServeSettings applies the flag > env > mode-default precedence.
// flagChanged reports whether the named cobra flag was set explicitly; port,
// bind, stateStore, namespace carry the flag values (which hold cobra
// defaults when unchanged).
func resolveServeSettings(mode Mode, flagChanged func(string) bool, port int, bind, stateStore, namespace string, getenv func(string) string) (serveSettings, error) {
	s := serveSettings{Port: port, Bind: bind, StateStore: stateStore, Namespace: namespace}

	if !flagChanged("port") {
		if v := getenv("DEVDASHBOARD_PORT"); v != "" {
			p, err := strconv.Atoi(v)
			if err != nil || p < 1 || p > 65535 {
				return s, fmt.Errorf("DEVDASHBOARD_PORT: expected a port number, got %q", v)
			}
			s.Port = p
		} else if mode == ModeAspire {
			s.Port = 8080
		}
	}
	if !flagChanged("bind") {
		if v := getenv("DEVDASHBOARD_BIND"); v != "" {
			s.Bind = v
		} else if mode == ModeAspire {
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
	} else if mode == ModeAspire && s.StateStore != "" {
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
