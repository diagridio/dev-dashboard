# Testing Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run the existing integration tests in CI, pin Dapr data shapes with golden files, add a full-server wiring test, and add an opt-in test that reads workflow state authored by a real `daprd`.

**Architecture:** Three test tiers by external dependency — `unit` (no deps, already in CI), `integration` (in-process miniredis/SQLite, added to CI), and `e2e` (real `daprd` on PATH, local-only). Item 3 extracts the dependency-assembly currently inlined in `cmd.runServe` into a testable `assembleOptions` function so the assembled graph can be exercised end to end. Item 4 ships a tiny self-contained Dapr workflow app (its own Go module) that a tagged test drives via `dapr run`.

**Tech Stack:** Go 1.26, chi router, `dapr/durabletask-go` (proto), `components-contrib` state stores, `alicebob/miniredis` (test), `modernc.org/sqlite`, `stretchr/testify`, `gotestsum`, GitHub Actions; the e2e app uses `dapr/go-sdk` workflow.

## Global Constraints

- Go version: `1.26` (CI pins `go-version: '1.26.3'`; go.mod is `go 1.26.4`). Do not lower.
- Build tags partition tests: `//go:build unit`, `//go:build integration`, `//go:build e2e`. A test file must carry exactly one. Production `.go` files carry no tag.
- `gofmt` must report zero files (`test -z "$(gofmt -l .)"` runs in CI over the whole tree, including nested modules).
- Module path: `github.com/diagridio/dev-dashboard`.
- Tests use `testify/require`. Follow the existing seeding pattern: write workflow state through `statestore.SeedForTest` / `store.Set`, never raw backend writes.
- `make test` must remain unit + web only (fast default loop). Integration runs via its own target/CI step; e2e is local-only and never added to CI.
- The e2e workflow app must be a **separate Go module** so `dapr/go-sdk` never enters the main `go.mod`.

---

### Task 1: Test plumbing — Makefile targets + integration tests in CI

Adds `make test-integration` / `make test-e2e` and a CI step that runs the `integration`-tagged tests. This is item 1 plus the cross-cutting Makefile targets.

**Files:**
- Modify: `Makefile`
- Modify: `.github/workflows/ci.yaml`

**Interfaces:**
- Consumes: existing `//go:build integration` tests in `pkg/statestore` and `pkg/workflow`.
- Produces: `make test-integration` and `make test-e2e` targets; a CI step running integration tests. Later tasks' `integration`-tagged tests run automatically under this step.

- [ ] **Step 1: Add Makefile targets**

Edit `Makefile`. Update the `.PHONY` line and add two targets after `test`:

```makefile
.PHONY: web build test test-go test-web test-integration test-e2e tidy release-snapshot release-check
```

```makefile
test: test-go test-web

test-integration:
	@if command -v gotestsum >/dev/null 2>&1; then gotestsum -- -tags integration -race ./...; else go test -tags integration -race ./...; fi

test-e2e:
	go test -tags e2e ./...
```

- [ ] **Step 2: Verify the integration target runs the existing tests**

Run: `make test-integration`
Expected: PASS, output includes `TestRedisStoreRoundTrip` and `TestWorkflowListGetSQLite`.

- [ ] **Step 3: Add the integration step to CI**

Edit `.github/workflows/ci.yaml`. In the `go` job, add a step after the existing unit-test `run` (line 15):

```yaml
      - run: gotestsum --format testname -- -tags unit -race ./...
      - run: gotestsum --format testname -- -tags integration -race ./...
```

- [ ] **Step 4: Verify the workflow file is valid YAML and formatted**

Run: `test -z "$(gofmt -l .)" && echo OK`
Expected: `OK` (no Go files changed yet, but confirms tree is clean).

- [ ] **Step 5: Commit**

```bash
git add Makefile .github/workflows/ci.yaml
git commit -m "test: run integration tests in CI; add make test-integration/test-e2e"
```

---

### Task 2: Golden helper + workflow decode golden test

Item 2, part 1. A reusable golden-file helper and a golden test that pins the JSON the dashboard produces from decoded workflow proto state.

**Files:**
- Create: `internal/golden/golden.go`
- Create: `pkg/workflow/golden_test.go`
- Create: `pkg/workflow/testdata/golden/execution_running.golden.json` (generated via `-update`)

