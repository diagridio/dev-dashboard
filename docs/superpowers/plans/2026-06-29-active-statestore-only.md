# Active State Store Only — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Workflows page shows data only from the active Dapr Workflow state store (the component with `actorStateStore: "true"`), and the state-store dropdown is replaced by a non-interactive label showing the store type + a secrets-free connection summary (the colored status dot stays).

**Architecture:** Enforce single-store behavior at the backend boundary: the `/statestores` endpoint returns only the active store, and `/workflows*` only ever serves the active store because only it gets registered in the backend. A new secrets-free connection summary is computed per component type and surfaced on `StoreInfo`. The frontend drops all store-switching state and renders a label instead of a `<select>`.

**Tech Stack:** Go (chi router, components-contrib state stores), React + TypeScript, React Query, Vitest + MSW (frontend), Go `testing` + testify (backend).

## Global Constraints

- Go tests run with build tag `unit`: `go test -tags unit -race ./...` (via `make test-go`). All new/modified Go test files MUST start with `//go:build unit`.
- Frontend tests run with `vitest run` (via `make test-web`, which also runs `npm install`).
- The connection summary MUST NEVER contain credentials (passwords, user info, full connection strings with secrets). Only host/port/db-name/file-path are allowed.
- Supported state store types in this codebase are exactly: `state.redis`, `state.sqlite`, `state.postgresql`, `state.postgres` (see `pkg/statestore/store.go`). Any other type yields an empty connection summary.
- Follow existing code style: doc comments on exported identifiers, table-free focused tests matching the patterns already in each test file.
- "Active store" = the component with `actorStateStore == "true"` in metadata, else the first detected component, else none (existing `newStoreRegistry` logic in `cmd/workflow.go:31-43` — do not change this selection rule).

---

### Task 1: Add a secrets-free connection summary helper (`statestore.ConnInfo`)

**Files:**
- Create: `pkg/statestore/conninfo.go`
- Test: `pkg/statestore/conninfo_test.go`

**Interfaces:**
- Consumes: `statestore.Component` (existing — `pkg/statestore/store.go:22-28`, has `Type string` and `Metadata map[string]string`).
- Produces: `func ConnInfo(c Component) string` — returns a display string like `localhost:6379`, `localhost:5432/orders`, or `data.db`; returns `""` when no usable, non-secret metadata exists.

- [ ] **Step 1: Write the failing tests**

Create `pkg/statestore/conninfo_test.go`:

```go
//go:build unit

package statestore

import "testing"

func TestConnInfo(t *testing.T) {
	cases := []struct {
		name string
		comp Component
		want string
	}{
		{
			name: "redis uses redisHost",
			comp: Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "localhost:6379", "redisPassword": "s3cret"}},
			want: "localhost:6379",
		},
		{
			name: "redis missing host yields empty",
			comp: Component{Type: "state.redis", Metadata: map[string]string{}},
			want: "",
		},
		{
			name: "sqlite shows file path",
			comp: Component{Type: "state.sqlite", Metadata: map[string]string{"connectionString": "data.db"}},
			want: "data.db",
		},
		{
			name: "postgres URL form strips credentials",
			comp: Component{Type: "state.postgresql", Metadata: map[string]string{"connectionString": "postgres://admin:p4ss@localhost:5432/orders?sslmode=disable"}},
			want: "localhost:5432/orders",
		},
		{
			name: "postgres keyword form strips credentials",
			comp: Component{Type: "state.postgres", Metadata: map[string]string{"connectionString": "host=db1 port=5432 user=admin password=p4ss dbname=orders connect_timeout=10"}},
			want: "db1:5432/orders",
		},
		{
			name: "postgres keyword form with database alias and no port",
			comp: Component{Type: "state.postgresql", Metadata: map[string]string{"connectionString": "host=localhost database=mydb password=x"}},
			want: "localhost/mydb",
		},
		{
			name: "unsupported type yields empty",
			comp: Component{Type: "state.cosmosdb", Metadata: map[string]string{"url": "https://secret.example"}},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ConnInfo(tc.comp); got != tc.want {
				t.Fatalf("ConnInfo() = %q, want %q", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/statestore/ -run TestConnInfo -v`
