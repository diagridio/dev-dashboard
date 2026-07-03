package controlplane

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

var (
	ErrRuntimeUnavailable = errors.New("no container runtime available")
	ErrUnknownService     = errors.New("unknown control-plane service")
	ErrInvalidAction      = errors.New("invalid action")
)

// ListResult is the payload of GET /api/controlplane.
type ListResult struct {
	Runtime   RuntimeKind `json:"runtime"`
	Available bool        `json:"available"`
	Services  []Service   `json:"services"`
}

// Manager lists and controls the local control-plane services.
type Manager interface {
	List(ctx context.Context) (ListResult, error)
	Do(ctx context.Context, action, name string) error
	LogStream(ctx context.Context, name string) (<-chan string, error)
}

type manager struct {
	runtime RuntimeKind
	run     runner
}

// New resolves the container runtime from the environment and PATH.
func New() Manager {
	kind := resolveRuntime(os.Getenv("DASH_CONTAINER_RUNTIME"), exec.LookPath)
	if kind == RuntimeNone {
		return newManager(RuntimeNone, nil)
	}
	return newManager(kind, newExecRunner(kind))
}

func newManager(kind RuntimeKind, run runner) *manager {
	return &manager{runtime: kind, run: run}
}

func (m *manager) List(ctx context.Context) (ListResult, error) {
	if m.runtime == RuntimeNone {
		return ListResult{Runtime: RuntimeNone, Available: false}, nil
	}
	mem := m.memory(ctx)
	services := make([]Service, 0, len(LiveServiceNames)+len(K8sOnlyServiceNames))
	for _, name := range LiveServiceNames {
		svc := Service{Name: name, Status: StatusStopped, Actionable: true}
		out, err := m.run.run(ctx, "inspect", name)
		if err == nil {
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
		services = append(services, svc)
	}
	for _, name := range K8sOnlyServiceNames {
		services = append(services, Service{Name: name, Status: StatusK8sOnly, Actionable: false})
	}
	return ListResult{Runtime: m.runtime, Available: true, Services: services}, nil
}

// memory fetches a single stats snapshot; failures degrade to empty (no memory shown).
// The args are passed as: "stats", "--no-stream", "--format", "{{json .}}", names...
// so that execRunner invokes: docker stats --no-stream --format '{{json .}}' <names>.
// The fakeRunner in tests keys on args[0]+" "+args[1], i.e. "stats --no-stream".
func (m *manager) memory(ctx context.Context) map[string]memStat {
	args := append([]string{"stats", "--no-stream", "--format", "{{json .}}"}, LiveServiceNames...)
	out, err := m.run.run(ctx, args...)
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
	_, err := m.run.run(ctx, action, name)
	return err
}

func (m *manager) LogStream(ctx context.Context, name string) (<-chan string, error) {
	if !IsLiveName(name) {
		return nil, ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return nil, ErrRuntimeUnavailable
	}
	return m.run.stream(ctx, "logs", "-f", "--tail", "200", name)
}
