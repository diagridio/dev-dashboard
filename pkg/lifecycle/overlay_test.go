package lifecycle

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestOverlayAppendsFullyStoppedInstances(t *testing.T) {
	reg := NewRegistry()
	stopped := standaloneInst()
	stopped.DaprdStatus, stopped.AppStatus = discovery.StatusRunning, discovery.StatusRunning
	reg.RecordStop(stopped, map[Target]ProcSnapshot{TargetAll: {PID: 300}})

	proc := newFakeProc() // nothing alive
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{}}, reg, proc)

	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	in := items[0]
	require.Equal(t, discovery.StatusStopped, in.DaprdStatus)
	require.Equal(t, discovery.StatusStopped, in.AppStatus)
	require.Equal(t, discovery.HealthUnknown, in.Health)
	require.Zero(t, in.DaprdPID)
	require.Empty(t, in.DaprdStartedAt)

	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusStopped, got.DaprdStatus)
}

func TestOverlaySynthesizeClearsStaleMetadata(t *testing.T) {
	reg := NewRegistry()
	stopped := standaloneInst()
	stopped.DaprdStatus, stopped.AppStatus = discovery.StatusRunning, discovery.StatusRunning
	stopped.Actors = []discovery.ActorType{{Type: "cart", Count: 3}}
	stopped.Subscriptions = []discovery.Subscription{{PubsubName: "pubsub", Topic: "orders"}}
	stopped.Components = []discovery.Component{{Name: "statestore", Type: "state.redis"}}
	stopped.EnabledFeatures = []string{"some-feature"}
	stopped.RuntimeVersion = "1.14.0"
	stopped.Placement = "localhost:6050"
	reg.RecordStop(stopped, map[Target]ProcSnapshot{TargetAll: {PID: 300}})

	proc := newFakeProc() // nothing alive
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{}}, reg, proc)

	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	in := items[0]
	require.Nil(t, in.Actors)
	require.Nil(t, in.Subscriptions)
	require.Nil(t, in.Components)
	require.Nil(t, in.EnabledFeatures)
	require.Empty(t, in.RuntimeVersion)
	require.Empty(t, in.Placement)
}

func TestOverlayMarksPartialAppStopOnLiveInstance(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetApp: {PID: 100}})

	live := standaloneInst() // scanner still sees daprd; stale metadata may echo AppPID 100
	live.DaprdStatus = discovery.StatusRunning
	live.AppStatus = discovery.StatusRunning

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusStopped, got.AppStatus)
	require.Zero(t, got.AppPID)
	require.Equal(t, discovery.StatusRunning, got.DaprdStatus)
}

func TestOverlayDropsEntryWhenAppExternallyRestarted(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetApp: {PID: 100}})

	live := standaloneInst()
	live.AppPID = 555 // new pid: restarted outside the dashboard
	live.AppStatus = discovery.StatusRunning

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusRunning, got.AppStatus)
	_, ok := reg.Get("orders")
	require.False(t, ok, "stale entry dropped")
}

func TestOverlayDropsDaprdEntryWhenDaprdRestarted(t *testing.T) {
	// The snapshot captured daprd under PID 999; the live instance runs it
	// under 200 — the snapshot is stale and must go.
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetDaprd: {PID: 999}, TargetAll: {PID: 888}})

	live := standaloneInst() // DaprdPID 200, CLIPID 300
	live.DaprdStatus = discovery.StatusRunning
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	_, err := svc.List(context.Background())
	require.NoError(t, err)
	_, ok := reg.Get("orders")
	require.False(t, ok)
}

func TestOverlayKeepsCascadeInsuranceSnapshotsWhilePIDsMatch(t *testing.T) {
	// An app-only stop captures daprd + CLI while both still run (cascade
	// insurance). The overlay must not erase them on the next poll: they
	// still describe the live processes (same PIDs).
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetApp:   {PID: 100},
		TargetDaprd: {PID: 200},
		TargetAll:   {PID: 300},
	})

	live := standaloneInst() // AppPID 100, DaprdPID 200, CLIPID 300
	live.DaprdStatus = discovery.StatusRunning
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	_, err := svc.List(context.Background())
	require.NoError(t, err)
	e, ok := reg.Get("orders")
	require.True(t, ok, "insurance snapshots survive while PIDs match")
	require.Len(t, e.Procs, 3)
}