Expected: FAIL — `undefined: ConnInfo`.

- [ ] **Step 3: Write the implementation**

Create `pkg/statestore/conninfo.go`:

```go
package statestore

import (
	"net/url"
	"strings"
)

// ConnInfo returns a short, human-readable connection summary for a component,
// suitable for display in the UI. It NEVER includes credentials (passwords or
// user info). Returns "" when no usable, non-secret metadata is present.
func ConnInfo(c Component) string {
	switch c.Type {
	case "state.redis":
		return c.Metadata["redisHost"]
	case "state.sqlite":
		// connectionString for sqlite is a local file path (or ":memory:"),
		// which contains no secret.
		return strings.TrimSpace(c.Metadata["connectionString"])
	case "state.postgresql", "state.postgres":
		return pgConnInfo(c.Metadata["connectionString"])
	default:
		return ""
	}
}

// pgConnInfo extracts a secrets-free "host[:port][/dbname]" summary from a
// Postgres connection string in either URL form
// (postgres://user:pass@host:5432/db) or keyword/DSN form
// (host=localhost port=5432 dbname=db user=... password=...).
// User and password are always discarded.
func pgConnInfo(cs string) string {
	cs = strings.TrimSpace(cs)
	if cs == "" {
		return ""
	}
	if strings.HasPrefix(cs, "postgres://") || strings.HasPrefix(cs, "postgresql://") {
		u, err := url.Parse(cs)
		if err != nil {
			return ""
		}
		// u.Host is host[:port] and excludes userinfo; u.Path is "/dbname".
		db := strings.TrimPrefix(u.Path, "/")
		if u.Host != "" && db != "" {
			return u.Host + "/" + db
		}
		return u.Host
	}
	// Keyword/DSN form: collect only host, port, dbname/database.
	var host, port, db string
	for _, field := range strings.Fields(cs) {
		kv := strings.SplitN(field, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch strings.ToLower(kv[0]) {
		case "host":
			host = kv[1]
		case "port":
			port = kv[1]
		case "dbname", "database":
			db = kv[1]
		}
	}
	hostPort := host
	if host != "" && port != "" {
		hostPort = host + ":" + port
	}
	switch {
	case hostPort != "" && db != "":
		return hostPort + "/" + db
	case hostPort != "":
		return hostPort
	default:
		return db
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/statestore/ -run TestConnInfo -v`
Expected: PASS (all sub-tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/statestore/conninfo.go pkg/statestore/conninfo_test.go
git commit -m "feat(statestore): add secrets-free ConnInfo connection summary"
```

---

### Task 2: Add `Connection` to `StoreInfo` and make the registry expose only the active store

**Files:**
- Modify: `pkg/server/workflows.go:25-31` (add `Connection` field to `StoreInfo`)
- Modify: `cmd/workflow.go:53-65` (`Stores()` — return only active, populate `Connection`)
- Test: `cmd/workflow_test.go` (update `TestStoreRegistry_*` to the new single-store contract)

**Interfaces:**
- Consumes: `statestore.ConnInfo` (Task 1), `storeRegistry` fields `comps []statestore.Component` and `activeIndex int` (existing — `cmd/workflow.go:23-26`).
- Produces: `StoreInfo` now has `Connection string` (`json:"connection"`). `storeRegistry.Stores()` returns a slice of length 0 (no active store) or 1 (the active store), with `Active: true` and `Connection` populated.

- [ ] **Step 1: Update the failing tests**

In `cmd/workflow_test.go`, replace the three existing registry tests (`TestStoreRegistry_FirstWhenNoActorFlag` — the one ending around line 113, `TestStoreRegistry_ActorStateStoreWins`, `TestStoreRegistry_StoreInfoMapping`) so they assert the new single-store output. Use these exact tests:

```go
func TestStoreRegistry_StoresReturnsActiveOnly_FirstFallback(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "sqlite", Type: "state.sqlite", Path: "/a/sqlite.yaml", Metadata: map[string]string{}},
	}
	r := newStoreRegistry(comps)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "redis", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 1, "only the active store is returned")
	require.Equal(t, "redis", infos[0].Name)
	require.True(t, infos[0].Active)
	require.Equal(t, "localhost:6379", infos[0].Connection)
}

