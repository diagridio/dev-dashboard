//go:build unit

package workflow

import (
	"context"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
)

// fakeBase is a canned store-backed Service.
type fakeBase struct {
	items []ExecutionSummary
	err   error
}

func (f fakeBase) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{Items: f.items, NextToken: "tok"}, f.err
}
func (f fakeBase) Stats(_ context.Context, q ListQuery) (StatsResult, error) {
	if f.err != nil {
		return StatsResult{}, f.err
	}
	res := StatsResult{Counts: map[Status]int{}}
	for _, it := range f.items {
		if q.AppID != "" && it.AppID != q.AppID {
			continue
		}
		res.Counts[it.Status]++
		res.Total++
	}
	return res, nil
}
func (f fakeBase) Get(_ context.Context, appID, id string) (Execution, error) {
	if f.err != nil {
		return Execution{}, f.err
	}
	for _, it := range f.items {
		if it.AppID == appID && it.InstanceID == id {
			return Execution{ExecutionSummary: it}, nil
		}
	}
	return Execution{}, ErrNotFound
}
func (f fakeBase) AppIDs(context.Context) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	seen := map[string]bool{}
	var ids []string
	for _, it := range f.items {
		if !seen[it.AppID] {
			seen[it.AppID] = true
			ids = append(ids, it.AppID)
		}
	}
	return ids, nil
}

// sidecarWith builds a *SidecarService over a fakeHub (Task 6 helpers).
func sidecarWith(t *testing.T, appID string, hub *fakeHub) *SidecarService {
	t.Helper()
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	return pool.Service(fixedEndpoints(appID, addr))
}

func emptySidecar(t *testing.T) *SidecarService {
	t.Helper()
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	return pool.Service(func(context.Context) []SidecarEndpoint { return nil })
}

func TestComposite_MergesAndSidecarWinsCollisions(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{
		{AppID: "store-app", InstanceID: "s1", Name: "StoreWF", Status: StatusCompleted, CreatedAt: &now},
		{AppID: "tc-app", InstanceID: "dup", Name: "Stale", Status: StatusFailed, CreatedAt: &now},
	}}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"dup"}},
		states: map[string]*protos.WorkflowState{"dup": wfState("dup", "LiveWF", protos.OrchestrationStatus_ORCHESTRATION_STATUS_RUNNING, "")},
	})
	svc := NewComposite(base, sc)

	res, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2) // s1 + dup (sidecar copy), stale store dup dropped
	byID := map[string]ExecutionSummary{}
	for _, it := range res.Items {
		byID[it.InstanceID] = it
	}
	require.Equal(t, "LiveWF", byID["dup"].Name) // sidecar won
	require.Equal(t, "tok", res.NextToken)       // base cursor preserved

	// App-scoped queries route to the owner.
	res, err = svc.List(context.Background(), ListQuery{AppID: "tc-app", IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "LiveWF", res.Items[0].Name)

	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"store-app", "tc-app"}, ids)
}

func TestComposite_CursorPageExcludesSidecarItems(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{
		{AppID: "store-app", InstanceID: "s1", Name: "StoreWF", Status: StatusCompleted, CreatedAt: &now},
	}}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "LiveWF", protos.OrchestrationStatus_ORCHESTRATION_STATUS_RUNNING, "")},
	})
	svc := NewComposite(base, sc)

	// First page (empty PageToken): sidecar items are merged in, as before.
	res, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)

	// Cursor page (non-empty PageToken): sidecar items must not be
	// re-merged, or every page after the first would repeat them.
	res, err = svc.List(context.Background(), ListQuery{IncludeChildren: true, PageToken: "tok"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "s1", res.Items[0].InstanceID)
	require.Equal(t, "tok", res.NextToken)
}

func TestComposite_NoStoreSuppressedWhenSidecarHasEndpoints(t *testing.T) {
	base := fakeBase{err: ErrNoStore}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
	})
	svc := NewComposite(base, sc)

	res, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)

	stats, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 1, stats.Total)
}

