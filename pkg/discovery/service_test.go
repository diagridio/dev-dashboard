//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestServiceListEnriches(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.14.4","extended":{"appPID":"48213","appCommand":"go run ./cmd/order"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "order", HTTPPort: port, GRPCPort: 50001, AppPort: 8080, DaprdPID: 48230, Created: time.Now(), Command: "go run ./cmd/order"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})

	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 1)
	got := list[0]
	require.Equal(t, "order", got.AppID)
	require.Equal(t, HealthHealthy, got.Health)
	require.True(t, got.MetadataOK)
	require.Equal(t, 48213, got.AppPID)
	require.Equal(t, "1.14.4", got.RuntimeVersion)
	require.Equal(t, "go", got.Runtime)

	one, err := svc.Get(context.Background(), "order")
	require.NoError(t, err)
	require.Equal(t, "order", one.AppID)

	_, err = svc.Get(context.Background(), "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestServiceEnrichCarriesMetadataCollections(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.18.0","enabledFeatures":["StateStore"],"actors":[{"type":"OrderActor","count":2}],"components":[{"name":"statestore","type":"state.redis","version":"v1"}],"subscriptions":[{"pubsubname":"pubsub","topic":"orders"}],"actorRuntime":{"placement":"connected"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "order", HTTPPort: port, Command: "go run ./cmd/order"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	in := list[0]
	require.Equal(t, []string{"StateStore"}, in.EnabledFeatures)
	require.Equal(t, "OrderActor", in.Actors[0].Type)
	require.Equal(t, "statestore", in.Components[0].Name)
	require.Equal(t, "orders", in.Subscriptions[0].Topic)
	require.Equal(t, "connected", in.Placement)
}

func TestServiceListMetadataDown(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "x", HTTPPort: 1, DaprdPID: 9, Command: "python app.py"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 100 * time.Millisecond})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.False(t, list[0].MetadataOK)
	require.Equal(t, HealthUnhealthy, list[0].Health)
	require.Equal(t, "python", list[0].Runtime) // inferred from scan command
	require.Equal(t, 0, list[0].AppPID)         // unknown
}

func TestServiceListConcurrentEnrich(t *testing.T) {
	// One shared httptest server responds for all five fake apps.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"app","runtimeVersion":"1.14.4","extended":{"appPID":"100","appCommand":"go run ./cmd/app"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	appIDs := []string{"echo", "alpha", "delta", "bravo", "charlie"}
	scan := func() ([]ScanResult, error) {
		results := make([]ScanResult, len(appIDs))
		for i, id := range appIDs {
			results[i] = ScanResult{AppID: id, HTTPPort: port, Command: "go run ./cmd/" + id}
		}
		return results, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})

	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 5)

	// Must be sorted by AppID.
	for i := 1; i < len(list); i++ {
		require.Less(t, list[i-1].AppID, list[i].AppID, "list must be sorted by AppID")
	}

	// Every instance must be enriched (MetadataOK, HealthHealthy).
	for _, inst := range list {
		require.True(t, inst.MetadataOK, "expected MetadataOK for %s", inst.AppID)
		require.Equal(t, HealthHealthy, inst.Health, "expected HealthHealthy for %s", inst.AppID)
	}
}

func TestServiceGetFastPath(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"target","runtimeVersion":"1.15.0","extended":{"appPID":"200","appCommand":"go run ./cmd/target"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "other", HTTPPort: 1, Command: "go run ./cmd/other"},
			{AppID: "target", HTTPPort: port, Command: "go run ./cmd/target"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})

	// Get returns the right instance.
	inst, err := svc.Get(context.Background(), "target")
	require.NoError(t, err)
	require.Equal(t, "target", inst.AppID)
	require.True(t, inst.MetadataOK)

	// Get returns ErrNotFound for unknown appID.
	_, err = svc.Get(context.Background(), "missing")
	require.ErrorIs(t, err, ErrNotFound)
}
