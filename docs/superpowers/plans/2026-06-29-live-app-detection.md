# Live App Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep boot-derived state (resource scan paths, state-store detection, active-store election, and the workflow DB connection) current as Dapr apps start/stop while the dashboard runs — without adding a second polling loop.

**Architecture:** A new `reconciler` in package `cmd` owns all previously-boot-frozen derived state behind a `sync.RWMutex`. It implements the existing `server.StoreRegistry` and `server.WorkflowBackend` interfaces and supplies the resources path list, so HTTP handlers are unchanged. A thin decorator around `discovery.Service` fires reconciliation on every `/api/apps` poll, gated by a change-detection fingerprint so the expensive work (dir walk, re-detect, DB reconnect) only runs when the set of apps actually changes. The DB reconnect runs in a fired-on-change, single-flight goroutine so the apps poll never blocks on it.

**Tech Stack:** Go 1.x, `chi` router, `components-contrib` state stores, `sync.RWMutex` + `sync/atomic`, `crypto/sha256` for the fingerprint, `testify/require` for tests.

## Global Constraints

- **Build tags (critical):** Go test files in this repo are gated by build tags. Unit tests start with `//go:build unit`; the integration test starts with `//go:build integration`. **Every new `*_test.go` file in this plan MUST start with `//go:build unit` followed by a blank line, then `package ...`.** Without the tag the test is invisible to `go test -tags unit`.
- **Test commands:** Unit tests run with `go test -tags unit ./...` (or `make test-go`, which adds `-race`). The integration test runs with `go test -tags integration ./cmd/...`. A bare `go test ./...` finds **no** tests in `cmd`/`pkg/resources` and must not be used as the verification command.
- **Commit hygiene:** Commit ONLY the task's files via explicit `git add <paths>`; never `git commit -am`. Leave the pre-existing uncommitted artifacts `web/dist/index.html` and `web/package-lock.json` untouched — never stage or commit them.
- Language: Go. Follow existing package layout; new code for the reconciler lives in package `cmd` (it depends on cmd-private types `storeRegistry`, `storeBackend`, `storeEntry`, `newStoreRegistry`, `newStoreBackend`, `newTargetResolver`).
- Reuse existing functions; do not rewrite the active-store election (`newStoreRegistry`) or per-store wiring (`newStoreBackend`).
- The `assembleOptions` signature stays `func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error)`.
- DB connections must be opened with a background context (not a request context), with a timeout, so a request cancelation cannot abort an in-flight connect.
- Connections are never opened on the request hot path: reconnect happens in a single-flight goroutine.
- The connection summary used for identity comparison is secrets-free (`statestore.ConnInfo`).
- Keep `cmd/serve_integration_test.go`, `cmd/workflow_test.go`, and `pkg/resources/resources_test.go` green.

---

### Task 1: Resources service accepts a live path provider

Make `resources.New` take a `func() []string` so the scan paths can change at runtime. Today it takes a static `[]string` captured at boot (`pkg/resources/resources.go:59`, consumed by `scan` at line 81).

**Files:**
- Modify: `pkg/resources/resources.go:54-61,77-81`
- Modify (test): `pkg/resources/resources_test.go:23`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `resources.New(paths func() []string) Service` — the reconciler (Task 6) passes a provider backed by its lock-guarded `resPaths`.

- [ ] **Step 1: Update the existing test to pass a provider**

In `pkg/resources/resources_test.go`, change line 23 from:

```go
	svc := New([]string{dir})
```

to:

```go
	svc := New(func() []string { return []string{dir} })
```

- [ ] **Step 2: Run the test to verify it fails to compile**

Run: `go test -tags unit ./pkg/resources/ -run TestService -v`
Expected: FAIL — build error, `cannot use func literal (...) as []string value in argument to New`.

- [ ] **Step 3: Change `New` and `scan` to use a provider**

In `pkg/resources/resources.go`, change the struct and constructor:

```go
type service struct {
	paths func() []string
}

// New returns a Service that scans the paths returned by the provider for Dapr
// resource YAMLs. The provider is called on every List/Get so callers can change
// the scan locations at runtime.
func New(paths func() []string) Service {
	return &service{paths: paths}
}
```

Then in `scan`, change the loop header from `for _, p := range s.paths {` to:

```go
	for _, p := range s.paths() {
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/resources/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/resources/resources.go pkg/resources/resources_test.go
git commit -m "refactor(resources): accept a live path provider instead of static paths"
```

---

### Task 2: Inject the store opener into `newStoreBackend`

`newStoreBackend` (`cmd/workflow.go:182`) calls `statestore.New(ctx, *active)` directly (line 208), which needs a real DB. Add an `opener` parameter so the reconciler's tests can inject a fake store and assert connection lifecycle. Production passes `statestore.New`.

