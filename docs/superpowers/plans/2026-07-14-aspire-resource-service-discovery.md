# Aspire Resource-Service Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a live Aspire discovery source that consumes the Aspire AppHost `DashboardService` resource-service gRPC (`WatchResources` + `WatchResourceConsoleLogs`), giving Aspire apps live add/remove and console logs, while coexisting with the existing `DEVDASHBOARD_APP_*` env contract as a reachability fallback.

**Architecture:** A new self-contained `pkg/aspire` package owns one gRPC connection. A background goroutine consumes `WatchResources` into a mutex-guarded snapshot cache; a projection function turns that snapshot into `[]discovery.ScanResult`; a log provider adapts `WatchResourceConsoleLogs` to `<-chan string`. The package exposes exactly two seams to the rest of the app: a `discovery.Scanner` (merged in `cmd/root.go`) and a `func(ctx, resourceName) (<-chan string, error)` log provider (wired into `pkg/server` logs handler). All gRPC/proto knowledge stays inside `pkg/aspire`.

**Tech Stack:** Go, `google.golang.org/grpc` (already vendored indirect; promoted to direct), `google.golang.org/protobuf`, protobuf well-known types (`timestamp`, `struct`). Testing with `google.golang.org/grpc/test/bufconn` + `testify`.

**Design spec:** [docs/superpowers/specs/2026-07-14-aspire-resource-service-discovery-design.md](../specs/2026-07-14-aspire-resource-service-discovery-design.md)

## Global Constraints

