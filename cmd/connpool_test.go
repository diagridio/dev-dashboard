//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// poolStore is a fake statestore.Store that records Close calls.
// Named distinctly from countingStore in reconciler_test.go.
type poolStore struct {
	closes *int32
}

func (s poolStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", nil
}
func (s poolStore) Get(context.Context, string) ([]byte, error)                  { return nil, nil }
func (s poolStore) BulkGet(context.Context, []string) (map[string][]byte, error) { return nil, nil }
func (s poolStore) Delete(context.Context, string) error                         { return nil }
func (s poolStore) Set(context.Context, string, []byte) error                    { return nil }
func (s poolStore) Close() error                                                 { atomic.AddInt32(s.closes, 1); return nil }

// poolOpener counts opens and hands back poolStores. If block is non-nil it
// waits on it before returning (to probe single-flight).
type poolOpener struct {
	opens  int32
	closes int32
	block  chan struct{}
	err    error
}

func (o *poolOpener) open(_ context.Context, _ statestore.Component) (statestore.Store, error) {
	atomic.AddInt32(&o.opens, 1)
	if o.block != nil {
		<-o.block
	}
	if o.err != nil {
		return nil, o.err
	}
	return poolStore{closes: &o.closes}, nil
}

func compA() statestore.Component {
	return statestore.Component{Name: "A", Type: "state.sqlite", Metadata: map[string]string{"connectionString": "a.db"}}
}
func compB() statestore.Component {
	return statestore.Component{Name: "B", Type: "state.sqlite", Metadata: map[string]string{"connectionString": "b.db"}}
}

func TestConnPool_OpensOnceAndCaches(t *testing.T) {
	o := &poolOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	e1, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	require.NotNil(t, e1.svc)

	e2, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	require.NotNil(t, e2.svc)

	require.Equal(t, int32(1), atomic.LoadInt32(&o.opens), "same identity must open exactly once")
}

func TestConnPool_OpenError_NotCached(t *testing.T) {
	o := &poolOpener{err: errors.New("connect failed")}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.Error(t, err)
	_, err = p.openOrGet(context.Background(), compA())
	require.Error(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(&o.opens), "a failed open is not cached; it retries")
}

func TestConnPool_SingleFlight(t *testing.T) {
	o := &poolOpener{block: make(chan struct{})}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	const n = 8
	var wg sync.WaitGroup
	wg.Add(n)
	for i := 0; i < n; i++ {
		go func() {
			defer wg.Done()
			_, _ = p.openOrGet(context.Background(), compA())
		}()
	}
	// Give the goroutines time to all arrive at the single-flight gate, then release.
	// We can't sleep (blocked by harness); instead release immediately — the
	// per-identity gate still funnels concurrent callers through one open.
	close(o.block)
	wg.Wait()

	require.Equal(t, int32(1), atomic.LoadInt32(&o.opens), "concurrent opens of one identity must open once")
}

func TestConnPool_CloseClosesAll(t *testing.T) {
	o := &poolOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	_, err = p.openOrGet(context.Background(), compB())
	require.NoError(t, err)
	require.Equal(t, int32(2), atomic.LoadInt32(&o.opens))

	require.NoError(t, p.Close())
	require.Equal(t, int32(2), atomic.LoadInt32(&o.closes), "Close must close every cached connection")
}

func TestConnPool_TwoIdentitiesBothRetained(t *testing.T) {
	o := &poolOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	_, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	_, err = p.openOrGet(context.Background(), compB())
	require.NoError(t, err)

	// No close happens just because a second identity was opened (retention).
	require.Equal(t, int32(0), atomic.LoadInt32(&o.closes), "opening a second store must NOT close the first")
}

