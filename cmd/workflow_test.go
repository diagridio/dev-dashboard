//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestStoreRegistry_Empty(t *testing.T) {
	r := newStoreRegistry(nil)
	require.Nil(t, r.active())
	require.Empty(t, r.Stores())
}

func TestStoreRegistry_FirstIsActive(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{}},
		{Name: "sqlite", Type: "state.sqlite", Path: "/a/sqlite.yaml", Metadata: map[string]string{}},
	}
	r := newStoreRegistry(comps)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "redis", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 2)
	require.True(t, infos[0].Active, "first should be active")
	require.False(t, infos[1].Active)
}

func TestStoreRegistry_ActorStateStoreWins(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{"actorStateStore": "true"}},
	}
	r := newStoreRegistry(comps)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "pg", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 2)
	require.False(t, infos[0].Active)
	require.True(t, infos[1].Active, "actorStateStore=true component should be active")
}

func TestStoreRegistry_StoreInfoMapping(t *testing.T) {
	comps := []statestore.Component{
		{Name: "mystore", Type: "state.sqlite", Path: "/path/to/sqlite.yaml", Metadata: map[string]string{}},
	}
	r := newStoreRegistry(comps)

	infos := r.Stores()
	require.Len(t, infos, 1)
	require.Equal(t, "mystore", infos[0].Name)
	require.Equal(t, "state.sqlite", infos[0].Type)
	require.Equal(t, "/path/to/sqlite.yaml", infos[0].Path)
	require.True(t, infos[0].Active)
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
