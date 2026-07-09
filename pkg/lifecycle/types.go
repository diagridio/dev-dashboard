// Package lifecycle starts, stops and restarts discovered Dapr applications
// and their sidecars. Compose instances act on containers via the container
// runtime; standalone (dapr run) instances signal processes and re-run
// captured commands. An in-memory registry keeps standalone instances the
// dashboard stopped visible until they are started again.
package lifecycle

import "errors"

// Target selects which half of an instance an action applies to.
type Target string

const (
	TargetApp   Target = "app"
	TargetDaprd Target = "daprd"
	TargetAll   Target = "all"
)

// Action is the lifecycle operation.
type Action string

const (
	ActionStart   Action = "start"
	ActionStop    Action = "stop"
	ActionRestart Action = "restart"
)

func ValidTarget(t Target) bool { return t == TargetApp || t == TargetDaprd || t == TargetAll }
func ValidAction(a Action) bool {
	return a == ActionStart || a == ActionStop || a == ActionRestart
}

var (
	ErrInvalidTarget      = errors.New("invalid target")
	ErrInvalidAction      = errors.New("invalid action")
	ErrUnsupported        = errors.New("action not supported for this app")
	ErrRuntimeUnavailable = errors.New("no container runtime available")
)

// ProcSnapshot captures what is needed to re-run a stopped process.
type ProcSnapshot struct {
	PID     int
	Argv    []string
	Dir     string
	LogPath string // stdout/stderr destination for the re-run; "" discards
}
