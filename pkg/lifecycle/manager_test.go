package lifecycle

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// fakeApps serves canned instances by key.
type fakeApps struct{ items map[string]discovery.Instance }

func (f fakeApps) List(ctx context.Context) ([]discovery.Instance, error) {
	out := make([]discovery.Instance, 0, len(f.items))
	for _, in := range f.items {
		out = append(out, in)
	}
	return out, nil
}
func (f fakeApps) Get(ctx context.Context, key string) (discovery.Instance, error) {
	if in, ok := f.items[key]; ok {
		return in, nil
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

// fakeRunner records docker invocations.
type fakeRunner struct{ calls [][]string }

func (f *fakeRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	return nil, nil
}
func (f *fakeRunner) Stream(ctx context.Context, args ...string) (<-chan string, error) {
	return nil, nil
}

func composeInst() discovery.Instance {
	return discovery.Instance{
		AppID: "checkout", InstanceKey: "shop-checkout-app-1",
		Source:         discovery.SourceCompose,
		AppContainerID: "appC", DaprdContainerID: "daprdC",
	}
}

func TestComposeSingleTargetActions(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"shop-checkout-app-1": composeInst()}},
		NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetApp, ActionStop))
	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetDaprd, ActionRestart))
	require.Equal(t, [][]string{{"stop", "appC"}, {"restart", "daprdC"}}, run.calls)
}

func TestComposeAllOrdering(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStop))
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStart))
	require.Equal(t, [][]string{
		{"stop", "appC"}, {"stop", "daprdC"}, // stop: app first
		{"start", "daprdC"}, {"start", "appC"}, // start: sidecar first
	}, run.calls)
}

func TestComposeValidation(t *testing.T) {
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), nil, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", "bogus", ActionStop), ErrInvalidTarget)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, "bogus"), ErrInvalidAction)
	require.ErrorIs(t, m.Do(context.Background(), "missing", TargetApp, ActionStop), discovery.ErrNotFound)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrRuntimeUnavailable) // nil runner

	// unpaired app container
	in := composeInst()
	in.AppContainerID = ""
	run := &fakeRunner{}
	m = New(fakeApps{items: map[string]discovery.Instance{"k": in}}, NewRegistry(), run, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrUnsupported)
}

func TestComposeAllRestart(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionRestart))
	require.Equal(t, [][]string{{"restart", "daprdC"}, {"restart", "appC"}}, run.calls)
}

func TestComposeAllPartialContainers(t *testing.T) {
	// Test case 1: sidecar-only instance (empty AppContainerID)
	run := &fakeRunner{}
	inSidecarOnly := composeInst()
	inSidecarOnly.AppContainerID = ""
	m := New(fakeApps{items: map[string]discovery.Instance{"k": inSidecarOnly}}, NewRegistry(), run, nil, nil)

	// TargetAll stop should act on daprd container only
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStop))
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStart))
	require.Equal(t, [][]string{{"stop", "daprdC"}, {"start", "daprdC"}}, run.calls)

	// Test case 2: both containers missing
	inBothMissing := composeInst()
	inBothMissing.AppContainerID = ""
	inBothMissing.DaprdContainerID = ""
	runBoth := &fakeRunner{}
	mBoth := New(fakeApps{items: map[string]discovery.Instance{"k": inBothMissing}}, NewRegistry(), runBoth, nil, nil)

	require.ErrorIs(t, mBoth.Do(context.Background(), "k", TargetAll, ActionStop), ErrUnsupported)
}

// fakeProc is a scriptable ProcController.
type fakeProc struct {
	snaps      map[int]ProcSnapshot
	terminated []int
	killed     []int
	alive      map[int]bool
}

func newFakeProc() *fakeProc {
	return &fakeProc{snaps: map[int]ProcSnapshot{}, alive: map[int]bool{}}
}
func (f *fakeProc) Snapshot(pid int) (ProcSnapshot, error) {
	if s, ok := f.snaps[pid]; ok {
		return s, nil
	}
	return ProcSnapshot{}, errors.New("no such process")
}
func (f *fakeProc) Terminate(pid int) error {
	f.terminated = append(f.terminated, pid)
	f.alive[pid] = false
	return nil
}
func (f *fakeProc) Kill(pid int) error {
	f.killed = append(f.killed, pid)
	f.alive[pid] = false
	return nil
}
func (f *fakeProc) Alive(pid int) bool { return f.alive[pid] }

func standaloneInst() discovery.Instance {
	return discovery.Instance{
		AppID: "orders", InstanceKey: "orders", Source: discovery.SourceStandalone,
		AppPID: 100, DaprdPID: 200, CLIPID: 300,
		AppLogPath: "/tmp/app.log", DaprdLogPath: "/tmp/daprd.log",
	}
}

func TestStandaloneStopAllSignalsCLIAndSnapshotsEverything(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"}
	proc.snaps[300] = ProcSnapshot{PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"}
	proc.alive[100], proc.alive[200], proc.alive[300] = true, true, true

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStop))
	require.Equal(t, []int{300}, proc.terminated) // CLI only; it tears down children

	e, ok := reg.Get("orders")
	require.True(t, ok)
	require.Equal(t, []string{"dapr", "run", "--app-id", "orders"}, e.Procs[TargetAll].Argv)
	require.Equal(t, []string{"go", "run", "."}, e.Procs[TargetApp].Argv) // snapshotted before kill
	require.Equal(t, []string{"daprd", "--app-id", "orders"}, e.Procs[TargetDaprd].Argv)
}

