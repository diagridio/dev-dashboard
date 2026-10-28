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

func TestInstanceBaseURL(t *testing.T) {
	require.Equal(t, "http://127.0.0.1:3500", Instance{HTTPPort: 3500}.BaseURL())
	require.Equal(t, "http://proxy:8080", Instance{DaprHTTPBaseURL: "http://proxy:8080/", HTTPPort: 3500}.BaseURL())
}

func TestInstanceGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		in   Instance
		want string
	}{
		{
			name: "contract address wins over port",
			in:   Instance{DaprGRPCAddr: "order-dapr:50001", GRPCPort: 9999},
			want: "order-dapr:50001",
		},
		{
			name: "no contract address falls back to loopback port",
			in:   Instance{GRPCPort: 58445},
			want: "127.0.0.1:58445",
		},
		{
			name: "neither available yields empty",
			in:   Instance{},
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.in.GRPCAddr(); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
