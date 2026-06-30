# Path-aware active-store election Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Elect the state store a running app actually loaded — identified by its component file living under the app's `resourcePaths` — so a same-named global `~/.dapr/components` default no longer shadows it as the active store.

**Architecture:** `derivePaths` returns the union of running apps' resource paths (`appPaths`); `newStoreRegistry` gains an `isAppProvided(c) = isLoaded(c) && pathUnder(c.Path, appPaths)` check and a new precedence that prefers app-provided stores over a same-named global default; the reconciler passes `appPaths` through. Backward-compatible: nil `appPaths` falls through to today's loaded→actor→first precedence.

**Tech Stack:** Go (`path/filepath`, `os`, `runtime`, reuse existing `normPath`), `testify/require`.

## Global Constraints

- Build tags: new/changed Go test files start with `//go:build unit` (unit) or `//go:build integration`. Unit: `go test -tags unit -race ./...`; integration: `go test -tags integration ./cmd/...`. Bare `go test` finds no tests in `cmd`.
- Commit ONLY each task's files via explicit `git add <paths>`; never `git commit -am`. Leave pre-existing uncommitted artifacts `web/dist/index.html` + `web/package-lock.json` untouched.
- Reuse the existing `normPath` (`cmd/registry.go`: `filepath.Clean` + `strings.ToLower` on Windows) for all path normalization — do not re-implement it.
- `/api/statestores` listing, the registry, and the connection pool are unchanged; only the `active` election flips.
- Election precedence (exact order): (1) app-provided & actorStateStore, (2) app-provided, (3) loaded & actorStateStore, (4) loaded, (5) actorStateStore, (6) first component.

---

### Task 1: Path-aware election

**Files:**
- Modify: `cmd/derive.go` (`derivePaths` returns `appPaths`)
- Modify: `cmd/workflow.go` (`pathUnder` helper + `newStoreRegistry` signature + precedence)
- Modify: `cmd/reconciler.go:81,101` (capture + pass `appPaths`)
- Modify (tests): `cmd/derive_test.go`, `cmd/workflow_test.go`, `cmd/reconciler_test.go`

**Interfaces:**
- Consumes: existing `statestore.Component` (`Name`, `Type`, `Path`, `Metadata`), `normPath` (`cmd/registry.go`), `storeRegistry`/`active()`.
- Produces:
  - `derivePaths(apps []discovery.Instance, homeDir, stateStorePath string) (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string)`
  - `func pathUnder(child string, parents []string) bool`
  - `func newStoreRegistry(comps []statestore.Component, loaded map[string]bool, appPaths []string) *storeRegistry`

- [ ] **Step 1: Write the failing tests**

Append to `cmd/derive_test.go`:

```go
func TestDerivePaths_AppPaths(t *testing.T) {
	apps := []discovery.Instance{
		{AppID: "a", ResourcePaths: []string{"/app/a/resources"}},
		{AppID: "b", ResourcePaths: []string{"/app/b/resources"}},
	}
	_, _, _, appPaths := derivePaths(apps, "/home/me", "")
	require.ElementsMatch(t, []string{"/app/a/resources", "/app/b/resources"}, appPaths)
	require.NotContains(t, appPaths, "/home/me/.dapr/components")
}
```

Append to `cmd/workflow_test.go`:

```go
func TestStoreRegistry_AppPathStoreWinsOverSameNamedGlobalDefault(t *testing.T) {
	comps := []statestore.Component{
		// Global ~/.dapr default — detected first.
		{Name: "statestore", Type: "state.redis", Path: "/home/me/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
		// The app's own store, under its resource path.
		{Name: "statestore", Type: "state.redis", Path: "/app/pr-digest/resources/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:16379"}},
	}
	loaded := map[string]bool{"statestore": true}
	appPaths := []string{"/app/pr-digest/resources"}

	r := newStoreRegistry(comps, loaded, appPaths)
	require.NotNil(t, r.active())
	require.Equal(t, "localhost:16379", r.active().Metadata["redisHost"],
		"the app-provided store must win over the same-named ~/.dapr default")
}

func TestStoreRegistry_FallsBackToGlobalDefaultWhenNoAppStore(t *testing.T) {
	comps := []statestore.Component{
		{Name: "statestore", Type: "state.redis", Path: "/home/me/.dapr/components/statestore.yaml",
			Metadata: map[string]string{"actorStateStore": "true", "redisHost": "localhost:6379"}},
	}
	loaded := map[string]bool{"statestore": true}
	// No appPaths: the app provided no store of its own → the loaded global default is elected.
	r := newStoreRegistry(comps, loaded, nil)
	require.NotNil(t, r.active())
	require.Equal(t, "localhost:6379", r.active().Metadata["redisHost"])
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run 'TestDerivePaths_AppPaths|TestStoreRegistry_AppPathStoreWins|TestStoreRegistry_FallsBackToGlobalDefault' -v`
Expected: FAIL to compile — `derivePaths` returns 3 values not 4; `newStoreRegistry` takes 2 args not 3.

- [ ] **Step 3: Add `appPaths` to `derivePaths`**

In `cmd/derive.go`, change the signature and collect `appPaths` in the existing apps loop:

```go
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string) (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string) {
	loaded = make(map[string]bool)
	for _, a := range apps {
		for _, c := range a.Components {
			if strings.HasPrefix(c.Type, "state.") {
				loaded[c.Name] = true
			}
		}
		appPaths = append(appPaths, a.ResourcePaths...)
	}
```

Leave the rest of the function body unchanged, and change the final return to:

```go
	return resPaths, scanPaths, loaded, appPaths
}
```

- [ ] **Step 4: Add `pathUnder` + path-aware `newStoreRegistry`**

In `cmd/workflow.go`, add the `pathUnder` helper (near `newStoreRegistry`):

```go
// pathUnder reports whether child equals, or is nested under, any of parents,
// after normalization (filepath.Clean, case-folded on Windows via normPath).
func pathUnder(child string, parents []string) bool {
	if child == "" {
		return false
	}
	c := normPath(child)
	for _, p := range parents {
		np := normPath(p)
		if c == np || strings.HasPrefix(c, np+string(os.PathSeparator)) {
			return true
		}
	}
	return false
}
```

Ensure `cmd/workflow.go` imports `os` and `strings` (add to the import block if missing).

Replace `newStoreRegistry` with the path-aware version:

```go
func newStoreRegistry(comps []statestore.Component, loaded map[string]bool, appPaths []string) *storeRegistry {
	r := &storeRegistry{comps: comps, activeIndex: -1}
	if len(comps) == 0 {
		return r
	}

	isLoaded := func(c statestore.Component) bool { return loaded != nil && loaded[c.Name] }
	isActor := func(c statestore.Component) bool { return c.Metadata["actorStateStore"] == "true" }
	// isAppProvided: the app loaded a store of this name AND the detected file
	// lives under one of the running apps' resource paths — i.e. the store the
	// app actually provided, as opposed to a same-named global ~/.dapr default.
	isAppProvided := func(c statestore.Component) bool { return isLoaded(c) && pathUnder(c.Path, appPaths) }

	// 1. app-provided AND actorStateStore.
	for i, c := range comps {
		if isAppProvided(c) && isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 2. app-provided (any).
	for i, c := range comps {
		if isAppProvided(c) {
			r.activeIndex = i
			return r
		}
	}
	// 3. loaded AND actorStateStore (fallback: app uses a global default store).
	for i, c := range comps {
		if isLoaded(c) && isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 4. loaded (any).
	for i, c := range comps {
		if isLoaded(c) {
			r.activeIndex = i
			return r
		}
	}
	// 5. actorStateStore.
	for i, c := range comps {
		if isActor(c) {
			r.activeIndex = i
			return r
		}
	}
	// 6. first component.
	r.activeIndex = 0
	return r
}
```

