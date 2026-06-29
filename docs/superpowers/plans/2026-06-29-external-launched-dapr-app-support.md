# External-launched (incl. Aspire) Dapr App Support — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the dashboard read workflow state from the store an app actually loaded, and label the runtime of apps whose daprd carries no app-command (e.g. .NET Aspire).

**Architecture:** Two independent, general bug fixes. (1) The single-active-state-store election in `cmd/` gains an "app-loaded" preference so an app's own store wins over the `~/.dapr` default. (2) The discovery enrichment gains a runtime fallback that inspects the process listening on the app port when the daprd-reported command is empty. No Aspire-specific branches.

**Tech Stack:** Go (cobra/chi backend), `dapr/cli` process scanning, `dapr/components-contrib` state stores, `shirou/gopsutil` (already a dependency) for process/port lookup, testify + `//go:build unit` tests.

## Global Constraints

- Go module: `github.com/diagridio/dev-dashboard`.
- Unit tests use build tag `unit` (file header `//go:build unit`) and run via `go test -tags unit -race ./...` (Makefile `test-go`).
- Assertions use `github.com/stretchr/testify/require`.
- gopsutil import path is the v3-incompatible module: `github.com/shirou/gopsutil/net` and `github.com/shirou/gopsutil/process` (NO `/v3/` segment), matching `go.sum` entry `github.com/shirou/gopsutil v3.21.11+incompatible`.
- Keep the single-active-store model. Do NOT add per-app multi-store resolution, cross-store aggregation, or any Aspire-specific code path.
- Runtime/store fallbacks must degrade gracefully: never worse than today's behaviour when a lookup fails.

---

## File Structure

- `cmd/workflow.go` — MODIFY: `newStoreRegistry` and `newStoreBackend` gain a `loaded map[string]bool` parameter; election precedence updated.
- `cmd/serve.go` — MODIFY: fetch running apps once; build the `loaded` component-name set; pass it to registry + backend.
- `cmd/workflow_test.go` — MODIFY: update existing `newStoreRegistry`/`newStoreBackend` calls to the new signature; add election tests.
- `pkg/discovery/appproc.go` — CREATE: `appProcResolver` interface, default gopsutil implementation, and the pure `appRuntime` helper.
- `pkg/discovery/service.go` — MODIFY: `service` holds an `appProcResolver`; `New` defaults it; `enrich` uses `appRuntime`.
- `pkg/discovery/appproc_test.go` — CREATE: unit tests for `appRuntime` with a fake resolver.

---

## Task 1: State-store election prefers app-loaded stores

**Files:**
- Modify: `cmd/workflow.go` (`newStoreRegistry` ~lines 28-43; `newStoreBackend` signature ~line 151 and internal `newStoreRegistry` call ~line 170)
- Modify: `cmd/serve.go` (`assembleOptions`, lines 32-92)
- Test: `cmd/workflow_test.go` (update calls at lines 98, 119, 136, 148, 216, 246; add new tests)

**Interfaces:**
- Produces: `newStoreRegistry(comps []statestore.Component, loaded map[string]bool) *storeRegistry`
- Produces: `newStoreBackend(ctx context.Context, comps []statestore.Component, loaded map[string]bool, namespace string, client *http.Client, apps discovery.Service, appIDs func(context.Context) ([]string, error)) (*storeBackend, []func() error)`
- `loaded` keys are state-store component names (`metadata.name`) that at least one running app reports having loaded.

- [ ] **Step 1: Write the failing election test**

Add to `cmd/workflow_test.go` (uses existing imports `statestore`, `require`):

```go
func TestStoreRegistry_AppLoadedStoreWinsOverDefault(t *testing.T) {
	// Both have actorStateStore=true; default ~/.dapr store is scanned first.
	comps := []statestore.Component{
		{Name: "statestore", Type: "state.redis", Path: "/home/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
		{Name: "workflow-store", Type: "state.redis", Path: "/app/Resources/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:16379"}},
	}
	loaded := map[string]bool{"workflow-store": true} // only the app-loaded one

	r := newStoreRegistry(comps, loaded)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "workflow-store", act.Name, "app-loaded store must win over the unloaded ~/.dapr default")
}

func TestStoreRegistry_FallsBackWhenNoneLoaded(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{"actorStateStore": "true"}},
	}
	r := newStoreRegistry(comps, nil) // no apps loaded anything

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "pg", act.Name, "with nothing loaded, actorStateStore wins (current fallback)")
}

func TestStoreRegistry_AppLoadedNonActorPreferredOverUnloadedActor(t *testing.T) {
	comps := []statestore.Component{
		{Name: "default", Type: "state.redis", Path: "/home/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true"}},
		{Name: "appstore", Type: "state.redis", Path: "/app/Resources/store.yaml",
			Metadata: map[string]string{}}, // app-loaded but not flagged actorStateStore
	}
	loaded := map[string]bool{"appstore": true}

	r := newStoreRegistry(comps, loaded)
	require.Equal(t, "appstore", r.active().Name, "an app-loaded store beats an unloaded default even without the actor flag")
}
```

