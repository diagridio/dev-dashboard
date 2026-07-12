//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

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

func (f fakeWorkflowSvc) AppIDs(_ context.Context) ([]string, error) {
	return nil, nil
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

	t.Run("populates namespace from the instance", func(t *testing.T) {
		disc := fakeDiscovery{inst: discovery.Instance{AppID: "order", HTTPPort: 3500, Namespace: "prod", Health: discovery.HealthHealthy}}
		wf := fakeWorkflowSvc{ex: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "inst", Status: workflow.StatusRunning}}}
		r := newTargetResolver(disc, wf)
		got, err := r.Resolve(ctx, "order", "inst")
		require.NoError(t, err)
		require.Equal(t, "prod", got.Namespace)
	})

	t.Run("leaves namespace empty for host-scanned apps", func(t *testing.T) {
		disc := fakeDiscovery{inst: discovery.Instance{AppID: "order", HTTPPort: 3500, Namespace: "", Health: discovery.HealthHealthy}}
		wf := fakeWorkflowSvc{ex: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "inst", Status: workflow.StatusRunning}}}
		r := newTargetResolver(disc, wf)
		got, err := r.Resolve(ctx, "order", "inst")
		require.NoError(t, err)
		require.Equal(t, "", got.Namespace)
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

// --- per-app namespace: static contract map, no sidecar probes ---

func TestContractNamespaces(t *testing.T) {
	env := map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "2",
		"DEVDASHBOARD_APP_0_ID":        "orders",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://orders-dapr:3500",
		"DEVDASHBOARD_APP_0_NAMESPACE": "prod",
		"DEVDASHBOARD_APP_1_ID":        "billing",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "http://billing-dapr:3500",
	}
	scan, err := discovery.NewAspireScanner(func(k string) string { return env[k] })
	require.NoError(t, err)

	m := contractNamespaces(scan)
	require.Equal(t, "prod", m["orders"])
	require.Equal(t, "default", m["billing"], "unset per-app namespace falls back to the contract default")
	require.Empty(t, m["unknown"], "unknown app resolves to empty (global namespace)")
}

// patternKeysStore is a statestore.Store recording the LIKE patterns passed to
// Keys; all reads return empty.
type patternKeysStore struct{ patterns []string }

func (s *patternKeysStore) Keys(_ context.Context, pattern, _ string, _ int) ([]string, string, error) {
	s.patterns = append(s.patterns, pattern)
	return nil, "", nil
}
func (s *patternKeysStore) Get(context.Context, string) ([]byte, error) { return nil, nil }
func (s *patternKeysStore) BulkGet(context.Context, []string) (map[string][]byte, error) {
	return nil, nil
}
func (s *patternKeysStore) Delete(context.Context, string) error      { return nil }
func (s *patternKeysStore) Set(context.Context, string, []byte) error { return nil }
func (s *patternKeysStore) Close() error                              { return nil }

// countingApps is a discovery.Service double counting Get calls (each real Get
// costs two sidecar HTTP probes via enrich).
type countingApps struct {
	fakeDiscovery
	gets int32
}

func (c *countingApps) Get(ctx context.Context, key string) (discovery.Instance, error) {
	atomic.AddInt32(&c.gets, 1)
	return c.fakeDiscovery.Get(ctx, key)
}

func TestBuildStoreEntryNamespaceResolverIsStatic(t *testing.T) {
	st := &patternKeysStore{}
	apps := &countingApps{}
	entry := buildStoreEntry(st, "default", &http.Client{}, apps, map[string]string{"orders": "prod"})

	// App-scoped Get resolves the namespace from the static contract map...
	_, err := entry.svc.Get(context.Background(), "orders", "inst-1")
	require.ErrorIs(t, err, workflow.ErrNotFound) // store is empty; only the pattern matters
	require.Contains(t, st.patterns, statestore.InstanceKeyPattern("prod", "orders", "inst-1"))

	// ...an unmapped app falls back to the store namespace...
	_, err = entry.svc.Get(context.Background(), "other", "inst-2")
	require.ErrorIs(t, err, workflow.ErrNotFound)
	require.Contains(t, st.patterns, statestore.InstanceKeyPattern("default", "other", "inst-2"))

	// ...and neither resolution touched discovery (zero sidecar probes).
	require.Zero(t, atomic.LoadInt32(&apps.gets), "namespace resolution must not call apps.Get")
}

func TestStoreRegistry_StoresReturnsActiveOnly_FirstFallback(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "sqlite", Type: "state.sqlite", Path: "/a/sqlite.yaml", Metadata: map[string]string{}},
	}
	r := newStoreRegistry(comps, nil, nil)

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
	r := newStoreRegistry(comps, nil, nil)

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
	r := newStoreRegistry(comps, nil, nil)

	infos := r.Stores()
	require.Len(t, infos, 1)
	require.Equal(t, "mystore", infos[0].Name)
	require.Equal(t, "state.sqlite", infos[0].Type)
	require.Equal(t, "/path/to/sqlite.yaml", infos[0].Path)
	require.Equal(t, "data.db", infos[0].Connection)
	require.True(t, infos[0].Active)
}

func TestStoreRegistry_StoresEmptyWhenNoComponents(t *testing.T) {
	r := newStoreRegistry(nil, nil, nil)
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

func TestStoreRegistry_AppLoadedStoreWinsOverDefault(t *testing.T) {
	// Both have actorStateStore=true; default ~/.dapr store is scanned first.
	comps := []statestore.Component{
		{Name: "statestore", Type: "state.redis", Path: "/home/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
		{Name: "workflow-store", Type: "state.redis", Path: "/app/Resources/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:16379"}},
	}
	loaded := map[string]bool{"workflow-store": true} // only the app-loaded one

	r := newStoreRegistry(comps, loaded, nil)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "workflow-store", act.Name, "app-loaded store must win over the unloaded ~/.dapr default")
}

func TestStoreRegistry_FallsBackWhenNoneLoaded(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{"actorStateStore": "true"}},
	}
	r := newStoreRegistry(comps, nil, nil) // no apps loaded anything

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

	r := newStoreRegistry(comps, loaded, nil)
	require.Equal(t, "appstore", r.active().Name, "an app-loaded store beats an unloaded default even without the actor flag")
}

func TestStoreRegistry_AppPathStoreWinsOverSameNamedGlobalDefault(t *testing.T) {
	comps := []statestore.Component{
		// Global ~/.dapr default — detected first.
		{Name: "statestore", Type: "state.redis", Path: "/home/me/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
		// The app's own store, under its resource path.
		{Name: "statestore", Type: "state.redis", Path: "/app/pr-digest/resources/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:16379"}},
	}
	loaded := map[string]bool{"statestore": true}
	appPaths := []string{"/app/pr-digest/resources"}

	r := newStoreRegistry(comps, loaded, appPaths)
	require.NotNil(t, r.active())
	require.Equal(t, "localhost:16379", r.active().Metadata["redisHost"],
		"the app-provided store must win over the same-named ~/.dapr default")
}

func TestStoreRegistry_FallsBackToGlobalDefaultWhenNoAppStore(t *testing.T) {
	comps := []statestore.Component{
		{Name: "statestore", Type: "state.redis", Path: "/home/me/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
	}
	loaded := map[string]bool{"statestore": true}
	// No appPaths: the app provided no store of its own → the loaded global default is elected.
	r := newStoreRegistry(comps, loaded, nil)
	require.NotNil(t, r.active())
	require.Equal(t, "localhost:6379", r.active().Metadata["redisHost"])
}