**Files:**
- Modify: `cmd/workflow.go:182-208`
- Modify (tests): `cmd/workflow_test.go:220,292`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `type storeOpener func(context.Context, statestore.Component) (statestore.Store, error)` and `newStoreBackend(ctx context.Context, comps []statestore.Component, loaded map[string]bool, namespace string, client *http.Client, apps discovery.Service, appIDs func(context.Context) ([]string, error), open storeOpener) (*storeBackend, []func() error)`.

- [ ] **Step 1: Update the two existing test call sites to pass `statestore.New`**

In `cmd/workflow_test.go`, line ~220 change:

```go
	_, closers := newStoreBackend(context.Background(), nil, nil, "default", &http.Client{}, nil, appIDs)
```

to:

```go
	_, closers := newStoreBackend(context.Background(), nil, nil, "default", &http.Client{}, nil, appIDs, statestore.New)
```

And line ~292 change:

```go
	b, closers := newStoreBackend(context.Background(), comps, nil, "default", &http.Client{}, nil, appIDs)
```

to:

```go
	b, closers := newStoreBackend(context.Background(), comps, nil, "default", &http.Client{}, nil, appIDs, statestore.New)
```

- [ ] **Step 2: Run the tests to verify they fail to compile**

Run: `go test -tags unit ./cmd/ -run TestNewStoreBackend -v`
Expected: FAIL — build error, too many arguments to `newStoreBackend`.

- [ ] **Step 3: Add the `storeOpener` type and parameter**

In `cmd/workflow.go`, add the type near the top (after the interface assertions, ~line 18):

```go
// storeOpener opens a state store from a component spec. Production uses
// statestore.New; tests inject a fake to assert connection lifecycle.
type storeOpener func(context.Context, statestore.Component) (statestore.Store, error)
```

Change the `newStoreBackend` signature (line 182) to add the final parameter:

```go
func newStoreBackend(
	ctx context.Context,
	comps []statestore.Component,
	loaded map[string]bool,
	namespace string,
	client *http.Client,
	apps discovery.Service,
	appIDs func(context.Context) ([]string, error),
	open storeOpener,
) (*storeBackend, []func() error) {
```

Inside the body, change the open call (line ~208) from `st, err := statestore.New(ctx, *active)` to:

```go
		st, err := open(ctx, *active)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run TestNewStoreBackend -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/workflow.go cmd/workflow_test.go
git commit -m "refactor(cmd): inject store opener into newStoreBackend for testability"
```

---

### Task 3: Path-derivation and fingerprint helpers

Extract the boot-time path/loaded-set derivation (currently inline in `cmd/serve.go:43-78`) into pure, reusable functions, plus a fingerprint over the apps inputs that drive those derivations. These are pure and independently testable.

**Files:**
- Create: `cmd/derive.go`
- Test: `cmd/derive_test.go`

**Interfaces:**
- Consumes: `discovery.Instance` (`pkg/discovery/types.go`).
- Produces:
  - `func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string) (resPaths, scanPaths []string, loaded map[string]bool)`
  - `func appsFingerprint(apps []discovery.Instance) string`

- [ ] **Step 1: Write the failing tests**

Create `cmd/derive_test.go` (note the mandatory `//go:build unit` tag):

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestDerivePaths_AutoDetect(t *testing.T) {
	apps := []discovery.Instance{
		{AppID: "order", ResourcePaths: []string{"/app/resources"}, ConfigPath: "/app/config/cfg.yaml",
			Components: []discovery.Component{{Name: "statestore", Type: "state.redis"}}},
	}
	resPaths, scanPaths, loaded := derivePaths(apps, "/home/me", "")

	require.Contains(t, resPaths, "/home/me/.dapr/components")
	require.Contains(t, resPaths, "/home/me/.dapr")
	require.Contains(t, resPaths, "/app/resources")
	require.Contains(t, resPaths, "/app/config") // dir of ConfigPath

	require.Contains(t, scanPaths, "/home/me/.dapr/components")
	require.Contains(t, scanPaths, "/app/resources")
	require.NotContains(t, scanPaths, "/home/me/.dapr") // scanPaths is components + app paths only

	require.True(t, loaded["statestore"])
}

func TestDerivePaths_ExplicitStateStoreOverride(t *testing.T) {
	apps := []discovery.Instance{{AppID: "order", ResourcePaths: []string{"/app/resources"}}}
	_, scanPaths, _ := derivePaths(apps, "/home/me", "/explicit/store.yaml")
	require.Equal(t, []string{"/explicit/store.yaml"}, scanPaths)
}