func TestStoreRegistry_StoresReturnsActiveOnly_ActorStateStoreWins(t *testing.T) {
	comps := []statestore.Component{
		{Name: "redis", Type: "state.redis", Path: "/a/redis.yaml", Metadata: map[string]string{"redisHost": "localhost:6379"}},
		{Name: "pg", Type: "state.postgresql", Path: "/a/pg.yaml", Metadata: map[string]string{
			"actorStateStore":  "true",
			"connectionString": "host=localhost port=5432 dbname=orders password=x",
		}},
	}
	r := newStoreRegistry(comps)

	act := r.active()
	require.NotNil(t, act)
	require.Equal(t, "pg", act.Name)

	infos := r.Stores()
	require.Len(t, infos, 1, "only the active (actorStateStore) store is returned")
	require.Equal(t, "pg", infos[0].Name)
	require.True(t, infos[0].Active)
	require.Equal(t, "localhost:5432/orders", infos[0].Connection)
}

func TestStoreRegistry_StoreInfoMapping(t *testing.T) {
	comps := []statestore.Component{
		{Name: "mystore", Type: "state.sqlite", Path: "/path/to/sqlite.yaml", Metadata: map[string]string{"connectionString": "data.db"}},
	}
	r := newStoreRegistry(comps)

	infos := r.Stores()
	require.Len(t, infos, 1)
	require.Equal(t, "mystore", infos[0].Name)
	require.Equal(t, "state.sqlite", infos[0].Type)
	require.Equal(t, "/path/to/sqlite.yaml", infos[0].Path)
	require.Equal(t, "data.db", infos[0].Connection)
	require.True(t, infos[0].Active)
}

func TestStoreRegistry_StoresEmptyWhenNoComponents(t *testing.T) {
	r := newStoreRegistry(nil)
	require.Nil(t, r.active())
	require.Empty(t, r.Stores())
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run TestStoreRegistry -v`
Expected: FAIL — `infos[0].Connection` undefined (StoreInfo has no Connection field) and/or length assertions fail (Stores still returns all).

- [ ] **Step 3: Add the `Connection` field to `StoreInfo`**

In `pkg/server/workflows.go`, change the `StoreInfo` struct (currently lines 26-31):

```go
// StoreInfo describes the active detected state store.
type StoreInfo struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Path       string `json:"path"`
	Active     bool   `json:"active"`
	Connection string `json:"connection"` // secrets-free host/db summary for display
}
```

- [ ] **Step 4: Change `Stores()` to return only the active store with connection info**

In `cmd/workflow.go`, replace the `Stores()` method (currently lines 53-65):

```go
// Stores satisfies server.StoreRegistry. It returns ONLY the active state store
// (the one used by Dapr Workflow), or an empty slice when no store is detected.
// The connection summary is secrets-free (see statestore.ConnInfo).
func (r *storeRegistry) Stores() []server.StoreInfo {
	active := r.active()
	if active == nil {
		return []server.StoreInfo{}
	}
	return []server.StoreInfo{{
		Name:       active.Name,
		Type:       active.Type,
		Path:       active.Path,
		Active:     true,
		Connection: statestore.ConnInfo(*active),
	}}
}
```

(`statestore` is already imported in `cmd/workflow.go:11`.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run TestStoreRegistry -v`
Expected: PASS (all four tests).

- [ ] **Step 6: Commit**

```bash
git add pkg/server/workflows.go cmd/workflow.go cmd/workflow_test.go
git commit -m "feat(workflow): expose only active state store with connection summary"
```

---

### Task 3: Register only the active store in the workflow backend

**Files:**
- Modify: `cmd/workflow.go:141-202` (`newStoreBackend` — initialize only the active component)
- Test: `cmd/workflow_test.go` (add a test asserting non-active stores are not served)

