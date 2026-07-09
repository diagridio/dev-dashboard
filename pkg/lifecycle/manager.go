package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

func logger() *slog.Logger { return slog.Default().With("component", "lifecycle") }

// Manager starts, stops and restarts discovered app instances.
type Manager interface {
	Do(ctx context.Context, key string, target Target, action Action) error
}

type manager struct {
	apps  discovery.Service
	reg   *Registry
	run   containerruntime.Runner
	proc  ProcController
	start Starter
	grace time.Duration // SIGTERM -> SIGKILL escalation window
}

// New builds the Manager. run may be nil (no container runtime): compose
// actions then fail with ErrRuntimeUnavailable.
func New(apps discovery.Service, reg *Registry, run containerruntime.Runner, proc ProcController, start Starter) Manager {
	return &manager{apps: apps, reg: reg, run: run, proc: proc, start: start, grace: 5 * time.Second}
}

func (m *manager) Do(ctx context.Context, key string, target Target, action Action) error {
	if !ValidTarget(target) {
		return fmt.Errorf("%w: %s", ErrInvalidTarget, target)
	}
	if !ValidAction(action) {
		return fmt.Errorf("%w: %s", ErrInvalidAction, action)
	}
	in, err := m.apps.Get(ctx, key)
	if err != nil {
		return err
	}
	logger().Info("lifecycle action", "key", in.InstanceKey, "target", target, "action", action, "source", in.Source)
	if in.Source == discovery.SourceCompose {
		return m.doCompose(ctx, in, target, action)
	}
	return m.doStandalone(ctx, in, target, action)
}

// doCompose maps targets to container ids and shells out to the runtime,
// exactly like pkg/controlplane does for placement/scheduler.
func (m *manager) doCompose(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	if m.run == nil {
		return ErrRuntimeUnavailable
	}
	ids, err := composeTargets(in, target, action)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := m.run.Run(ctx, string(actionForCompose(action)), id); err != nil {
			return err
		}
	}
	return nil
}

// composeTargets returns container ids in execution order. Stop tears the app
// down before its sidecar; start brings the sidecar up first so the app finds
// it on boot.
func composeTargets(in discovery.Instance, target Target, action Action) ([]string, error) {
	app, daprd := in.AppContainerID, in.DaprdContainerID
	switch target {
	case TargetApp:
		if app == "" {
			return nil, fmt.Errorf("%w: no app container", ErrUnsupported)
		}
		return []string{app}, nil
	case TargetDaprd:
		if daprd == "" {
			return nil, fmt.Errorf("%w: no daprd container", ErrUnsupported)
		}
		return []string{daprd}, nil
	}
	// TargetAll: tolerate a missing app container (sidecar-only instances)
	var stopOrder, startOrder []string
	if app != "" {
		stopOrder = append(stopOrder, app)
	}
	if daprd != "" {
		stopOrder = append(stopOrder, daprd)
		startOrder = append(startOrder, daprd)
	}
	if app != "" {
		startOrder = append(startOrder, app)
	}
	if len(stopOrder) == 0 {
		return nil, fmt.Errorf("%w: no containers", ErrUnsupported)
	}
	if action == ActionStart {
		return startOrder, nil
	}
	if action == ActionRestart {
		// docker restart per container, app-last so it reconnects to daprd
		return startOrder, nil
	}
	return stopOrder, nil
}

func actionForCompose(a Action) Action { return a } // start|stop|restart map 1:1 to docker verbs

// doStandalone is implemented in the standalone tasks.
func (m *manager) doStandalone(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	return fmt.Errorf("%w: standalone lifecycle not yet implemented", ErrUnsupported)
}