func TestAppsFingerprint_StableAndChangeSensitive(t *testing.T) {
	a := []discovery.Instance{
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
		{AppID: "a", ResourcePaths: []string{"/p1"}},
	}
	// Same content, different order -> same fingerprint.
	b := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/p1"}},
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
	}
	require.Equal(t, appsFingerprint(a), appsFingerprint(b))

	// New app -> different fingerprint.
	c := append([]discovery.Instance{{AppID: "c"}}, a...)
	require.NotEqual(t, appsFingerprint(a), appsFingerprint(c))

	// Same apps, new loaded state store -> different fingerprint.
	d := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/p1"}, Components: []discovery.Component{{Name: "x", Type: "state.redis"}}},
		{AppID: "b", ResourcePaths: []string{"/p2"}, Components: []discovery.Component{{Name: "s", Type: "state.redis"}}},
	}
	require.NotEqual(t, appsFingerprint(a), appsFingerprint(d))
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run 'TestDerivePaths|TestAppsFingerprint' -v`
Expected: FAIL — `undefined: derivePaths` / `undefined: appsFingerprint`.

- [ ] **Step 3: Implement the helpers**

Create `cmd/derive.go`:

```go
package cmd

import (
	"crypto/sha256"
	"encoding/hex"
	"path/filepath"
	"sort"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// derivePaths computes, from the current running apps, the inputs that were
// previously frozen at boot:
//   - resPaths:  directories the resources loader scans
//   - scanPaths: paths statestore.Detect walks for state-store components
//   - loaded:    set of state-store component names at least one app loaded
//
// stateStorePath, when non-empty, is an explicit component YAML that overrides
// state-store auto-detection (scanPaths becomes exactly that path).
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string) (resPaths, scanPaths []string, loaded map[string]bool) {
	loaded = make(map[string]bool)
	for _, a := range apps {
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
	}

	if stateStorePath != "" {
		scanPaths = []string{stateStorePath}
	} else {
		if homeDir != "" {
			scanPaths = append(scanPaths, filepath.Join(homeDir, ".dapr", "components"))
		}
		for _, a := range apps {
			scanPaths = append(scanPaths, a.ResourcePaths...)
		}
	}

	if homeDir != "" {
		resPaths = append(resPaths, filepath.Join(homeDir, ".dapr", "components"), filepath.Join(homeDir, ".dapr"))
	}
	for _, a := range apps {
		resPaths = append(resPaths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
		}
	}
	return resPaths, scanPaths, loaded
}

// appsFingerprint hashes the apps-derived inputs that the reconciler depends on:
// the set of app IDs, the union of resource paths + config-file dirs, and the
// set of loaded state-store component names. Order-independent: same content
// yields the same fingerprint regardless of app ordering.
func appsFingerprint(apps []discovery.Instance) string {
	var ids, paths, stores []string
	for _, a := range apps {
		ids = append(ids, a.AppID)
		paths = append(paths, a.ResourcePaths...)
		if a.ConfigPath != "" {
			paths = append(paths, filepath.Dir(a.ConfigPath))
		}
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				stores = append(stores, c.Name)
			}
		}
	}
	sort.Strings(ids)
	sort.Strings(paths)
	sort.Strings(stores)

	h := sha256.New()
	for _, group := range [][]string{ids, {"|paths|"}, paths, {"|stores|"}, stores} {
		for _, s := range group {
			h.Write([]byte(s))
			h.Write([]byte{0})
		}
	}
	return hex.EncodeToString(h.Sum(nil))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run 'TestDerivePaths|TestAppsFingerprint' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/derive.go cmd/derive_test.go
git commit -m "feat(cmd): add path-derivation and apps-fingerprint helpers"
```

---

### Task 4: Reconciler core — derived state, reconcile, and interface methods

Create the reconciler: it holds the swappable derived state behind a `sync.RWMutex`, implements `server.StoreRegistry` (`Stores()`) and `server.WorkflowBackend` (`ServiceFor()`), exposes `Paths()` for the resources provider, and reconciles on demand with connection diff / retain-on-failure / close-stale semantics.

**Files:**
- Create: `cmd/reconciler.go`
- Test: `cmd/reconciler_test.go`

**Interfaces:**
- Consumes: `derivePaths`, `appsFingerprint` (Task 3); `newStoreBackend`, `storeOpener` (Task 2); `newStoreRegistry`, `storeRegistry`, `storeBackend` (`cmd/workflow.go`); `statestore.Detect`, `statestore.ConnInfo`, `statestore.New`, `statestore.Component`, `statestore.Store` (`pkg/statestore`); `discovery.Service`, `discovery.Instance` (`pkg/discovery`); `server.StoreInfo` (`pkg/server`).
- Produces:
  - `func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client) *reconciler`
  - methods: `(*reconciler).reconcile(apps []discovery.Instance, fp string)`, `(*reconciler).Stores() []server.StoreInfo`, `(*reconciler).ServiceFor(name string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool)`, `(*reconciler).Paths() []string`, `(*reconciler).fingerprint() string`
  - field `open storeOpener` (defaults to `statestore.New`; tests override).

- [ ] **Step 1: Write the failing tests**

Create `cmd/reconciler_test.go` (note the mandatory `//go:build unit` tag):