- Module path: `github.com/diagridio/dev-dashboard`.
- New source constant value: `SourceAspireRS = "aspire-rs"` (distinct from `SourceAspire = "aspire"`).
- Activation env vars (Aspire's own): URL from `DOTNET_RESOURCE_SERVICE_ENDPOINT_URL` or `Dashboard__ResourceServiceClient__Url`; API key from `Dashboard__ResourceServiceClient__ApiKey`; auth mode from `Dashboard__ResourceServiceClient__AuthMode` (`Unsecured` | `ApiKey`; `Certificate` → fail fast). Skip-verify escape hatch: `DEVDASHBOARD_RESOURCE_SERVICE_INSECURE_SKIP_VERIFY` (truthy = skip).
- API key is sent as gRPC metadata header `x-resource-service-api-key`.
- Base-URL resolution is the deployment-aware ladder from spec §5.3: injected `_DAPR_HTTP` → Aspire `urls` → host-perspective `127.0.0.1:<dapr-http-port>` (host process only) → empty.
- Namespace default for RS apps: `"default"`.
- Proto package `aspire.v1`; vendor the real `dashboard_service.proto` — do not hand-transcribe messages.
- Run `make build` (or `go build ./... && go vet ./...`) on every task; `vitest`-style JS is not involved. Go tests: `go test ./pkg/aspire/... ./pkg/discovery/... ./pkg/server/... ./cmd/...`.
- TDD: failing test first, minimal impl, green, commit. Keep commits small.

---

### Task 1: Vendor the proto and generate Go stubs

**Files:**
- Create: `pkg/aspire/proto/dashboard_service.proto` (downloaded verbatim)
- Create: `pkg/aspire/proto/doc.go` (holds the `//go:generate` directive + package doc)
- Create: `pkg/aspire/proto/buf.gen.yaml`
- Create (generated): `pkg/aspire/proto/dashboard_service.pb.go`, `pkg/aspire/proto/dashboard_service_grpc.pb.go`
- Modify: `go.mod`, `go.sum` (promote `google.golang.org/grpc` to direct; add `google.golang.org/protobuf`)

**Interfaces:**
- Produces: generated package `proto` (import alias `pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"`) exposing `pb.DashboardServiceClient`, `pb.NewDashboardServiceClient`, `pb.WatchResourcesRequest`, `pb.WatchResourcesUpdate`, `pb.Resource`, `pb.ConsoleLogLine`, `pb.WatchResourceConsoleLogsRequest`, `pb.WatchResourceConsoleLogsUpdate`, and the `pb.RegisterDashboardServiceServer` server hook (used by test fakes).

- [ ] **Step 1: Download the real proto**

Run:
```bash
mkdir -p pkg/aspire/proto
curl -fsSL -o pkg/aspire/proto/dashboard_service.proto \
  https://raw.githubusercontent.com/dotnet/aspire/main/src/Aspire.Hosting/Dashboard/proto/dashboard_service.proto
```
Expected: file exists, first line `syntax = "proto3";`, contains `package aspire.v1;` and `service DashboardService`.

- [ ] **Step 2: Add the codegen config + directive**

Create `pkg/aspire/proto/buf.gen.yaml`:
```yaml
version: v2
managed:
  enabled: true
  override:
    - file_option: go_package_prefix
      value: github.com/diagridio/dev-dashboard/pkg/aspire/proto
plugins:
  - remote: buf.build/protocolbuffers/go
    out: .
    opt: paths=source_relative
  - remote: buf.build/grpc/go
    out: .
    opt: paths=source_relative
```

Create `pkg/aspire/proto/doc.go`:
```go
// Package proto holds the generated Aspire DashboardService gRPC stubs.
//
// Regenerate after updating dashboard_service.proto:
//
//	cd pkg/aspire/proto && buf generate
//
//go:generate buf generate
package proto
```

- [ ] **Step 3: Generate the stubs**

Run (from `pkg/aspire/proto`):
```bash
cd pkg/aspire/proto && buf generate && cd -
```
Expected: `dashboard_service.pb.go` and `dashboard_service_grpc.pb.go` created. If `buf` is unavailable, fall back to protoc:
```bash
protoc --proto_path=pkg/aspire/proto \
  --go_out=paths=source_relative:pkg/aspire/proto \
  --go-grpc_out=paths=source_relative:pkg/aspire/proto \
  pkg/aspire/proto/dashboard_service.proto
```

- [ ] **Step 4: Tidy modules + build**

Run:
```bash
go mod tidy
go build ./...
```
Expected: PASS. `go.mod` now lists `google.golang.org/grpc` and `google.golang.org/protobuf` as direct requirements.

- [ ] **Step 5: Smoke test the generated types**

Create `pkg/aspire/proto/proto_smoke_test.go`:
```go
package proto

import "testing"

func TestGeneratedTypesExist(t *testing.T) {
	// Compile-time proof the stubs are present and usable.
	_ = &WatchResourcesRequest{}
	r := &Resource{Name: "x", ResourceType: "Executable"}
	if r.GetName() != "x" {
		t.Fatalf("getter mismatch: %q", r.GetName())
	}
	_ = &ConsoleLogLine{Text: "hello"}
	_ = &WatchResourceConsoleLogsRequest{}
}
```

Run: `go test ./pkg/aspire/proto/ -run TestGeneratedTypesExist -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/aspire/proto go.mod go.sum
git commit -m "feat(aspire): vendor DashboardService proto and generate gRPC stubs"
```

---

### Task 2: Export `ParseDaprdArgs` / `DaprdArgs` from discovery

The projection in `pkg/aspire` (Task 6) reuses the daprd-argv parser that today is unexported (`parseDaprdArgs` / `daprdArgs` in `pkg/discovery/compose_args.go`). Export it so `pkg/aspire` can call it without duplicating logic.

**Files:**
- Modify: `pkg/discovery/compose_args.go`
- Modify: `pkg/discovery/compose_runtime.go` and any other in-package callers (grep first)
- Test: existing `pkg/discovery/*_test.go` (rename references)

**Interfaces:**
- Produces: `discovery.ParseDaprdArgs(argv []string) (discovery.DaprdArgs, bool)` and the exported struct `discovery.DaprdArgs` with fields `AppID, AppChannelAddress, ResourcesPath, ConfigPath, AppProtocol string; AppPort, HTTPPort, GRPCPort int`.

- [ ] **Step 1: Find all callers**

Run: `grep -rn "parseDaprdArgs\|daprdArgs" pkg/discovery`
Expected: a small list (compose scanner + tests).

- [ ] **Step 2: Rename the symbols**

In `pkg/discovery/compose_args.go` rename `daprdArgs` → `DaprdArgs` and `func parseDaprdArgs` → `func ParseDaprdArgs` (signature otherwise identical). Update the doc comment's first word to `ParseDaprdArgs`.

- [ ] **Step 3: Update in-package callers**

Replace every `parseDaprdArgs(` with `ParseDaprdArgs(` and `daprdArgs{` / `daprdArgs)` with `DaprdArgs{` / `DaprdArgs)` across the files from Step 1 (including tests).

- [ ] **Step 4: Build + test**

Run: `go build ./... && go test ./pkg/discovery/... -run Daprd -v`
Expected: PASS (existing parser tests green under the new name).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery
git commit -m "refactor(discovery): export ParseDaprdArgs for reuse by the aspire source"
```

---

### Task 3: Aspire client config resolution

**Files:**
- Create: `pkg/aspire/config.go`
- Test: `pkg/aspire/config_test.go`

**Interfaces:**
- Produces:
  ```go
  type Config struct {
      URL                string
      APIKey             string
      AuthMode           string // "Unsecured" | "ApiKey"
      InsecureSkipVerify bool
  }
  // ConfigFromEnv resolves Config from Aspire's env vars. ok=false when no URL
  // is set (source disabled). err is non-nil only for an invalid config that is
  // present but unusable (e.g. AuthMode=Certificate).
  func ConfigFromEnv(getenv func(string) string) (cfg Config, ok bool, err error)
  ```

- [ ] **Step 1: Write the failing test**

Create `pkg/aspire/config_test.go`:
```go
package aspire

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func env(m map[string]string) func(string) string {
	return func(k string) string { return m[k] }
}

func TestConfigFromEnv(t *testing.T) {
	t.Run("absent when no URL", func(t *testing.T) {
		_, ok, err := ConfigFromEnv(env(nil))
		require.NoError(t, err)
		require.False(t, ok)
	})

	t.Run("primary URL var + api key", func(t *testing.T) {
		cfg, ok, err := ConfigFromEnv(env(map[string]string{
			"DOTNET_RESOURCE_SERVICE_ENDPOINT_URL":  "https://localhost:22000",
			"Dashboard__ResourceServiceClient__ApiKey": "secret",
		}))
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, "https://localhost:22000", cfg.URL)
		require.Equal(t, "secret", cfg.APIKey)
		require.Equal(t, "ApiKey", cfg.AuthMode) // key present ⇒ default ApiKey
	})

	t.Run("fallback URL var", func(t *testing.T) {
		cfg, ok, err := ConfigFromEnv(env(map[string]string{
			"Dashboard__ResourceServiceClient__Url": "http://localhost:1",
		}))
		require.NoError(t, err)
		require.True(t, ok)
		require.Equal(t, "http://localhost:1", cfg.URL)
		require.Equal(t, "Unsecured", cfg.AuthMode) // no key ⇒ Unsecured
	})

	t.Run("explicit AuthMode wins", func(t *testing.T) {
		cfg, _, err := ConfigFromEnv(env(map[string]string{
			"DOTNET_RESOURCE_SERVICE_ENDPOINT_URL": "http://localhost:1",
			"Dashboard__ResourceServiceClient__AuthMode": "Unsecured",
			"Dashboard__ResourceServiceClient__ApiKey":   "k",
		}))
		require.NoError(t, err)
		require.Equal(t, "Unsecured", cfg.AuthMode)
	})

	t.Run("certificate fails fast", func(t *testing.T) {
		_, _, err := ConfigFromEnv(env(map[string]string{
			"DOTNET_RESOURCE_SERVICE_ENDPOINT_URL": "http://localhost:1",
			"Dashboard__ResourceServiceClient__AuthMode": "Certificate",
		}))
		require.Error(t, err)
		require.Contains(t, err.Error(), "Certificate")
	})

	t.Run("skip verify toggle", func(t *testing.T) {
		cfg, _, err := ConfigFromEnv(env(map[string]string{
			"DOTNET_RESOURCE_SERVICE_ENDPOINT_URL":            "https://localhost:1",
			"DEVDASHBOARD_RESOURCE_SERVICE_INSECURE_SKIP_VERIFY": "true",
		}))
		require.NoError(t, err)
		require.True(t, cfg.InsecureSkipVerify)
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/aspire/ -run TestConfigFromEnv -v`
Expected: FAIL (undefined: `ConfigFromEnv`).

- [ ] **Step 3: Write minimal implementation**

Create `pkg/aspire/config.go`:
```go
package aspire

import (
	"fmt"
	"strconv"
	"strings"
)

// Config is the resolved resource-service client configuration.
type Config struct {
	URL                string
	APIKey             string
	AuthMode           string // "Unsecured" | "ApiKey"
	InsecureSkipVerify bool
}

// ConfigFromEnv resolves Config from Aspire's own env vars. ok=false when no
// endpoint URL is set (the source is simply not activated). err is returned only
// when the config is present but unusable this iteration (AuthMode=Certificate).
func ConfigFromEnv(getenv func(string) string) (Config, bool, error) {
	url := strings.TrimSpace(getenv("DOTNET_RESOURCE_SERVICE_ENDPOINT_URL"))
	if url == "" {
		url = strings.TrimSpace(getenv("Dashboard__ResourceServiceClient__Url"))
	}
	if url == "" {
		return Config{}, false, nil
	}
	key := strings.TrimSpace(getenv("Dashboard__ResourceServiceClient__ApiKey"))
	mode := strings.TrimSpace(getenv("Dashboard__ResourceServiceClient__AuthMode"))
	if mode == "" {
		if key != "" {
			mode = "ApiKey"
		} else {
			mode = "Unsecured"
		}
	}
	switch mode {
	case "Unsecured", "ApiKey":
	case "Certificate":
		return Config{}, true, fmt.Errorf("resource-service AuthMode=Certificate is not supported; use Unsecured or ApiKey")
	default:
		return Config{}, true, fmt.Errorf("resource-service AuthMode %q is not recognized", mode)
	}
	skip, _ := strconv.ParseBool(strings.TrimSpace(getenv("DEVDASHBOARD_RESOURCE_SERVICE_INSECURE_SKIP_VERIFY")))
	return Config{URL: url, APIKey: key, AuthMode: mode, InsecureSkipVerify: skip}, true, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/aspire/ -run TestConfigFromEnv -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/aspire/config.go pkg/aspire/config_test.go
git commit -m "feat(aspire): resolve resource-service client config from Aspire env vars"
```

---

### Task 4: Client connection, WatchResources snapshot cache, reconnect

**Files:**
- Create: `pkg/aspire/client.go`
- Create: `pkg/aspire/snapshot.go`
- Test: `pkg/aspire/client_test.go`
- Test helper: `pkg/aspire/fakeserver_test.go`

**Interfaces:**
- Consumes: `pb` (Task 1), `Config` (Task 3).
- Produces:
  ```go
  // snapshot is the cached resource set, keyed by resource name.
  type snapshot map[string]*pb.Resource

  type Client struct { /* unexported */ }

  // Dial builds the gRPC connection and starts the background WatchResources
  // loop. It returns as soon as the connection object exists (the first snapshot
  // may not have arrived yet — see Resources()). Close stops the loop.
  func Dial(ctx context.Context, cfg Config) (*Client, error)

  // Resources returns a copy of the last-known snapshot (nil-safe, may be empty
  // before the first update).
  func (c *Client) Resources() []*pb.Resource

  func (c *Client) Close() error
  ```
- Internal for tests: `apiKeyStreamInterceptor(key string) grpc.StreamClientInterceptor` injecting metadata `x-resource-service-api-key`.

- [ ] **Step 1: Write the fake server test helper**

Create `pkg/aspire/fakeserver_test.go`:
```go
package aspire

import (
	"context"
	"net"
	"sync"
	"testing"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
	"google.golang.org/grpc/test/bufconn"
)

// fakeService is a controllable in-memory DashboardService.
type fakeService struct {
	pb.UnimplementedDashboardServiceServer
	mu       sync.Mutex
	updates  chan *pb.WatchResourcesUpdate
	logs     map[string][]*pb.ConsoleLogLine
	gotKeys  []string // captured x-resource-service-api-key values
}

func newFakeService() *fakeService {
	return &fakeService{updates: make(chan *pb.WatchResourcesUpdate, 16), logs: map[string][]*pb.ConsoleLogLine{}}
}

func (f *fakeService) captureKey(ctx context.Context) {
	if md, ok := metadata.FromIncomingContext(ctx); ok {
		if v := md.Get("x-resource-service-api-key"); len(v) > 0 {
			f.mu.Lock()
			f.gotKeys = append(f.gotKeys, v[0])
			f.mu.Unlock()
		}
	}
}

func (f *fakeService) WatchResources(_ *pb.WatchResourcesRequest, srv pb.DashboardService_WatchResourcesServer) error {
	f.captureKey(srv.Context())
	for {
		select {
		case <-srv.Context().Done():
			return srv.Context().Err()
		case u, ok := <-f.updates:
			if !ok {
				return nil
			}
			if err := srv.Send(u); err != nil {
				return err
			}
		}
	}
}

func (f *fakeService) WatchResourceConsoleLogs(req *pb.WatchResourceConsoleLogsRequest, srv pb.DashboardService_WatchResourceConsoleLogsServer) error {
	f.captureKey(srv.Context())
	f.mu.Lock()
	lines := f.logs[req.GetResourceName()]
	f.mu.Unlock()
	if len(lines) > 0 {
		if err := srv.Send(&pb.WatchResourceConsoleLogsUpdate{LogLines: lines}); err != nil {
			return err
		}
	}
	<-srv.Context().Done()
	return srv.Context().Err()
}

// startFake spins the fake on a bufconn listener and returns a dial function.
func startFake(t *testing.T, f *fakeService) func(context.Context, string) (net.Conn, error) {
	t.Helper()
	lis := bufconn.Listen(1024 * 1024)
	srv := grpc.NewServer()
	pb.RegisterDashboardServiceServer(srv, f)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return func(context.Context, string) (net.Conn, error) { return lis.Dial() }
}

// dialFake builds a Client whose grpc.ClientConn targets the bufconn dialer. The
// target string is a passthrough placeholder; the context dialer routes to the
// in-memory listener regardless of it.
func dialFake(t *testing.T, cfg Config, dialer func(context.Context, string) (net.Conn, error)) *Client {
	t.Helper()
	c, err := dialWith(context.Background(), cfg, "passthrough:///bufnet",
		grpc.WithContextDialer(dialer), grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		t.Fatalf("dialFake: %v", err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

// resourceUpdate builds an upsert changes update for one resource.
func upsert(r *pb.Resource) *pb.WatchResourcesUpdate {
	return &pb.WatchResourcesUpdate{Kind: &pb.WatchResourcesUpdate_Changes{Changes: &pb.WatchResourcesChanges{
		Value: []*pb.WatchResourcesChange{{Kind: &pb.WatchResourcesChange_Upsert{Upsert: r}}},
	}}}
}

func deletion(name string) *pb.WatchResourcesUpdate {
	return &pb.WatchResourcesUpdate{Kind: &pb.WatchResourcesUpdate_Changes{Changes: &pb.WatchResourcesChanges{
		Value: []*pb.WatchResourcesChange{{Kind: &pb.WatchResourcesChange_Delete{Delete: &pb.ResourceDeletion{ResourceName: name}}}},
	}}}
}

func initial(rs ...*pb.Resource) *pb.WatchResourcesUpdate {
	return &pb.WatchResourcesUpdate{Kind: &pb.WatchResourcesUpdate_InitialData{InitialData: &pb.InitialResourceData{Resources: rs}}}
}
```
> Note: the exact generated oneof wrapper names (`WatchResourcesUpdate_Changes`, `WatchResourcesChange_Upsert`, etc.) come from Task 1's generated code. If they differ, adjust these helpers to match the generated identifiers.

- [ ] **Step 2: Write the failing client test**

Create `pkg/aspire/client_test.go`:
```go
package aspire

import (
	"context"
	"testing"
	"time"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"github.com/stretchr/testify/require"
)

func waitFor(t *testing.T, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("condition not met before deadline")
}

func TestClientSnapshotLifecycle(t *testing.T) {
	f := newFakeService()
	dialer := startFake(t, f)
	c := dialFake(t, Config{APIKey: "secret", AuthMode: "ApiKey"}, dialer)

	f.updates <- initial(&pb.Resource{Name: "orders-dapr", ResourceType: "Executable"})
	waitFor(t, func() bool { return len(c.Resources()) == 1 })

	f.updates <- upsert(&pb.Resource{Name: "checkout-dapr", ResourceType: "Executable"})
	waitFor(t, func() bool { return len(c.Resources()) == 2 })

	f.updates <- deletion("orders-dapr")
	waitFor(t, func() bool { return len(c.Resources()) == 1 && c.Resources()[0].GetName() == "checkout-dapr" })

	// API key propagated as metadata.
	f.mu.Lock()
	keys := append([]string(nil), f.gotKeys...)
	f.mu.Unlock()
	require.Contains(t, keys, "secret")
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/aspire/ -run TestClientSnapshotLifecycle -v`
Expected: FAIL (undefined: `Client`, `dialWith`, `Resources`).

- [ ] **Step 4: Write the snapshot cache**

Create `pkg/aspire/snapshot.go`:
```go
package aspire

import (
	"sync"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
)

// cache is a concurrency-safe last-known resource snapshot keyed by name.
type cache struct {
	mu sync.RWMutex
	m  map[string]*pb.Resource
}

func newCache() *cache { return &cache{m: map[string]*pb.Resource{}} }

func (c *cache) replaceAll(rs []*pb.Resource) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m = make(map[string]*pb.Resource, len(rs))
	for _, r := range rs {
		c.m[r.GetName()] = r
	}
}

func (c *cache) upsert(r *pb.Resource) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.m[r.GetName()] = r
}

func (c *cache) delete(name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.m, name)
}

func (c *cache) list() []*pb.Resource {
	c.mu.RLock()
	defer c.mu.RUnlock()
	out := make([]*pb.Resource, 0, len(c.m))
	for _, r := range c.m {
		out = append(out, r)
	}
	return out
}
```

- [ ] **Step 5: Write the client**

Create `pkg/aspire/client.go`:
```go
package aspire

import (
	"context"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net/url"
	"time"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"google.golang.org/grpc"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/metadata"
)

const apiKeyHeader = "x-resource-service-api-key"

func log() *slog.Logger { return slog.Default().With("component", "aspire") }

// Client owns one gRPC connection to the Aspire resource service and a
// background WatchResources loop feeding a last-known snapshot cache.
type Client struct {
	conn   *grpc.ClientConn
	rpc    pb.DashboardServiceClient
	cache  *cache
	cancel context.CancelFunc
}

// apiKeyStreamInterceptor injects the API-key metadata header on every stream.
func apiKeyStreamInterceptor(key string) grpc.StreamClientInterceptor {
	return func(ctx context.Context, desc *grpc.StreamDesc, cc *grpc.ClientConn, method string, streamer grpc.Streamer, opts ...grpc.CallOption) (grpc.ClientStream, error) {
		if key != "" {
			ctx = metadata.AppendToOutgoingContext(ctx, apiKeyHeader, key)
		}
		return streamer(ctx, desc, cc, method, opts...)
	}
}

// transportCreds derives transport credentials and the dial target (host:port)
// from the URL scheme and config.
func transportCreds(cfg Config) (credentials.TransportCredentials, string, error) {
	u, err := url.Parse(cfg.URL)
	if err != nil {
		return nil, "", fmt.Errorf("resource-service URL %q: %w", cfg.URL, err)
	}
	target := u.Host
	if target == "" {
		target = cfg.URL // bare host:port with no scheme
	}
	if u.Scheme == "https" {
		return credentials.NewTLS(&tls.Config{InsecureSkipVerify: cfg.InsecureSkipVerify}), target, nil
	}
	return insecure.NewCredentials(), target, nil
}

// Dial builds the connection and starts the background snapshot loop.
func Dial(ctx context.Context, cfg Config) (*Client, error) {
	creds, target, err := transportCreds(cfg)
	if err != nil {
		return nil, err
	}
	return dialWith(ctx, cfg, target, grpc.WithTransportCredentials(creds))
}

// dialWith is the test seam: the caller supplies the dial target and the
// transport/dialer options (bufconn tests pass a context dialer + insecure
// creds; real callers go through Dial). The API-key stream interceptor is always
// installed here so both paths authenticate identically.
func dialWith(ctx context.Context, cfg Config, target string, opts ...grpc.DialOption) (*Client, error) {
	all := append([]grpc.DialOption{
		grpc.WithChainStreamInterceptor(apiKeyStreamInterceptor(cfg.APIKey)),
	}, opts...)
	conn, err := grpc.NewClient(target, all...)
	if err != nil {
		return nil, fmt.Errorf("aspire resource service dial: %w", err)
	}
	loopCtx, cancel := context.WithCancel(context.Background())
	c := &Client{conn: conn, rpc: pb.NewDashboardServiceClient(conn), cache: newCache(), cancel: cancel}
	go c.watchLoop(loopCtx)
	return c, nil
}

// watchLoop maintains the WatchResources stream, reconnecting with backoff.
func (c *Client) watchLoop(ctx context.Context) {
	backoff := 250 * time.Millisecond
	const maxBackoff = 30 * time.Second
	for {
		if ctx.Err() != nil {
			return
		}
		err := c.streamOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			log().Warn("resource-service stream ended; reconnecting", "err", err, "backoff", backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff *= 2; backoff > maxBackoff {
			backoff = maxBackoff
		}
	}
}

// streamOnce consumes one WatchResources stream to completion or error.
func (c *Client) streamOnce(ctx context.Context) error {
	stream, err := c.rpc.WatchResources(ctx, &pb.WatchResourcesRequest{})
	if err != nil {
		return err
	}
	for {
		upd, err := stream.Recv()
		if err != nil {
			return err
		}
		c.apply(upd)
	}
}

// apply folds one update into the snapshot cache.
func (c *Client) apply(upd *pb.WatchResourcesUpdate) {
	if init := upd.GetInitialData(); init != nil {
		c.cache.replaceAll(init.GetResources())
		return
	}
	for _, ch := range upd.GetChanges().GetValue() {
		if d := ch.GetDelete(); d != nil {
			c.cache.delete(d.GetResourceName())
			continue
		}
		if r := ch.GetUpsert(); r != nil {
			c.cache.upsert(r)
		}
	}
}

// Resources returns a copy of the last-known snapshot.
func (c *Client) Resources() []*pb.Resource { return c.cache.list() }

// Close stops the background loop and closes the connection.
func (c *Client) Close() error {
	if c.cancel != nil {
		c.cancel()
	}
	return c.conn.Close()
}
```
> Note: `grpc.NewClient` (grpc ≥ v1.63) is lazy — the background loop dials on first RPC. The real `Dial` computes creds+target from the URL via `transportCreds`; the bufconn tests bypass that by passing `"passthrough:///bufnet"` as the target plus their own `grpc.WithContextDialer` + insecure creds through `dialWith`. The `ctx` parameter on `Dial`/`dialWith` is currently unused (the watch loop owns its own lifetime context) — that is intentional and Go-legal; keep it for signature symmetry and future cancellation wiring. If the installed grpc version lacks `NewClient`, use `grpc.DialContext(ctx, target, append(all, grpc.WithBlock())...)` instead.

- [ ] **Step 6: Run test to verify it passes**

Run: `go test ./pkg/aspire/ -run TestClientSnapshotLifecycle -v`
Expected: PASS. Fix any generated-identifier mismatches in the fake helpers.

- [ ] **Step 7: Add a reconnect test**

Append to `pkg/aspire/client_test.go`:
```go
func TestClientReconnectKeepsSnapshot(t *testing.T) {
	f := newFakeService()
	dialer := startFake(t, f)
	c := dialFake(t, Config{}, dialer)

	f.updates <- initial(&pb.Resource{Name: "orders-dapr", ResourceType: "Executable"})
	waitFor(t, func() bool { return len(c.Resources()) == 1 })

	// End the current stream; the loop must reconnect and the snapshot must persist.
	close(f.updates)
	f.updates = make(chan *pb.WatchResourcesUpdate, 16)
	require.Len(t, c.Resources(), 1) // last-known snapshot retained across the drop
}
```
Run: `go test ./pkg/aspire/ -run TestClient -v`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add pkg/aspire/client.go pkg/aspire/snapshot.go pkg/aspire/client_test.go pkg/aspire/fakeserver_test.go
git commit -m "feat(aspire): resource-service client with snapshot cache and reconnect"
```

---

### Task 5: Discovery source constant, log-resource fields, merge + enrich

**Files:**
- Modify: `pkg/discovery/service.go` (constant, enrich branch)
- Modify: `pkg/discovery/merge.go` (dedup generalization)
- Modify: `pkg/discovery/types.go` (Instance fields)
- Test: `pkg/discovery/merge_test.go`, `pkg/discovery/service_test.go`

**Interfaces:**
- Produces: `discovery.SourceAspireRS = "aspire-rs"`. New `ScanResult` fields `AspireDaprdResource, AspireAppResource string` and matching `Instance` fields (JSON `aspireDaprdResource`, `aspireAppResource`, both `omitempty`). Merge lets `SourceAspireRS` and `SourceAspire` both win Key() collisions.

- [ ] **Step 1: Write the failing merge test**

Add to `pkg/discovery/merge_test.go`:
```go
func TestMergeAspireRSWinsCollision(t *testing.T) {
	standalone := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone}}, nil
	}
	rs := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceAspireRS, DaprHTTPBaseURL: "http://host.docker.internal:3500"}}, nil
	}
	got, err := Merge(standalone, rs)()
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, SourceAspireRS, got[0].Source)
	require.Equal(t, "http://host.docker.internal:3500", got[0].DaprHTTPBaseURL)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestMergeAspireRSWins -v`
Expected: FAIL (undefined: `SourceAspireRS`; or the standalone entry not dropped).

- [ ] **Step 3: Add the constant**

In `pkg/discovery/service.go`, extend the const block:
```go
	// SourceAspireRS marks apps discovered live via the Aspire DashboardService
	// resource-service gRPC (WatchResources). Distinct from SourceAspire (the
	// static DEVDASHBOARD_APP_* env contract).
	SourceAspireRS = "aspire-rs"
```

- [ ] **Step 4: Generalize the merge dedup**

In `pkg/discovery/merge.go`, replace `dedupAspireWins` so both aspire sources win, and RS wins over the env contract too:
```go
// isAspireSource reports whether s is one of the Aspire-origin sources that win
// Key() collisions (they carry the reachable DaprHTTPBaseURL).
func isAspireSource(s string) bool { return s == SourceAspire || s == SourceAspireRS }

// dedupAspireWins drops non-aspire results whose Key() collides with an aspire
// result's Key(). When both SourceAspire and SourceAspireRS share a Key, the RS
// entry wins (it is live and log-capable). Order is preserved otherwise.
func dedupAspireWins(results []ScanResult) []ScanResult {
	rsKeys := make(map[string]bool)
	aspireKeys := make(map[string]bool)
	for _, r := range results {
		switch r.Source {
		case SourceAspireRS:
			rsKeys[r.Key()] = true
		case SourceAspire:
			aspireKeys[r.Key()] = true
		}
	}
	if len(rsKeys) == 0 && len(aspireKeys) == 0 {
		return results
	}
	out := make([]ScanResult, 0, len(results))
	for _, r := range results {
		key := r.Key()
		// Non-aspire results lose to any aspire result on the same key.
		if !isAspireSource(r.Source) && (rsKeys[key] || aspireKeys[key]) {
			continue
		}
		// Env-contract aspire loses to an RS result on the same key.
		if r.Source == SourceAspire && rsKeys[key] {
			continue
		}
		out = append(out, r)
	}
	return out
}
```
Also update the `Merge` doc comment: replace "When any result has Source == SourceAspire" with "When any result has an Aspire source (SourceAspire or SourceAspireRS)".

- [ ] **Step 5: Run merge test to verify it passes**

Run: `go test ./pkg/discovery/ -run TestMerge -v`
Expected: PASS.

- [ ] **Step 6: Add log-resource fields**

In `pkg/discovery/service.go` `ScanResult`, after the `Label` field add:
```go
	// AspireDaprdResource / AspireAppResource are the resource-service resource
	// names for the daprd sidecar and its app, used to stream console logs
	// (SourceAspireRS only; "" otherwise).
	AspireDaprdResource string
	AspireAppResource   string
```
In `pkg/discovery/types.go` `Instance`, after `Label`:
```go
	AspireDaprdResource string `json:"aspireDaprdResource,omitempty"`
	AspireAppResource   string `json:"aspireAppResource,omitempty"`
```

- [ ] **Step 7: Write the failing enrich test**

Add to `pkg/discovery/service_test.go`:
```go
func TestEnrichAspireRS(t *testing.T) {
	s := &service{} // no probes wired; SidecarReachable false ⇒ early return path
	in := s.enrich(context.Background(), ScanResult{
		AppID: "orders", Source: SourceAspireRS, Namespace: "default", Label: "Orders",
		AspireDaprdResource: "orders-dapr", AspireAppResource: "orders",
		DaprHTTPBaseURL: "http://host.docker.internal:3500",
	})
	require.Equal(t, SourceAspireRS, in.Source)
	require.True(t, in.IsAspire)
	require.Equal(t, "orders-dapr", in.AspireDaprdResource)
	require.Equal(t, "orders", in.AspireAppResource)
	require.False(t, in.SidecarOrphaned) // aspire sources are never orphaned
}
```

- [ ] **Step 8: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestEnrichAspireRS -v`
Expected: FAIL (fields not copied; IsAspire false).

- [ ] **Step 9: Wire enrich**

In `pkg/discovery/service.go` `enrich`, add the new fields to the initial `Instance` literal (alongside `Namespace: r.Namespace, Label: r.Label`):
```go
		AspireDaprdResource: r.AspireDaprdResource, AspireAppResource: r.AspireAppResource,
```
Extend the IsAspire branch to cover RS:
```go
	if in.Source == SourceAspire || in.Source == SourceAspireRS {
		in.IsAspire = true
	}
```
And add an RS early-return mirroring the `SourceAspire` block (the container/executable-managed case — no host PIDs/stdout/orphan). Place it next to the existing `if in.Source == SourceAspire {` block:
```go
	if in.Source == SourceAspireRS {
		// Live resource-service apps are Aspire-managed executables/containers:
		// host PIDs, stdout files, and orphan semantics don't apply. Logs come
		// from the resource-service log provider, not file paths.
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
```
> `md` is in scope only after metadata fetch; place this RS block in the SAME location as the existing `SourceAspire` block (after the metadata section, line ~320), so both behave identically. If `SidecarReachable` is false the function already returns at line ~268 before reaching here — that is fine (RS results set `SidecarReachable: true`).

- [ ] **Step 10: Run tests**

Run: `go test ./pkg/discovery/... -v`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add pkg/discovery
git commit -m "feat(discovery): SourceAspireRS constant, log-resource fields, merge+enrich handling"
```

---

### Task 6: Projection — snapshot to ScanResults

**Files:**
- Create: `pkg/aspire/projection.go`
- Test: `pkg/aspire/projection_test.go`
- Modify: `pkg/aspire/client.go` (add `Scanner`, projection config on the client)

**Interfaces:**
- Consumes: `pb`, `discovery.ParseDaprdArgs`/`discovery.DaprdArgs` (Task 2), `discovery.ScanResult`, `discovery.SourceAspireRS`.
- Produces:
  ```go
  // ProjectionConfig tunes how resources map to scan results.
  type ProjectionConfig struct {
      // Containerized gates the host-perspective argv fallback (§5.3 step 3):
      // only a host-run dashboard may reach 127.0.0.1:<dapr-http-port>.
      Containerized bool
      // DaprHTTPFallback maps app-id → injected base URL (env contract).
      DaprHTTPFallback map[string]string
  }
  // Scanner returns a discovery.Scanner projecting the client's live snapshot.
  func (c *Client) Scanner(pc ProjectionConfig) discovery.Scanner
  // project is the pure mapping (exported for tests within the package).
  func project(resources []*pb.Resource, pc ProjectionConfig) []discovery.ScanResult
  ```

- [ ] **Step 1: Write the failing projection test**

Create `pkg/aspire/projection_test.go`:
```go
package aspire

import (
	"testing"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/structpb"
)

// daprdResource builds an Executable daprd resource with the given argv exposed
// via the conventional "Args" property (a ListValue of strings) and a Parent
// relationship to appName.
func daprdResource(name, appName string, argv []string, urls ...*pb.Url) *pb.Resource {
	items := make([]*structpb.Value, len(argv))
	for i, a := range argv {
		items[i] = structpb.NewStringValue(a)
	}
	return &pb.Resource{
		Name: name, ResourceType: "Executable", DisplayName: name,
		Properties: []*pb.ResourceProperty{{
			Name:  "executable.args",
			Value: structpb.NewListValue(&structpb.ListValue{Values: items}),
		}},
		Relationships: []*pb.ResourceRelationship{{ResourceName: appName, Type: "Parent"}},
		Urls:          urls,
	}
}

func TestProjectFiltersToDaprd(t *testing.T) {
	rs := []*pb.Resource{
		{Name: "frontend", ResourceType: "Project"}, // not daprd
		daprdResource("orders-dapr", "orders",
			[]string{"daprd", "--app-id", "orders", "--dapr-http-port", "3500"}),
	}
	out := project(rs, ProjectionConfig{Containerized: false})
	require.Len(t, out, 1)
	require.Equal(t, "orders", out[0].AppID)
	require.Equal(t, discovery.SourceAspireRS, out[0].Source)
	require.Equal(t, "orders-dapr", out[0].AspireDaprdResource)
	require.Equal(t, "orders", out[0].AspireAppResource)
	require.Equal(t, "default", out[0].Namespace)
	require.Equal(t, "orders", out[0].Label) // display_name of the app parent (falls back to app-id)
}

func TestProjectBaseURLLadder(t *testing.T) {
	argv := []string{"daprd", "--app-id", "orders", "--dapr-http-port", "3500"}

	t.Run("injected fallback wins", func(t *testing.T) {
		out := project([]*pb.Resource{daprdResource("orders-dapr", "orders", argv)},
			ProjectionConfig{Containerized: true, DaprHTTPFallback: map[string]string{"orders": "http://host.docker.internal:9000"}})
		require.Equal(t, "http://host.docker.internal:9000", out[0].DaprHTTPBaseURL)
	})

	t.Run("urls next", func(t *testing.T) {
		out := project([]*pb.Resource{daprdResource("orders-dapr", "orders", argv,
			&pb.Url{FullUrl: "http://host.docker.internal:12345", EndpointName: "dapr-http"})},
			ProjectionConfig{Containerized: true})
		require.Equal(t, "http://host.docker.internal:12345", out[0].DaprHTTPBaseURL)
	})

	t.Run("argv localhost when host process", func(t *testing.T) {
		out := project([]*pb.Resource{daprdResource("orders-dapr", "orders", argv)},
			ProjectionConfig{Containerized: false})
		require.Equal(t, "http://127.0.0.1:3500", out[0].DaprHTTPBaseURL)
	})

	t.Run("empty when containerized and no explicit source", func(t *testing.T) {
		out := project([]*pb.Resource{daprdResource("orders-dapr", "orders", argv)},
			ProjectionConfig{Containerized: true})
		require.Equal(t, "", out[0].DaprHTTPBaseURL)
	})
}
```
> Note: the property name carrying argv (`executable.args` here) and the URL endpoint naming are Aspire conventions confirmed during the deciding spike (spec §10). `argvFromResource` (Step 3) centralizes this so a single place changes if the convention differs.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/aspire/ -run TestProject -v`
Expected: FAIL (undefined: `project`, `ProjectionConfig`).

- [ ] **Step 3: Write the projection**

Create `pkg/aspire/projection.go`:
```go
package aspire

import (
	"fmt"
	"strings"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"google.golang.org/protobuf/types/known/structpb"
)

// ProjectionConfig tunes how resources map to scan results.
type ProjectionConfig struct {
	Containerized    bool
	DaprHTTPFallback map[string]string
}

// argvFromResource extracts the launch argv from a resource's properties. Aspire
// exposes an Executable's arguments as a ListValue property; this centralizes the
// property lookup so a convention change touches one place.
func argvFromResource(r *pb.Resource) []string {
	for _, p := range r.GetProperties() {
		name := strings.ToLower(p.GetName())
		if !strings.Contains(name, "arg") {
			continue
		}
		lv := p.GetValue().GetListValue()
		if lv == nil {
			continue
		}
		out := make([]string, 0, len(lv.GetValues()))
		for _, v := range lv.GetValues() {
			out = append(out, valueString(v))
		}
		if len(out) > 0 {
			return out
		}
	}
	return nil
}

func valueString(v *structpb.Value) string {
	if s, ok := v.GetKind().(*structpb.Value_StringValue); ok {
		return s.StringValue
	}
	return v.String()
}

// parentApp returns the resource name of the "Parent" relationship, if any.
func parentApp(r *pb.Resource) string {
	for _, rel := range r.GetRelationships() {
		if strings.EqualFold(rel.GetType(), "Parent") {
			return rel.GetResourceName()
		}
	}
	return ""
}

// daprHTTPURL returns the resource's dapr-http endpoint url, if present.
func daprHTTPURL(r *pb.Resource) string {
	for _, u := range r.GetUrls() {
		if u.GetIsInternal() {
			continue
		}
		if strings.Contains(strings.ToLower(u.GetEndpointName()), "dapr") || len(r.GetUrls()) == 1 {
			if u.GetFullUrl() != "" {
				return u.GetFullUrl()
			}
		}
	}
	return ""
}

// resolveBaseURL applies the deployment-aware ladder (spec §5.3).
func resolveBaseURL(appID string, httpPort int, r *pb.Resource, pc ProjectionConfig) string {
	if v := pc.DaprHTTPFallback[appID]; v != "" {
		return v
	}
	if v := daprHTTPURL(r); v != "" {
		return v
	}
	if !pc.Containerized && httpPort != 0 {
		return fmt.Sprintf("http://127.0.0.1:%d", httpPort)
	}
	return ""
}

// displayName returns app's display name from the snapshot, falling back to id.
func displayName(byName map[string]*pb.Resource, appResource, appID string) string {
	if r, ok := byName[appResource]; ok && r.GetDisplayName() != "" {
		return r.GetDisplayName()
	}
	if appID != "" {
		return appID
	}
	return appResource
}

// project maps a resource snapshot to discovery scan results (Dapr sidecars only).
func project(resources []*pb.Resource, pc ProjectionConfig) []discovery.ScanResult {
	byName := make(map[string]*pb.Resource, len(resources))
	for _, r := range resources {
		byName[r.GetName()] = r
	}
	var out []discovery.ScanResult
	for _, r := range resources {
		switch r.GetResourceType() {
		case "Executable", "Container":
		default:
			continue
		}
		args := argvFromResource(r)
		d, ok := discovery.ParseDaprdArgs(args)
		if !ok || d.AppID == "" {
			continue
		}
		appResource := parentApp(r)
		out = append(out, discovery.ScanResult{
			AppID:               d.AppID,
			HTTPPort:            d.HTTPPort,
			GRPCPort:            d.GRPCPort,
			AppPort:             d.AppPort,
			ResourcePaths:       nonEmpty(d.ResourcesPath),
			ConfigPath:          d.ConfigPath,
			AppProtocol:         d.AppProtocol,
			Source:              discovery.SourceAspireRS,
			Namespace:           "default",
			Label:               displayName(byName, appResource, d.AppID),
			DaprHTTPBaseURL:     resolveBaseURL(d.AppID, d.HTTPPort, r, pc),
			AspireDaprdResource: r.GetName(),
			AspireAppResource:   appResource,
			SidecarReachable:    true,
		})
	}
	return out
}

func nonEmpty(s string) []string {
	if s == "" {
		return nil
	}
	return []string{s}
}
```

- [ ] **Step 4: Add the client Scanner method**

Append to `pkg/aspire/client.go`:
```go
// Scanner returns a discovery.Scanner projecting the live snapshot on each call.
func (c *Client) Scanner(pc ProjectionConfig) discovery.Scanner {
	return func() ([]discovery.ScanResult, error) {
		return project(c.Resources(), pc), nil
	}
}
```
Add the import `"github.com/diagridio/dev-dashboard/pkg/discovery"` to `client.go`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/aspire/ -run TestProject -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/aspire/projection.go pkg/aspire/projection_test.go pkg/aspire/client.go
git commit -m "feat(aspire): project resource snapshot to discovery scan results"
```

---

### Task 7: Console-log provider

**Files:**
- Create: `pkg/aspire/logs.go`
- Test: `pkg/aspire/logs_test.go`

**Interfaces:**
- Produces:
  ```go
  // Logs opens a WatchResourceConsoleLogs stream for resourceName and returns a
  // channel of rendered lines. The channel closes when ctx is cancelled or the
  // stream ends. stderr lines are prefixed nowhere — the caller normalizes.
  func (c *Client) Logs(ctx context.Context, resourceName string) (<-chan string, error)
  ```

- [ ] **Step 1: Write the failing test**

Create `pkg/aspire/logs_test.go`:
```go
package aspire

import (
	"context"
	"testing"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
	"github.com/stretchr/testify/require"
)

func TestLogsStreamsLines(t *testing.T) {
	f := newFakeService()
	f.logs["orders-dapr"] = []*pb.ConsoleLogLine{
		{Text: "starting daprd"},
		{Text: "listening on 3500"},
	}
	dialer := startFake(t, f)
	c := dialFake(t, Config{APIKey: "secret", AuthMode: "ApiKey"}, dialer)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := c.Logs(ctx, "orders-dapr")
	require.NoError(t, err)

	require.Equal(t, "starting daprd", <-ch)
	require.Equal(t, "listening on 3500", <-ch)

	cancel()
	// Draining after cancel must not block indefinitely; channel closes.
	for range ch {
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/aspire/ -run TestLogsStreams -v`
Expected: FAIL (undefined: `Logs`).

- [ ] **Step 3: Write the implementation**

Create `pkg/aspire/logs.go`:
```go
package aspire

import (
	"context"

	pb "github.com/diagridio/dev-dashboard/pkg/aspire/proto"
)

// Logs streams a resource's console logs as rendered text lines. The returned
// channel is closed when ctx is cancelled or the upstream stream terminates.
func (c *Client) Logs(ctx context.Context, resourceName string) (<-chan string, error) {
	stream, err := c.rpc.WatchResourceConsoleLogs(ctx, &pb.WatchResourceConsoleLogsRequest{ResourceName: resourceName})
	if err != nil {
		return nil, err
	}
	out := make(chan string, 64)
	go func() {
		defer close(out)
		for {
			upd, err := stream.Recv()
			if err != nil {
				return
			}
			for _, ln := range upd.GetLogLines() {
				select {
				case out <- ln.GetText():
				case <-ctx.Done():
					return
				}
			}
		}
	}()
	return out, nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/aspire/ -run TestLogsStreams -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/aspire/logs.go pkg/aspire/logs_test.go
git commit -m "feat(aspire): console-log provider over WatchResourceConsoleLogs"
```

---

### Task 8: Server logs handler branch for SourceAspireRS

**Files:**
- Modify: `pkg/server/logs.go` (source branch + format normalization)
- Modify: `pkg/server/server.go` (Options field + pass into logsHandler)
- Test: `pkg/server/logs_test.go` (or `server_test.go`)

**Interfaces:**
- Consumes: `discovery.SourceAspireRS`, `Instance.AspireDaprdResource`/`AspireAppResource`.
- Produces: `server.Options.AspireLogs func(ctx context.Context, resourceName string) (<-chan string, error)`; new format constant `logFormatAspireRS = "aspire"`.

- [ ] **Step 1: Locate the Options struct + logsHandler call**

Run: `grep -n "ContainerLogs\|logsHandler\|type Options" pkg/server/server.go`
Expected: shows where `ContainerLogs` is declared on `Options` and where `logsHandler(svc, opts.ContainerLogs)` is registered.

- [ ] **Step 2: Write the failing handler test**

Add to `pkg/server/logs_test.go` (create if absent) a test that a `SourceAspireRS` instance streams from `AspireLogs`:
```go
func TestLogsHandlerAspireRS(t *testing.T) {
	// Fake discovery.Service returning one SourceAspireRS instance.
	svc := fakeAppsService{inst: discovery.Instance{
		AppID: "orders", InstanceKey: "orders", Source: discovery.SourceAspireRS,
		SidecarReachable: true, AspireDaprdResource: "orders-dapr", AspireAppResource: "orders",
	}}
	aspireLogs := func(ctx context.Context, resource string) (<-chan string, error) {
		require.Equal(t, "orders-dapr", resource) // daprd source by default
		ch := make(chan string, 1)
		ch <- "hello from daprd"
		close(ch)
		return ch, nil
	}
	h := logsHandler(svc, nil, aspireLogs)

	req := httptest.NewRequest("GET", "/api/apps/orders/logs", nil)
	req = withURLParam(req, "appId", "orders")
	rec := httptest.NewRecorder()
	h(rec, req)

	require.Equal(t, http.StatusOK, rec.Code)
	require.Contains(t, rec.Body.String(), "data: hello from daprd")
}
```
> Reuse the existing test's fake `discovery.Service` and `withURLParam` chi helper if present; otherwise add minimal versions mirroring the container-logs test in this file.

- [ ] **Step 3: Run test to verify it fails**

Run: `go test ./pkg/server/ -run TestLogsHandlerAspireRS -v`
Expected: FAIL (logsHandler signature mismatch / undefined AspireLogs).

- [ ] **Step 4: Extend logsHandler**

In `pkg/server/logs.go`:
- Add the format constant near `logFormatDCP`'s usage: `const logFormatAspireRS = "aspire"`.
- Change the signature to `func logsHandler(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), aspireLogs func(context.Context, string) (<-chan string, error)) http.HandlerFunc`.
- Before the compose/testcontainers branch, add:
```go
		if in.Source == discovery.SourceAspireRS {
			resource := in.AspireDaprdResource
			if source == "app" {
				resource = in.AspireAppResource
			}
			if resource == "" || aspireLogs == nil {
				log.Warn("aspire log source unavailable", "app", appID, "source", source)
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "no logs for this app/source"})
				return
			}
			ch, err = aspireLogs(req.Context(), resource)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
			format = logFormatAspireRS
		} else if in.Source == discovery.SourceCompose || in.Source == discovery.SourceTestcontainers {
```
(i.e. fold the existing compose/testcontainers `if` into an `else if`). The rest of the SSE loop is unchanged.
- In `normalizeLine`, treat `logFormatAspireRS` like a plain line (ANSI strip only — already the default), so no change needed beyond passing the format through.

- [ ] **Step 5: Add the Options field and wire it**

In `pkg/server/server.go`:
- Add to `Options`:
```go
	// AspireLogs streams a resource's console logs via the Aspire resource
	// service (SourceAspireRS apps); nil when the source is inactive.
	AspireLogs func(ctx context.Context, resourceName string) (<-chan string, error)
```
- Update the `logsHandler(...)` registration to pass `opts.AspireLogs` as the third argument.

- [ ] **Step 6: Run tests**

Run: `go test ./pkg/server/... -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pkg/server
git commit -m "feat(server): stream Aspire resource-service console logs for SourceAspireRS apps"
```

---

### Task 9: Wire the source into cmd/root.go

**Files:**
- Modify: `cmd/root.go` (both the `containerPosture` branch and the `default` branch)
- Modify: `cmd/serve.go` (thread `AspireLogs` into `assembleOptions` → `server.Options`)
- Create: `cmd/aspire_source.go` (small helpers: build client, base-URL fallback map)
- Test: `cmd/aspire_source_test.go`

**Interfaces:**
- Consumes: `aspire.ConfigFromEnv`, `aspire.Dial`, `aspire.ProjectionConfig`, `Client.Scanner`, `Client.Logs`, `contractNamespaces` (existing), and the env-contract scanner.
- Produces: an activated RS scanner appended to the merge, `serveDeps.AspireLogs` set, and `Client.Close` appended to closers.

- [ ] **Step 1: Write the failing helper test**

Create `cmd/aspire_source_test.go`:
```go
package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestContractBaseURLs(t *testing.T) {
	scan := discovery.Scanner(func() ([]discovery.ScanResult, error) {
		return []discovery.ScanResult{
			{AppID: "orders", DaprHTTPBaseURL: "http://host.docker.internal:9000", Source: discovery.SourceAspire},
			{AppID: "checkout", Source: discovery.SourceAspire}, // no base url ⇒ omitted
		}, nil
	})
	got := contractBaseURLs(scan)
	require.Equal(t, map[string]string{"orders": "http://host.docker.internal:9000"}, got)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestContractBaseURLs -v`
Expected: FAIL (undefined: `contractBaseURLs`).

- [ ] **Step 3: Write the helper**

Create `cmd/aspire_source.go`:
```go
package cmd

import "github.com/diagridio/dev-dashboard/pkg/discovery"

// contractBaseURLs maps app-id → injected DaprHTTPBaseURL from the env-contract
// scanner, used as the reachability fallback for the resource-service source
// (spec §5.3 step 1). Apps without an injected base URL are omitted.
func contractBaseURLs(scan discovery.Scanner) map[string]string {
	if scan == nil {
		return nil
	}
	res, err := scan()
	if err != nil {
		return nil
	}
	out := map[string]string{}
	for _, r := range res {
		if r.DaprHTTPBaseURL != "" {
			out[r.AppID] = r.DaprHTTPBaseURL
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./cmd/ -run TestContractBaseURLs -v`
Expected: PASS.

- [ ] **Step 5: Add the AspireLogs field to serveDeps and thread it**

In `cmd/serve.go`:
- Add to `serveDeps`:
```go
	// AspireLogs streams console logs for SourceAspireRS apps; nil when the
	// resource-service source is inactive.
	AspireLogs func(ctx context.Context, resourceName string) (<-chan string, error)
```
- In `assembleOptions`, set `AspireLogs: deps.AspireLogs,` in the returned `server.Options{...}`.

- [ ] **Step 6: Activate the source in root.go**

In `cmd/root.go`, add these locals near the other `var (...)` declarations in `runServe`:
```go
		aspireLogs func(context.Context, string) (<-chan string, error)
		aspireClose func() error
```
In the `default:` branch, hoist a `contractScan` var so the RS fallback can reuse the env-contract scanner already built for `src.AspireContract`. Change the existing block from:
```go
			if src.AspireContract {
				as, err := discovery.NewAspireScanner(os.Getenv)
				if err != nil {
					return err
				}
				appNS = contractNamespaces(as)
				scanners = append(scanners, as)
			}
```
to:
```go
			var contractScan discovery.Scanner
			if src.AspireContract {
				as, err := discovery.NewAspireScanner(os.Getenv)
				if err != nil {
					return err
				}
				appNS = contractNamespaces(as)
				contractScan = as
				scanners = append(scanners, as)
			}
			if cfg, ok, err := aspire.ConfigFromEnv(os.Getenv); err != nil {
				return err
			} else if ok {
				cl, err := aspire.Dial(ctx, cfg)
				if err != nil {
					return err
				}
				aspireClose = cl.Close
				scanners = append(scanners, cl.Scanner(aspire.ProjectionConfig{
					Containerized:    false,
					DaprHTTPFallback: contractBaseURLs(contractScan), // nil-safe when no env contract
				}))
				aspireLogs = cl.Logs
			}
```
In the `case containerPosture:` branch, after `appsSvc = discovery.New(scan, client)`, insert:
```go
			if cfg, ok, err := aspire.ConfigFromEnv(os.Getenv); err != nil {
				return err
			} else if ok {
				cl, err := aspire.Dial(ctx, cfg)
				if err != nil {
					return err
				}
				aspireClose = cl.Close
				merged := discovery.Merge(scan, cl.Scanner(aspire.ProjectionConfig{
					Containerized: true, DaprHTTPFallback: contractBaseURLs(scan),
				}))
				appsSvc = discovery.New(merged, client)
				aspireLogs = cl.Logs
			}
```
Add `"github.com/diagridio/dev-dashboard/pkg/aspire"` to the imports.
Pass `AspireLogs: aspireLogs,` into the `serveDeps{...}` literal.
After the existing `for _, close := range closers { ... }` deferred-close block, add:
```go
	if aspireClose != nil {
		defer func() { _ = aspireClose() }()
	}
```

- [ ] **Step 7: Verify no new discovery helper was introduced**

Confirm the RS fallback reuses the existing `discovery.NewAspireScanner` via the hoisted `contractScan` var (Step 6) and that `contractBaseURLs(nil)` is safe (Task 9 Step 3 returns nil for a nil scanner). Run: `grep -n "NewAspireScannerMust" cmd/` — expected: no matches.

- [ ] **Step 8: Build + vet + full test**

Run:
```bash
go build ./... && go vet ./...
go test ./cmd/... ./pkg/aspire/... ./pkg/discovery/... ./pkg/server/... -v
```
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add cmd
git commit -m "feat(cmd): activate the Aspire resource-service source in host and container postures"
```

---

### Task 10: Frontend source label + docs + manual validation

**Files:**
- Modify: `web/src/lib/modeLabel.ts` (+ `web/src/lib/modeLabel.test.ts`) if it maps `source` values to display labels — add `aspire-rs`
- Modify: `web/src/types/api.ts` if the `Instance` TS type enumerates `source` — add `"aspire-rs"` and the two new optional fields
- Modify: `README.md` (or the aspire docs section) — document standalone activation
- Test: existing `web` vitest suite

**Interfaces:**
- Consumes: the `SourceAspireRS` wire value `"aspire-rs"`, `aspireDaprdResource`, `aspireAppResource` JSON fields.

- [ ] **Step 1: Check the frontend source-label mapping**

Run: `grep -rn "aspire\|source" web/src/lib/modeLabel.ts web/src/types/api.ts`
Expected: find where `source` is typed/labelled.

- [ ] **Step 2: Add the label + type (write failing vitest first if a test maps labels)**

If `modeLabel.test.ts` asserts label mappings, add:
```ts
it("labels aspire-rs apps", () => {
  expect(sourceLabel("aspire-rs")).toBe("Aspire");
});
```
Then extend `sourceLabel` (and the `Source` union in `api.ts`) so `"aspire-rs"` maps to `"Aspire"` (same display as `"aspire"`), and add optional `aspireDaprdResource?: string; aspireAppResource?: string;` to the `Instance` type.

- [ ] **Step 3: Run the frontend build + tests**

Run: `cd web && npm run test -- --run modeLabel && npm run build && cd -`
Expected: PASS. (Per the vitest-no-typecheck memory, run the TS build too.)

- [ ] **Step 4: Document standalone activation**

Add a short subsection to the README's Aspire section:
```markdown
### Discovering an Aspire app in standalone mode

Run the dashboard on the host (no container) and point it at your AppHost's
resource service — the same endpoint the standalone Aspire dashboard uses:

    export DOTNET_RESOURCE_SERVICE_ENDPOINT_URL=https://localhost:22000
    export Dashboard__ResourceServiceClient__ApiKey=<key-from-apphost-output>
    diagrid-dev-dashboard

The dashboard discovers Dapr sidecars live from the resource service and reaches
each daprd at 127.0.0.1:<dapr-http-port> (no container-perspective rewrite is
needed when the dashboard shares the host).
```

- [ ] **Step 5: Commit**

```bash
git add web README.md
git commit -m "feat(web,docs): label aspire-rs source and document standalone resource-service setup"
```

- [ ] **Step 6: Manual validation — the deciding spike (spec §10)**

This step needs a real AppHost with a `.WithDaprSidecar()` app; it is a manual check, not an automated test. Record the outcome in the design spec's §10.

1. Start an Aspire AppHost that adds a Dapr sidecar to at least one app.
2. From the AppHost startup output, copy the resource-service URL + API key.
3. Run the dashboard standalone with the two env vars set (README Step 4).
4. Confirm: the app appears in the dashboard; its health/metadata resolve (proving `127.0.0.1:<dapr-http-port>` is reachable); logs stream on the app's Logs page.
5. Inspect the resource in the AppHost dashboard / logs to answer the spike: does the daprd `ExecutableResource` expose a `urls` entry for its HTTP port? Note yes/no in spec §10 so the container-mode fallback expectations are confirmed.

- [ ] **Step 7: Commit the spike outcome**

```bash
git add docs/superpowers/specs/2026-07-14-aspire-resource-service-discovery-design.md
git commit -m "docs(aspire): record resource-service endpoint spike outcome"
```

---

## Notes for the implementer

- **Generated identifiers:** Task 4's fake-server helpers reference oneof wrapper types (`WatchResourcesUpdate_Changes`, `WatchResourcesChange_Upsert`, `WatchResourcesChange_Delete`, `WatchResourcesUpdate_InitialData`). These names come from Task 1's generated code — if protoc/buf emits different casing, adjust the helpers to match. Everything else keys off getter methods (`GetName()`, `GetLogLines()`, etc.) which are stable.
- **grpc version:** `grpc.NewClient` requires grpc ≥ v1.63. `go.mod` already carries a recent grpc (indirect). If `go build` reports `NewClient` undefined, use the `grpc.DialContext` fallback noted in Task 4 Step 5.
- **No host-process assumptions for RS:** SourceAspireRS never goes through the standalone/orphan logic (Task 5 enrich branch), and never touches gopsutil — the whole point is to stop depending on process inspection for Aspire.
- **Coexistence:** the env-contract (`SourceAspire`) and heuristic host-scan remain untouched; RS wins Key() collisions so a doubly-discovered app shows once with live data.
