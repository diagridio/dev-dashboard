package lifecycle

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func inst(key, appID string) discovery.Instance {
	return discovery.Instance{AppID: appID, InstanceKey: key, Source: discovery.SourceStandalone}
}

func TestRegistryRecordGetDrop(t *testing.T) {
	r := NewRegistry()
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{
		TargetApp: {PID: 42, Argv: []string{"go", "run", "."}, Dir: "/src/orders"},
	})

	e, ok := r.Get("orders")
	require.True(t, ok)
	require.Equal(t, 42, e.Procs[TargetApp].PID)

	// second stop merges targets without losing the first snapshot
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{TargetDaprd: {PID: 43}})
	e, _ = r.Get("orders")
	require.Len(t, e.Procs, 2)

	r.DropTarget("orders", TargetApp)
	e, ok = r.Get("orders")
	require.True(t, ok)
	require.Len(t, e.Procs, 1)

	r.DropTarget("orders", TargetDaprd)
	_, ok = r.Get("orders") // dropping the last target removes the entry
	require.False(t, ok)
}

func TestRegistryGetFallsBackToAppID(t *testing.T) {
	r := NewRegistry()
	r.RecordStop(inst("orders-1", "orders"), map[Target]ProcSnapshot{TargetAll: {PID: 7}})
	_, ok := r.Get("orders")
	require.True(t, ok)
}

func TestValidTargetAndAction(t *testing.T) {
	require.True(t, ValidTarget(TargetApp))
	require.True(t, ValidTarget(TargetDaprd))
	require.True(t, ValidTarget(TargetAll))
	require.False(t, ValidTarget("cli"))
	require.True(t, ValidAction(ActionStart))
	require.True(t, ValidAction(ActionStop))
	require.True(t, ValidAction(ActionRestart))
	require.False(t, ValidAction("pause"))
}
