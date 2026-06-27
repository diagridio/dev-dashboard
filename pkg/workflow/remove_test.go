//go:build unit

package workflow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestRemovePurgeTerminal(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	port := mustPort(t, srv.URL)

	r := NewRemover(&http.Client{Timeout: time.Second}, newFakeStore(), "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "inst-1", Status: StatusCompleted, HTTPPort: port, Healthy: true}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechPurge, res.Mechanism)
	require.Equal(t, "/v1.0-beta1/workflows/dapr/inst-1/purge", gotPath)
}

func TestRemoveTerminateThenPurge(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	port := mustPort(t, srv.URL)

	r := NewRemover(&http.Client{Timeout: time.Second}, newFakeStore(), "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "live", Status: StatusRunning, HTTPPort: port, Healthy: true}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechTerminateThenPurge, res.Mechanism)
	require.Len(t, calls, 2)
	require.True(t, strings.HasSuffix(calls[0], "/terminate"))
	require.True(t, strings.HasSuffix(calls[1], "/purge"))
}

func TestRemoveForceDeletesKeys(t *testing.T) {
	f := newFakeStore()
	prefix := statestore.InstancePrefix("default", "order", "stuck")
	f.kv[prefix+"metadata"] = []byte("{}")
	f.kv[prefix+"history-000000"] = []byte("x")
	f.kv["order||other||keep||metadata"] = []byte("keep")

	r := NewRemover(&http.Client{Timeout: time.Second}, f, "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "stuck", Status: StatusRunning, Healthy: false}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechForce, res.Mechanism)
	require.NotContains(t, f.kv, prefix+"metadata")
	require.NotContains(t, f.kv, prefix+"history-000000")
	require.Contains(t, f.kv, "order||other||keep||metadata") // untouched
}

func mustPort(t *testing.T, raw string) int {
	t.Helper()
	u, err := url.Parse(raw)
	require.NoError(t, err)
	p, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return p
}
