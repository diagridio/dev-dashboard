package controlplane

import (
	"context"
	"errors"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
)

var (
	ErrRuntimeUnavailable = errors.New("no container runtime available")
	ErrUnknownService     = errors.New("unknown control-plane service")
	ErrInvalidAction      = errors.New("invalid action")
)

// ListResult is the payload of GET /api/controlplane.
type ListResult struct {
	Runtime             RuntimeKind `json:"runtime"`
	Available           bool        `json:"available"`
	Reachable           bool        `json:"reachable"`           // runtime daemon responded
	ControlPlanePresent bool        `json:"controlPlanePresent"` // >=1 live container exists
	Services            []Service   `json:"services"`
}

// Manager lists and controls the local control-plane services.
type Manager interface {
	List(ctx context.Context) (ListResult, error)
	Do(ctx context.Context, action, name string) error
	LogStream(ctx context.Context, name string) (<-chan string, error)
}

type manager struct {
	runtime RuntimeKind
	run     containerruntime.Runner
}

// New resolves the container runtime from the environment and PATH.
func New() Manager {
	kind, run := containerruntime.Detect()
	return newManager(kind, run)
}

func newManager(kind RuntimeKind, run containerruntime.Runner) *manager {
	return &manager{runtime: kind, run: run}
}

func (m *manager) List(ctx context.Context) (ListResult, error) {
	if m.runtime == RuntimeNone {
		return ListResult{Runtime: RuntimeNone, Available: false}, nil
	}
	// Probe whether the daemon is reachable before attempting container operations.
	if _, err := m.run.Run(ctx, "info"); err != nil {
		return ListResult{Runtime: m.runtime, Available: true, Reachable: false}, nil
	}
	mem := m.memory(ctx)
	services := make([]Service, 0, len(LiveServiceNames)+len(K8sOnlyServiceNames))
	present := false
	for _, name := range LiveServiceNames {
		svc := Service{Name: name, Status: StatusStopped, Actionable: true}
		out, err := m.run.Run(ctx, "inspect", name)
		if err == nil {
			present = true
			if info, perr := parseInspect(out); perr == nil {
				svc.Status = info.State
				svc.Healthy = info.Healthy
				svc.Ports = info.Ports
				svc.LogPath = info.LogPath
			}
		}
		if ms, ok := mem[name]; ok {
			svc.MemoryBytes = ms.Bytes
			svc.MemoryHuman = ms.Human
		}
		// Never emit a nil Ports slice: a nil []string marshals to JSON null,
		// which breaks the frontend's svc.ports.length. A stopped/absent
		// container has no port bindings, so this is the common case.
		if svc.Ports == nil {
			svc.Ports = []string{}
		}
		services = append(services, svc)
	}
	for _, name := range K8sOnlyServiceNames {
		services = append(services, Service{Name: name, Status: StatusK8sOnly, Actionable: false})
	}
	return ListResult{Runtime: m.runtime, Available: true, Reachable: true, ControlPlanePresent: present, Services: services}, nil
}

// memory fetches a single stats snapshot; failures degrade to empty (no memory shown).
// The args are passed as: "stats", "--no-stream", "--format", "{{json .}}", names...
// so that execRunner invokes: docker stats --no-stream --format '{{json .}}' <names>.
// The fakeRunner in tests keys on args[0]+" "+args[1], i.e. "stats --no-stream".
func (m *manager) memory(ctx context.Context) map[string]memStat {
	args := append([]string{"stats", "--no-stream", "--format", "{{json .}}"}, LiveServiceNames...)
	out, err := m.run.Run(ctx, args...)
	if err != nil {
		return map[string]memStat{}
	}
	return parseStats(out)
}

func (m *manager) Do(ctx context.Context, action, name string) error {
	if !ValidAction(action) {
		return ErrInvalidAction
	}
	if !IsLiveName(name) {
		return ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return ErrRuntimeUnavailable
	}
	_, err := m.run.Run(ctx, action, name)
	return err
}

func (m *manager) LogStream(ctx context.Context, name string) (<-chan string, error) {
	if !IsLiveName(name) {
		return nil, ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return nil, ErrRuntimeUnavailable
	}
	return m.run.Stream(ctx, "logs", "-f", "--tail", "200", name)
}
