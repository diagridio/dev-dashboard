package controlplane

import "github.com/diagridio/dev-dashboard/pkg/containerruntime"

// RuntimeKind identifies the resolved container runtime.
type RuntimeKind = containerruntime.Kind

const (
	RuntimeDocker = containerruntime.Docker
	RuntimePodman = containerruntime.Podman
	RuntimeNone   = containerruntime.None
)

// ServiceStatus is the coarse lifecycle state shown in the UI.
type ServiceStatus string

const (
	StatusRunning ServiceStatus = "running"
	StatusStopped ServiceStatus = "stopped"
	StatusUnknown ServiceStatus = "unknown"
)

// Service is one control-plane service row returned by GET /api/controlplane.
type Service struct {
	Name           string        `json:"name"`
	Status         ServiceStatus `json:"status"`
	Healthy        bool          `json:"healthy"`
	Ports          []string      `json:"ports"`
	MemoryBytes    uint64        `json:"memoryBytes"`
	MemoryHuman    string        `json:"memoryHuman"`
	LogPath        string        `json:"logPath"`
	Actionable     bool          `json:"actionable"`
	ComposeProject string        `json:"composeProject,omitempty"`
}

// LiveServiceNames are the self-hosted control-plane containers this dashboard manages.
var LiveServiceNames = []string{"dapr_scheduler", "dapr_placement"}

func IsLiveName(name string) bool {
	return contains(LiveServiceNames, name)
}

// ValidAction reports whether action is one of the allowed lifecycle verbs.
func ValidAction(action string) bool {
	switch action {
	case "start", "stop", "restart":
		return true
	default:
		return false
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