func TestStandaloneStopSingleTargetEscalatesToKill(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}}
	proc.alive[100] = true
	stubborn := &stubbornProc{fakeProc: proc} // Terminate does not clear alive

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, stubborn, nil).(*manager)
	m.grace = 20 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStop))
	require.Equal(t, []int{100}, proc.terminated)
	require.Equal(t, []int{100}, proc.killed) // escalated after grace
}

// stubbornProc ignores Terminate (process stays alive) to exercise escalation.
type stubbornProc struct{ *fakeProc }

func (s *stubbornProc) Terminate(pid int) error {
	s.terminated = append(s.terminated, pid)
	return nil // alive stays true
}
func (s *stubbornProc) Kill(pid int) error { return s.fakeProc.Kill(pid) }

func TestAspireStartRejectedStopAllowed(t *testing.T) {
	in := standaloneInst()
	in.IsAspire = true
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"dotnet", "run"}}
	proc.alive[100] = true
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": in}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetApp, ActionStart), ErrUnsupported)
	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetAll, ActionRestart), ErrUnsupported)
	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStop))
	e, _ := reg.Get("orders")
	require.True(t, e.Instance.IsAspire)
}

type fakeStarter struct {
	started [][]string
	dirs    []string
	err     error
}

func (f *fakeStarter) Start(argv []string, dir, logPath string) error {
	if f.err != nil {
		return f.err
	}
	f.started = append(f.started, argv)
	f.dirs = append(f.dirs, dir)
	return nil
}

func TestStandaloneStartAllRerunsCLICommand(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetAll:   {PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"},
		TargetApp:   {PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"},
		TargetDaprd: {PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"},
	})
	st := &fakeStarter{}
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, newFakeProc(), st)

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStart))
	require.Equal(t, [][]string{{"dapr", "run", "--app-id", "orders"}}, st.started)
	require.Equal(t, []string{"/src"}, st.dirs)
	_, ok := reg.Get("orders")
	require.False(t, ok, "whole entry dropped after start")
}

func TestStandaloneStartSingleTarget(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetApp:   {PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src", LogPath: "/tmp/app.log"},
		TargetDaprd: {PID: 200, Argv: []string{"daprd", "--app-id", "orders"}},
	})
	st := &fakeStarter{}
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, newFakeProc(), st)

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStart))
	require.Equal(t, [][]string{{"go", "run", "."}}, st.started)
	e, ok := reg.Get("orders")
	require.True(t, ok, "daprd snapshot remains")
	require.Len(t, e.Procs, 1)
}

func TestStandaloneStartWithoutSnapshotRejected(t *testing.T) {
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}},
		NewRegistry(), nil, newFakeProc(), &fakeStarter{})
	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetApp, ActionStart), ErrUnsupported)
}

func TestStandaloneRestartStopsThenStarts(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.alive[100] = true
	st := &fakeStarter{}
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, st).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionRestart))
	require.Equal(t, []int{100}, proc.terminated)
	require.Equal(t, [][]string{{"go", "run", "."}}, st.started)
}

func TestStandaloneDaprdTargetFunnelsToAll(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"}
	proc.snaps[300] = ProcSnapshot{PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"}
	proc.alive[100], proc.alive[200], proc.alive[300] = true, true, true

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetDaprd, ActionStop))
	require.Equal(t, []int{300}, proc.terminated, "daprd target must signal the CLI, like TargetAll")
	e, ok := reg.Get("orders")
	require.True(t, ok)
	require.Contains(t, e.Procs, TargetAll, "whole-instance snapshot recorded")
}

func TestAspireDaprdStopNotFunneled(t *testing.T) {
	in := standaloneInst()
	in.IsAspire = true
	proc := newFakeProc()
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}}
	proc.alive[200] = true
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": in}}, NewRegistry(), nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetDaprd, ActionStop))
	require.Equal(t, []int{200}, proc.terminated, "Aspire keeps per-PID daprd stop")
}

// Pins the TargetAll start fallback: with no CLI snapshot (e.g. the CLI was
// never captured), the halves start individually, sidecar first, and each
// started target leaves the registry.
func TestStandaloneStartAllWithoutCLISnapshotStartsHalvesInOrder(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetDaprd: {PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"},
		TargetApp:   {PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"},
	})
	st := &fakeStarter{}
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, newFakeProc(), st)

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStart))
	require.Equal(t, [][]string{{"daprd", "--app-id", "orders"}, {"go", "run", "."}}, st.started, "sidecar starts before the app")
	_, ok := reg.Get("orders")
	require.False(t, ok, "both targets dropped -> entry gone")
}

// An orphaned sidecar (no supervising CLI, app gone) supports only stop:
// there is no re-runnable command, so start/restart are rejected and a stop
// records nothing in the registry.
func TestOrphanedSidecarOnlyStopAllowed(t *testing.T) {
	in := standaloneInst()
	in.SidecarOrphaned = true
	in.CLIPID = 0
	in.AppPID = 0
	proc := newFakeProc()
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}}
	proc.alive[200] = true
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": in}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetAll, ActionStart), ErrUnsupported)
	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetDaprd, ActionRestart), ErrUnsupported)

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStop))
	require.Equal(t, []int{200}, proc.terminated, "orphan stop signals the surviving daprd")
	_, ok := reg.Get("orders")
	require.False(t, ok, "orphan stop must not create a registry entry")
}
