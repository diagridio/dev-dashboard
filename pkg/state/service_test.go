//go:build unit

package state

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// fakeStore is an in-memory statestore.Store + RecordReader for unit tests.
// It translates the LIKE pattern to a regexp the same way the real backends
// translate it to their native matcher, including backslash escapes, so
// pattern-construction bugs surface here.
type fakeStore struct {
	kv map[string][]byte
	// etags is optional per-key etag data.
	etags map[string]string
	// recordCalls counts Records invocations, to assert one bulk read per List.
	recordCalls int
	// keyCalls counts Keys invocations, to assert loop-fill behavior.
	keyCalls int
	// pages, when non-nil, makes Keys return cursor pages of this size.
	pageLimit int
	// patterns records every pattern Keys was called with.
	patterns []string
	// deleteErr, when set for a key, makes Delete fail for it.
	deleteErr map[string]error
	// setErr, when non-nil, makes every Set fail.
	setErr error
}

func newFakeStore() *fakeStore {
	return &fakeStore{kv: map[string][]byte{}, etags: map[string]string{}, deleteErr: map[string]error{}}
}

func (f *fakeStore) set(key, value string) { f.kv[key] = []byte(value) }

// likeToRegexp mirrors the backends' LIKE translation: % is any run, _ is any
// single character, and a backslash escapes the next character.
func likeToRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	escaped := false
	for _, r := range pattern {
		switch {
		case escaped:
			b.WriteString(regexp.QuoteMeta(string(r)))
			escaped = false
		case r == '\\':
			escaped = true
		case r == '%':
			b.WriteString("(?s).*")
		case r == '_':
			b.WriteString("(?s).")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

func (f *fakeStore) Keys(_ context.Context, pattern, token string, pageSize int) ([]string, string, error) {
	f.keyCalls++
	f.patterns = append(f.patterns, pattern)
	re := likeToRegexp(pattern)
	var all []string
	for k := range f.kv {
		if re.MatchString(k) {
			all = append(all, k)
		}
	}
	sort.Strings(all)
	// Cursor paging: the token is the last key of the previous page.
	if token != "" {
		i := sort.SearchStrings(all, token)
		if i < len(all) && all[i] == token {
			i++
		}
		all = all[i:]
	}
	limit := f.pageLimit
	if limit <= 0 {
		limit = pageSize
	}
	if limit > 0 && len(all) > limit {
		return all[:limit], all[limit-1], nil
	}
	return all, "", nil
}

func (f *fakeStore) Get(_ context.Context, key string) ([]byte, error) { return f.kv[key], nil }

func (f *fakeStore) BulkGet(_ context.Context, keys []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	for _, k := range keys {
		out[k] = f.kv[k]
	}
	return out, nil
}

func (f *fakeStore) Records(_ context.Context, keys []string) ([]statestore.Record, error) {
	f.recordCalls++
	out := make([]statestore.Record, 0, len(keys))
	for _, k := range keys {
		v, ok := f.kv[k]
		if !ok {
			continue // missing keys are omitted, like the real backends
		}
		out = append(out, statestore.Record{Key: k, Value: v, ETag: f.etags[k]})
	}
	return out, nil
}

func (f *fakeStore) Delete(_ context.Context, key string) error {
	if err, ok := f.deleteErr[key]; ok {
		return err
	}
	delete(f.kv, key)
	return nil
}

func (f *fakeStore) Set(_ context.Context, k string, v []byte) error {
	if f.setErr != nil {
		return f.setErr
	}
	f.kv[k] = v
	return nil
}
func (f *fakeStore) Close() error { return nil }

func TestServiceDegradation(t *testing.T) {
	ctx := context.Background()

	t.Run("nil store reports ErrNoStore from every method", func(t *testing.T) {
		svc := New(nil, nil)
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrNoStore)
		_, err = svc.Record(ctx, "k")
		require.ErrorIs(t, err, ErrNoStore)
		_, err = svc.AppIDs(ctx, false)
		require.ErrorIs(t, err, ErrNoStore)
		res := svc.Delete(ctx, []string{"k"})
		require.Len(t, res, 1)
		require.False(t, res[0].OK)
		require.Contains(t, res[0].Error, "no state store")
		require.ErrorIs(t, svc.Set(ctx, SetRequest{AppID: "a", Key: "k", Value: "v"}), ErrNoStore)
	})

	t.Run("store without a RecordReader reports ErrNotBrowsable", func(t *testing.T) {
		svc := New(newFakeStore(), nil)
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrNotBrowsable)
	})

	t.Run("unreachable service names the store and its connection", func(t *testing.T) {
		svc := NewUnreachable("mystore", "localhost:6379")
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrStoreUnreachable)
		require.Contains(t, err.Error(), "mystore")
		require.Contains(t, err.Error(), "localhost:6379")

		res := svc.Delete(ctx, []string{"a", "b"})
		require.Len(t, res, 2)
		require.False(t, res[0].OK)

		require.ErrorIs(t, svc.Set(ctx, SetRequest{AppID: "a", Key: "k", Value: "v"}), ErrStoreUnreachable)
	})
}

