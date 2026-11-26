//go:build unit

package cmd

import (
	"context"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func newActorStoreRC(t *testing.T, reg *ConnRegistry) *reconciler {
	t.Helper()
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open, nil)
	rc := newReconciler(context.Background(), nil, "default", t.TempDir(), "", &http.Client{}, reg, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })
	return rc
}

func stateComps(names ...string) []discovery.Component {
	out := []discovery.Component{}
	for _, n := range names {
		out = append(out, discovery.Component{Name: n, Type: "state.redis"})
	}
	return out
}

func manualID(t *testing.T, reg *ConnRegistry, name string) string {
	t.Helper()
	for _, e := range reg.List() {
		if e.Source == SourceManual && e.Name == name {
			return e.ID
		}
	}
	t.Fatalf("no manual entry %s", name)
	return ""
}

func TestActorStoreForPicksActorStore(t *testing.T) {
	reg := LoadRegistry(t.TempDir())
	require.NoError(t, reg.Add(ConnEntry{Name: "statestore", Type: "state.redis", Metadata: map[string]string{"actorStateStore": "true"}}))
	require.NoError(t, reg.Add(ConnEntry{Name: "cache", Type: "state.redis"}))
	rc := newActorStoreRC(t, reg)

	id, name, ok := rc.ActorStoreFor(discovery.Instance{Components: stateComps("statestore", "cache")})
	require.True(t, ok)
	require.Equal(t, "statestore", name)
	require.Equal(t, manualID(t, reg, "statestore"), id)
	_, found := rc.StateFor(id)
	require.True(t, found)
}

func TestActorStoreForPathAware(t *testing.T) {
	dir := t.TempDir()
	appDir := filepath.Join(dir, "app", "resources")
	otherDir := filepath.Join(dir, "global")
	mine := seedActorYAML(t, appDir, "statestore")
	other := seedActorYAML(t, otherDir, "statestore")
	reg := LoadRegistry(t.TempDir())
	// Other is registered first so a naive first-match would pick it.
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.sqlite", Path: other}))
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "statestore", Type: "state.sqlite", Path: mine}))
	rc := newActorStoreRC(t, reg)

	id, name, ok := rc.ActorStoreFor(discovery.Instance{Components: stateComps("statestore"), ResourcePaths: []string{appDir}})
	require.True(t, ok)
	require.Equal(t, "statestore", name)
	require.Equal(t, entryID(SourceAuto, normPath(mine)), id)
}

func seedActorYAML(t *testing.T, dir, name string) string {
	t.Helper()
	require.NoError(t, os.MkdirAll(dir, 0o755))
	y := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: " + name +
		"\nspec:\n  type: state.sqlite\n  version: v1\n  metadata:\n  - name: connectionString\n    value: " +
		filepath.Join(dir, "x.db") + "\n  - name: actorStateStore\n    value: \"true\"\n"
	p, err := filepath.Abs(filepath.Join(dir, name+".yaml"))
	require.NoError(t, err)
	require.NoError(t, os.WriteFile(p, []byte(y), 0o644))
	return p
}

func TestActorStoreForNotConnected(t *testing.T) {
	rc := newActorStoreRC(t, LoadRegistry(t.TempDir()))
	id, name, ok := rc.ActorStoreFor(discovery.Instance{Components: stateComps("statestore")})
	require.False(t, ok)
	require.Empty(t, id)
	require.Equal(t, "statestore", name)

	id, name, ok = rc.ActorStoreFor(discovery.Instance{})
	require.False(t, ok)
	require.Empty(t, id)
	require.Empty(t, name)
}

func TestActorStoreForContainerPosture(t *testing.T) {
	dir := t.TempDir()
	rc := newActorStoreRC(t, nil)
	active := statestore.Component{Name: "wfstore", Type: "state.sqlite", Path: filepath.Join(dir, "statestore.yaml")}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	id, name, ok := rc.ActorStoreFor(discovery.Instance{Components: stateComps("wfstore")})
	require.True(t, ok)
	require.Equal(t, "wfstore", name)
	require.Equal(t, entryID(SourceAuto, normPath(active.Path)), id)

	id, name, ok = rc.ActorStoreFor(discovery.Instance{Components: stateComps("other")})
	require.False(t, ok)
	require.Empty(t, id)
	require.Equal(t, "other", name)
}

func TestActorStoreForNoneFlagged(t *testing.T) {
	reg := LoadRegistry(t.TempDir())
	require.NoError(t, reg.Add(ConnEntry{Name: "b", Type: "state.redis"}))
	require.NoError(t, reg.Add(ConnEntry{Name: "a", Type: "state.redis"}))
	rc := newActorStoreRC(t, reg)

	id, name, ok := rc.ActorStoreFor(discovery.Instance{Components: stateComps("a", "b")})
	require.False(t, ok)
	require.Empty(t, id)
	require.Equal(t, "a", name)

	// A single registered but unflagged store is not an actor store either.
	_, name, ok = rc.ActorStoreFor(discovery.Instance{Components: stateComps("a")})
	require.False(t, ok)
	require.Equal(t, "a", name)
}
