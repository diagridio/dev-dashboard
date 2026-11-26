//go:build unit

package cmd

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// closedPort returns a loopback port nothing listens on, so a sidecar dial
// fails fast.
func closedPort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	port := l.Addr().(*net.TCPAddr).Port
	require.NoError(t, l.Close())
	return port
}

// An active store the dashboard cannot open (here an unsupported type) must
// not hide the sidecar source when the page addresses it by id, which is what
// the Workflows page always does. Before the fix only ServiceFor("") fell
// back, so ?store=<active id> answered 503.
func TestReconciler_UnopenableActiveStoreByIDFallsBackToSidecar(t *testing.T) {
	dir := t.TempDir()
	unsupported := func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		return nil, fmt.Errorf("%w: %s", statestore.ErrUnsupported, c.Type)
	}
	pool := newConnPool("default", &http.Client{}, nil, unsupported, nil)
	apps := staticApps{instances: []discovery.Instance{{AppID: "mortgage-agent", GRPCPort: closedPort(t), SidecarReachable: true}}}
	rc := newReconciler(context.Background(), apps, "default", "", "", &http.Client{}, nil, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })

	active := statestore.Component{
		Name: "statestore", Type: "state.sqlserver", Path: filepath.Join(dir, "statestore.yaml"),
		Metadata: map[string]string{"actorStateStore": "true"},
	}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	stores := rc.Stores()
	require.Len(t, stores, 1)
	require.True(t, stores[0].Unsupported, "state.sqlserver is listed as unsupported")

	for _, id := range []string{"", stores[0].ID} {
		svc, _, _, ok := rc.ServiceFor(id)
		require.True(t, ok)
		res, err := svc.List(context.Background(), workflow.ListQuery{})
		require.NoError(t, err, "id %q: the sidecar source stands in for the store", id)
		require.Contains(t, res.StoreError, "unsupported state store type: state.sqlserver", "id %q", id)
		require.NotContains(t, res.StoreError, "could not connect", "id %q", id)

		_, err = svc.AppIDs(context.Background())
		require.NoError(t, err, "id %q", id)
		_, err = svc.Stats(context.Background(), workflow.ListQuery{})
		require.NoError(t, err, "id %q", id)
	}
}

// A non-active store that fails to open keeps its error: the sidecars serve
// the active store's apps, not an arbitrary other store's.
func TestReconciler_UnopenableOtherStoreKeepsError(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	failing := func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		return nil, errors.New("dial tcp: connection refused")
	}
	pool := newConnPool("default", &http.Client{}, nil, failing, nil)
	reg := LoadRegistry(home)
	require.NoError(t, reg.Add(ConnEntry{Name: "other", Type: "state.redis", Source: SourceManual,
		Metadata: map[string]string{"redisHost": "localhost:1"}}))
	apps := staticApps{instances: []discovery.Instance{{AppID: "app", GRPCPort: closedPort(t), SidecarReachable: true}}}
	rc := newReconciler(context.Background(), apps, "default", home, "", &http.Client{}, reg, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{{
		Name: "active", Type: "state.sqlite", Path: filepath.Join(dir, "a.yaml"),
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "a.db")},
	}}, nil, nil)
	rc.mu.Unlock()

	var otherID string
	for _, e := range reg.List() {
		otherID = e.ID
	}
	svc, _, _, ok := rc.ServiceFor(otherID)
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.ErrorIs(t, err, workflow.ErrStoreUnreachable)
	require.Equal(t, `could not connect to state store "other" (localhost:1): dial tcp: connection refused`, err.Error())
}

// The reserved sidecar id reads every reachable sidecar and no store.
func TestReconciler_SidecarStoreID(t *testing.T) {
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open, nil)
	apps := staticApps{instances: []discovery.Instance{{AppID: "app", GRPCPort: closedPort(t), SidecarReachable: true}}}
	rc := newReconciler(context.Background(), apps, "default", "", "", &http.Client{}, nil, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })

	svc, _, _, ok := rc.ServiceFor(server.SidecarStoreID)
	require.True(t, ok)
	res, err := svc.List(context.Background(), workflow.ListQuery{})
	require.NoError(t, err)
	require.Empty(t, res.StoreError, "no store was selected, so there is no store error")
	require.Zero(t, o.opens, "the sidecar choice never opens a store")

	// With no sidecar at all, it reports the no-store condition.
	rc2 := newReconciler(context.Background(), staticApps{}, "default", "", "", &http.Client{}, nil, pool, nil, nil)
	t.Cleanup(func() { _ = rc2.Close() })
	svc, _, _, ok = rc2.ServiceFor(server.SidecarStoreID)
	require.True(t, ok)
	_, err = svc.List(context.Background(), workflow.ListQuery{})
	require.ErrorIs(t, err, workflow.ErrNoStore)
}

// Two projects can each have a "statestore" component of the same
// unsupported type. Their connection summary is empty, so the
// name|type|connection identity can't tell them apart: only the elected one
// (by path) is active, and only it falls back to the sidecars.
func TestReconciler_SameNameUnsupportedStoresAreDistinct(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()
	yaml := func(project string) string {
		p := filepath.Join(dir, project, "statestore.yaml")
		require.NoError(t, os.MkdirAll(filepath.Dir(p), 0o755))
		require.NoError(t, os.WriteFile(p, []byte(`apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.sqlserver
  version: v1
  metadata:
  - name: actorStateStore
    value: "true"
`), 0o600))
		return p
	}
	activePath, otherPath := yaml("a"), yaml("b")

	unsupported := func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		return nil, fmt.Errorf("%w: %s", statestore.ErrUnsupported, c.Type)
	}
	pool := newConnPool("default", &http.Client{}, nil, unsupported, nil)
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.sqlserver", Source: SourceAuto, Path: activePath}))
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.sqlserver", Source: SourceAuto, Path: otherPath}))
	apps := staticApps{instances: []discovery.Instance{{AppID: "app", GRPCPort: closedPort(t), SidecarReachable: true}}}
	rc := newReconciler(context.Background(), apps, "default", home, "", &http.Client{}, reg, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{{
		Name: "statestore", Type: "state.sqlserver", Path: activePath,
		Metadata: map[string]string{"actorStateStore": "true"},
	}}, nil, nil)
	rc.mu.Unlock()

	activeID, otherID := entryID(SourceAuto, normPath(activePath)), entryID(SourceAuto, normPath(otherPath))
	stores := rc.Stores()
	require.Len(t, stores, 2)
	for _, s := range stores {
		require.Equal(t, s.ID == activeID, s.Active, "store %s (%s)", s.ID, s.Path)
	}

	svc, _, _, ok := rc.ServiceFor(activeID)
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.NoError(t, err, "the active store falls back to the sidecars")

	svc, _, _, ok = rc.ServiceFor(otherID)
	require.True(t, ok)
	_, err = svc.List(context.Background(), workflow.ListQuery{})
	require.ErrorIs(t, err, workflow.ErrStoreUnreachable, "another project's store keeps its own error")
}