**Interfaces:**
- Consumes: `newStoreRegistry` + `registry.active()` (existing), `statestore.New` (existing — `pkg/statestore/store.go:51`).
- Produces: `newStoreBackend` returns a `*storeBackend` whose `services` map contains at most one entry (the active store) and whose `activeName` is that store's name. `ServiceFor` behavior is unchanged (empty → active; unknown name → `ok=false`), so non-active store names now resolve to `ok=false` because they are never registered.

- [ ] **Step 1: Write the failing test**

`ServiceFor`/`storeBackend` unit tests live under `//go:build unit` in `cmd/workflow_test.go`. Add this test (it exercises the real `newStoreBackend` with a sqlite component, which initialises against a local file and needs no network):

```go
func TestNewStoreBackend_RegistersOnlyActiveStore(t *testing.T) {
	_ = withCapturedLogs(t)
	appIDs := func(context.Context) ([]string, error) { return nil, nil }

	dir := t.TempDir()
	comps := []statestore.Component{
		// Active: sqlite with actorStateStore=true (initialises from a local file).
		{
			Name: "wfstore", Type: "state.sqlite", Path: "/x/wf.yaml",
			Metadata: map[string]string{
				"actorStateStore":  "true",
				"connectionString": filepath.Join(dir, "wf.db"),
			},
		},
		// Non-active: sqlite, different name. Must NOT be served.
		{
			Name: "other", Type: "state.sqlite", Path: "/x/other.yaml",
			Metadata: map[string]string{"connectionString": filepath.Join(dir, "other.db")},
		},
	}

	b, closers := newStoreBackend(context.Background(), comps, "default", &http.Client{}, nil, appIDs)
	defer func() {
		for _, c := range closers {
			_ = c()
		}
	}()

	require.Equal(t, "wfstore", b.activeName)

	// Active store (explicit name) is served.
	_, _, _, ok := b.ServiceFor("wfstore")
	require.True(t, ok)

	// Empty name resolves to the active store.
	_, _, _, ok = b.ServiceFor("")
	require.True(t, ok)

	// Non-active store name is rejected.
	_, _, _, ok = b.ServiceFor("other")
	require.False(t, ok, "non-active store must not be served")
}
```

Add `"path/filepath"` to the imports of `cmd/workflow_test.go` if not already present.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/ -run TestNewStoreBackend_RegistersOnlyActiveStore -v`
Expected: FAIL — `ServiceFor("other")` returns `ok=true` (current code registers every component).

- [ ] **Step 3: Initialize only the active store**

In `cmd/workflow.go`, replace the component loop in `newStoreBackend` (currently lines 167-191, from `registry := newStoreRegistry(comps)` through the `if active := registry.active(); active != nil { ... }` block) with:

```go
	registry := newStoreRegistry(comps)
	active := registry.active()

	// Only the active state store (the one Dapr Workflow uses) is initialised
	// and served. Non-active components are detected but never connected.
	if active != nil {
		st, err := statestore.New(ctx, *active)
		if err != nil {
			fmt.Printf("warning: state store %q init failed: %v (skipping)\n", active.Name, err)
			log.Warn("state store init failed, skipping", "name", active.Name, "err", err)
		} else {
			closers = append(closers, st.Close)
			svc := workflow.New(st, namespace, appIDs)
			rem := workflow.NewRemover(client, st, namespace)
			res := newTargetResolver(apps, svc)
			b.services[active.Name] = storeEntry{svc: svc, rem: rem, targets: res}
			b.activeName = active.Name
			log.Info("active state store connected", "name", active.Name, "type", active.Type)
		}
	}
```

Leave the surrounding code intact: the `log.Info("detected state-store components", ...)` / `log.Warn("no state store detected")` block above (lines 162-165) stays, and the degraded-entry block below (lines 193-199) plus `return b, closers` stay unchanged.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./cmd/ -run TestNewStoreBackend_RegistersOnlyActiveStore -v`
Expected: PASS.

- [ ] **Step 5: Run the full cmd package tests (catch regressions in existing ServiceFor tests)**