func TestComposite_NoStorePropagatedWithoutEndpoints(t *testing.T) {
	base := fakeBase{err: ErrNoStore}
	svc := NewComposite(base, emptySidecar(t))

	_, err := svc.List(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.Stats(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.AppIDs(context.Background())
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.Get(context.Background(), "any", "x")
	require.ErrorIs(t, err, ErrNoStore)
}

func TestComposite_GetRoutesToOwner(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{{AppID: "store-app", InstanceID: "s1", Status: StatusCompleted, CreatedAt: &now}}}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
		history: map[string][]*protos.HistoryEvent{"w1": {{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
				Name: "W", WorkflowInstance: &protos.WorkflowInstance{InstanceId: "w1"},
			}},
		}}},
	})
	svc := NewComposite(base, sc)

	ex, err := svc.Get(context.Background(), "store-app", "s1")
	require.NoError(t, err)
	require.Equal(t, "s1", ex.InstanceID)

	ex, err = svc.Get(context.Background(), "tc-app", "w1")
	require.NoError(t, err)
	require.Equal(t, "W", ex.Name)
}

// A sidecar-owned app whose sidecar cannot answer (here: a pre-1.17 daprd)
// falls back to the store for app-scoped reads when the store is usable, so a
// mounted store keeps per-app views working (compose container posture, spec §8).
func TestComposite_OwnedAppFallsBackToStoreWhenSidecarFails(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{{AppID: "old-app", InstanceID: "s1", Status: StatusCompleted, CreatedAt: &now}}}
	sc := sidecarWith(t, "old-app", &fakeHub{unimplemented: true, pages: [][]string{{}}})
	svc := NewComposite(base, sc)
	ctx := context.Background()

	lr, err := svc.List(ctx, ListQuery{AppID: "old-app"})
	require.NoError(t, err)
	require.Len(t, lr.Items, 1)
	require.Equal(t, "s1", lr.Items[0].InstanceID)

	st, err := svc.Stats(ctx, ListQuery{AppID: "old-app"})
	require.NoError(t, err)
	require.Equal(t, 1, st.Total)

	ex, err := svc.Get(ctx, "old-app", "s1")
	require.NoError(t, err)
	require.Equal(t, "s1", ex.InstanceID)
}

// Without a usable store the sidecar outcome stands: app-scoped lists stay
// empty (a failing app is skipped, never errors the page) and Get surfaces the
// sidecar error.
func TestComposite_OwnedAppSidecarFailureWithoutStore(t *testing.T) {
	base := fakeBase{err: ErrNoStore}
	sc := sidecarWith(t, "old-app", &fakeHub{unimplemented: true, pages: [][]string{{}}})
	svc := NewComposite(base, sc)
	ctx := context.Background()

	lr, err := svc.List(ctx, ListQuery{AppID: "old-app"})
	require.NoError(t, err)
	require.Empty(t, lr.Items)

	st, err := svc.Stats(ctx, ListQuery{AppID: "old-app"})
	require.NoError(t, err)
	require.Zero(t, st.Total)

	_, err = svc.Get(ctx, "old-app", "s1")
	require.ErrorIs(t, err, ErrSidecarUnsupported)
}

// With a store mounted, a sidecar-owned app's workflows are reported by both
// the sidecar and the store (the store is the sidecar's own actor store).
// All-apps stats must count each such workflow once, matching the merged list.
func TestComposite_StatsCountsSidecarAppsOnce(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{
		{AppID: "wfapp", InstanceID: "w1", Status: StatusCompleted, CreatedAt: &now},
		{AppID: "store-app", InstanceID: "s1", Status: StatusRunning, CreatedAt: &now},
	}}
	sc := sidecarWith(t, "wfapp", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
	})
	svc := NewComposite(base, sc)
	ctx := context.Background()

	lr, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, lr.Items, 2)

	st, err := svc.Stats(ctx, ListQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, st.Total, "stats must match the merged list")
	require.Equal(t, 1, st.Counts[StatusCompleted])
	require.Equal(t, 1, st.Counts[StatusRunning])
}

// An owned app whose sidecar can't answer keeps its store counts.
func TestComposite_StatsKeepsStoreCountsForFailingSidecar(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{
		{AppID: "old-app", InstanceID: "s1", Status: StatusCompleted, CreatedAt: &now},
	}}
	sc := sidecarWith(t, "old-app", &fakeHub{unimplemented: true, pages: [][]string{{}}})
	st, err := NewComposite(base, sc).Stats(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Equal(t, 1, st.Total)
}
