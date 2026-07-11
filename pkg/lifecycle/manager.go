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
		if _, err := m.run.Run(ctx, string(action), id); err != nil {
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

// doStandalone dispatches start/stop/restart for a process-table instance.
// Aspire-managed apps only allow stop; Aspire itself owns start/restart.
func (m *manager) doStandalone(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	// dapr run supervises app + daprd together: stopping the sidecar alone
	// cascades to the app, and restarting it alone orphans daprd outside the
	// CLI. Funnel sidecar actions to the whole instance instead.
	if !in.IsAspire && target == TargetDaprd {
		target = TargetAll
	}
	if in.IsAspire && action != ActionStop {
		return fmt.Errorf("%w: Aspire manages this app's lifecycle — restart it from the Aspire dashboard", ErrUnsupported)
	}
	// An orphaned sidecar has no supervising CLI and no app: nothing is
	// re-runnable, so starting or restarting would only resurrect another
	// orphan. Stop is the sole supported action.
	if in.SidecarOrphaned && action != ActionStop {
		return fmt.Errorf("%w: orphaned sidecar — only stop is supported", ErrUnsupported)
	}
	switch action {
	case ActionStop:
		return m.standaloneStop(ctx, in, target)
	case ActionStart:
		return m.standaloneStart(ctx, in, target)
	default: // restart
		if err := m.standaloneStop(ctx, in, target); err != nil {
			return err
		}
		return m.standaloneStart(ctx, in, target)
	}
}

// standaloneStop snapshots every process it may kill (directly or as a CLI
// child), records them, then signals with SIGTERM -> SIGKILL escalation.
func (m *manager) standaloneStop(ctx context.Context, in discovery.Instance, target Target) error {
	snaps := map[Target]ProcSnapshot{}
	snapshot := func(t Target, pid int, logPath string) {
		if pid == 0 {
			return
		}
		s, err := m.proc.Snapshot(pid)
		if err != nil {
			logger().Warn("process snapshot failed; restart via dashboard won't be possible", "pid", pid, "err", err)
			return
		}
		s.LogPath = logPath
		snaps[t] = s
	}

	var pids []int
	switch target {
	case TargetApp:
		if in.AppPID == 0 {
			return fmt.Errorf("%w: app process unknown", ErrUnsupported)
		}
		// Killing the app usually makes the dapr CLI tear down daprd and exit
		// (supervision cascade), so capture all three commands even though
		// only the app is signalled — the whole instance stays recoverable.
		snapshot(TargetApp, in.AppPID, in.AppLogPath)
		snapshot(TargetDaprd, in.DaprdPID, in.DaprdLogPath)
		snapshot(TargetAll, in.CLIPID, "")
		pids = []int{in.AppPID}
	case TargetDaprd:
		if in.DaprdPID == 0 {
			return fmt.Errorf("%w: daprd process unknown", ErrUnsupported)
		}
		snapshot(TargetDaprd, in.DaprdPID, in.DaprdLogPath)
		pids = []int{in.DaprdPID}
	default: // all: snapshot everything, signal the CLI which reaps children
		snapshot(TargetApp, in.AppPID, in.AppLogPath)
		snapshot(TargetDaprd, in.DaprdPID, in.DaprdLogPath)
		snapshot(TargetAll, in.CLIPID, "")
		if in.CLIPID != 0 {
			pids = []int{in.CLIPID}
		} else {
			for _, p := range []int{in.AppPID, in.DaprdPID} {
				if p != 0 {
					pids = append(pids, p)
				}
			}
		}
		if len(pids) == 0 {
			return fmt.Errorf("%w: no processes to stop", ErrUnsupported)
		}
	}
	// Orphans record nothing: their daprd command must not be offered for
	// re-run (it would only resurrect another orphan), so the instance simply
	// disappears once its process is gone.
	if !in.SidecarOrphaned {
		m.reg.RecordStop(in, snaps)
	}
	for _, pid := range pids {
		if err := m.terminateWithEscalation(ctx, pid); err != nil {
			return fmt.Errorf("stop pid %d: %w", pid, err)
		}
	}
	return nil
}

// terminateWithEscalation SIGTERMs, waits up to m.grace for exit, then SIGKILLs.
func (m *manager) terminateWithEscalation(ctx context.Context, pid int) error {
	if err := m.proc.Terminate(pid); err != nil {
		return err
	}
	deadline := time.Now().Add(m.grace)
	for time.Now().Before(deadline) {
		if !m.proc.Alive(pid) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	if m.proc.Alive(pid) {
		logger().Warn("process ignored SIGTERM; killing", "pid", pid)
		return m.proc.Kill(pid)
	}
	return nil
}

// standaloneStart re-runs the snapshot captured at stop time. TargetAll
// prefers the dapr CLI command (it starts both halves). The registry entry
// deliberately survives the start: dropping it here opened a window where
// the instance was neither remembered nor yet discovered (the page 404'd,
// and a command that exited immediately erased the instance for good). The
// overlay's live reconciliation removes the entry once the process scan
// sees the instance again.
func (m *manager) standaloneStart(ctx context.Context, in discovery.Instance, target Target) error {
	entry, ok := m.reg.Get(in.InstanceKey)
	if !ok {
		return fmt.Errorf("%w: this app was not stopped by the dashboard, so there is no command to re-run", ErrUnsupported)
	}
	if target == TargetAll {
		if snap, ok := entry.Procs[TargetAll]; ok {
			return m.start.Start(snap.Argv, snap.Dir, snap.LogPath)
		}
		// No CLI snapshot: bring the halves up individually, sidecar first.
		started := false
		for _, t := range []Target{TargetDaprd, TargetApp} {
			snap, ok := entry.Procs[t]
			if !ok {
				continue
			}
			if err := m.start.Start(snap.Argv, snap.Dir, snap.LogPath); err != nil {
				return err
			}
			started = true
		}
		if !started {
			return fmt.Errorf("%w: no captured command to re-run", ErrUnsupported)
		}
		return nil
	}
	snap, ok := entry.Procs[target]
	if !ok {
		return fmt.Errorf("%w: no captured command for %s", ErrUnsupported, target)
	}
	return m.start.Start(snap.Argv, snap.Dir, snap.LogPath)
}