**Interfaces:**
- Produces: `golden.Assert(t *testing.T, update bool, path string, got []byte)` — compares `got` to the file at `path`; when `update` is true it writes the file instead. Consumed by Tasks 2 and 3.

- [ ] **Step 1: Write the golden helper**

Create `internal/golden/golden.go`:

```go
//go:build integration

// Package golden provides a tiny golden-file assertion helper for tests.
package golden

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// Assert compares got against the golden file at path. When update is true it
// (re)writes the golden file (creating parent dirs) instead of comparing.
func Assert(t *testing.T, update bool, path string, got []byte) {
	t.Helper()
	if update {
		require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
		require.NoError(t, os.WriteFile(path, got, 0o644))
		return
	}
	want, err := os.ReadFile(path)
	require.NoError(t, err, "missing golden file %s (run the test with -update)", path)
	require.Equal(t, string(want), string(got))
}
```

- [ ] **Step 2: Write the failing workflow golden test**

Create `pkg/workflow/golden_test.go`:

```go
//go:build integration

package workflow_test

import (
	"context"
	"encoding/json"
	"flag"
	"path/filepath"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/internal/golden"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// update regenerates golden files: go test -tags integration ./pkg/workflow -run Golden -update
var update = flag.Bool("update", false, "regenerate golden files")

// TestWorkflowDecodeGolden pins the JSON the dashboard emits for a running
// workflow instance decoded from seeded durabletask proto state. The seeded
// timestamp is fixed so the golden output is deterministic.
func TestWorkflowDecodeGolden(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "wf.db")
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  "OrderWorkflow",
				Input: &wrapperspb.StringValue{Value: `{"id":1}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)

	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))

	svc := workflow.New(store, "default", func(context.Context) ([]string, error) {
		return []string{"order"}, nil
	})
	ex, err := svc.Get(context.Background(), "order", "inst-1")
	require.NoError(t, err)

	got, err := json.MarshalIndent(ex, "", "  ")
	require.NoError(t, err)

	golden.Assert(t, *update, filepath.Join("testdata", "golden", "execution_running.golden.json"), got)
}
```

- [ ] **Step 3: Run to verify it fails (no golden file yet)**

Run: `go test -tags integration ./pkg/workflow -run TestWorkflowDecodeGolden -v`
Expected: FAIL with "missing golden file testdata/golden/execution_running.golden.json (run the test with -update)".

- [ ] **Step 4: Generate the golden file**

Run: `go test -tags integration ./pkg/workflow -run TestWorkflowDecodeGolden -update -v`
Expected: PASS. A new file `pkg/workflow/testdata/golden/execution_running.golden.json` exists containing the indented JSON for a `Running` instance named `OrderWorkflow` with one history event.

- [ ] **Step 5: Run again without -update to verify it passes**

Run: `go test -tags integration ./pkg/workflow -run TestWorkflowDecodeGolden -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add internal/golden/golden.go pkg/workflow/golden_test.go pkg/workflow/testdata/golden/execution_running.golden.json
git commit -m "test(workflow): golden file for decoded workflow JSON shape"
```

---

### Task 3: Discovery metadata-parse golden test

Item 2, part 2. Pins the parsed `discovery.Metadata` struct produced from a committed `/v1.0/metadata` fixture.

**Files:**
- Create: `pkg/discovery/golden_test.go`
- Create: `pkg/discovery/testdata/metadata_response.json` (input fixture)
- Create: `pkg/discovery/testdata/golden/metadata_parsed.golden.json` (generated via `-update`)

**Interfaces:**
- Consumes: `golden.Assert` (Task 2); `discovery.FetchMetadata(ctx, *http.Client, httpPort int) (discovery.Metadata, error)`.

- [ ] **Step 1: Create the input fixture**

Create `pkg/discovery/testdata/metadata_response.json`. This is a representative Dapr `/v1.0/metadata` body. **Provenance:** captured shape for Dapr runtime 1.15.x; recapture and re-run `-update` when bumping the supported Dapr version.

```json
{
  "id": "order",
  "runtimeVersion": "1.15.0",
  "enabledFeatures": ["ServiceInvocation", "StateManagement"],
  "actors": [
    { "type": "dapr.internal.default.order.workflow", "count": 2 }
  ],
  "components": [
    { "name": "statestore", "type": "state.sqlite", "version": "v1" }
  ],
  "subscriptions": [
    {
      "pubsubname": "pubsub",
      "topic": "orders",
      "rules": [{ "match": "", "path": "/orders" }],
      "deadLetterTopic": "",
      "type": "PROGRAMMATIC"
    }
  ],
  "actorRuntime": { "placement": "placement: connected" },
  "extended": {
    "appPID": "12345",
    "cliPID": "12000",
    "appCommand": "go run .",
    "appLogPath": "/home/dev/.dapr/logs/order_app.log",
    "daprdLogPath": "/home/dev/.dapr/logs/order_daprd.log",
    "runTemplateName": "dapr.yaml"
  }
}
```

- [ ] **Step 2: Write the failing golden test**

Create `pkg/discovery/golden_test.go`:

```go
//go:build integration

