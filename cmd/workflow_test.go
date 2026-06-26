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
