//go:build unit

package workflow

import (
	"context"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestSummaryCacheGetPutMatchesMetaBytes(t *testing.T) {
	c := newSummaryCache(10)
	k := cacheKey("default", "order", "a")
	c.put(k, "default", "order", []byte("m1"), ExecutionSummary{InstanceID: "a", Name: "W"})

	got, ok := c.get(k, []byte("m1"))
	require.True(t, ok)
	require.Equal(t, "W", got.Name)

	_, ok = c.get(k, []byte("m2"))
	require.False(t, ok, "changed metadata bytes are a miss")
	_, ok = c.get(k, nil)
	require.False(t, ok, "nil metadata is always a miss")
}

func TestSummaryCacheClearsOnOverflow(t *testing.T) {
	c := newSummaryCache(2)
	c.put(cacheKey("default", "o", "a"), "default", "o", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "o", "b"), "default", "o", []byte("m"), ExecutionSummary{})
	require.Equal(t, 2, c.size())
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m"), ExecutionSummary{})
	require.Equal(t, 1, c.size(), "overflow clears, then stores the new entry")
	// Overwriting an existing key at the cap doesn't clear.
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m2"), ExecutionSummary{})
	require.Equal(t, 1, c.size())
}

func TestSummaryCachePruneScopesByNamespaceAndApp(t *testing.T) {
	c := newSummaryCache(10)
	c.put(cacheKey("default", "order", "a"), "default", "order", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "order", "b"), "default", "order", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "billing", "c"), "default", "billing", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("prod", "order", "d"), "prod", "order", []byte("m"), ExecutionSummary{})

	// App-scoped prune only touches that app in that namespace.
	c.prune("default", "order", map[string]struct{}{cacheKey("default", "order", "a"): {}})
	require.Equal(t, 3, c.size())
	_, ok := c.get(cacheKey("default", "order", "b"), []byte("m"))
	require.False(t, ok)

	// All-apps prune touches every app in that namespace, never other namespaces.
	c.prune("default", "", map[string]struct{}{})
	require.Equal(t, 1, c.size())
	_, ok = c.get(cacheKey("prod", "order", "d"), []byte("m"))
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
	require.EqualValues(t, 1, cs.bulkGets.Load(), "one BulkGet for all metadata values")
	require.Zero(t, cs.historyReads(), "no history is re-read for unchanged instances")
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
	require.Equal(t, 2, cs.historyReads(), "only the changed instance's 2 history keys are read")
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