package discovery_test

import (
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/internal/golden"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// update regenerates golden files: go test -tags integration ./pkg/discovery -run Golden -update
var update = flag.Bool("update", false, "regenerate golden files")

// TestFetchMetadataGolden pins the parsed Metadata struct produced from a
// captured /v1.0/metadata response, so a Dapr schema change surfaces as a diff.
func TestFetchMetadataGolden(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("testdata", "metadata_response.json"))
	require.NoError(t, err)

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		require.Equal(t, "/v1.0/metadata", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(body)
	}))
	t.Cleanup(srv.Close)

	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)

	md, err := discovery.FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, port)
	require.NoError(t, err)

	got, err := json.MarshalIndent(md, "", "  ")
	require.NoError(t, err)

	golden.Assert(t, *update, filepath.Join("testdata", "golden", "metadata_parsed.golden.json"), got)
}
```

- [ ] **Step 3: Run to verify it fails (no golden file yet)**

Run: `go test -tags integration ./pkg/discovery -run TestFetchMetadataGolden -v`
Expected: FAIL with "missing golden file testdata/golden/metadata_parsed.golden.json".

- [ ] **Step 4: Generate the golden file**

Run: `go test -tags integration ./pkg/discovery -run TestFetchMetadataGolden -update -v`
Expected: PASS. `pkg/discovery/testdata/golden/metadata_parsed.golden.json` now contains the parsed struct (AppPID 12345, CLIPID 12000, Placement "placement: connected", one subscription, etc.).

- [ ] **Step 5: Run again without -update to verify it passes**

Run: `go test -tags integration ./pkg/discovery -run TestFetchMetadataGolden -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery/golden_test.go pkg/discovery/testdata/
git commit -m "test(discovery): golden file for parsed /v1.0/metadata shape"
```

---

### Task 4: Extract `assembleOptions` from `runServe` (refactor)

Item 3, part 1. Pure refactor: move the dependency-assembly out of `cmd.runServe` into a testable function. No behavior change; verified by build + existing tests.

**Files:**
- Create: `cmd/serve.go`
- Modify: `cmd/root.go:66-147` (replace the inline assembly with a call to `assembleOptions`)

**Interfaces:**
- Produces:
  - `type serveDeps struct { BasePath, StateStorePath, Namespace string; Apps discovery.Service; HomeDir string; HTTPClient *http.Client }`
  - `func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error)`
  Consumed by Task 5.

- [ ] **Step 1: Create `cmd/serve.go` with the extracted assembly**

Create `cmd/serve.go`:

```go
package cmd

import (
	"context"
	"io/fs"
	"net/http"
	"path/filepath"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/version"
)

// serveDeps holds the inputs needed to assemble the server's dependency graph.
// Apps and HomeDir are injectable so tests can avoid real process scanning and
// the real ~/.dapr directory.
type serveDeps struct {
	BasePath       string
	StateStorePath string // explicit component YAML; "" means auto-detect
	Namespace      string
	Apps           discovery.Service
	HomeDir        string
	HTTPClient     *http.Client // workflow HTTP client (remover/purge)
}