- [ ] **Step 5: Update the production call sites in `cmd/reconciler.go`**

Line ~81: capture the new return:

```go
	resPaths, scanPaths, loaded, appPaths := derivePaths(apps, rc.homeDir, rc.stateStorePath)
```

Line ~101 (the `newReg := newStoreRegistry(...)` call): pass `appPaths`:

```go
	newReg := newStoreRegistry(detected, loaded, appPaths)
```

- [ ] **Step 6: Update the remaining call sites in tests**

In `cmd/derive_test.go`, fix the two existing `derivePaths` destructures to capture the 4th value as `_`:
- line ~17: `resPaths, scanPaths, loaded, _ := derivePaths(apps, "/home/me", "")`
- line ~33: `_, scanPaths, _, _ := derivePaths(apps, "/home/me", "/explicit/store.yaml")`

In `cmd/reconciler_test.go`, the two `newStoreRegistry([]statestore.Component{active}, nil)` calls (lines ~97, ~154) gain a `nil` third arg:
```go
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
```

In `cmd/workflow_test.go`, every existing `newStoreRegistry(...)` call (lines ~87, 108, 125, 137, 166, 178, 194) gains a `nil` third arg, e.g. `newStoreRegistry(comps, nil, nil)` / `newStoreRegistry(comps, loaded, nil)` / `newStoreRegistry(nil, nil, nil)` — match each call's existing first two args, append `, nil`. (These existing tests assert name-based precedence; with `nil` appPaths they exercise steps 3–6 and keep their current outcomes.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `go build ./...`
Expected: success.
Run: `go test -tags unit -race ./cmd/ -v`
Expected: PASS — the three new tests plus all existing `TestStoreRegistry_*`, `TestDerivePaths_*`, `TestReconciler_*` (unchanged outcomes via the `nil` appPaths fall-through).

- [ ] **Step 8: Commit**

```bash
git add cmd/derive.go cmd/workflow.go cmd/reconciler.go cmd/derive_test.go cmd/workflow_test.go cmd/reconciler_test.go
git commit -m "fix(cmd): prefer the app's own store over a same-named ~/.dapr default in active-store election"
```

---

### Task 2: End-to-end integration test

**Files:**
- Create: `cmd/store_election_integration_test.go`

**Interfaces:**
- Consumes: `assembleOptions`, `server.NewRouter`, `wiringFakeApps`, `httpGet` (existing in `cmd/serve_integration_test.go`, same package + `//go:build integration`); `statestore` (Component/New/SeedForTest unused here — only detection matters); the Task 1 election change.
- Produces: nothing later relies on this.

- [ ] **Step 1: Write the integration test**

Create `cmd/store_election_integration_test.go`. It reproduces the `pr-digest` shape: a running app whose `ResourcePaths` contain a `statestore.yaml` (app store), plus a same-named `statestore.yaml` under `<HomeDir>/.dapr/components` (global default). Assert `/api/statestores` marks the **app-path** store `active:true` and the global default `active:false`. Uses SQLite component YAMLs (detection only — no DB connection needed for the active-flag assertion):