- [ ] **Step 2: Run the test to verify it fails (compile error: too few args)**

Run: `go test -tags unit ./cmd/ -run TestStoreRegistry_AppLoaded -v`
Expected: FAIL — `not enough arguments in call to newStoreRegistry` (signature is still single-arg).

- [ ] **Step 3: Update the election in `cmd/workflow.go`**

Replace `newStoreRegistry` (currently lines 28-43) with:

```go
// newStoreRegistry builds a storeRegistry from detected components and the set of
// state-store component names that running apps have actually loaded.
//
// Active-store election precedence:
//  1. app-loaded AND actorStateStore=="true"
//  2. app-loaded (any)
//  3. actorStateStore=="true"
//  4. first component
//  5. none (empty slice)
//
// Preferring app-loaded stores stops the global ~/.dapr default (also flagged
// actorStateStore) from shadowing the store an externally-launched app (e.g. one
// started by .NET Aspire) actually loaded.
func newStoreRegistry(comps []statestore.Component, loaded map[string]bool) *storeRegistry {
	r := &storeRegistry{comps: comps, activeIndex: -1}
	if len(comps) == 0 {
		return r
	}

	isLoaded := func(c statestore.Component) bool { return loaded != nil && loaded[c.Name] }
	isActor := func(c statestore.Component) bool { return c.Metadata["actorStateStore"] == "true" }

	// 1. app-loaded AND actorStateStore.
	for i, c := range comps {
		if isLoaded(c) && isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 2. app-loaded (any).
	for i, c := range comps {
		if isLoaded(c) {
			r.activeIndex = i
			return r
		}
	}
	// 3. actorStateStore.
	for i, c := range comps {
		if isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 4. first component.
	r.activeIndex = 0
	return r
}
```

- [ ] **Step 4: Thread `loaded` through `newStoreBackend` in `cmd/workflow.go`**

Change the `newStoreBackend` signature (line ~151) from:

```go
func newStoreBackend(
	ctx context.Context,
	comps []statestore.Component,
	namespace string,
	client *http.Client,
	apps discovery.Service,
	appIDs func(context.Context) ([]string, error),
) (*storeBackend, []func() error) {
```

to (add `loaded map[string]bool` after `comps`):

```go
func newStoreBackend(
	ctx context.Context,
	comps []statestore.Component,
	loaded map[string]bool,
	namespace string,
	client *http.Client,
	apps discovery.Service,
	appIDs func(context.Context) ([]string, error),
) (*storeBackend, []func() error) {
```

And change the internal registry construction (line ~170) from:

```go
	registry := newStoreRegistry(comps)
```

to:

```go
	registry := newStoreRegistry(comps, loaded)
```

- [ ] **Step 5: Build the `loaded` set and update call sites in `cmd/serve.go`**

Replace the body of `assembleOptions` (lines 32-92) with this version. It fetches apps once, derives `loaded` (state-store component names only), and passes `loaded` to both the registry and the backend. Add `"strings"` to the import block.

```go
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Fetch running apps once (best-effort), reused for store-path scanning, the
	// resources loader, and the app-loaded component-name set.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}

	// loaded = state-store component names that at least one running app loaded.
	loaded := make(map[string]bool)
	for _, a := range apps {
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
	}

	// Resolve resource paths to scan for state-store components.
	var scanPaths []string
	if deps.StateStorePath != "" {
		scanPaths = []string{deps.StateStorePath}
	} else {
		if deps.HomeDir != "" {
			scanPaths = append(scanPaths, filepath.Join(deps.HomeDir, ".dapr", "components"))
		}
		for _, a := range apps {
			scanPaths = append(scanPaths, a.ResourcePaths...)
		}
	}
	detected, _ := statestore.Detect(scanPaths)
	registry := newStoreRegistry(detected, loaded)

	// Resolve resource paths for the resources loader.
	var resPaths []string
	if deps.HomeDir != "" {
		resPaths = append(resPaths, filepath.Join(deps.HomeDir, ".dapr", "components"), filepath.Join(deps.HomeDir, ".dapr"))
	}
	for _, a := range apps {
		resPaths = append(resPaths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
		}
	}
	resSvc := resources.New(resPaths)

	appIDs := func(ctx context.Context) ([]string, error) {
		apps, err := appsSvc.List(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(apps))
		for _, a := range apps {
			ids = append(ids, a.AppID)
		}
		return ids, nil
	}

	backend, closers := newStoreBackend(ctx, detected, loaded, deps.Namespace, deps.HTTPClient, appsSvc, appIDs)
	newsSvc := news.New(&http.Client{Timeout: 5 * time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)

	return server.Options{
		BasePath:  deps.BasePath,
		DistFS:    dist,
		Version:   version.Get(),
		Apps:      appsSvc,
		Backend:   backend,
		Stores:    registry,
		Resources: resSvc,
		News:      newsSvc,
	}, closers
}
```