// assembleOptions builds server.Options and the matching store closers from deps.
// The caller owns invoking the returned closers.
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Resolve resource paths to scan for state-store components.
	var scanPaths []string
	if deps.StateStorePath != "" {
		scanPaths = []string{deps.StateStorePath}
	} else {
		if deps.HomeDir != "" {
			scanPaths = append(scanPaths, filepath.Join(deps.HomeDir, ".dapr", "components"))
		}
		if apps, err := appsSvc.List(ctx); err == nil {
			for _, a := range apps {
				scanPaths = append(scanPaths, a.ResourcePaths...)
			}
		}
	}
	detected, _ := statestore.Detect(scanPaths)
	registry := newStoreRegistry(detected)

	// Resolve resource paths for the resources loader.
	var resPaths []string
	if deps.HomeDir != "" {
		resPaths = append(resPaths, filepath.Join(deps.HomeDir, ".dapr", "components"), filepath.Join(deps.HomeDir, ".dapr"))
	}
	if apps, err := appsSvc.List(ctx); err == nil {
		for _, a := range apps {
			resPaths = append(resPaths, a.ResourcePaths...)
			if a.ConfigPath != "" {
				resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
			}
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

	backend, closers := newStoreBackend(ctx, detected, deps.Namespace, deps.HTTPClient, appsSvc, appIDs)
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

- [ ] **Step 2: Replace the inline assembly in `runServe`**

In `cmd/root.go`, replace the body from the `appsSvc := discovery.New(...)` line (currently line 82) through the `srv := server.New(addr, server.Options{...})` block (currently ending line 147) with:

```go
	home, _ := os.UserHomeDir()
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:       basePath,
		StateStorePath: stateStore,
		Namespace:      namespace,
		Apps:           discovery.New(discovery.StandaloneScanner(), &http.Client{Timeout: 2 * time.Second}),
		HomeDir:        home,
		HTTPClient:     &http.Client{Timeout: 10 * time.Second},
	}, dist)
	for _, close := range closers {
		close := close
		defer func() { _ = close() }()
	}

	srv := server.New(addr, opts)
```

Then remove now-unused imports from `cmd/root.go` (`net/http`, `path/filepath`, `time`, `discovery`, `news`, `resources`, `statestore`, `version` may no longer be referenced there — let the compiler tell you which). Keep `os` (used for `UserHomeDir`, signals).

- [ ] **Step 3: Build to verify the refactor compiles and imports are correct**

Run: `go build ./...`
Expected: success, no unused-import errors.

- [ ] **Step 4: Run existing unit tests to confirm no behavior change**

Run: `gotestsum -- -tags unit -race ./cmd/...`
Expected: PASS (existing `cmd/root_test.go`, `cmd/workflow_test.go` still pass).

- [ ] **Step 5: Confirm formatting**

Run: `test -z "$(gofmt -l .)" && echo OK`
Expected: `OK`.

- [ ] **Step 6: Commit**

```bash
git add cmd/serve.go cmd/root.go
git commit -m "refactor(cmd): extract assembleOptions from runServe for testability"
```

---

### Task 5: Full-server wiring test

Item 3, part 2. Exercises the assembled graph end to end: `assembleOptions` → `server.NewRouter` → real statestore→workflow→handler read path, with a fake discovery service so no sidecar/process scan is needed.

**Files:**
- Create: `cmd/serve_integration_test.go`

**Interfaces:**
- Consumes: `assembleOptions` / `serveDeps` (Task 4); `server.NewRouter(server.Options) http.Handler`; `statestore.New`, `statestore.SeedForTest`, `statestore.InstancePrefix`, `statestore.SuffixMetadata`, `statestore.HistoryPrefix`; `discovery.Service`, `discovery.Instance`, `discovery.ErrNotFound`, `discovery.HealthHealthy`.

- [ ] **Step 1: Write the failing wiring test**

Create `cmd/serve_integration_test.go`:

```go
//go:build integration

package cmd

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// wiringFakeApps is a discovery.Service double returning fixed instances.
type wiringFakeApps struct {
	insts []discovery.Instance
}

func (f wiringFakeApps) List(context.Context) ([]discovery.Instance, error) {
	return f.insts, nil
}

func (f wiringFakeApps) Get(_ context.Context, appID string) (discovery.Instance, error) {
	for _, i := range f.insts {
		if i.AppID == appID {
			return i, nil
		}
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

func httpGet(t *testing.T, url string) (*http.Response, string) {
	t.Helper()
	res, err := http.Get(url)
	require.NoError(t, err)
	b, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	return res, string(b)
}

// TestAssembleServerServesSeededWorkflow wires the real server via
// assembleOptions against a temp SQLite store seeded with one workflow
// instance, then drives the real HTTP surface end to end.
func TestAssembleServerServesSeededWorkflow(t *testing.T) {
	dir := t.TempDir()
	dbPath := filepath.Join(dir, "wf.db")

	// Seed one workflow instance into the SQLite store.
	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	ts := timestamppb.New(time.Date(2026, 1, 1, 12, 0, 0, 0, time.UTC))
	started := &protos.HistoryEvent{
		EventId:   0,
		Timestamp: ts,
		EventType: &protos.HistoryEvent_ExecutionStarted{
			ExecutionStarted: &protos.ExecutionStartedEvent{
				Name:  "OrderWorkflow",
				Input: &wrapperspb.StringValue{Value: `{}`},
			},
		},
	}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.SuffixMetadata, []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+statestore.HistoryPrefix+"000000", b))
	require.NoError(t, store.Close())

	// Write a component YAML pointing at that DB.
	comp := "apiVersion: dapr.io/v1alpha1\n" +
		"kind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbPath + "\n"
	compPath := filepath.Join(dir, "statestore.yaml")
	require.NoError(t, os.WriteFile(compPath, []byte(comp), 0o644))

	dist := fstest.MapFS{
		"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")},
	}

	opts, closers := assembleOptions(context.Background(), serveDeps{
		StateStorePath: compPath,
		Namespace:      "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{
			{AppID: "order", HTTPPort: 3500, Health: discovery.HealthHealthy},
		}},
		HomeDir:    dir,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	// /api/health
	res, _ := httpGet(t, srv.URL+"/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)

	// /api/version returns JSON, 200.
	res, _ = httpGet(t, srv.URL+"/api/version")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Equal(t, "application/json", res.Header.Get("Content-Type"))

	// /api/apps reflects the fake app.
	res, body := httpGet(t, srv.URL+"/api/apps")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"order"`)

	// /api/workflows returns the seeded instance through the real read path.
	res, body = httpGet(t, srv.URL+"/api/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"inst-1"`)

	// Unknown non-/api route falls back to the SPA index.
	res, body = httpGet(t, srv.URL+"/some/spa/route")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "spa")
}
```

- [ ] **Step 2: Run to verify it passes**

Run: `go test -tags integration ./cmd -run TestAssembleServerServesSeededWorkflow -v`
Expected: PASS — all assertions hold (the seeded `inst-1` appears in `/api/workflows`).

- [ ] **Step 3: Confirm formatting**

Run: `test -z "$(gofmt -l .)" && echo OK`
Expected: `OK`.

- [ ] **Step 4: Commit**

```bash
git add cmd/serve_integration_test.go
git commit -m "test(cmd): full-server wiring test through assembleOptions"
```

---

### Task 6: e2e workflow app (separate module)

Item 4, part 1. A minimal Dapr workflow app that, when run under `dapr run`, schedules and completes one workflow instance, then prints a completion marker. Lives in its own Go module so `dapr/go-sdk` stays out of the main `go.mod`.

**Files:**
- Create: `test/e2e/wfapp/go.mod`
- Create: `test/e2e/wfapp/main.go`

**Interfaces:**
- Produces: a runnable `main` package that schedules workflow instance `e2e-order-1` (workflow name `OrderWorkflow`) and on completion prints `WORKFLOW_DONE e2e-order-1` to stdout, then exits 0. Consumed by Task 7.

> **Note on go-sdk API:** the code targets the `github.com/dapr/go-sdk/workflow` package. If the installed go-sdk version differs, adjust the worker/client calls to match — the contract Task 7 relies on is only the stdout marker and instance ID.

- [ ] **Step 1: Create the module file**

Create `test/e2e/wfapp/go.mod`:

```
module github.com/diagridio/dev-dashboard/test/e2e/wfapp