Run: `go test -tags unit ./cmd/ -v`
Expected: PASS. The existing `TestStoreBackend_*` tests use `buildTestBackend` (a hand-built map) and are unaffected; `TestNewStoreBackend_LogsNoStoreDetected` still passes (nil comps → no active → warn logged).

- [ ] **Step 6: Commit**

```bash
git add cmd/workflow.go cmd/workflow_test.go
git commit -m "feat(workflow): register and serve only the active state store"
```

---

### Task 4: Assert the `/statestores` endpoint returns the connection field

**Files:**
- Modify: `pkg/server/workflows_test.go:172-187` (extend `TestStateStoresEndpoint`)

**Interfaces:**
- Consumes: `fakeStoreRegistry` (existing — `pkg/server/workflows_test.go:189-194`), `StoreInfo.Connection` (Task 2).
- Produces: no new code; tightens the contract test for `/statestores`.

- [ ] **Step 1: Update the test to include and assert `connection`**

In `pkg/server/workflows_test.go`, replace the body of `TestStateStoresEndpoint` so the fixture carries a connection and the assertion checks it. Keep the existing assertions on name/active:

```go
func TestStateStoresEndpoint(t *testing.T) {
	stores := fakeStoreRegistry{stores: []StoreInfo{
		{Name: "statestore", Type: "state.redis", Active: true, Connection: "localhost:6379"},
	}}
	h := apiRouter(version.Info{}, nil, nil, stores, nil, nil)
	res, body := get(t, h, "/statestores")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
	require.Contains(t, body, `"active":true`)
	require.Contains(t, body, `"connection":"localhost:6379"`)
}
```

> NOTE: Match the existing call signature of `apiRouter` used elsewhere in this test file — if the existing `TestStateStoresEndpoint` constructs the handler differently (e.g. a helper), keep that construction and only add the `Connection` field to the fixture plus the new `require.Contains` assertion. Read lines 162-194 before editing.

- [ ] **Step 2: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -run TestStateStores -v`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add pkg/server/workflows_test.go
git commit -m "test(server): assert /statestores returns connection summary"
```

---

### Task 5: Add `connection` to the frontend `StateStore` type

**Files:**
- Modify: `web/src/types/workflow.ts:35-40`

**Interfaces:**
- Produces: `StateStore` interface gains `connection: string`. Consumed by `Workflows.tsx` (Task 6).

- [ ] **Step 1: Add the field**

In `web/src/types/workflow.ts`, update the `StateStore` interface:

```ts
export interface StateStore {
  name: string
  type: string
  path: string
  active: boolean
  connection: string
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS (no type errors introduced by this change alone).

- [ ] **Step 3: Commit**

```bash
git add web/src/types/workflow.ts
git commit -m "feat(web): add connection field to StateStore type"
```

---

### Task 6: Replace the state-store dropdown with a label and drop store-switching state

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (lines 48, 69-77, 91-100, 102-108, 182-202, 247-274)

**Interfaces:**
- Consumes: `useStateStores()` (unchanged — `web/src/hooks/useWorkflows.ts:48`), `StateStore.connection` (Task 5).
- Produces: the statestore chip renders `<span className="led" />` + `statestore` + `<b>{storeLabel}</b>` with no `<select>`. No `store` query param is sent from this page; `useWorkflows`/`useRemoveWorkflows` are called without `store` so the backend serves the active store.

- [ ] **Step 1: Update the Workflows component test FIRST (TDD)**

Jump to Task 7 and write the failing frontend tests, then return here to implement. (Task 7 covers the `Workflows.test.tsx` changes; this task is the implementation that makes them pass.)

- [ ] **Step 2: Replace the store-picker derivation block**

In `web/src/pages/Workflows.tsx`, replace the current block (lines 69-77):

```tsx
  // State store picker
  const { data: storeList } = useStateStores()
  const activeStoreName = storeList?.find((s) => s.active)?.name ?? ''
  const selectedStore = urlStore || activeStoreName
  const activeStore = storeList?.find((s) => s.name === selectedStore)
  // Derive store type short label (e.g. "redis" from "state.redis")
  const storeTypeLabel = activeStore
    ? (activeStore.type.split('.').pop() ?? activeStore.type)
    : (activeStoreName ? activeStoreName : 'unknown')