```go
//go:build unit

package cmd

import (
	"context"
	"errors"
	"net/http"
	"path/filepath"
	"sync"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// fakeApps is a minimal discovery.Service returning a fixed list.
type fakeApps struct{ insts []discovery.Instance }

func (f fakeApps) List(context.Context) ([]discovery.Instance, error) { return f.insts, nil }
func (f fakeApps) Get(_ context.Context, id string) (discovery.Instance, error) {
	for _, in := range f.insts {
		if in.AppID == id {
			return in, nil
		}
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

// countingStore wraps no real backend; it only tracks Close calls.
type countingStore struct {
	closes *int32
	mu     *sync.Mutex
}

func (s countingStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", nil
}
func (s countingStore) Get(context.Context, string) ([]byte, error)            { return nil, nil }
func (s countingStore) BulkGet(context.Context, []string) (map[string][]byte, error) {
	return map[string][]byte{}, nil
}
func (s countingStore) Delete(context.Context, string) error          { return nil }
func (s countingStore) Set(context.Context, string, []byte) error     { return nil }
func (s countingStore) Close() error {
	s.mu.Lock()
	*s.closes++
	s.mu.Unlock()
	return nil
}

func compYAML(t *testing.T, dir, name, storeType string) string {
	t.Helper()
	p := filepath.Join(dir, name+".yaml")
	body := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: " + name +
		"\nspec:\n  type: " + storeType + "\n  version: v1\n  metadata:\n" +
		"  - name: actorStateStore\n    value: \"true\"\n  - name: redisHost\n    value: localhost:6379\n"
	require.NoError(t, writeFile(p, body))
	return p
}

func TestReconciler_NewResourcePathAppearsInPaths(t *testing.T) {
	dir := t.TempDir()
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})

	apps := []discovery.Instance{{AppID: "order", ResourcePaths: []string{dir}}}
	rc.reconcile(apps, appsFingerprint(apps))

	require.Contains(t, rc.Paths(), dir)
}

func TestReconciler_ActiveStoreSwapsAndClosesOldExactlyOnce(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	compYAML(t, dirA, "store-a", "state.redis")
	compYAML(t, dirB, "store-b", "state.redis")

	var closes int32
	var mu sync.Mutex
	opened := map[string]int{}
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})
	rc.open = func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		mu.Lock()
		opened[c.Name]++
		mu.Unlock()
		return countingStore{closes: &closes, mu: &mu}, nil
	}

	// First app loads store-a from dirA.
	apps1 := []discovery.Instance{{AppID: "a", ResourcePaths: []string{dirA},
		Components: []discovery.Component{{Name: "store-a", Type: "state.redis"}}}}
	rc.reconcile(apps1, appsFingerprint(apps1))
	require.Len(t, rc.Stores(), 1)
	require.Equal(t, "store-a", rc.Stores()[0].Name)
	require.EqualValues(t, 0, closes)

	// Second app loads store-b from dirB: active store changes -> old closed once.
	apps2 := []discovery.Instance{{AppID: "b", ResourcePaths: []string{dirB},
		Components: []discovery.Component{{Name: "store-b", Type: "state.redis"}}}}
	rc.reconcile(apps2, appsFingerprint(apps2))
	require.Equal(t, "store-b", rc.Stores()[0].Name)
	require.EqualValues(t, 1, closes, "old connection must be closed exactly once")
	require.Equal(t, 1, opened["store-b"])
}

func TestReconciler_RetainsConnectionWhenNewOpenFails(t *testing.T) {
	dirA, dirB := t.TempDir(), t.TempDir()
	compYAML(t, dirA, "store-a", "state.redis")
	compYAML(t, dirB, "store-b", "state.redis")

	var closes int32
	var mu sync.Mutex
	failNext := false
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})
	rc.open = func(_ context.Context, c statestore.Component) (statestore.Store, error) {
		if failNext {
			return nil, errors.New("connection refused")
		}
		return countingStore{closes: &closes, mu: &mu}, nil
	}

	apps1 := []discovery.Instance{{AppID: "a", ResourcePaths: []string{dirA},
		Components: []discovery.Component{{Name: "store-a", Type: "state.redis"}}}}
	rc.reconcile(apps1, appsFingerprint(apps1))
	require.Equal(t, "store-a", rc.Stores()[0].Name)

	// New active store election, but the open fails: keep serving store-a.
	failNext = true
	apps2 := []discovery.Instance{{AppID: "b", ResourcePaths: []string{dirB},
		Components: []discovery.Component{{Name: "store-b", Type: "state.redis"}}}}
	rc.reconcile(apps2, appsFingerprint(apps2))
	require.Equal(t, "store-a", rc.Stores()[0].Name, "must retain previous store when new open fails")
	require.EqualValues(t, 0, closes, "old working connection must not be closed on failed swap")
}
```

