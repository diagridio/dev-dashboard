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
