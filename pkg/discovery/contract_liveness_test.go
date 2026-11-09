//go:build unit

package discovery

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// sidecarWithMetadata serves healthz plus a metadata body.
func sidecarWithMetadata(t *testing.T, body string) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/healthz") {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestContractAppProbeAddr(t *testing.T) {
	tests := []struct {
		name, base, channel string
		port                int
		want                string
	}{
		// Shared network namespace: daprd reaches the app on loopback, so
		// the dashboard reaches it at the namespace owner's service name.
		{"loopback channel uses sidecar host", "http://order-app:3500", "127.0.0.1", 5001, "order-app:5001"},
		{"localhost channel uses sidecar host", "http://order-app:3500", "localhost", 5001, "order-app:5001"},
		{"empty channel uses sidecar host", "http://order-dapr:3500", "", 5001, "order-dapr:5001"},
		{"separate service uses channel address", "http://order-dapr:3500", "order-app", 5001, "order-app:5001"},
		{"no port is not probed", "http://order-dapr:3500", "127.0.0.1", 0, ""},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := contractAppProbeAddr(tc.base, tc.channel, tc.port); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

// Contract apps (compose and aspire container posture) get an app status from
// what the sidecar network can observe: a TCP probe of the app port, else a connected workflow worker,
// else unknown ("") rather than implying the app is up.
func TestContractComposeAppStatus(t *testing.T) {
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	openPort := lis.Addr().(*net.TCPAddr).Port
	t.Cleanup(func() { _ = lis.Close() })
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedPort := closed.Addr().(*net.TCPAddr).Port
	_ = closed.Close()

	portBody := func(p int) string {
		return fmt.Sprintf(`{"id":"order","runtimeVersion":"1.19.1","appConnectionProperties":{"port":%d,"protocol":"http","channelAddress":"127.0.0.1"}}`, p)
	}
	tests := []struct {
		name     string
		body     string
		wantApp  string
		wantPort int
	}{
		{"app port open", portBody(openPort), StatusRunning, openPort},
		{"app port closed", portBody(closedPort), StatusStopped, closedPort},
		{"worker connected, no port", `{"id":"order","workflows":{"connectedWorkers":1}}`, StatusRunning, 0},
		{"no port, no worker", `{"id":"order","appConnectionProperties":{"protocol":"http","channelAddress":"127.0.0.1"}}`, "", 0},
	}
	for _, source := range []string{SourceCompose, SourceAspire} {
		for _, tc := range tests {
			t.Run(source+"/"+tc.name, func(t *testing.T) {
				sc := sidecarWithMetadata(t, tc.body)
				in := contractInstanceFor(t, source, sc.URL)
				if in.AppStatus != tc.wantApp {
					t.Fatalf("AppStatus = %q want %q", in.AppStatus, tc.wantApp)
				}
				if in.AppPort != tc.wantPort {
					t.Fatalf("AppPort = %d want %d", in.AppPort, tc.wantPort)
				}
				if in.Health != HealthHealthy {
					t.Fatalf("Health = %q", in.Health)
				}
			})
		}
	}
}