```go
//go:build integration

package cmd

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"testing/fstest"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/stretchr/testify/require"
)

func TestStoreElection_AppStoreWinsOverSameNamedGlobalDefault(t *testing.T) {
	home := t.TempDir()
	appDir := t.TempDir()

	// Two same-named state.redis components: global default vs the app's own.
	comp := func(host string) string {
		return "apiVersion: dapr.io/v1alpha1\nkind: Component\n" +
			"metadata:\n  name: statestore\n" +
			"spec:\n  type: state.redis\n  version: v1\n  metadata:\n" +
			"  - name: redisHost\n    value: " + host + "\n" +
			"  - name: actorStateStore\n    value: \"true\"\n"
	}
	defaultDir := filepath.Join(home, ".dapr", "components")
	require.NoError(t, os.MkdirAll(defaultDir, 0o755))
	require.NoError(t, os.WriteFile(filepath.Join(defaultDir, "statestore.yaml"), []byte(comp("localhost:6379")), 0o644))
	require.NoError(t, os.WriteFile(filepath.Join(appDir, "statestore.yaml"), []byte(comp("localhost:16379")), 0o644))

	dist := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}

	// The app loaded a component named "statestore" and its resources live in appDir.
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace: "default",
		Apps: wiringFakeApps{insts: []discovery.Instance{{
			AppID: "pr-digest", Health: discovery.HealthHealthy,
			ResourcePaths: []string{appDir},
			Components:    []discovery.Component{{Name: "statestore", Type: "state.redis"}},
		}}},
		HomeDir:    home,
		HTTPClient: &http.Client{Timeout: 2 * time.Second},
	}, dist)
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	srv := httptest.NewServer(server.NewRouter(opts))
	t.Cleanup(srv.Close)

	res, body := httpGet(t, srv.URL+"/api/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)

	var stores []server.StoreInfo
	require.NoError(t, json.Unmarshal([]byte(body), &stores))
	require.Len(t, stores, 2)

	var appStore, defaultStore *server.StoreInfo
	for i := range stores {
		switch stores[i].Connection {
		case "localhost:16379":
			appStore = &stores[i]
		case "localhost:6379":
			defaultStore = &stores[i]
		}
	}
	require.NotNil(t, appStore, "app store (16379) must be listed")
	require.NotNil(t, defaultStore, "global default (6379) must be listed")
	require.True(t, appStore.Active, "the app-provided store must be active")
	require.False(t, defaultStore.Active, "the same-named ~/.dapr default must not be active")
}
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `go test -tags integration ./cmd/ -run TestStoreElection_AppStoreWinsOverSameNamedGlobalDefault -v`
Expected: PASS — the app-path store (16379) is `active:true`, the `~/.dapr` default (6379) is `active:false`. (This test would have FAILED before Task 1: the global default would be active.)

- [ ] **Step 3: Run the full integration suite to confirm no regressions**

Run: `go test -tags integration -race ./cmd/...`
Expected: PASS (existing `TestServe`/secret/registry integration tests still green).

- [ ] **Step 4: Commit**

```bash
git add cmd/store_election_integration_test.go
git commit -m "test(cmd): integration test for path-aware store election (app store beats global default)"
```

---

## Self-Review

**Spec coverage:**
- "`derivePaths` returns `appPaths` = union of app resourcePaths, excluding ~/.dapr" → Task 1 Step 3 + `TestDerivePaths_AppPaths`. ✓
- "`isAppProvided = isLoaded && pathUnder(path, appPaths)` + new precedence (1–6)" → Task 1 Step 4. ✓
- "`pathUnder` reuses `normPath`, cross-platform" → Task 1 Step 4. ✓
- "Wiring passes appPaths" → Task 1 Step 5. ✓
- "Backward-compatible: nil appPaths → old behavior; existing call sites gain nil arg" → Task 1 Step 6 + Step 7 (existing tests unchanged outcomes). ✓
- "Same-name election picks app-provided; fallback to global default" → Task 1 tests. ✓
- "Integration test: two same-named stores → app one active" → Task 2. ✓
- "Out of scope: 2c selector, /api/statestores listing/registry/pool unchanged" → not touched. ✓

**Placeholder scan:** No TBD/TODO; complete code in every step.

**Type consistency:** `derivePaths` 4-value return is consumed identically in reconciler.go (Step 5) and tests (Step 6). `newStoreRegistry(comps, loaded, appPaths)` matches all call sites (reconciler + reconciler_test + workflow_test). `pathUnder(child string, parents []string) bool` matches its use in `isAppProvided`. `server.StoreInfo` fields (`Connection`, `Active`) used in Task 2 match the existing struct. `wiringFakeApps`/`httpGet` reused from `cmd/serve_integration_test.go` (not redefined). Build stays green at the end of Task 1 (all call sites updated together) and Task 2 (additive test only).
