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

// Regression test for shallow clone bug: ensure mutating Argv on a returned Entry
// does not corrupt the registry's stored snapshot.
func TestCloneIsolation(t *testing.T) {
	r := NewRegistry()
	originalArgv := []string{"go", "run", "."}
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{
		TargetApp: {PID: 42, Argv: originalArgv, Dir: "/src/orders"},
	})

	// Get the entry and mutate its Argv
	e, ok := r.Get("orders")
	require.True(t, ok)
	require.Equal(t, "go", e.Procs[TargetApp].Argv[0])

	// Mutate the returned Argv
	e.Procs[TargetApp].Argv[0] = "python"

	// Get the entry again and verify the stored snapshot is unchanged
	e2, _ := r.Get("orders")
	require.Equal(t, "go", e2.Procs[TargetApp].Argv[0], "stored snapshot should not be corrupted by mutation")
}

// Test that List() returns entries sorted by InstanceKey.
func TestListSorted(t *testing.T) {
	r := NewRegistry()
	// Record entries out of order
	r.RecordStop(inst("zebra", "zebra"), map[Target]ProcSnapshot{TargetApp: {PID: 1}})
	r.RecordStop(inst("apple", "apple"), map[Target]ProcSnapshot{TargetApp: {PID: 2}})
	r.RecordStop(inst("mango", "mango"), map[Target]ProcSnapshot{TargetApp: {PID: 3}})

	entries := r.List()
	require.Len(t, entries, 3)
	require.Equal(t, "apple", entries[0].Instance.InstanceKey)
	require.Equal(t, "mango", entries[1].Instance.InstanceKey)
	require.Equal(t, "zebra", entries[2].Instance.InstanceKey)
}

// Test that Drop() removes the whole entry.
func TestDrop(t *testing.T) {
	r := NewRegistry()
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{
		TargetApp:   {PID: 42},
		TargetDaprd: {PID: 43},
	})

	// Verify entry exists
	_, ok := r.Get("orders")
	require.True(t, ok)

	// Drop the entry
	r.Drop("orders")

	// Verify entry is gone
	_, ok = r.Get("orders")
	require.False(t, ok)

	// Verify List is empty
	require.Len(t, r.List(), 0)
}
