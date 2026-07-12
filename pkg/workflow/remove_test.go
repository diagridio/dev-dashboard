//go:build unit

package workflow

import (
	"bytes"
	"context"
	"log/slog"
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

func captureWFLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestRemove_LogsForceUnavailableWhenNoStore(t *testing.T) {
	buf := captureWFLogs(t)
	r := NewRemover(nil, nil, "default") // nil store -> force delete unavailable
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "app1", InstanceID: "inst1", HTTPPort: 0, Healthy: false,
	}, true) // force=true and unhealthy -> MechForce
	if res.OK {
		t.Fatal("expected force delete to fail with no store")
	}
	out := buf.String()
	if !strings.Contains(out, "workflow removal requested") {
		t.Fatalf("expected request INFO, got %q", out)
	}
	if !strings.Contains(out, "workflow removal failed") {
		t.Fatalf("expected failure ERROR, got %q", out)
	}
}

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

// patternStore wraps fakeStore to record the LIKE patterns passed to Keys.
type patternStore struct {
	*fakeStore
	patterns []string
}

func (p *patternStore) Keys(ctx context.Context, pattern, token string, n int) ([]string, string, error) {
	p.patterns = append(p.patterns, pattern)
	return p.fakeStore.Keys(ctx, pattern, token, n)
}

func TestRemoveForceDeleteUsesPerAppNamespace(t *testing.T) {
	f := &patternStore{fakeStore: newFakeStore()}
	// Instance data lives under the app's own namespace "prod", while the
	// remover's store namespace is the global "default".
	prefix := statestore.InstancePrefix("prod", "order", "stuck")
	f.kv[prefix+"metadata"] = []byte("{}")
	f.kv[prefix+"history-000000"] = []byte("x")

	r := NewRemover(&http.Client{Timeout: time.Second}, f, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "order", InstanceID: "stuck", Namespace: "prod", Status: StatusRunning, Healthy: false,
	}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechForce, res.Mechanism)
	require.NotContains(t, f.kv, prefix+"metadata")
	require.NotContains(t, f.kv, prefix+"history-000000")
	require.Contains(t, f.patterns, statestore.InstanceKeyPattern("prod", "order", "stuck"),
		"force delete must scan under the target's per-app namespace")
}

func TestRemoveForceDeleteFallsBackToRemoverNamespace(t *testing.T) {
	f := &patternStore{fakeStore: newFakeStore()}
	prefix := statestore.InstancePrefix("default", "order", "stuck")
	f.kv[prefix+"metadata"] = []byte("{}")

	r := NewRemover(&http.Client{Timeout: time.Second}, f, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "order", InstanceID: "stuck", Namespace: "", Status: StatusRunning, Healthy: false,
	}, false)
	require.True(t, res.OK, res.Error)
	require.NotContains(t, f.kv, prefix+"metadata")
	require.Contains(t, f.patterns, statestore.InstanceKeyPattern("default", "order", "stuck"),
		"empty target namespace must fall back to the remover's store namespace")
}

func TestRemoverUsesBaseURL(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	r := NewRemover(srv.Client(), nil, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID:           "orders",
		InstanceID:      "wf-1",
		Status:          StatusCompleted, // terminal → MechPurge (single POST)
		DaprHTTPBaseURL: srv.URL,
		Healthy:         true,
	}, false)
	if !res.OK {
		t.Fatalf("remove failed: %+v", res)
	}
	if want := "/v1.0-beta1/workflows/dapr/wf-1/purge"; gotPath != want {
		t.Fatalf("path %q want %q", gotPath, want)
	}
}

func TestRemoverBaseURLCountsAsReachable(t *testing.T) {
	// HTTPPort 0 but a base URL present must still select the HTTP mechanism,
	// not force-delete.
	if got := SelectMechanism(StatusCompleted, true, false); got != MechPurge {
		t.Fatalf("sanity: %v", got)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	r := NewRemover(srv.Client(), nil, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "a", InstanceID: "i", Status: StatusCompleted,
		HTTPPort: 0, DaprHTTPBaseURL: srv.URL, Healthy: true,
	}, false)
	if !res.OK || res.Mechanism != MechPurge {
		t.Fatalf("want OK purge, got %+v", res)
	}
}

func mustPort(t *testing.T, raw string) int {
	t.Helper()
	u, err := url.Parse(raw)
	require.NoError(t, err)
	p, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return p
}
