//go:build unit

package discovery

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestCheckHealthHealthy(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(204) }))
	t.Cleanup(srv.Close)
	require.Equal(t, HealthHealthy, CheckHealth(context.Background(), &http.Client{Timeout: time.Second}, srv.URL))
}

func TestCheckHealthUnhealthy(t *testing.T) {
	require.Equal(t, HealthUnhealthy, CheckHealth(context.Background(), &http.Client{Timeout: 100 * time.Millisecond}, "http://127.0.0.1:1")) // nothing listening on port 1
}

func TestSidecarBaseURL(t *testing.T) {
	if got := sidecarBaseURL("", 3500); got != "http://127.0.0.1:3500" {
		t.Fatalf("port fallback: %q", got)
	}
	if got := sidecarBaseURL("http://orders-dapr:3500", 0); got != "http://orders-dapr:3500" {
		t.Fatalf("base passthrough: %q", got)
	}
	if got := sidecarBaseURL("http://orders-dapr:3500/", 0); got != "http://orders-dapr:3500" {
		t.Fatalf("trailing slash: %q", got)
	}
}
