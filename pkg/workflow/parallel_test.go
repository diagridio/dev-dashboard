//go:build unit

package workflow

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
)

// slowStore delays every BulkGet and records the peak number in flight.
type slowStore struct {
	*countingStore
	inflight, peak atomic.Int32
}

func (s *slowStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	n := s.inflight.Add(1)
	for {
		p := s.peak.Load()
		if n <= p || s.peak.CompareAndSwap(p, n) {
			break
		}
	}
	time.Sleep(5 * time.Millisecond)
	defer s.inflight.Add(-1)
	return s.countingStore.BulkGet(ctx, ks)
}

func seedN(t *testing.T, f *fakeStore, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		seedWorkflowProto(t, f, "default", "order", fmt.Sprintf("inst-%03d", i), []*protos.HistoryEvent{startedEvent(fmt.Sprintf("W%d", i))})
	}
}

func TestStatsLoadsInParallelWithinBound(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 40)
	s := &slowStore{countingStore: newCountingStore(f)}

	res, err := New(s, "default").Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 40, res.Total)
	require.Greater(t, s.peak.Load(), int32(1), "instances load concurrently")
	require.LessOrEqual(t, s.peak.Load(), int32(instanceLoadConcurrency))
}

func TestListParallelResultsMatchSequentialOrder(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 30)
	s := &slowStore{countingStore: newCountingStore(f)}

	res, err := New(s, "default").List(context.Background(), ListQuery{IncludeChildren: true, PageSize: 50})
	require.NoError(t, err)
	require.Len(t, res.Items, 30)
	seen := map[string]bool{}
	for _, it := range res.Items {
		require.False(t, seen[it.InstanceID], "no duplicates")
		seen[it.InstanceID] = true
	}
}

// cancellingStore cancels the request context on its first BulkGet.
type cancellingStore struct {
	*countingStore
	cancel context.CancelFunc
}

func (c *cancellingStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	c.cancel()
	return c.countingStore.BulkGet(ctx, ks)
}

func TestStatsStopsOnCancelledContext(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 50)
	ctx, cancel := context.WithCancel(context.Background())
	s := &cancellingStore{countingStore: newCountingStore(f), cancel: cancel}

	_, err := New(s, "default").Stats(ctx, ListQuery{IncludeChildren: true})
	require.ErrorIs(t, err, context.Canceled)
	require.LessOrEqual(t, s.bulkGets.Load(), int32(instanceLoadConcurrency+1),
		"no new loads are scheduled after cancellation")
}

func TestListReturnsErrorOnCancelledContext(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 50)
	ctx, cancel := context.WithCancel(context.Background())
	s := &cancellingStore{countingStore: newCountingStore(f), cancel: cancel}

	res, err := New(s, "default").List(ctx, ListQuery{IncludeChildren: true, PageSize: 50})
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, res.Items, "never a silently partial page")
}
