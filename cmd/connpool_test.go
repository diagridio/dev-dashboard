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
func (s poolStore) Get(context.Context, string) ([]byte, error)                    { return nil, nil }
func (s poolStore) BulkGet(context.Context, []string) (map[string][]byte, error)   { return nil, nil }
func (s poolStore) Delete(context.Context, string) error                           { return nil }
func (s poolStore) Set(context.Context, string, []byte) error                      { return nil }
func (s poolStore) Close() error                                                   { atomic.AddInt32(s.closes, 1); return nil }

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