```

with:

```tsx
  // Active state store (the one Dapr Workflow uses). The API returns only this
  // store, so there is no switching — we render it as a label.
  const { data: storeList } = useStateStores()
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]
  // Label: short type + secrets-free connection, e.g. "redis · localhost:6379".
  const storeTypeShort = activeStore
    ? (activeStore.type.split('.').pop() ?? activeStore.type)
    : ''
  const storeLabel = activeStore
    ? (activeStore.connection ? `${storeTypeShort} · ${activeStore.connection}` : storeTypeShort)
    : 'unknown'
```

- [ ] **Step 3: Remove the `urlStore` declaration**

In `web/src/pages/Workflows.tsx`, delete this line (line 48):

```tsx
  const urlStore = searchParams.get('store') ?? ''
```

- [ ] **Step 4: Remove `store` from the URL-mirroring effect**

In `web/src/pages/Workflows.tsx`, in the effect that mirrors filter state to the URL (lines 92-100), delete the line:

```tsx
    if (urlStore) params.store = urlStore
```

and remove `urlStore` from that effect's dependency array (line 100), so it reads:

```tsx
  }, [activeStatus, debouncedSearch, page, selectedApp, setSearchParams])
```

- [ ] **Step 5: Stop sending `store` to the workflows query**

In `web/src/pages/Workflows.tsx`, in the `useWorkflows({...})` call (lines 102-108), delete the line:

```tsx
    store: selectedStore || undefined,
```

- [ ] **Step 6: Stop sending `store` to the removal mutation**

In `web/src/pages/Workflows.tsx`, in `onConfirmRemove` (line 188), change:

```tsx
      { ids, force, store: selectedStore || undefined },
```

to:

```tsx
      { ids, force },
```

- [ ] **Step 7: Replace the dropdown with a label in the chip**

In `web/src/pages/Workflows.tsx`, replace the chip's conditional (lines 250-273, from `statestore{' '}` through the closing of the ternary `)}`) with a static label. The result should be:

```tsx
          <span className="chip">
            <span className="led" />
            statestore{' '}
            <b>{storeLabel}</b>
          </span>
```

- [ ] **Step 8: Verify no dangling references and it type-checks**

Run: `cd web && npx tsc -b --noEmit`
Expected: PASS. There must be no remaining references to `urlStore`, `selectedStore`, `activeStoreName`, or `storeTypeLabel` (tsc will error on unused/undefined if any remain). If tsc reports an unused import (none expected — `useStateStores` is still used), remove it.

- [ ] **Step 9: Commit (together with Task 7's test changes)**

Commit happens at the end of Task 7 so tests and implementation land together.

---

### Task 7: Update the Workflows page tests for the label (no dropdown)

**Files:**
- Modify: `web/src/pages/Workflows.test.tsx:12-22` (store fixture + `beforeEach`)
- Modify: `web/src/pages/Workflows.test.tsx:92-131` (replace the three store-selector tests)

**Interfaces:**
- Consumes: the new label behavior from Task 6.
- Produces: tests asserting the chip renders `state store type · connection` as a label and that no `<select>` is present.

- [ ] **Step 1: Update the store fixture to a single active store with a connection**

In `web/src/pages/Workflows.test.tsx`, replace the `twoStores` fixture and `beforeEach` (lines 12-22) with a single active store (the API now returns only the active store):

```tsx
const activeStoreOnly = [
  { name: 'redis', type: 'state.redis', path: '/components/redis.yaml', active: true, connection: 'localhost:6379' },
]

