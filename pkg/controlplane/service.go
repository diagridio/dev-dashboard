package controlplane

import (
	"context"
	"errors"
	"strings"
	"sync"

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
	src     Sources

	mu           sync.Mutex
	composeNames map[string]bool // compose CP containers found by the last List
}

// New resolves the container runtime from the environment and PATH.
func New(src Sources) Manager {
	kind, run := containerruntime.Detect()
	return newManager(kind, run, src)
}

func newManager(kind RuntimeKind, run containerruntime.Runner, src Sources) *manager {
	return &manager{runtime: kind, run: run, src: src}
}

func (m *manager) List(ctx context.Context) (ListResult, error) {
	if m.runtime == RuntimeNone {
		return ListResult{Runtime: RuntimeNone, Available: false}, nil
	}
	// Probe whether the daemon is reachable before attempting container operations.
	if _, err := m.run.Run(ctx, "info"); err != nil {
		return ListResult{Runtime: m.runtime, Available: true, Reachable: false}, nil
	}
	var composeSvcs []Service
	if m.src.Compose {
		composeSvcs = m.composeControlPlane(ctx)
	}
	var liveNames []string
	if m.src.Init {
		liveNames = LiveServiceNames
	}
	statNames := append(append([]string{}, liveNames...), serviceNames(composeSvcs)...)
	mem := m.memory(ctx, statNames)
	services := make([]Service, 0, len(liveNames)+len(composeSvcs))
	present := false
	for _, name := range liveNames {
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
	for i := range composeSvcs {
		if ms, ok := mem[composeSvcs[i].Name]; ok {
			composeSvcs[i].MemoryBytes = ms.Bytes
			composeSvcs[i].MemoryHuman = ms.Human
		}
		if composeSvcs[i].Status == StatusRunning {
			present = true
		}
		services = append(services, composeSvcs[i])
	}
	m.setComposeNames(serviceNames(composeSvcs))
	return ListResult{Runtime: m.runtime, Available: true, Reachable: true, ControlPlanePresent: present, Services: services}, nil
}

// memory fetches a single stats snapshot; failures degrade to empty (no memory shown).
// The args are passed as: "stats", "--no-stream", "--format", "{{json .}}", names...
// so that execRunner invokes: docker stats --no-stream --format '{{json .}}' <names>.
// The fakeRunner in tests keys on args[0]+" "+args[1], i.e. "stats --no-stream".
func (m *manager) memory(ctx context.Context, names []string) map[string]memStat {
	args := append([]string{"stats", "--no-stream", "--format", "{{json .}}"}, names...)
	out, err := m.run.Run(ctx, args...)
	if err != nil {
		return map[string]memStat{}
	}
	return parseStats(out)
}

// composeControlPlane finds compose-run placement/scheduler containers.
// Failures degrade to none (the fixed dapr_* services still render).
func (m *manager) composeControlPlane(ctx context.Context) []Service {
	out, err := m.run.Run(ctx, "ps", "-aq", "--filter", "label=com.docker.compose.project")
	if err != nil {
		return nil
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil
	}
	raw, err := m.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil
	}
	svcs, err := parseComposeControlPlane(raw)
	if err != nil {
		return nil
	}
	return svcs
}

func serviceNames(svcs []Service) []string {
	out := make([]string, len(svcs))
	for i, s := range svcs {
		out[i] = s.Name
	}
	return out
}

func (m *manager) setComposeNames(names []string) {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	m.mu.Lock()
	m.composeNames = set
	m.mu.Unlock()
}

func (m *manager) isComposeName(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.composeNames[name]
}

// allowed reports whether name belongs to a family this manager serves.
func (m *manager) allowed(name string) bool {
	return (m.src.Init && IsLiveName(name)) || (m.src.Compose && m.isComposeName(name))
}

func (m *manager) Do(ctx context.Context, action, name string) error {
	if !ValidAction(action) {
		return ErrInvalidAction
	}
	if !m.allowed(name) {
		return ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return ErrRuntimeUnavailable
	}
	_, err := m.run.Run(ctx, action, name)
	return err
}

func (m *manager) LogStream(ctx context.Context, name string) (<-chan string, error) {
	if !m.allowed(name) {
		return nil, ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return nil, ErrRuntimeUnavailable
	}
	return m.run.Stream(ctx, "logs", "-f", "--tail", "200", name)
}
