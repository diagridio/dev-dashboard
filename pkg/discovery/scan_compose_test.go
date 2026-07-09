//go:build unit

package discovery

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeCRT struct {
	responses map[string][]byte // key: first two args joined by space
	errs      map[string]error
	calls     []string
}

func (f *fakeCRT) key(args []string) string {
	if len(args) >= 2 {
		return args[0] + " " + args[1]
	}
	return strings.Join(args, " ")
}

func (f *fakeCRT) Run(_ context.Context, args ...string) ([]byte, error) {
	k := f.key(args)
	f.calls = append(f.calls, k)
	if err, ok := f.errs[k]; ok {
		return nil, err
	}
	return f.responses[k], nil
}

func (f *fakeCRT) Stream(context.Context, ...string) (<-chan string, error) {
	return nil, errors.New("not used")
}

func newFakeCRT(t *testing.T) *fakeCRT {
	t.Helper()
	inspect, err := os.ReadFile("testdata/compose_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	return &fakeCRT{responses: map[string][]byte{
		"ps -q":          []byte("aaa111\nbbb222\nccc333\n"),
		"inspect aaa111": inspect,
	}}
}

func TestComposeSourceScan(t *testing.T) {
	crt := newFakeCRT(t)
	src := NewComposeSource(crt)
	results, err := src.Scanner()()
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("want 1 sidecar, got %d: %+v", len(results), results)
	}
	r := results[0]
	if r.AppID != "primes-go" || r.Source != SourceCompose {
		t.Fatalf("identity: %+v", r)
	}
	if r.HTTPPort != 3500 {
		t.Fatalf("host http port: %+v", r)
	}
	if r.GRPCPort != 0 {
		t.Fatalf("unpublished grpc port must be 0: %+v", r)
	}
	if !r.SidecarReachable {
		t.Fatalf("published http port => reachable: %+v", r)
	}
	if r.ComposeProject != "saga" || r.ComposeService != "primes-go-dapr" {
		t.Fatalf("compose labels: %+v", r)
	}
	if r.DaprdContainerID != "aaa111" || r.AppContainerID != "bbb222" || r.AppContainerName != "saga-primes-go-1" {
		t.Fatalf("container pairing: %+v", r)
	}
	if r.AppImage != "saga-primes-go" {
		t.Fatalf("app image: %+v", r)
	}
	// App runtime: fixture app container has entrypoint /app/server (no
	// command signal), image saga-primes-go (no image signal), and
	// GOLANG_VERSION in env — the env marker resolves it.
	if r.AppRuntime != "go" {
		t.Fatalf("app runtime from env marker: %+v", r)
	}
	if len(r.ResourcePaths) != 1 || r.ResourcePaths[0] != "/Users/dev/saga/components" {
		t.Fatalf("host resource path: %+v", r.ResourcePaths)
	}
	if r.ConfigPath != "/Users/dev/saga/dapr_config/config.yml" {
		t.Fatalf("host config path: %q", r.ConfigPath)
	}

	env := src.Env()
	if env.Projects["saga"].ServicePorts["postgres-db"][5432] != 5432 {
		t.Fatalf("endpoint map: %+v", env.Projects)
	}
	if proj, ok := env.ProjectForPath("/Users/dev/saga/components/statestore.yaml"); !ok || proj != "saga" {
		t.Fatalf("ProjectForPath: %q %v", proj, ok)
	}
	if _, ok := env.ProjectForPath("/somewhere/else.yaml"); ok {
		t.Fatal("foreign path must not match")
	}
}

func TestComposeSourceNilRunner(t *testing.T) {
	src := NewComposeSource(nil)
	results, err := src.Scanner()()
	if err != nil || results != nil {
		t.Fatalf("nil runner must be a silent no-op, got %v %v", results, err)
	}
}

func TestComposeSourceNoContainers(t *testing.T) {
	crt := &fakeCRT{responses: map[string][]byte{"ps -q": []byte("")}}
	src := NewComposeSource(crt)
	results, err := src.Scanner()()
	if err != nil || len(results) != 0 {
		t.Fatalf("empty ps => no results, got %v %v", results, err)
	}
}

func TestComposeSourceCachesResults(t *testing.T) {
	crt := newFakeCRT(t)
	src := NewComposeSource(crt)
	now := time.Now()
	src.clock = func() time.Time { return now }
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	callsAfterFirst := len(crt.calls)
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	if len(crt.calls) != callsAfterFirst {
		t.Fatalf("second scan within TTL must hit the cache: %v", crt.calls)
	}
	now = now.Add(3 * time.Second)
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	if len(crt.calls) == callsAfterFirst {
		t.Fatal("scan after TTL must re-exec")
	}
}

func TestComposeSourceErrorPropagates(t *testing.T) {
	crt := &fakeCRT{errs: map[string]error{"ps -q": errors.New("daemon down")}}
	src := NewComposeSource(crt)
	if _, err := src.Scanner()(); err == nil {
		t.Fatal("ps failure must surface as an error (Merge handles it)")
	}
}