Add `strings` to the imports at the top of `cmd/serve.go`:

```go
import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/version"
)
```

- [ ] **Step 6: Update existing test call sites in `cmd/workflow_test.go`**

The signature change breaks four `newStoreRegistry(...)` calls and one `newStoreBackend(...)` call. Update them:

- Line 98 `r := newStoreRegistry(comps)` → `r := newStoreRegistry(comps, nil)`
- Line 119 `r := newStoreRegistry(comps)` → `r := newStoreRegistry(comps, nil)`
- Line 136 `r := newStoreRegistry(comps)` → `r := newStoreRegistry(comps, nil)`
- Line 148 `r := newStoreRegistry(nil)` → `r := newStoreRegistry(nil, nil)`
- Line 216 `_, closers := newStoreBackend(context.Background(), nil, "default", &http.Client{}, nil, appIDs)` → `_, closers := newStoreBackend(context.Background(), nil, nil, "default", &http.Client{}, nil, appIDs)`
- Line 246 `b, closers := newStoreBackend(context.Background(), comps, "default", &http.Client{}, nil, appIDs)` → `b, closers := newStoreBackend(context.Background(), comps, nil, "default", &http.Client{}, nil, appIDs)`

(Passing `nil` preserves these tests' intent: they assert the pre-existing actorStateStore/first-fallback behaviour, which is exactly precedence rules 3-4 when nothing is app-loaded.)

- [ ] **Step 7: Run the cmd test suite to verify pass**

Run: `go test -tags unit -race ./cmd/ -v`
Expected: PASS — new `TestStoreRegistry_AppLoaded*` / `*FallsBackWhenNoneLoaded` tests pass, and all pre-existing `TestStoreRegistry_*` / `TestNewStoreBackend_*` tests still pass.

- [ ] **Step 8: Commit**

```bash
git add cmd/workflow.go cmd/serve.go cmd/workflow_test.go
git commit -m "$(cat <<'EOF'
feat(statestore): prefer app-loaded store in active-store election

The first-actorStateStore election let the ~/.dapr default shadow the store
an externally-launched app (e.g. Aspire) actually loaded, so workflow reads
hit the wrong Redis. Prefer components a running app reports loading.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Infer runtime from the app process when the daprd command is empty

**Files:**
- Create: `pkg/discovery/appproc.go`
- Modify: `pkg/discovery/service.go` (`service` struct ~lines 39-42; `New` ~line 44; `enrich` ~lines 86-126)
- Test: `pkg/discovery/appproc_test.go`

**Interfaces:**
- Consumes: `InferRuntime(string) string` (existing, `pkg/discovery/infer.go`).
- Produces: `type appProcResolver interface { CommandForPort(port int) (string, bool) }`
- Produces: `func appRuntime(command string, appPort int, r appProcResolver) string` — returns `InferRuntime(command)`, and only when that is `"unknown"` and `appPort != 0` and `r != nil`, falls back to `InferRuntime(r.CommandForPort(appPort))` if that resolves to a known runtime.
- Produces: `gopsutilResolver` (default impl) used by `New`.

- [ ] **Step 1: Write the failing helper test**

Create `pkg/discovery/appproc_test.go`:

```go
//go:build unit

package discovery

import (
	"testing"

	"github.com/stretchr/testify/require"
)

type fakeResolver struct {
	cmd string
	ok  bool
}

func (f fakeResolver) CommandForPort(int) (string, bool) { return f.cmd, f.ok }

func TestAppRuntime(t *testing.T) {
	t.Run("known primary command — no fallback needed", func(t *testing.T) {
		// Resolver would return python, but primary already resolves to dotnet.
		got := appRuntime("dotnet run", 5467, fakeResolver{cmd: "python app.py", ok: true})
		require.Equal(t, "dotnet", got)
	})

	t.Run("empty command, fallback resolves dotnet from app port", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{cmd: "/usr/bin/dotnet MyApp.dll", ok: true})
		require.Equal(t, "dotnet", got)
	})

	t.Run("empty command, no app port — stays unknown", func(t *testing.T) {
		got := appRuntime("", 0, fakeResolver{cmd: "dotnet x", ok: true})
		require.Equal(t, "unknown", got)
	})

	t.Run("empty command, resolver miss — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{ok: false})
		require.Equal(t, "unknown", got)
	})

	t.Run("nil resolver — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, nil)
		require.Equal(t, "unknown", got)
	})

	t.Run("fallback command also unknown — stays unknown", func(t *testing.T) {
		got := appRuntime("", 5467, fakeResolver{cmd: "./mystery-binary", ok: true})
		require.Equal(t, "unknown", got)
	})
}
```

- [ ] **Step 2: Run the test to verify it fails (undefined: appRuntime)**

Run: `go test -tags unit ./pkg/discovery/ -run TestAppRuntime -v`
Expected: FAIL — `undefined: appRuntime` (and `undefined: appProcResolver` indirectly).

- [ ] **Step 3: Create `pkg/discovery/appproc.go`**

```go
package discovery

