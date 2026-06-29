//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// fakeApps is a minimal discovery.Service returning a fixed list.
type fakeApps struct{ insts []discovery.Instance }

func (f fakeApps) List(context.Context) ([]discovery.Instance, error) { return f.insts, nil }
func (f fakeApps) Get(_ context.Context, id string) (discovery.Instance, error) {
	for _, in := range f.insts {
		if in.AppID == id {
			return in, nil
		}
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

// countingStore wraps no real backend; it only tracks Close calls.
type countingStore struct {
	closes *atomic.Int32
}

func (s countingStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", nil
}
func (s countingStore) Get(context.Context, string) ([]byte, error)            { return nil, nil }
func (s countingStore) BulkGet(context.Context, []string) (map[string][]byte, error) {
	return map[string][]byte{}, nil
}
func (s countingStore) Delete(context.Context, string) error      { return nil }
func (s countingStore) Set(context.Context, string, []byte) error { return nil }
func (s countingStore) Close() error {
	s.closes.Add(1)
	return nil
}

func compYAML(t *testing.T, dir, name, storeType string) string {
	t.Helper()
	p := filepath.Join(dir, name+".yaml")
	body := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: " + name +
		"\nspec:\n  type: " + storeType + "\n  version: v1\n  metadata:\n" +
		"  - name: actorStateStore\n    value: \"true\"\n  - name: redisHost\n    value: localhost:6379\n"
	require.NoError(t, os.WriteFile(p, []byte(body), 0o644))
	return p
}

func TestReconciler_NewResourcePathAppearsInPaths(t *testing.T) {
	dir := t.TempDir()
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})

	apps := []discovery.Instance{{AppID: "order", ResourcePaths: []string{dir}}}
	rc.reconcile(apps, appsFingerprint(apps))

	require.Contains(t, rc.Paths(), dir)
}

func TestReconciler_ActiveStoreSwapsAndClosesOldExactlyOnce(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	compYAML(t, dirA, "store-a", "state.redis")
	compYAML(t, dirB, "store-b", "state.redis")

	var closes atomic.Int32
	opened := map[string]int{}
	var openedMu sync.Mutex
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})
	rc.open = func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		openedMu.Lock()
		opened[c.Name]++
		openedMu.Unlock()
		return countingStore{closes: &closes}, nil
	}

	// First app loads store-a from dirA.
	apps1 := []discovery.Instance{{AppID: "a", ResourcePaths: []string{dirA},
		Components: []discovery.Component{{Name: "store-a", Type: "state.redis"}}}}
	rc.reconcile(apps1, appsFingerprint(apps1))
	require.Len(t, rc.Stores(), 1)
	require.Equal(t, "store-a", rc.Stores()[0].Name)
	require.EqualValues(t, 0, closes.Load())

	// Second app loads store-b from dirB: active store changes -> old closed once.
	apps2 := []discovery.Instance{{AppID: "b", ResourcePaths: []string{dirB},
		Components: []discovery.Component{{Name: "store-b", Type: "state.redis"}}}}
	rc.reconcile(apps2, appsFingerprint(apps2))
	require.Equal(t, "store-b", rc.Stores()[0].Name)
	require.EqualValues(t, 1, closes.Load(), "old connection must be closed exactly once")
	require.Equal(t, 1, opened["store-b"])
}

func TestReconciler_RetainsConnectionWhenNewOpenFails(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	compYAML(t, dirA, "store-a", "state.redis")
	compYAML(t, dirB, "store-b", "state.redis")

	var closes atomic.Int32
	failNext := false
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})
	rc.open = func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		if failNext {
			return nil, errors.New("connection refused")
		}
		return countingStore{closes: &closes}, nil
	}

	apps1 := []discovery.Instance{{AppID: "a", ResourcePaths: []string{dirA},
		Components: []discovery.Component{{Name: "store-a", Type: "state.redis"}}}}
	rc.reconcile(apps1, appsFingerprint(apps1))
	require.Equal(t, "store-a", rc.Stores()[0].Name)

	// New active store election, but the open fails: keep serving store-a.
	failNext = true
	apps2 := []discovery.Instance{{AppID: "b", ResourcePaths: []string{dirB},
		Components: []discovery.Component{{Name: "store-b", Type: "state.redis"}}}}
	rc.reconcile(apps2, appsFingerprint(apps2))
	require.Equal(t, "store-a", rc.Stores()[0].Name, "must retain previous store when new open fails")
	require.EqualValues(t, 0, closes.Load(), "old working connection must not be closed on failed swap")
}
