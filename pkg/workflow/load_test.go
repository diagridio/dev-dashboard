//go:build unit

package workflow

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// countingStore wraps fakeStore and counts store round-trips so tests can
// pin how many scans and reads each operation costs. Safe for concurrent use
// as long as the underlying map is not written concurrently.
type countingStore struct {
	*fakeStore
	keys, gets, bulkGets atomic.Int32
	mu                   sync.Mutex
	bulkKeys             []string
}

func newCountingStore(f *fakeStore) *countingStore { return &countingStore{fakeStore: f} }

func (c *countingStore) Keys(ctx context.Context, p, tok string, n int) ([]string, string, error) {
	c.keys.Add(1)
	return c.fakeStore.Keys(ctx, p, tok, n)
}
func (c *countingStore) Get(ctx context.Context, k string) ([]byte, error) {
	c.gets.Add(1)
	return c.fakeStore.Get(ctx, k)
}
func (c *countingStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	c.bulkGets.Add(1)
	c.mu.Lock()
	c.bulkKeys = append(c.bulkKeys, ks...)
	c.mu.Unlock()
	return c.fakeStore.BulkGet(ctx, ks)
}

// historyReads counts history-* keys requested through BulkGet.
func (c *countingStore) historyReads() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.bulkKeys {
		if strings.Contains(k, statestore.KeyDelimiter+statestore.HistoryPrefix) {
			n++
		}
	}
	return n
}

// keysWithSuffix counts keys requested through BulkGet that end in suffix.
func (c *countingStore) keysWithSuffix(suffix string) int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.bulkKeys {
		if strings.HasSuffix(k, suffix) {
			n++
		}
	}
	return n
}

func (c *countingStore) reset() {
	c.keys.Store(0)
	c.gets.Store(0)
	c.bulkGets.Store(0)
	c.mu.Lock()
	c.bulkKeys = nil
	c.mu.Unlock()
}

// seedWorkflowProto writes an instance the way Dapr 1.16+ does: a
// BackendWorkflowStateMetadata proto whose HistoryLength matches the events.
func seedWorkflowProto(t *testing.T, f *fakeStore, ns, appID, instanceID string, events []*protos.HistoryEvent) {
	t.Helper()
	seedWorkflow(t, f, ns, appID, instanceID, "", events)
	b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: uint64(len(events)), Generation: 1})
	require.NoError(t, err)
	f.kv[statestore.InstancePrefix(ns, appID, instanceID)+statestore.SuffixMetadata] = b
}

func TestLoadProtoMetadataSkipsKeyScan(t *testing.T) {
	f := newFakeStore()
	seedWorkflowProto(t, f, "default", "order", "inst-a", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("ignored")})
	cs := newCountingStore(f)

	ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Equal(t, "OrderWorkflow", ex.Name)
	require.Len(t, ex.History, 2)
	require.EqualValues(t, 0, cs.keys.Load(), "metadata path must not scan keys")
	require.EqualValues(t, 1, cs.gets.Load(), "one Get for the metadata record")
	require.EqualValues(t, 1, cs.bulkGets.Load(), "one BulkGet for history + customStatus")
}

func TestLoadLegacyJSONMetadataSkipsKeyScan(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("x")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] =
		[]byte(`{"InboxLength":0,"HistoryLength":2,"Generation":1}`)
	cs := newCountingStore(f)

	ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Len(t, ex.History, 2)
	require.EqualValues(t, 0, cs.keys.Load())
}

func TestLoadFallsBackToScan(t *testing.T) {
	for name, meta := range map[string][]byte{
		"empty json":   []byte(`{}`),
		"garbage json": []byte(`{not json`),
		"over bound":   mustProtoMeta(t, maxHistoryEntries+1),
		"zero length":  mustProtoMeta(t, 0),
		"binary junk":  {0xff, 0xff, 0xff},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeStore()
			seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
			f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] = meta
			cs := newCountingStore(f)

			ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
			require.NoError(t, err)
			require.Equal(t, "OrderWorkflow", ex.Name)
			require.EqualValues(t, 1, cs.keys.Load(), "exactly one fallback scan")
		})
	}
}

func TestLoadMissingMetadataIsNotFound(t *testing.T) {
	cs := newCountingStore(newFakeStore())
	_, err := New(cs, "default").Get(context.Background(), "order", "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestLoadSkipsMissingConstructedHistoryKey(t *testing.T) {
	// Metadata claims 3 events but only 2 exist (history truncated by a
	// concurrent continue-as-new): decode what exists, no error.
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("x")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] = mustProtoMeta(t, 3)

	ex, err := New(f, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Len(t, ex.History, 2)
}

func TestLoadReadsCustomStatusOnMetadataPath(t *testing.T) {
	f := newFakeStore()
	seedWorkflowProto(t, f, "default", "order", "inst-a", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixCustomStatus] = []byte(`{"step":2}`)

	ex, err := New(f, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Equal(t, `{"step":2}`, ex.CustomStatus)
}

func TestListUnfilteredPageScansKeysOnce(t *testing.T) {
	f := newFakeStore()
	for _, id := range []string{"a", "b", "c"} {
		seedWorkflowProto(t, f, "default", "order", id, []*protos.HistoryEvent{startedEvent("W")})
	}
	cs := newCountingStore(f)
	res, err := New(cs, "default").List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 3)
	require.EqualValues(t, 1, cs.keys.Load(), "one metadata-key scan per unfiltered page, no per-instance scans")
}

func mustProtoMeta(t *testing.T, n uint64) []byte {
	t.Helper()
	b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: n, Generation: 1})
	require.NoError(t, err)
	return b
}