Add a tiny test helper `writeFile` in the same test file (avoids importing os in every test):

```go
func writeFile(path, body string) error {
	return osWriteFile(path, []byte(body))
}
```

and at the top of the file add the import alias by using `os.WriteFile` directly instead — replace the two helpers above with a single direct call. (Implementer note: simplest is to `import "os"` and call `os.WriteFile(p, []byte(body), 0o644)` inside `compYAML`; delete the `writeFile`/`osWriteFile` indirection.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run TestReconciler -v`
Expected: FAIL — `undefined: newReconciler`.

- [ ] **Step 3: Implement the reconciler core**

Create `cmd/reconciler.go`:

```go
package cmd

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// Compile-time interface assertions.
var _ server.StoreRegistry = (*reconciler)(nil)
var _ server.WorkflowBackend = (*reconciler)(nil)

// connectTimeout bounds a single state-store connection attempt during reconcile.
const connectTimeout = 15 * time.Second

// reconciler owns all state that used to be frozen at boot from the running-apps
// snapshot: the resource scan paths, the detected state stores, the active-store
// election, and the live workflow DB connection. It re-derives this state when
// the apps fingerprint changes, swapping the DB connection only when the elected
// active store's identity changes. All reads take the read lock and never block
// on a reconnect.
type reconciler struct {
	// immutable after construction
	apps           discovery.Service
	namespace      string
	homeDir        string
	stateStorePath string
	client         *http.Client
	open           storeOpener

	reconciling atomic.Bool // single-flight guard for background reconciles

	mu             sync.RWMutex
	fp             string
	resPaths       []string
	registry       *storeRegistry
	backend        *storeBackend
	closers        []func() error
	activeIdentity string // name|type|connInfo of the open store; "" means none
	closed         bool
}

// newReconciler builds a reconciler. open defaults to statestore.New; tests
// override it via the exported field after construction.
func newReconciler(apps discovery.Service, namespace, homeDir, stateStorePath string, client *http.Client) *reconciler {
	return &reconciler{
		apps:           apps,
		namespace:      namespace,
		homeDir:        homeDir,
		stateStorePath: stateStorePath,
		client:         client,
		open:           statestore.New,
		registry:       newStoreRegistry(nil, nil),
	}
}

// appIDs lists current app IDs; used by the workflow service for key scoping.
func (rc *reconciler) appIDs(ctx context.Context) ([]string, error) {
	apps, err := rc.apps.List(ctx)
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(apps))
	for _, a := range apps {
		ids = append(ids, a.AppID)
	}
	return ids, nil
}

// identity returns a secrets-free key for connection-change detection.
func identity(c *statestore.Component) string {
	if c == nil {
		return ""
	}
	return c.Name + "|" + c.Type + "|" + statestore.ConnInfo(*c)
}

// reconcile re-derives state from apps and swaps it in. fp is the precomputed
// fingerprint for apps. The DB connection is reopened only when the active
// store's identity changes; if reopening fails while a working connection
// exists, the previous connection is retained (registry unchanged) and only the
// resource paths and fingerprint are refreshed.
func (rc *reconciler) reconcile(apps []discovery.Instance, fp string) {
	log := slog.Default().With("component", "reconciler")
	resPaths, scanPaths, loaded := derivePaths(apps, rc.homeDir, rc.stateStorePath)
	detected, _ := statestore.Detect(scanPaths)
	newReg := newStoreRegistry(detected, loaded)
	newID := identity(newReg.active())

	rc.mu.RLock()
	curID := rc.activeIdentity
	curHasConn := rc.backend != nil && rc.backend.activeName != ""
	rc.mu.RUnlock()

	// Active store unchanged: refresh listings only, keep the live connection.
	if newID == curID && (newReg.active() == nil || curHasConn) {
		rc.mu.Lock()
		rc.resPaths, rc.registry, rc.fp = resPaths, newReg, fp
		rc.mu.Unlock()
		return
	}

	// Active store changed: build a fresh backend (opens the new connection).
	octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	newBackend, newClosers := newStoreBackend(octx, detected, loaded, rc.namespace, rc.client, rc.apps, rc.appIDs, rc.open)
	openFailed := newReg.active() != nil && newBackend.activeName == ""

	if openFailed && curHasConn {
		// Keep the previous working connection; only refresh resource paths + fp.
		for _, c := range newClosers {
			_ = c()
		}
		rc.mu.Lock()
		rc.resPaths, rc.fp = resPaths, fp
		rc.mu.Unlock()
		log.Warn("new active store failed to open; retaining previous connection",
			"intended", newID, "active", curID)
		return
	}

	rc.mu.Lock()
	if rc.closed {
		rc.mu.Unlock()
		for _, c := range newClosers {
			_ = c()
		}
		return
	}
	old := rc.closers
	rc.resPaths, rc.registry, rc.backend, rc.closers = resPaths, newReg, newBackend, newClosers
	rc.activeIdentity, rc.fp = newID, fp
	rc.mu.Unlock()

	for _, c := range old {
		_ = c()
	}
	log.Info("reconciled derived state", "activeStore", newID, "detected", len(detected))
}