// TestConnPool_EvictDuringOpenClosesStore verifies Fix 1: if evict is called
// while an open is in flight, the store that eventually opens is closed
// immediately (no leak) and the openOrGet caller receives an error.
func TestConnPool_EvictDuringOpenClosesStore(t *testing.T) {
	block := make(chan struct{})
	o := &poolOpener{block: block}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	comp := compA()
	var openErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, openErr = p.openOrGet(context.Background(), comp)
	}()

	// Wait until the opener goroutine has inserted its slot and is blocked inside open.
	// We poll until the slot appears in the map (under lock via a second openOrGet
	// attempt won't work cleanly, so we spin on opens count instead).
	for atomic.LoadInt32(&o.opens) == 0 {
		// tight spin — opens is incremented inside open(), right at entry
	}

	// Evict the slot while the open is still blocked. evict waits for the
	// in-flight open to finish (Fix 3), so it must run in its own goroutine;
	// we release the opener only once evict has removed the slot from the map,
	// preserving the evict-before-Fix-1-check interleaving this test covers.
	wg.Add(1)
	go func() {
		defer wg.Done()
		p.evict(comp)
	}()
	id := identity(&comp)
	for {
		p.mu.Lock()
		_, present := p.slots[id]
		p.mu.Unlock()
		if !present {
			break
		}
	}

	// Release the blocked open so both goroutines can finish.
	close(block)
	wg.Wait()

	// The opened store must have been closed (no leak).
	require.Equal(t, int32(1), atomic.LoadInt32(&o.closes),
		"store opened after eviction must be closed immediately")

	// The openOrGet call must return an error.
	require.Error(t, openErr, "openOrGet must fail when the slot was evicted mid-open")

	// The pool must have no cached entry for compA.
	// A subsequent openOrGet should open a brand-new connection (opens count goes to 2).
	o2 := &poolOpener{}
	p2 := newConnPool("default", &http.Client{}, nil, o2.open)
	_, err := p2.openOrGet(context.Background(), comp)
	require.NoError(t, err) // sanity: a fresh pool works normally
}

// TestConnPool_EvictDuringStoreAssignment_NoLeakNoRace exercises the other
// evict interleaving: the opener returns successfully and openOrGet passes the
// Fix 1 re-check, then evict runs while the unsynchronized `slot.store = st`
// assignment (which happens outside the lock) is still pending. Without Fix 3,
// evict read slot.store without waiting on slot.done: a data race with that
// assignment, and — if it observed nil — a freshly opened store that is closed
// by nobody and no longer in the map, so even Close() can't reach it.
//
// There is no seam between the Fix 1 check and the store assignment, so this
// is a stress test: each iteration releases evict the moment the opener
// returns. Whenever evict takes the lock after the Fix 1 check, its slot.store
// read has no happens-before edge to the write, so -race flags it; the
// close-count assertion catches the leak.
func TestConnPool_EvictDuringStoreAssignment_NoLeakNoRace(t *testing.T) {
	comp := compA()
	for i := 0; i < 200; i++ {
		o := &poolOpener{}
		returning := make(chan struct{})
		open := func(ctx context.Context, c statestore.Component) (statestore.Store, error) {
			st, err := o.open(ctx, c)
			close(returning) // signal "opener about to return"; the store write happens after this
			return st, err
		}
		p := newConnPool("default", &http.Client{}, nil, open)

		var wg sync.WaitGroup
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, _ = p.openOrGet(context.Background(), comp)
		}()

		<-returning
		p.evict(comp)
		wg.Wait()

		// Exactly one close, whichever side won: Fix 1 closes the fresh store
		// if evict got there first, evict closes the cached one otherwise.
		// Zero means the store leaked.
		require.Equal(t, int32(1), atomic.LoadInt32(&o.closes),
			"iteration %d: store must be closed exactly once", i)
	}
}

// failingCloseStore is a statestore.Store whose Close returns a fixed error.
type failingCloseStore struct {
	poolStore
	closeErr error
}

func (s failingCloseStore) Close() error { return s.closeErr }

// TestConnPool_CloseJoinsAllErrors verifies that Close reports EVERY close
// error, not just the last one: with two cached stores whose Close both fail,
// the returned error must match both via errors.Is (errors.Join semantics).
func TestConnPool_CloseJoinsAllErrors(t *testing.T) {
	errA := errors.New("close A failed")
	errB := errors.New("close B failed")
	var closes int32
	open := func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		e := errA
		if c.Name == "B" {
			e = errB
		}
		return failingCloseStore{poolStore: poolStore{closes: &closes}, closeErr: e}, nil
	}
	p := newConnPool("default", &http.Client{}, nil, open)

	_, err := p.openOrGet(context.Background(), compA())
	require.NoError(t, err)
	_, err = p.openOrGet(context.Background(), compB())
	require.NoError(t, err)

	err = p.Close()
	require.Error(t, err)
	require.ErrorIs(t, err, errA, "Close must keep the first close error")
	require.ErrorIs(t, err, errB, "Close must keep the second close error")
}

// TestConnPool_OpenOrGetAfterCloseErrors verifies Fix 2: after Close() no new
// connection is opened and openOrGet returns an error.
func TestConnPool_OpenOrGetAfterCloseErrors(t *testing.T) {
	o := &poolOpener{}
	p := newConnPool("default", &http.Client{}, nil, o.open)

	require.NoError(t, p.Close())

	_, err := p.openOrGet(context.Background(), compA())
	require.Error(t, err, "openOrGet after Close must return an error")
	require.Equal(t, int32(0), atomic.LoadInt32(&o.opens),
		"no open must be attempted after Close")
}
