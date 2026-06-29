//go:build unit

package cmd

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// withCapturedLogs swaps the default logger for one writing to buf, returns a restore func.
func withCapturedLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

// --- targetResolver unit tests ---

type fakeDiscovery struct {
	inst discovery.Instance
	err  error
}

func (f fakeDiscovery) List(_ context.Context) ([]discovery.Instance, error) {
	return []discovery.Instance{f.inst}, f.err
}

func (f fakeDiscovery) Get(_ context.Context, _ string) (discovery.Instance, error) {
	return f.inst, f.err
}

type fakeWorkflowSvc struct {
	ex  workflow.Execution
	err error
}

func (f fakeWorkflowSvc) List(_ context.Context, _ workflow.ListQuery) (workflow.ListResult, error) {
	return workflow.ListResult{}, nil
}

func (f fakeWorkflowSvc) Get(_ context.Context, _, _ string) (workflow.Execution, error) {
	return f.ex, f.err
}

func (f fakeWorkflowSvc) Stats(_ context.Context, _ workflow.ListQuery) (workflow.StatsResult, error) {
	return workflow.StatsResult{}, nil
}

func TestTargetResolver(t *testing.T) {
	ctx := context.Background()

	t.Run("happy path", func(t *testing.T) {
		disc := fakeDiscovery{inst: discovery.Instance{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy}}
		wf := fakeWorkflowSvc{ex: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "inst", Status: workflow.StatusRunning}}}
		r := newTargetResolver(disc, wf)
		got, err := r.Resolve(ctx, "order", "inst")
		require.NoError(t, err)
		require.Equal(t, workflow.StatusRunning, got.Status)
		require.Equal(t, 3500, got.HTTPPort)
		require.True(t, got.Healthy)
	})

	t.Run("discovery Get fails — still succeeds with HTTPPort=0 Healthy=false", func(t *testing.T) {
		disc := fakeDiscovery{err: errors.New("not found")}
		wf := fakeWorkflowSvc{ex: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "inst", Status: workflow.StatusCompleted}}}
		r := newTargetResolver(disc, wf)
		got, err := r.Resolve(ctx, "order", "inst")
		require.NoError(t, err)
		require.Equal(t, 0, got.HTTPPort)
		require.False(t, got.Healthy)
		require.Equal(t, workflow.StatusCompleted, got.Status)
	})

	t.Run("workflow Get fails — returns error", func(t *testing.T) {
		disc := fakeDiscovery{inst: discovery.Instance{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy}}
		wf := fakeWorkflowSvc{err: errors.New("db error")}
		r := newTargetResolver(disc, wf)
		_, err := r.Resolve(ctx, "order", "inst")
		require.Error(t, err)
	})
}

func TestStoreRegistry_StoresReturnsActiveOnly_FirstFallback(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "sqlite", Type: "state.sqlite", Path: "/a/sqlite.yaml", Metadata: map[string]string{}},
	}
	r := newStoreRegistry(comps, nil)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "redis", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 1, "only the active store is returned")
	require.Equal(t, "redis", infos[0].Name)
	require.True(t, infos[0].Active)
	require.Equal(t, "localhost:6379", infos[0].Connection)
}

func TestStoreRegistry_StoresReturnsActiveOnly_ActorStateStoreWins(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{
			"actorStateStore":  "true",
			"connectionString": "host=localhost port=5432 dbname=orders password=x",
		}},
	}
	r := newStoreRegistry(comps, nil)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "pg", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 1, "only the active (actorStateStore) store is returned")
	require.Equal(t, "pg", infos[0].Name)
	require.True(t, infos[0].Active)
	require.Equal(t, "localhost:5432/orders", infos[0].Connection)
}

func TestStoreRegistry_StoreInfoMapping(t *testing.T) {
	comps := []statestore.Component{
		{Name: "mystore", Type: "state.sqlite", Path: "/path/to/sqlite.yaml", Metadata: map[string]string{"connectionString": "data.db"}},
	}
	r := newStoreRegistry(comps, nil)

	infos := r.Stores()
	require.Len(t, infos, 1)
	require.Equal(t, "mystore", infos[0].Name)
	require.Equal(t, "state.sqlite", infos[0].Type)
	require.Equal(t, "/path/to/sqlite.yaml", infos[0].Path)
	require.Equal(t, "data.db", infos[0].Connection)
	require.True(t, infos[0].Active)
}

func TestStoreRegistry_StoresEmptyWhenNoComponents(t *testing.T) {
	r := newStoreRegistry(nil, nil)
	require.Nil(t, r.active())
	got := r.Stores()
	require.NotNil(t, got)
	require.Len(t, got, 0)
}

func TestNewRootCmd_NewFlags(t *testing.T) {
	c := NewRootCmd()

	ss, err := c.Flags().GetString("statestore")
	require.NoError(t, err)
	require.Equal(t, "", ss)

	ns, err := c.Flags().GetString("namespace")
	require.NoError(t, err)
	require.Equal(t, "default", ns)
}

// --- storeBackend unit tests ---