go 1.26

require github.com/dapr/go-sdk v1.12.0
```

- [ ] **Step 2: Create the workflow app**

Create `test/e2e/wfapp/main.go`:

```go
// Command wfapp is a minimal Dapr workflow app used only by the e2e test.
// Run under `dapr run`, it schedules one workflow instance, waits for it to
// complete, then prints a marker line so the test can read the resulting
// state back from the actor state store.
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"time"

	"github.com/dapr/go-sdk/workflow"
)

const instanceID = "e2e-order-1"

// OrderWorkflow calls one activity and returns its result.
func OrderWorkflow(ctx *workflow.WorkflowContext) (any, error) {
	var out string
	if err := ctx.CallActivity(Notify, workflow.ActivityInput("order")).Await(&out); err != nil {
		return nil, err
	}
	return out, nil
}

// Notify is a trivial activity returning a deterministic string.
func Notify(ctx workflow.ActivityContext) (any, error) {
	var in string
	if err := ctx.GetInput(&in); err != nil {
		return nil, err
	}
	return "notified:" + in, nil
}

func main() {
	w, err := workflow.NewWorker()
	if err != nil {
		log.Fatalf("new worker: %v", err)
	}
	if err := w.RegisterWorkflow(OrderWorkflow); err != nil {
		log.Fatalf("register workflow: %v", err)
	}
	if err := w.RegisterActivity(Notify); err != nil {
		log.Fatalf("register activity: %v", err)
	}
	if err := w.Start(); err != nil {
		log.Fatalf("start worker: %v", err)
	}
	defer func() { _ = w.Shutdown() }()

	client, err := workflow.NewClient()
	if err != nil {
		log.Fatalf("new client: %v", err)
	}
	ctx := context.Background()

	id, err := client.ScheduleNewWorkflow(ctx, "OrderWorkflow", workflow.WithInstanceID(instanceID))
	if err != nil {
		log.Fatalf("schedule: %v", err)
	}
	if _, err := client.WaitForWorkflowCompletion(ctx, id, workflow.WithFetchPayloads(true)); err != nil {
		log.Fatalf("wait: %v", err)
	}

	// Brief grace period so the runtime flushes final state to the store.
	time.Sleep(500 * time.Millisecond)
	fmt.Printf("WORKFLOW_DONE %s\n", id)
	os.Exit(0)
}
```

- [ ] **Step 3: Resolve deps and verify the app builds**

Run: `cd test/e2e/wfapp && go mod tidy && go build ./... && cd -`
Expected: success. (`go mod tidy` writes `go.sum` and may adjust the go-sdk version to one that resolves.)

- [ ] **Step 4: Confirm formatting of the new module**

Run: `test -z "$(gofmt -l test/e2e/wfapp)" && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/wfapp/go.mod test/e2e/wfapp/go.sum test/e2e/wfapp/main.go
git commit -m "test(e2e): minimal Dapr workflow app for real-daprd read-back"
```

---

### Task 7: Real-`daprd` e2e read-back test

Item 4, part 2. Opt-in (`e2e` tag) test: runs the Task 6 app under `dapr run`, waits for completion, then reads the workflow state back through the dashboard's real `statestore` + `workflow` packages and asserts it matches what the runtime wrote.

**Files:**
- Create: `test/e2e/workflow_e2e_test.go`

**Interfaces:**
- Consumes: the Task 6 app at `test/e2e/wfapp` (run via `dapr run -- go run .`); `statestore.New`, `statestore.Component`; `workflow.New`, `workflow.Service.Get`, `workflow.StatusCompleted`.

> **Prerequisite (documented, not enforced beyond binary checks):** the runner must have Dapr self-hosted initialized (`dapr init`) so `daprd` and the placement service are available; workflows require an actor state store and placement. The test skips when `dapr`/`daprd` are not on PATH.

- [ ] **Step 1: Write the e2e test**

Create `test/e2e/workflow_e2e_test.go`:

```go
//go:build e2e