// Register statestores handler for all tests in this file
beforeEach(() => {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(activeStoreOnly)),
  )
})
```

- [ ] **Step 2: Replace the three selector-related tests with label tests**

In `web/src/pages/Workflows.test.tsx`, replace the three tests currently at lines 92-131 (`shows the active store type label in the statestore chip`, `renders a store select inside the chip when multiple stores exist`, `switching the store select updates ?store= in the URL`) with:

```tsx
  it('shows the active store type and connection as a label in the statestore chip', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toMatch(/statestore/)
      // "state.redis" → "redis", plus the secrets-free connection summary
      expect(chip?.textContent).toMatch(/redis · localhost:6379/)
    })
  })

  it('renders the statestore as a label, not a select', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip).not.toBeNull()
    })
    expect(document.querySelector('select[aria-label="Switch state store"]')).toBeNull()
  })

  it('keeps the colored status dot in the statestore chip', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip?.querySelector('.led')).not.toBeNull()
    })
  })
```

- [ ] **Step 3: Run the Workflows page tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS. (If any other test in the file referenced `twoStores` or `postgres`, update it to the new fixture — search the file for `twoStores`/`postgres` and fix.)

- [ ] **Step 4: Run the full frontend test suite**

Run: `cd web && npm test`
Expected: PASS. Watch for any other test that mocked `/api/statestores` with multiple stores or relied on the `?store=` selector.

- [ ] **Step 5: Commit (Task 6 + Task 7 together)**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): show active state store as a label instead of a selector"
```

---

### Task 8: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the complete Go unit suite**

Run: `make test-go`
Expected: PASS (all packages, `-tags unit -race`).

- [ ] **Step 2: Run the complete frontend suite + type-check + build**

Run: `cd web && npm test && npx tsc -b --noEmit && npm run build`
Expected: PASS for all three.

- [ ] **Step 3: Manual smoke check (optional but recommended)**

Run the app against a Dapr setup that has multiple `state.*` components where exactly one has `actorStateStore: "true"`. Open the Workflows page and confirm:
- The statestore chip shows a non-interactive label of the form `redis · localhost:6379` (type · connection), with the colored dot still present and no dropdown.
- The workflow rows correspond only to the active (actorStateStore) store.
- `GET /api/statestores` returns a single-element array with `"active": true` and a `"connection"` value that contains NO password/credentials.

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: verification fixes for active-statestore-only"
```

---

## Self-Review

**Spec coverage:**
- "Workflows table only shows data from the active state store" → Task 2 (`/statestores` returns active only) + Task 3 (backend registers/serves only active; non-active rejected). ✅
- "statestore dropdown should become a label" → Task 6 (dropdown removed, label rendered) + Task 7 (tests). ✅
- "the connection info" in the label → Task 1 (`ConnInfo`), Task 2 (`Connection` on `StoreInfo`), Task 5 (`connection` on `StateStore`), Task 6 (label renders `type · connection`). ✅
- "colored dot stays" → Task 6 keeps `<span className="led" />`; Task 7 asserts `.led` present. ✅
- Secrets never shown → Task 1 strips Postgres credentials (URL + keyword form), redis uses only `redisHost`, sqlite is a file path; Task 8 manual check. ✅

**Placeholder scan:** No TBD/TODO/"handle edge cases"/"similar to Task N". All code shown in full. Task 4 includes a NOTE to read the existing `apiRouter` call shape before editing (defensive, not a placeholder). ✅

**Type consistency:**
- Go `Connection` field (`StoreInfo`) ↔ JSON `connection` ↔ TS `StateStore.connection`. ✅
- `statestore.ConnInfo(*active)` called with a `statestore.Component` value (registry holds `[]statestore.Component`). ✅
- `storeRegistry.active()` returns `*statestore.Component` (existing, `cmd/workflow.go:46-51`), dereferenced for `ConnInfo`. ✅
- Frontend label var `storeLabel` defined in Task 6, used in the chip in Task 6 Step 7. ✅
- `useWorkflows`/`useRemoveWorkflows` still accept optional `store`; Tasks 6 just stop passing it — no signature change needed. ✅

**Note on WorkflowDetail (verified, no change required):** `WorkflowDetail.tsx` reads `?store=` from the URL (line 206), but the Workflows list row links (`Workflows.tsx:466`) never append `?store=`. After this change nothing sets `?store=`, so detail requests omit it → backend `ServiceFor("")` resolves to the active store. A stale bookmarked `?store=<non-active>` URL would now 404 — acceptable and out of scope.