// buildTestBackend builds a storeBackend with a hand-crafted services map,
// bypassing the real statestore.New (which needs disk/network).
func buildTestBackend(activeName string, names ...string) *storeBackend {
	b := &storeBackend{
		services:   make(map[string]storeEntry),
		activeName: activeName,
		degraded:   storeEntry{}, // nil svc/rem/targets — sufficient for name-routing tests
	}
	for _, n := range names {
		b.services[n] = storeEntry{} // entries just need to be present
	}
	return b
}

func TestStoreBackend_EmptyNameReturnsActive(t *testing.T) {
	b := buildTestBackend("redis", "redis", "pg")
	_, _, _, ok := b.ServiceFor("")
	require.True(t, ok)
}

func TestStoreBackend_KnownNameReturnsEntry(t *testing.T) {
	b := buildTestBackend("redis", "redis", "pg")
	_, _, _, ok := b.ServiceFor("pg")
	require.True(t, ok)
}

func TestStoreBackend_UnknownNameReturnsFalse(t *testing.T) {
	b := buildTestBackend("redis", "redis", "pg")
	_, _, _, ok := b.ServiceFor("nosuchstore")
	require.False(t, ok)
}

func TestStoreBackend_NoStoresDegraded(t *testing.T) {
	b := buildTestBackend("") // no stores, no activeName
	_, _, _, ok := b.ServiceFor("")
	require.True(t, ok, "degraded entry should always return ok=true")
}

func TestStoreBackend_NoStoresUnknownExplicit(t *testing.T) {
	b := buildTestBackend("") // no stores
	_, _, _, ok := b.ServiceFor("anything")
	require.False(t, ok)
}

func TestNewStoreBackend_LogsNoStoreDetected(t *testing.T) {
	buf := withCapturedLogs(t)
	_, closers := newStoreBackend(context.Background(), nil, nil, "default", &http.Client{}, nil, statestore.New)
	for _, c := range closers {
		_ = c()
	}
	if !strings.Contains(buf.String(), "no state store detected") {
		t.Fatalf("expected 'no state store detected' WARN, got %q", buf.String())
	}
}

func TestStoreRegistry_AppLoadedStoreWinsOverDefault(t *testing.T) {
	// Both have actorStateStore=true; default ~/.dapr store is scanned first.
	comps := []statestore.Component{
		{Name: "statestore", Type: "state.redis", Path: "/home/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
		{Name: "workflow-store", Type: "state.redis", Path: "/app/Resources/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:16379"}},
	}
	loaded := map[string]bool{"workflow-store": true} // only the app-loaded one

	r := newStoreRegistry(comps, loaded)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "workflow-store", act.Name, "app-loaded store must win over the unloaded ~/.dapr default")
}

func TestStoreRegistry_FallsBackWhenNoneLoaded(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{"actorStateStore": "true"}},
	}
	r := newStoreRegistry(comps, nil) // no apps loaded anything

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "pg", act.Name, "with nothing loaded, actorStateStore wins (current fallback)")
}

func TestStoreRegistry_AppLoadedNonActorPreferredOverUnloadedActor(t *testing.T) {
	comps := []statestore.Component{
		{Name: "default", Type: "state.redis", Path: "/home/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true"}},
		{Name: "appstore", Type: "state.redis", Path: "/app/Resources/store.yaml",
			Metadata: map[string]string{}}, // app-loaded but not flagged actorStateStore
	}
	loaded := map[string]bool{"appstore": true}

	r := newStoreRegistry(comps, loaded)
	require.Equal(t, "appstore", r.active().Name, "an app-loaded store beats an unloaded default even without the actor flag")
}

func TestNewStoreBackend_RegistersOnlyActiveStore(t *testing.T) {
	_ = withCapturedLogs(t)

	dir := t.TempDir()
	comps := []statestore.Component{
		// Active: sqlite with actorStateStore=true (initialises from a local file).
		{
			Name: "wfstore", Type: "state.sqlite", Path: "/x/wf.yaml",
			Metadata: map[string]string{
				"actorStateStore":  "true",
				"connectionString": filepath.Join(dir, "wf.db"),
			},
		},
		// Non-active: sqlite, different name. Must NOT be served.
		{
			Name: "other", Type: "state.sqlite", Path: "/x/other.yaml",
			Metadata: map[string]string{"connectionString": filepath.Join(dir, "other.db")},
		},
	}

	b, closers := newStoreBackend(context.Background(), comps, nil, "default", &http.Client{}, nil, statestore.New)
	defer func() {
		for _, c := range closers {
			_ = c()
		}
	}()

	require.Equal(t, "wfstore", b.activeName)

	// Active store (explicit name) is served.
	_, _, _, ok := b.ServiceFor("wfstore")
	require.True(t, ok)

	// Empty name resolves to the active store.
	_, _, _, ok = b.ServiceFor("")
	require.True(t, ok)

	// Non-active store name is rejected.
	_, _, _, ok = b.ServiceFor("other")
	require.False(t, ok, "non-active store must not be served")
}