import (
	gnet "github.com/shirou/gopsutil/net"
	gproc "github.com/shirou/gopsutil/process"
)

// appProcResolver resolves the full command line of the local process listening
// on a TCP port. It isolates the OS-level lookup so it can be faked in tests.
type appProcResolver interface {
	CommandForPort(port int) (string, bool)
}

// appRuntime determines an app's runtime. It first tries InferRuntime on the
// daprd-reported command; if that is "unknown" (e.g. the app was launched
// outside dapr-run, as with .NET Aspire, so daprd carries no app command) it
// falls back to inspecting the process listening on the app port.
func appRuntime(command string, appPort int, r appProcResolver) string {
	rt := InferRuntime(command)
	if rt != "unknown" || appPort == 0 || r == nil {
		return rt
	}
	if cmd, ok := r.CommandForPort(appPort); ok {
		if rt2 := InferRuntime(cmd); rt2 != "unknown" {
			return rt2
		}
	}
	return rt
}

// gopsutilResolver is the default appProcResolver, backed by gopsutil.
//
// NOTE (verify on macOS): net.Connections may require elevated privileges on
// some platforms. On failure CommandForPort returns ("", false), so the runtime
// simply stays "unknown" — never worse than before this fallback existed.
type gopsutilResolver struct{}

func (gopsutilResolver) CommandForPort(port int) (string, bool) {
	conns, err := gnet.Connections("inet")
	if err != nil {
		return "", false
	}
	for _, c := range conns {
		if c.Status == "LISTEN" && int(c.Laddr.Port) == port && c.Pid != 0 {
			p, err := gproc.NewProcess(c.Pid)
			if err != nil {
				continue
			}
			cmd, err := p.Cmdline()
			if err != nil || cmd == "" {
				continue
			}
			return cmd, true
		}
	}
	return "", false
}
```

- [ ] **Step 4: Run `go mod tidy` to pull in `gopsutil/net`**

Run: `go mod tidy`
Then verify it builds: `go build ./...`
Expected: `gopsutil/net` resolves from the already-present `github.com/shirou/gopsutil v3.21.11+incompatible` module; build succeeds.

- [ ] **Step 5: Run the helper test to verify pass**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestAppRuntime -v`
Expected: PASS (all six sub-tests).

- [ ] **Step 6: Wire the resolver into the service in `pkg/discovery/service.go`**

Change the `service` struct (lines 39-42) from:

```go
type service struct {
	scan   Scanner
	client *http.Client
}

func New(scan Scanner, client *http.Client) Service { return &service{scan: scan, client: client} }
```

to:

```go
type service struct {
	scan    Scanner
	client  *http.Client
	appProc appProcResolver
}

func New(scan Scanner, client *http.Client) Service {
	return &service{scan: scan, client: client, appProc: gopsutilResolver{}}
}
```

In `enrich`, change the initial Runtime assignment (line 92) — leave it as-is for the metadata-unavailable early-return path:

```go
		Runtime: InferRuntime(r.Command), Health: HealthUnknown,
```

Then, in the metadata-success path, replace the `if md.AppCommand != ""` block (lines 112-115):

```go
	if md.AppCommand != "" {
		in.Command = md.AppCommand
		in.Runtime = InferRuntime(md.AppCommand)
	}
```

with (set the best-known command, then resolve runtime with the app-port fallback):

```go
	if md.AppCommand != "" {
		in.Command = md.AppCommand
	}
	in.Runtime = appRuntime(in.Command, in.AppPort, s.appProc)
```