func TestServiceSet(t *testing.T) {
	ctx := context.Background()

	t.Run("composes appID||key and stores the value verbatim", func(t *testing.T) {
		f := newFakeStore()
		svc := New(f, f)

		require.NoError(t, svc.Set(ctx, SetRequest{AppID: "order-app", Key: "cart-1", Value: "hello"}))

		require.Equal(t, []byte("hello"), f.kv["order-app||cart-1"],
			"the stored bytes are exactly the submitted text, with no JSON wrapping")
	})

	t.Run("refuses an existing key unless overwrite is set", func(t *testing.T) {
		f := newFakeStore()
		f.set("order-app||cart-1", "original")
		svc := New(f, f)

		err := svc.Set(ctx, SetRequest{AppID: "order-app", Key: "cart-1", Value: "replacement"})
		require.ErrorIs(t, err, ErrExists)
		require.Equal(t, []byte("original"), f.kv["order-app||cart-1"], "the existing value survives")
	})

	t.Run("overwrites an existing key when overwrite is set", func(t *testing.T) {
		f := newFakeStore()
		f.set("order-app||cart-1", "original")
		svc := New(f, f)

		require.NoError(t, svc.Set(ctx, SetRequest{
			AppID: "order-app", Key: "cart-1", Value: "replacement", Overwrite: true,
		}))
		require.Equal(t, []byte("replacement"), f.kv["order-app||cart-1"])
	})

	t.Run("an empty value is a valid record, not a missing one", func(t *testing.T) {
		f := newFakeStore()
		svc := New(f, f)

		require.NoError(t, svc.Set(ctx, SetRequest{AppID: "order-app", Key: "empty", Value: ""}))
		require.Equal(t, []byte(""), f.kv["order-app||empty"])
	})

	t.Run("propagates a store write error", func(t *testing.T) {
		f := newFakeStore()
		f.setErr = errors.New("redis down")
		svc := New(f, f)

		err := svc.Set(ctx, SetRequest{AppID: "order-app", Key: "cart-1", Value: "v"})
		require.ErrorContains(t, err, "redis down")
	})
}

func TestAppIDs(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("zeta||order-1", "v")
	f.set("alpha||order-2", "v")
	f.set("alpha||order-3", "v")
	f.set("alpha||dapr.internal.default.alpha.workflow||i1||metadata", "v")
	f.set("bare-key-no-prefix", "v")
	svc := New(f, f)

	ids, err := svc.AppIDs(ctx, true)
	require.NoError(t, err)
	require.Equal(t, []string{"alpha", "zeta"}, ids, "sorted, deduped, unprefixed keys excluded")

	t.Run("an app with both app and internal keys survives the default filter", func(t *testing.T) {
		ids, err := svc.AppIDs(ctx, false)
		require.NoError(t, err)
		require.Equal(t, []string{"alpha", "zeta"}, ids,
			"alpha has workflow history but also plain records, so it stays")
	})

	t.Run("an internal-only prefix is hidden unless internal keys are shown", func(t *testing.T) {
		only := newFakeStore()
		only.set("gamma||dapr.internal.default.gamma.workflow||i1||metadata", "v")
		only.set("delta||MyActor||a1||balance", "v")
		svc := New(only, only)

		ids, err := svc.AppIDs(ctx, false)
		require.NoError(t, err)
		require.Empty(t, ids,
			"an app whose every record is filtered out must not be offered in the dropdown")

		ids, err = svc.AppIDs(ctx, true)
		require.NoError(t, err)
		require.Equal(t, []string{"delta", "gamma"}, ids)
	})

	t.Run("a store of only unprefixed keys yields an empty list", func(t *testing.T) {
		bare := newFakeStore()
		bare.set("k1", "v")
		ids, err := New(bare, bare).AppIDs(ctx, true)
		require.NoError(t, err)
		require.Empty(t, ids)
	})
}

func TestAppIDsPropagatesStoreErrors(t *testing.T) {
	f := &erroringStore{}
	_, err := New(f, f).AppIDs(context.Background(), false)
	require.Error(t, err)
	require.Contains(t, err.Error(), "boom")
}

// erroringStore fails every Keys call.
type erroringStore struct{ fakeStore }

func (e *erroringStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", errors.New("boom")
}