// Stores satisfies server.StoreRegistry.
func (rc *reconciler) Stores() []server.StoreInfo {
	rc.mu.RLock()
	reg := rc.registry
	rc.mu.RUnlock()
	if reg == nil {
		return []server.StoreInfo{}
	}
	return reg.Stores()
}

// ServiceFor satisfies server.WorkflowBackend.
func (rc *reconciler) ServiceFor(name string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	rc.mu.RLock()
	b := rc.backend
	rc.mu.RUnlock()
	if b == nil {
		return nil, nil, nil, false
	}
	return b.ServiceFor(name)
}

// Paths returns the current resource scan paths (provider for resources.New).
func (rc *reconciler) Paths() []string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	out := make([]string, len(rc.resPaths))
	copy(out, rc.resPaths)
	return out
}

// fingerprint returns the last reconciled apps fingerprint.
func (rc *reconciler) fingerprint() string {
	rc.mu.RLock()
	defer rc.mu.RUnlock()
	return rc.fp
}

var _ = errors.New // keep errors import if unused after edits
```

(Implementer note: remove the trailing `var _ = errors.New` line and the `errors` import if `errors` ends up unused.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run TestReconciler -v`
Expected: PASS. Fix the test-file import notes from Step 1 (`os.WriteFile`, drop the `writeFile` indirection, ensure `server` is imported) if the build complains.

- [ ] **Step 5: Run the full cmd package to confirm nothing regressed**

Run: `go test -tags unit ./cmd/ -v`
Expected: PASS (existing `TestNewStoreBackend*`, `TestStoreRegistry*` still green).

- [ ] **Step 6: Commit**

```bash
git add cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(cmd): add reconciler owning live store registry/backend/paths"
```

---

### Task 5: Single-flight trigger decorator over discovery.Service

Add a `discovery.Service` decorator that fires reconciliation after each `List`, gated by the fingerprint and a single-flight guard, plus the reconciler's `Close()`. The reconnect runs in a background goroutine so the apps poll is never blocked.

**Files:**
- Modify: `cmd/reconciler.go` (add decorator + `Close` + `maybeReconcile`)
- Test: `cmd/reconciler_test.go` (add cases)

**Interfaces:**
- Consumes: `reconciler` (Task 4); `discovery.Service` (`pkg/discovery`).
- Produces:
  - `func (rc *reconciler) Close() error`
  - `func (rc *reconciler) maybeReconcile(apps []discovery.Instance)`
  - `type reconcilingApps struct { inner discovery.Service; rc *reconciler }` implementing `discovery.Service`.

- [ ] **Step 1: Write the failing tests**

Append to `cmd/reconciler_test.go`:

```go
func TestReconcilingApps_ListTriggersReconcileOnChange(t *testing.T) {
	dir := t.TempDir()
	apps := []discovery.Instance{{AppID: "order", ResourcePaths: []string{dir}}}
	inner := fakeApps{insts: apps}
	rc := newReconciler(inner, "default", "", "", &http.Client{})
	dec := reconcilingApps{inner: inner, rc: rc}

	got, err := dec.List(context.Background())
	require.NoError(t, err)
	require.Len(t, got, 1)

	// Reconcile runs in the background; wait for the fingerprint to settle.
	require.Eventually(t, func() bool {
		return rc.fingerprint() == appsFingerprint(apps)
	}, time.Second, 5*time.Millisecond)
	require.Contains(t, rc.Paths(), dir)
}

func TestReconciler_CloseClosesActiveConnection(t *testing.T) {
	dir := t.TempDir()
	compYAML(t, dir, "store-a", "state.redis")
	var closes int32
	var mu sync.Mutex
	rc := newReconciler(fakeApps{}, "default", "", "", &http.Client{})
	rc.open = func(context.Context, statestore.Component) (statestore.Store, error) {
		return countingStore{closes: &closes, mu: &mu}, nil
	}
	apps := []discovery.Instance{{AppID: "a", ResourcePaths: []string{dir},
		Components: []discovery.Component{{Name: "store-a", Type: "state.redis"}}}}
	rc.reconcile(apps, appsFingerprint(apps))

	require.NoError(t, rc.Close())
	require.EqualValues(t, 1, closes)
}
```