(`in.Command` holds `md.AppCommand` when present, else the original scan command; `appRuntime` only does the port lookup when that command yields `"unknown"`.)

- [ ] **Step 7: Run the full discovery + cmd suites to verify pass**

Run: `go test -tags unit -race ./pkg/discovery/ ./cmd/ -v`
Expected: PASS — `TestAppRuntime`, the existing `TestInferRuntime`, and all existing service tests (they call `New(...)`, which now sets the default resolver) pass.

- [ ] **Step 8: Commit**

```bash
git add pkg/discovery/appproc.go pkg/discovery/service.go pkg/discovery/appproc_test.go go.mod go.sum
git commit -m "$(cat <<'EOF'
feat(discovery): infer runtime from app process when daprd has no command

Apps launched outside dapr-run (e.g. .NET Aspire) give daprd no app command,
so InferRuntime returned "unknown". Fall back to the command of the process
listening on the app port. Degrades to "unknown" if the lookup fails.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Verify end-to-end against a live Aspire app

**Files:** none (manual/observational verification)

This task confirms the fixes against the real symptom. It requires the `EnterpriseDiagnostics` Aspire app running (start it via `aspire run` / running the AppHost). If it cannot be started, this task is skipped and noted.

- [ ] **Step 1: Build the dashboard**

Run: `make build` (or `go build -o dev-dashboard .`)
Expected: a `dev-dashboard` binary is produced.

- [ ] **Step 2: Start the Aspire app and confirm its daprd is up**

Run: `dapr list` and `ps aux | grep '[d]aprd'`
Expected: the app (e.g. `wf-app`) is listed with an HTTP port; the daprd cmdline shows `--app-id`, `--dapr-http-port`, `--resources-path .../Resources`, and `--app-port <P>`.

- [ ] **Step 3: Run the freshly built dashboard on a spare port**

Run: `./dev-dashboard serve --port 9091` (adjust flag name to match the serve command; use a port not already taken by an existing dashboard)
Expected: server starts; logs show `active state store connected name=workflow-store` (NOT `statestore`).

- [ ] **Step 4: Verify the active store is the app's store**

Run: `curl -s http://localhost:9091/api/statestores`
Expected: the active store `name` is the app-loaded store (e.g. `workflow-store`), not the `~/.dapr` `statestore`.

- [ ] **Step 5: Verify runtime label**

Run: `curl -s http://localhost:9091/api/apps`
Expected: the Aspire app's `runtime` is `"dotnet"` (not `"unknown"`), assuming the .NET app process is listening on its app port. If `net.Connections` needs privileges on this macOS host and returns nothing, `runtime` stays `"unknown"` — record this as the known platform limitation from the spec rather than a regression.

- [ ] **Step 6: Verify workflow data comes from the correct store**

Trigger a workflow in the Aspire app (e.g. `POST /start`), then:
Run: `curl -s http://localhost:9091/api/workflows`
Expected: the newly created instance appears (read from the app's store), confirming workflow reads now target the correct Redis.

- [ ] **Step 7: Record results**

Note the observed `/api/statestores`, `/api/apps` runtime, and `/api/workflows` output in the PR description. Stop the test dashboard.

---

## Self-Review

**Spec coverage:**
- Spec "Fix 1 — Prefer app-loaded state stores" → Task 1 (election precedence 1-4, threaded through registry + backend + serve.go). ✓
- Spec "Fix 2 — Infer runtime from app process" → Task 2 (`appRuntime` + resolver + `enrich` wiring). ✓
- Spec "Testing (TDD)" election cases (app-loaded wins; no apps fallback; default still elected when loaded) → Task 1 Step 1 tests + retained existing tests via `nil`. ✓
- Spec "Testing (TDD)" runtime cases (dotnet/known/unknown/not-resolvable) → Task 2 Step 1 tests. ✓
- Spec "Implementation risk to verify" (macOS privilege) → Task 2 Step 3 NOTE + Task 3 Step 5 fallback handling. ✓
- Spec non-goals (no per-app/multi-store, no Aspire branches) → Global Constraints + single-active-store retained. ✓

**Placeholder scan:** No TBD/TODO; every code step shows full code; commands have expected output. ✓

**Type consistency:** `newStoreRegistry(comps, loaded)` and `newStoreBackend(ctx, comps, loaded, ...)` used consistently across Task 1 steps 3-6. `appProcResolver.CommandForPort(int) (string, bool)`, `appRuntime(string, int, appProcResolver) string`, and `gopsutilResolver` used consistently across Task 2. `loaded` is `map[string]bool` throughout. gopsutil import paths match the Global Constraints. ✓
