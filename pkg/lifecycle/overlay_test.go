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

func TestOverlayDropsDaprdEntryWhenKeyLiveAgain(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetDaprd: {PID: 200}})

	live := standaloneInst()
	live.DaprdStatus = discovery.StatusRunning
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	_, err := svc.List(context.Background())
	require.NoError(t, err)
	_, ok := reg.Get("orders")
	require.False(t, ok)
}
