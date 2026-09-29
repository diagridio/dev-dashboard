//go:build unit

package statestore

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/dapr/components-contrib/state"
	"github.com/stretchr/testify/require"
)

// fakeBulk is a state.BulkStore that serves BulkGet from a map and records
// the size of every request, so tests can assert chunking. Like the native
// backends, it returns results in arbitrary order and a Key-only entry for
// a missing key.
type fakeBulk struct {
	kv     map[string][]byte
	calls  []int
	errKey string
	failAt int // 1-based BulkGet call that returns a transport error; 0 = never
}

func (f *fakeBulk) BulkGet(_ context.Context, req []state.GetRequest, _ state.BulkGetOpts) ([]state.BulkGetResponse, error) {
	f.calls = append(f.calls, len(req))
	if f.failAt == len(f.calls) {
		return nil, errors.New("transport down")
	}
	out := make([]state.BulkGetResponse, 0, len(req))
	for i := len(req) - 1; i >= 0; i-- { // reversed: order must not matter
		k := req[i].Key
		r := state.BulkGetResponse{Key: k, Data: f.kv[k]}
		if k == f.errKey {
			r.Error = "row decode failed"
		}
		out = append(out, r)
	}
	return out, nil
}
func (f *fakeBulk) BulkSet(context.Context, []state.SetRequest, state.BulkStoreOpts) error {
	return nil
}
func (f *fakeBulk) BulkDelete(context.Context, []state.DeleteRequest, state.BulkStoreOpts) error {
	return nil
}

func TestBulkGetChunkedSplitsAndMaps(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{}}
	var keys []string
	for i := 0; i < 250; i++ {
		k := fmt.Sprintf("k%03d", i)
		keys = append(keys, k)
		if i != 42 {
			f.kv[k] = []byte("v" + k)
		}
	}
	got, err := bulkGetChunked(context.Background(), f, keys, 100)
	require.NoError(t, err)
	require.Equal(t, []int{100, 100, 50}, f.calls)
	require.Len(t, got, 250, "every requested key has an entry")
	require.Equal(t, []byte("vk000"), got["k000"])
	require.Equal(t, []byte("vk249"), got["k249"])
	v, ok := got["k042"]
	require.True(t, ok, "a missing key is present in the map")
	require.Nil(t, v, "a missing key maps to nil")
}

func TestBulkGetChunkedPerKeyErrorFails(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{"a": []byte("1")}, errKey: "a"}
	_, err := bulkGetChunked(context.Background(), f, []string{"a"}, 100)
	require.ErrorContains(t, err, "row decode failed")
}

func TestBulkGetChunkedTransportErrorFails(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{}, failAt: 2}
	keys := make([]string, 150)
	for i := range keys {
		keys[i] = fmt.Sprintf("k%d", i)
	}
	_, err := bulkGetChunked(context.Background(), f, keys, 100)
	require.ErrorContains(t, err, "transport down")
}

func TestBulkGetChunkedEmpty(t *testing.T) {
	f := &fakeBulk{}
	got, err := bulkGetChunked(context.Background(), f, nil, 100)
	require.NoError(t, err)
	require.Empty(t, got)
	require.Empty(t, f.calls, "no backend round-trip for zero keys")
}
