//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// Container posture runs without a connection registry. The configured store
// (elected from DEVDASHBOARD_STATESTORE_FILE) must still be listed and
// addressable by its id — the SPA's Workflows and State pages key off the
// list — and saving connections must fail loudly instead of a silent 201.
func TestReconciler_NilRegistryListsElectedStoreReadOnly(t *testing.T) {
	dir := t.TempDir()
	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open, nil)
	rc := newReconciler(context.Background(), nil, "default", "", "", &http.Client{}, nil, pool, nil, nil)
	t.Cleanup(func() { _ = rc.Close() })

	require.Empty(t, rc.Stores(), "no elected store yet -> empty list")

	active := statestore.Component{
		Name: "wfstore", Type: "state.sqlite", Path: filepath.Join(dir, "statestore.yaml"),
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "wf.db")},
	}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	stores := rc.Stores()
	require.Len(t, stores, 1)
	require.Equal(t, "wfstore", stores[0].Name)
	require.True(t, stores[0].Active)
	require.Equal(t, entryID(SourceAuto, normPath(active.Path)), stores[0].ID)

	_, _, _, ok := rc.ServiceFor(stores[0].ID)
	require.True(t, ok, "the listed id must resolve for workflows")
	_, ok = rc.StateFor(stores[0].ID)
	require.True(t, ok, "the listed id must resolve for state")
	_, _, _, ok = rc.ServiceFor("nosuchstoreid")
	require.False(t, ok)

	err := rc.AddStore("manual", "state.redis", map[string]string{"redisHost": "redis:6379"})
	require.True(t, errors.Is(err, server.ErrRegistryReadOnly), "add: %v", err)
	_, err = rc.UpdateStore(stores[0].ID, "x", "state.redis", nil)
	require.True(t, errors.Is(err, server.ErrRegistryReadOnly), "update: %v", err)
	err = rc.DeleteStore(stores[0].ID)
	require.True(t, errors.Is(err, server.ErrRegistryReadOnly), "delete: %v", err)
}