Add `"time"` to the test imports if not already present.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run 'TestReconcilingApps|TestReconciler_Close' -v`
Expected: FAIL — `undefined: reconcilingApps` / `rc.Close undefined`.

- [ ] **Step 3: Implement the decorator, maybeReconcile, and Close**

Append to `cmd/reconciler.go`:

```go
// maybeReconcile schedules a background reconcile when the apps fingerprint has
// changed and no reconcile is already in flight (single-flight). It never blocks
// the caller and never opens connections on the caller's goroutine.
func (rc *reconciler) maybeReconcile(apps []discovery.Instance) {
	fp := appsFingerprint(apps)
	if fp == rc.fingerprint() {
		return
	}
	if !rc.reconciling.CompareAndSwap(false, true) {
		return // a reconcile is already running; the next poll will catch up
	}
	go func() {
		defer rc.reconciling.Store(false)
		rc.reconcile(apps, fp)
	}()
}

// Close closes whatever connection is currently open and prevents further swaps.
func (rc *reconciler) Close() error {
	rc.mu.Lock()
	rc.closed = true
	old := rc.closers
	rc.closers = nil
	rc.mu.Unlock()
	var err error
	for _, c := range old {
		if e := c(); e != nil {
			err = e
		}
	}
	return err
}

// reconcilingApps decorates a discovery.Service so every List fires a
// fingerprint-gated, single-flight reconcile. Get is a pass-through; the
// frontend polls List, which is sufficient to drive reconciliation.
type reconcilingApps struct {
	inner discovery.Service
	rc    *reconciler
}

func (d reconcilingApps) List(ctx context.Context) ([]discovery.Instance, error) {
	apps, err := d.inner.List(ctx)
	if err == nil {
		d.rc.maybeReconcile(apps)
	}
	return apps, err
}

