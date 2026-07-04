//go:build integration

package cmd

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// fakeComposeRunner serves canned ps/inspect payloads.
type fakeComposeRunner struct{ ps, inspect []byte }

func (f *fakeComposeRunner) Run(_ context.Context, args ...string) ([]byte, error) {
	if args[0] == "ps" {
		return f.ps, nil
	}
	return f.inspect, nil
}
func (f *fakeComposeRunner) Stream(context.Context, ...string) (<-chan string, error) {
	ch := make(chan string, 1)
	ch <- "container log line"
	close(ch)
	return ch, nil
}

// composeInspectJSON builds a two-container inspect array:
//   - a daprd sidecar that mounts dir as /components with -resources-path /components
//   - a redis service whose container port 6379 is published at hostPort
func composeInspectJSON(t *testing.T, dir, hostPort string) []byte {
	t.Helper()
	return []byte(fmt.Sprintf(`[
  {
    "Id": "sc1",
    "Name": "/myapp-daprd-1",
    "State": { "Status": "running", "StartedAt": "2026-07-04T09:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.15.0",
      "Labels": {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "daprd"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "-app-id", "myapp", "-app-channel-address", "myapp", "-app-port", "8080", "-dapr-http-port", "3500", "-dapr-grpc-port", "50001", "-resources-path", "/components"]
    },
    "NetworkSettings": { "Ports": { "3500/tcp": [ { "HostIp": "0.0.0.0", "HostPort": "3500" } ], "50001/tcp": null } },
    "Mounts": [
      { "Type": "bind", "Source": %q, "Destination": "/components" }
    ]
  },
  {
    "Id": "rd1",
    "Name": "/myapp-redis-1",
    "State": { "Status": "running", "StartedAt": "2026-07-04T08:59:50.000000000Z" },
    "Config": {
      "Image": "redis:7-alpine",
      "Labels": {
        "com.docker.compose.project": "myapp",
        "com.docker.compose.service": "redis"
      },
      "Entrypoint": ["docker-entrypoint.sh"],
      "Cmd": ["redis-server"]
    },
    "NetworkSettings": { "Ports": { "6379/tcp": [ { "HostIp": "0.0.0.0", "HostPort": %q } ] } },
    "Mounts": []
  }
]`, dir, hostPort))
}

// noDialTransport is an http.RoundTripper that fails immediately, so enrichment
// degrades fast without real network dials.
type noDialTransport struct{}

func (noDialTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, errors.New("no-dial: enrichment intentionally disabled for this test")
}

// httpClientNoDial returns an http.Client whose transport errors immediately.
func httpClientNoDial(_ *testing.T) *http.Client {
	return &http.Client{Transport: noDialTransport{}}
}

func TestComposeStoreElectionWithTranslation(t *testing.T) {
	mr := miniredis.RunT(t)
	hostPort := mr.Port() // string

	dir := t.TempDir()
	yaml := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: redis:6379`
	if err := os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}

	// Compose inspect payload: one daprd sidecar mounting dir as /components,
	// plus a redis service whose 6379 is "published" at miniredis's port.
	inspect := composeInspectJSON(t, dir, hostPort) // helper below
	src := discovery.NewComposeSource(&fakeComposeRunner{
		ps:      []byte("sc1\nrd1\n"),
		inspect: inspect,
	})
	apps := discovery.New(src.Scanner(), httpClientNoDial(t)) // enrichment fails fast; scan data suffices

	pool := newConnPool("default", nil, apps, nil)
	registry := LoadRegistry(t.TempDir())
	rc := newReconciler(context.Background(), apps, "default", "", "", nil, registry, pool, src.Env)
	defer rc.Close()

	got, err := apps.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rc.reconcile(got, appsFingerprint(got))

	active := rc.activeComponent()
	if active == nil || active.Name != "statestore" {
		t.Fatalf("active store: %+v", active)
	}
	translated := rc.translate(*active)
	if !strings.HasSuffix(translated.Metadata["redisHost"], hostPort) {
		t.Fatalf("expected translation to miniredis port %s, got %q", hostPort, translated.Metadata["redisHost"])
	}
	// The pre-warm in reconcile already connected through the pool; a working
	// ServiceFor("") proves the translated address actually dials.
	svc, _, _, ok := rc.ServiceFor("")
	if !ok || svc == nil {
		t.Fatal("ServiceFor must resolve the elected store")
	}
}
