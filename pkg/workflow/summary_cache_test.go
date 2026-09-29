//go:build unit

package workflow

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func TestSummaryCacheGetPutMatchesMetaBytes(t *testing.T) {
	c := newSummaryCache(10)
	k := cacheKey("default", "order", "a")
	c.put(k, "default", "order", []byte("m1"), []byte("f1"), ExecutionSummary{InstanceID: "a", Name: "W"})

	got, ok := c.get(k, []byte("m1"), []byte("f1"))
	require.True(t, ok)
	require.Equal(t, "W", got.Name)

	_, ok = c.get(k, []byte("m2"), []byte("f1"))
	require.False(t, ok, "changed metadata bytes are a miss")
	_, ok = c.get(k, nil, []byte("f1"))
	require.False(t, ok, "nil metadata is always a miss")
}

func TestSummaryCacheMissesOnChangedFirstEntry(t *testing.T) {
	c := newSummaryCache(10)
	k := cacheKey("default", "order", "a")
	c.put(k, "default", "order", []byte("m1"), []byte("f1"), ExecutionSummary{InstanceID: "a"})

	_, ok := c.get(k, []byte("m1"), []byte("f2"))
	require.False(t, ok, "same metadata, different first entry (purged + re-created) is a miss")
	_, ok = c.get(k, []byte("m1"), nil)
	require.False(t, ok, "a now-missing first entry is a miss")
}

func TestSummaryCacheClearsOnOverflow(t *testing.T) {
	c := newSummaryCache(2)
	c.put(cacheKey("default", "o", "a"), "default", "o", []byte("m"), []byte("f"), ExecutionSummary{})
	c.put(cacheKey("default", "o", "b"), "default", "o", []byte("m"), []byte("f"), ExecutionSummary{})
	require.Equal(t, 2, c.size())
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m"), []byte("f"), ExecutionSummary{})
	require.Equal(t, 1, c.size(), "overflow clears, then stores the new entry")
	// Overwriting an existing key at the cap doesn't clear.
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m2"), []byte("f"), ExecutionSummary{})
	require.Equal(t, 1, c.size())
}

func TestSummaryCachePruneScopesByNamespaceAndApp(t *testing.T) {
	c := newSummaryCache(10)
	c.put(cacheKey("default", "order", "a"), "default", "order", []byte("m"), []byte("f"), ExecutionSummary{})
	c.put(cacheKey("default", "order", "b"), "default", "order", []byte("m"), []byte("f"), ExecutionSummary{})
	c.put(cacheKey("default", "billing", "c"), "default", "billing", []byte("m"), []byte("f"), ExecutionSummary{})
	c.put(cacheKey("prod", "order", "d"), "prod", "order", []byte("m"), []byte("f"), ExecutionSummary{})

	// App-scoped prune only touches that app in that namespace.
	c.prune("default", "order", map[string]struct{}{cacheKey("default", "order", "a"): {}})
	require.Equal(t, 3, c.size())
	_, ok := c.get(cacheKey("default", "order", "b"), []byte("m"), []byte("f"))
	require.False(t, ok)

	// All-apps prune touches every app in that namespace, never other namespaces.
	c.prune("default", "", map[string]struct{}{})
	require.Equal(t, 1, c.size())
	_, ok = c.get(cacheKey("prod", "order", "d"), []byte("m"), []byte("f"))
	require.True(t, ok)
}

func TestStatsSecondCallReadsOnlyMetadata(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 20)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	q := ListQuery{IncludeChildren: true}

	first, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 20, first.Total)

	cs.reset()
	second, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, first, second)
	require.EqualValues(t, 1, cs.keys.Load(), "one metadata-key scan")
	require.EqualValues(t, 1, cs.bulkGets.Load(), "one BulkGet for all metadata values and first entries")
	require.Equal(t, 20, cs.keysWithSuffix(statestore.HistoryKey(0)), "one first-entry probe per instance")
	require.Equal(t, 20, cs.historyReads(), "no other history is re-read for unchanged instances")
}

func TestStatsReloadsOnlyChangedInstance(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 5)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	q := ListQuery{IncludeChildren: true}
	_, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)

	// inst-002 gains a second event: Dapr rewrites metadata with the new length.
	seedWorkflowProto(t, f, "default", "order", "inst-002", []*protos.HistoryEvent{startedEvent("W2"), startedEvent("x")})

	cs.reset()
	_, err = svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 5+2, cs.historyReads(),
		"one first-entry probe per instance, plus only the changed instance's 2 history keys")
}

func TestStatsPrunesRemovedInstancesListDoesNot(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 3)
	svc := New(f, "default")
	inner := svc.(*service)
	q := ListQuery{IncludeChildren: true}
	_, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 3, inner.cache.size())

	// Purge inst-001.
	prefix := statestore.InstancePrefix("default", "order", "inst-001")
	for k := range f.kv {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(f.kv, k)
		}
	}

	res, err := svc.List(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, res.Items, 2, "a purged instance is not listed")
	require.Equal(t, 3, inner.cache.size(), "List never prunes")

	st, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 2, st.Total)
	require.Equal(t, 2, inner.cache.size(), "Stats prunes entries whose keys are gone")
}

func TestScanFallbackResultsAreNotCached(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("W")}) // "{}" metadata
	svc := New(f, "default")
	_, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Zero(t, svc.(*service).cache.size())
}

func TestGetBypassesCache(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 1)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	_, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)

	cs.reset()
	ex, err := svc.Get(context.Background(), "order", "inst-000")
	require.NoError(t, err)
	require.Len(t, ex.History, 1)
	require.Equal(t, 1, cs.historyReads(), "detail always reads history")
}

// terminalEvents returns ExecutionStarted + ExecutionCompleted with status,
// both stamped at ts.
func terminalEvents(name string, ts time.Time, status protos.OrchestrationStatus) []*protos.HistoryEvent {
	started := startedEvent(name)
	started.Timestamp = timestamppb.New(ts)
	return []*protos.HistoryEvent{started, {
		EventId:   1,
		Timestamp: timestamppb.New(ts),
		EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: status,
		}},
	}}
}

func TestStatsDetectsPurgedAndRecreatedInstance(t *testing.T) {
	f := newFakeStore()
	t1 := time.Date(2026, 9, 1, 10, 0, 0, 0, time.UTC)
	seedWorkflowProto(t, f, "default", "order", "inst-a",
		terminalEvents("W", t1, protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED))
	svc := New(f, "default")
	q := ListQuery{IncludeChildren: true}

	st, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 1, st.Counts[StatusFailed])

	// Purge, then re-create under the same ID: same metadata bytes
	// (HistoryLength 2, Generation 1), different first event.
	prefix := statestore.InstancePrefix("default", "order", "inst-a")
	metaBefore := f.kv[prefix+statestore.SuffixMetadata]
	for k := range f.kv {
		if strings.HasPrefix(k, prefix) {
			delete(f.kv, k)
		}
	}
	t2 := t1.Add(time.Hour)
	seedWorkflowProto(t, f, "default", "order", "inst-a",
		terminalEvents("W", t2, protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED))
	require.Equal(t, metaBefore, f.kv[prefix+statestore.SuffixMetadata], "re-created metadata is byte-identical")

	st, err = svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 1, st.Counts[StatusCompleted])
	require.Zero(t, st.Counts[StatusFailed])

	res, err := svc.List(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, StatusCompleted, res.Items[0].Status)
}
