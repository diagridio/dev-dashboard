//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// countingStore is a minimal statestore.Store that tracks Close calls.
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
	if s.closes != nil {
		s.closes.Add(1)
	}
	return nil
}

// fakeOpener counts opens and hands back a minimal no-op store.
type fakeOpener struct {
	opens int32
}

func (o *fakeOpener) open(_ context.Context, _ statestore.Component) (statestore.Store, error) {
	atomic.AddInt32(&o.opens, 1)
	return countingStore{closes: new(atomic.Int32)}, nil
}

// seedAutoComponentYAML writes a minimal sqlite component YAML and returns its abs path.
func seedAutoComponentYAML(t *testing.T, dir, name, db string) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	y := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: " + name +
		"\nspec:\n  type: state.sqlite\n  version: v1\n  metadata:\n  - name: connectionString\n    value: " + db + "\n"
	p := filepath.Join(dir, name+".yaml")
	require.NoError(t, os.WriteFile(p, []byte(y), 0o644))
	abs, err := filepath.Abs(p)
	require.NoError(t, err)
	return abs
}

func TestReconciler_ServiceForRouting(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	// An auto entry referencing a real component YAML on disk, a manual entry,
	// and a second auto entry with the SAME name as the first but a different
	// path (to prove distinct ids resolve independently).
	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	autoPath2 := seedAutoComponentYAML(t, filepath.Join(dir, "proj2"), "autostore", filepath.Join(dir, "auto2.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath2}))
	require.NoError(t, reg.Add(ConnEntry{Name: "manualstore", Type: "state.sqlite", Source: SourceManual,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "manual.db")}}))

	// Resolve the assigned ids from the registry (don't duplicate the hash logic).
	ids := map[string]string{} // path-or-name -> id
	for _, e := range reg.List() {
		switch e.Source {
		case SourceManual:
			ids["manualstore"] = e.ID
		default:
			ids[e.Path] = e.ID
		}
	}
	require.NotEqual(t, ids[autoPath], ids[autoPath2], "same name + different paths -> distinct ids")

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Seed an elected active store directly (no apps needed for this routing test).
	active := statestore.Component{Name: "active", Type: "state.sqlite", Metadata: map[string]string{"connectionString": filepath.Join(dir, "active.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	t.Run("empty id -> active (pre-warmed via pool)", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("")
		require.True(t, ok)
	})
	t.Run("auto entry resolves by id and connects", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor(ids[autoPath])
		require.True(t, ok)
	})
	t.Run("second same-name auto entry resolves by its own id", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor(ids[autoPath2])
		require.True(t, ok)
	})
	t.Run("manual entry resolves by id and connects", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor(ids["manualstore"])
		require.True(t, ok)
	})
	t.Run("unknown id -> ok=false", func(t *testing.T) {
		_, _, _, ok := rc.ServiceFor("nosuchstoreid")
		require.False(t, ok)
	})

	require.GreaterOrEqual(t, o.opens, int32(1), "the fake opener must have been used for id lookups")
}

func TestReconciler_NoActiveNoStoresDegraded(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// No elected store and empty name -> degraded entry, ok=true.
	_, _, _, ok := rc.ServiceFor("")
	require.True(t, ok, "empty name with no active store returns the degraded entry")
}

func TestReconciler_StoresListsAllEntriesAndMutators(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Elect "autostore" active so the active flag is exercised.
	active := statestore.Component{Name: "autostore", Type: "state.sqlite", Path: autoPath,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "auto.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	// AddStore -> a manual entry appears in Stores().
	require.NoError(t, rc.AddStore("manualpg", "state.postgresql", map[string]string{"connectionString": "host=h dbname=d"}))

	infos := rc.Stores()
	byName := map[string]server.StoreInfo{}
	for _, i := range infos {
		byName[i.Name] = i
	}
	require.Contains(t, byName, "autostore")
	require.Contains(t, byName, "manualpg")
	require.Equal(t, "auto", byName["autostore"].Source)
	require.NotEmpty(t, byName["autostore"].ID)
	require.True(t, byName["autostore"].Active, "the elected store is flagged active")
	require.Equal(t, "manual", byName["manualpg"].Source)
	require.NotEmpty(t, byName["manualpg"].ID)
	require.False(t, byName["manualpg"].Active)
	require.Equal(t, "h/d", byName["manualpg"].Connection, "manual pg connection is secrets-free ConnInfo")

	pgID := byName["manualpg"].ID

	// UpdateStore mutates the manual entry, addressed by id, and returns the new id.
	newID, err := rc.UpdateStore(pgID, "manualpg", "state.postgresql", map[string]string{"connectionString": "host=h2 dbname=d2"})
	require.NoError(t, err)
	require.Equal(t, pgID, newID) // same name → same id
	for _, i := range rc.Stores() {
		if i.ID == pgID {
			require.Equal(t, "h2/d2", i.Connection)
		}
	}

	// DeleteStore removes it, addressed by id.
	require.NoError(t, rc.DeleteStore(pgID))
	for _, i := range rc.Stores() {
		require.NotEqual(t, pgID, i.ID)
	}
}

// failingOpener always fails to open, simulating an unreachable backend.
type failingOpener struct{}

func (failingOpener) open(_ context.Context, _ statestore.Component) (statestore.Store, error) {
	return nil, errors.New("dial tcp: connection refused")
}

func TestReconciler_ServiceForUnreachableByID(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "downstore", filepath.Join(dir, "down.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "downstore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	var id string
	for _, e := range reg.List() {
		if e.Path == autoPath {
			id = e.ID
		}
	}
	require.NotEmpty(t, id)

	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	svc, _, _, ok := rc.ServiceFor(id)
	require.True(t, ok, "a known but unreachable store is still ok=true")
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrStoreUnreachable), "unreachable store yields ErrStoreUnreachable, not ErrNoStore")
	require.False(t, errors.Is(err, workflow.ErrNoStore))
}

func TestReconciler_ServiceForUnreachableActive(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Elect an active store; the pool's opener will fail to connect to it.
	active := statestore.Component{Name: "activedown", Type: "state.sqlite", Metadata: map[string]string{"connectionString": filepath.Join(dir, "active.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrStoreUnreachable), "active-but-unreachable yields ErrStoreUnreachable")
}

func TestReconciler_ServiceForNoStoreStillErrNoStore(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// No elected store and empty id -> degraded/ErrNoStore (genuinely no store).
	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrNoStore), "no store at all stays ErrNoStore")
}

func TestReconciler_ServiceForUnknownID(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	_, _, _, ok := rc.ServiceFor("nosuchid")
	require.False(t, ok, "unknown id -> ok=false")
}