package e2e_test

import (
	"bufio"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// TestDaprWorkflowReadBack runs the wfapp under `dapr run`, waits for its
// workflow to complete, then reads the instance back through the dashboard's
// real statestore + workflow packages and asserts the runtime-authored state
// is decoded correctly. Skipped unless dapr/daprd are on PATH.
func TestDaprWorkflowReadBack(t *testing.T) {
	if _, err := exec.LookPath("dapr"); err != nil {
		t.Skip("dapr not on PATH; skipping e2e")
	}
	if _, err := exec.LookPath("daprd"); err != nil {
		t.Skip("daprd not on PATH; skipping e2e")
	}

	dir := t.TempDir()
	dbPath := filepath.Join(dir, "actors.db")
	resDir := filepath.Join(dir, "resources")
	require.NoError(t, os.MkdirAll(resDir, 0o755))

	// SQLite state store flagged as the actor state store (required for workflows).
	comp := "apiVersion: dapr.io/v1alpha1\n" +
		"kind: Component\n" +
		"metadata:\n  name: statestore\n" +
		"spec:\n  type: state.sqlite\n  version: v1\n  metadata:\n" +
		"  - name: connectionString\n    value: " + dbPath + "\n" +
		"  - name: actorStateStore\n    value: \"true\"\n"
	require.NoError(t, os.WriteFile(filepath.Join(resDir, "statestore.yaml"), []byte(comp), 0o644))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "dapr", "run",
		"--app-id", "ordersvc",
		"--resources-path", resDir,
		"--", "go", "run", ".")
	cmd.Dir = "wfapp" // relative to this test package (test/e2e)
	cmd.Stderr = os.Stderr
	stdout, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	})

	done := make(chan string, 1)
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			line := sc.Text()
			t.Log(line)
			if strings.HasPrefix(line, "WORKFLOW_DONE ") {
				done <- strings.TrimSpace(strings.TrimPrefix(line, "WORKFLOW_DONE "))
				return
			}
		}
	}()

	var instanceID string
	select {
	case instanceID = <-done:
	case <-ctx.Done():
		t.Fatal("workflow did not complete within timeout")
	}
	require.Equal(t, "e2e-order-1", instanceID)

	// Give the runtime a moment to flush final state.
	time.Sleep(1 * time.Second)

	store, err := statestore.New(context.Background(), statestore.Component{
		Name:    "statestore",
		Type:    "state.sqlite",
		Version: "v1",
		Metadata: map[string]string{
			"connectionString": dbPath,
		},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	svc := workflow.New(store, "default", func(context.Context) ([]string, error) {
		return []string{"ordersvc"}, nil
	})

	ex, err := svc.Get(context.Background(), "ordersvc", instanceID)
	require.NoError(t, err)
	require.Equal(t, workflow.StatusCompleted, ex.Status)
	require.NotEmpty(t, ex.History)
}
```

- [ ] **Step 2: Verify it compiles under the e2e tag**

Run: `go vet -tags e2e ./test/e2e/...`
Expected: success (no build/compile errors). Note this does not run the test.

- [ ] **Step 3: Run the e2e test locally (requires `dapr init` done)**

Run: `make test-e2e`
Expected (with Dapr installed): PASS — log shows the workflow scheduling, `WORKFLOW_DONE e2e-order-1`, and the read-back assertions pass.
Expected (without `dapr`/`daprd` on PATH): the test SKIPs cleanly.

> If `svc.Get` returns `ErrNotFound` or a wrong status here, that is the test doing its job — it means the dashboard's key format / decoding does not match what this Dapr version wrote. Investigate `pkg/statestore` key builders and `pkg/workflow` decode against the real keys in `actors.db` before adjusting the test.

- [ ] **Step 4: Confirm formatting**

Run: `test -z "$(gofmt -l .)" && echo OK`
Expected: `OK`.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/workflow_e2e_test.go
git commit -m "test(e2e): read back real daprd-authored workflow state"
```

---

## Self-Review

**Spec coverage:**
- Cross-cutting build-tag taxonomy + Makefile targets → Task 1. ✓
- Item 1 (integration in CI) → Task 1. ✓
- Item 2 (golden files, `-update`, provenance) → Tasks 2 (workflow) + 3 (discovery). ✓
- Item 3 (`assembleOptions` extraction + full-server wiring test) → Tasks 4 + 5. ✓
- Item 4 (`e2e` tag, real workflow app, SQLite, skip-if-absent) → Tasks 6 + 7. ✓
- Out-of-scope items (Playwright, SSE, Redis e2e, Dapr-in-CI) → not present. ✓

**Type consistency:**
- `golden.Assert(t, update bool, path string, got []byte)` defined in Task 2, called identically in Tasks 2 and 3. ✓
- `serveDeps` / `assembleOptions` signature defined in Task 4, consumed with matching fields in Task 5. ✓
- Existing signatures used verbatim from source: `statestore.New`, `statestore.Component`, `statestore.SeedForTest`, `statestore.InstancePrefix`, `statestore.SuffixMetadata`, `statestore.HistoryPrefix`, `workflow.New`, `workflow.Service.Get`, `workflow.StatusRunning/StatusCompleted`, `discovery.FetchMetadata`, `discovery.Service`, `server.NewRouter`, `server.Options`. ✓
- Health endpoint is `/api/health` (per `pkg/server/api.go`), matching the spec correction. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. The one flagged uncertainty (go-sdk API surface in Task 6) is explicitly bounded by a stable contract (stdout marker), not left vague. ✓

**Risks called out in-plan:**
- Task 6 go-sdk version/API may need adjustment to the installed version.
- Task 7 requires `dapr init` (placement + runtime) beyond the binary checks; documented as a prerequisite, with skip-on-missing-binary behavior.