func (d reconcilingApps) Get(ctx context.Context, appID string) (discovery.Instance, error) {
	return d.inner.Get(ctx, appID)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run 'TestReconcilingApps|TestReconciler_Close' -v`
Expected: PASS.

- [ ] **Step 5: Run the race detector on the package**

Run: `go test -tags unit -race ./cmd/ -run 'TestReconcil' -v`
Expected: PASS, no data races reported.

- [ ] **Step 6: Commit**

```bash
git add cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(cmd): single-flight reconcile trigger decorator and Close"
```

---

### Task 6: Wire the reconciler into `assembleOptions`

Replace the boot-frozen derivations in `assembleOptions` with the reconciler: seed it synchronously so first paint is correct, wrap the apps service with the decorator, and return `reconciler.Close` as the single closer.

**Files:**
- Modify: `cmd/serve.go:33-106`

**Interfaces:**
- Consumes: `newReconciler`, `reconcilingApps`, `reconciler.Close`, `reconciler.reconcile`, `reconciler.Paths`, `appsFingerprint` (Tasks 3–5); `resources.New` (Task 1).
- Produces: unchanged `assembleOptions` signature.

- [ ] **Step 1: Replace the body of `assembleOptions`**

In `cmd/serve.go`, replace everything between the function signature and its `return` with the reconciler wiring. The new body (keeping the existing signature at line 33):

```go
func assembleOptions(ctx context.Context, deps serveDeps, dist fs.FS) (server.Options, []func() error) {
	appsSvc := deps.Apps

	// Build the reconciler that owns all apps-derived state (resource paths,
	// detected state stores, active-store election, live workflow DB connection).
	rc := newReconciler(appsSvc, deps.Namespace, deps.HomeDir, deps.StateStorePath, deps.HTTPClient)

	// Seed once synchronously from the boot snapshot so the first request is
	// correct. Best-effort: an empty/failed list yields an empty derived state.
	var apps []discovery.Instance
	if got, err := appsSvc.List(ctx); err == nil {
		apps = got
	}
	rc.reconcile(apps, appsFingerprint(apps))

	// The decorator fires a fingerprint-gated reconcile on every /api/apps poll.
	decorated := reconcilingApps{inner: appsSvc, rc: rc}

	newsSvc := news.New(&http.Client{Timeout: 5 * time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)

	return server.Options{
		BasePath:  deps.BasePath,
		DistFS:    dist,
		Version:   version.Get(),
		Apps:      decorated,
		Backend:   rc,
		Stores:    rc,
		Resources: resources.New(rc.Paths),
		News:      newsSvc,
	}, []func() error{rc.Close}
}
```

Remove the now-unused imports from `cmd/serve.go` if the compiler flags them: `path/filepath`, `strings` (the path/loaded derivation moved into `derivePaths`/the reconciler), and `statestore` (Detect moved into the reconciler). Keep `discovery` (used for the `[]discovery.Instance` declaration), `resources`, `news`, `server`, `version`, `net/http`, `time`, `io/fs`, `context`.

- [ ] **Step 2: Build to confirm imports are correct**

Run: `go build ./...`
Expected: success. If `cmd/serve.go` reports an unused import, delete it; if it reports `undefined`, re-add the needed one per the note above.

- [ ] **Step 3: Run the integration test**

Run: `go test -tags integration ./cmd/ -run TestServe -v`
Expected: PASS — `/api/apps` shows `"order"`, and `/api/workflows` returns `"instanceId":"inst-1"` through the reconciler-built backend connected to the seeded SQLite store.

- [ ] **Step 4: Run the full test suite with the race detector**

Run: `go test -tags unit -race ./...` then `go test -tags integration -race ./cmd/...`
Expected: PASS across all packages, no data races. (`make test-go` runs the unit suite with `-race`.)

- [ ] **Step 5: Manual smoke test (live reconnect)**

```bash
go run . --no-open
```

Then, with a Dapr app already running, start a *second* app that loads a different state store (e.g. via `dapr run` with its own resources path). Within ~3s of the running dashboard's poll, confirm:
- the new app appears in `GET http://127.0.0.1:9090/api/apps`,
- the new component appears in `GET http://127.0.0.1:9090/api/resources?kind=component`,
- `GET http://127.0.0.1:9090/api/statestores` reflects the newly-elected active store.

Stop an app and confirm the lists update on the next poll. (If no Dapr apps are available in this environment, note that and rely on the integration + unit tests.)

- [ ] **Step 6: Commit**

```bash
git add cmd/serve.go
git commit -m "feat(cmd): keep store/resources state live via reconciler in assembleOptions"
```

---

## Self-Review

**Spec coverage:**
- "resPaths frozen" → Tasks 1, 3, 6 (live provider fed by reconciler `Paths()`). ✓
- "statestore.Detect / detected frozen" → Task 4 (`reconcile` re-runs `Detect`). ✓
- "loaded set + registry election frozen" → Tasks 3, 4 (`derivePaths` loaded set + `newStoreRegistry` per reconcile). ✓
- "backend DB connection frozen; must reconnect live" → Task 4 (connection diff, swap, close-stale) + Task 5 (single-flight background trigger). ✓
- "trigger = existing /api/apps poll + fingerprint" → Tasks 3, 5 (`appsFingerprint`, `reconcilingApps.List` → `maybeReconcile`). ✓
- "reconnect off the hot path / async" → Task 5 (goroutine + single-flight). ✓
- "same identity → keep connection" → Task 4 (`newID == curID` branch). ✓
- "open failure → retain old entry" → Task 4 (`openFailed && curHasConn` branch). ✓
- "Close closes current connection; assembleOptions returns single closer" → Tasks 5, 6. ✓
- "background context for opens" → Task 4 (`context.WithTimeout(context.Background(), connectTimeout)`). ✓
- "documented limitation: YAML content edits without app restart don't reconnect" → inherent in fingerprint inputs (Task 3); behavior matches spec. ✓
- "out of scope: UI toast, second poll loop, file watching" → none added. ✓

**Placeholder scan:** No TBD/TODO. Two implementer notes (test-file `os.WriteFile` simplification in Task 4; unused-import cleanup in Tasks 4 and 6) are explicit cleanups, not deferred work.

**Type consistency:** `storeOpener` defined in Task 2 and used in Tasks 4. `newStoreBackend`'s new arg order matches Task 4's call. `reconcile(apps, fp)`, `Paths()`, `Stores()`, `ServiceFor(name)`, `fingerprint()`, `maybeReconcile(apps)`, `Close()` names are consistent across Tasks 4–6. `appsFingerprint` / `derivePaths` signatures match between Task 3 and their callers in Tasks 4–6. `reconciler` implements `server.StoreRegistry` and `server.WorkflowBackend` (asserted in Task 4), matching the `Stores`/`Backend` fields of `server.Options` used in Task 6.
