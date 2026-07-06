# Components Page Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recency-ordered "Recent workflow state store connections" panel with durable tombstone removal and an active-store delete guard; file paths shown in both lists; stable hash IDs so duplicate-name components are independently selectable.

**Architecture:** The Go registry (`cmd/registry.go`, persisted at `~/.dapr/dev-dashboard/connections.yaml`) gains `updatedAt` and `dismissed` fields; the reconciler sorts/filters `Stores()` output, refuses to delete the elected active store, and un-dismisses a store that becomes active. `pkg/resources` gains a stable 12-char sha256 ID per scanned resource (mirroring the registry's `entryID` pattern) with ID-first/name-fallback lookup. The React frontend renames the panel, shows paths, shows Delete on all non-active rows, and selects components by ID.

**Tech Stack:** Go (chi, testify, `-tags unit`), React + TypeScript (React Router, TanStack Query, Vitest + RTL + msw).

**Spec:** `docs/superpowers/specs/2026-07-06-components-page-updates-design.md`

## Global Constraints

- Panel title copy, exact: `Recent workflow state store connections`
- Auto-row delete dialog copy, exact: `It will stay hidden unless it becomes the active workflow state store again.`
- Resource ID: `sha256(name + "|" + type + "|" + path)` hex-encoded, truncated to 12 chars.
- Store list order: active first, then `updatedAt` descending (zero timestamps last), then name.
- Deleting the active store returns `409 Conflict`.
- Go tests build with `//go:build unit`; run with `go test -tags unit -race ./...`. Web tests: `cd web && npx vitest run <file>`.
- Run `gofmt -w` on every Go file you touch before committing.

---

### Task 1: Registry `updatedAt` timestamp

**Files:**
- Modify: `cmd/registry.go`
- Test: `cmd/registry_test.go`

**Interfaces:**
- Consumes: existing `ConnRegistry` mutators (`Add`, `Update`, `UpsertAuto`), `LoadRegistry`.
- Produces: `ConnEntry.UpdatedAt time.Time` (`json:"updatedAt,omitempty"`); test-injectable `ConnRegistry.now func() time.Time`. Task 3 sorts by `UpdatedAt`; Task 2's `Undismiss` bumps it.

- [ ] **Step 1: Write the failing test**

Append to `cmd/registry_test.go`:

```go
// tickClock returns a fake clock advancing one second per call.
func tickClock(start time.Time) func() time.Time {
	t := start
	return func() time.Time { t = t.Add(time.Second); return t }
}

func entryByName(t *testing.T, r *ConnRegistry, name string) ConnEntry {
	t.Helper()
	for _, e := range r.List() {
		if e.Name == name {
			return e
		}
	}
	t.Fatalf("entry %q not found", name)
	return ConnEntry{}
}

func TestRegistry_UpdatedAtStampedAndBumped(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	r.now = tickClock(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))

	// Add stamps a manual entry.
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql",
		Metadata: map[string]string{"connectionString": "host=h"}}))
	manualAt := entryByName(t, r, "pg").UpdatedAt
	require.False(t, manualAt.IsZero(), "Add must stamp updatedAt")

	// UpsertAuto stamps a new auto entry.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	autoAt := entryByName(t, r, "s").UpdatedAt
	require.False(t, autoAt.IsZero(), "UpsertAuto must stamp a new entry")

	// A no-op upsert (identical fields) must NOT bump the timestamp.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.True(t, entryByName(t, r, "s").UpdatedAt.Equal(autoAt), "no-op upsert must not bump updatedAt")

	// A changed upsert must bump it.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.sqlite", Path: "/a/statestore.yaml"}))
	require.True(t, entryByName(t, r, "s").UpdatedAt.After(autoAt), "changed upsert must bump updatedAt")

	// Update bumps the manual entry.
	_, err := r.Update(ConnEntry{ID: entryByName(t, r, "pg").ID, Name: "pg", Type: "state.postgresql",
		Metadata: map[string]string{"connectionString": "host=h2"}})
	require.NoError(t, err)
	require.True(t, entryByName(t, r, "pg").UpdatedAt.After(manualAt), "Update must bump updatedAt")

	// updatedAt survives a reload from disk.
	r2 := LoadRegistry(home)
	require.False(t, entryByName(t, r2, "s").UpdatedAt.IsZero(), "updatedAt must persist")
}
```

Add `"time"` to the test file's imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run TestRegistry_UpdatedAtStampedAndBumped ./cmd/`
Expected: FAIL — compile error: `e.UpdatedAt undefined` / `r.now undefined`.

- [ ] **Step 3: Write minimal implementation**

In `cmd/registry.go`:

Add `"time"` to imports. Add the field to `ConnEntry` (after `Metadata`):

```go
	UpdatedAt time.Time         `json:"updatedAt,omitempty"`
```

Add the clock to `ConnRegistry` (after `entries`):

```go
	now     func() time.Time // test seam; nil means time.Now
```

Add below `List`:

```go
// timeNow returns the registry clock (a test seam), defaulting to wall time.
func (r *ConnRegistry) timeNow() time.Time {
	if r.now == nil {
		return time.Now().UTC()
	}
	return r.now()
}
```

In `UpsertAuto`, stamp the changed-entry branch right before `return r.save()` (after `cur.Metadata = e.Metadata`):

```go
			cur.UpdatedAt = r.timeNow()
```

and stamp the new-entry branch right before `r.entries = append(r.entries, e)`:

```go
	e.UpdatedAt = r.timeNow()
```

In `Add`, after `e.ID = entryID(SourceManual, e.Name)`:

```go
	e.UpdatedAt = r.timeNow()
```

In `Update`, right after `e.ID = entryID(SourceManual, e.Name)` (inside the matched-entry branch):

```go
			e.UpdatedAt = r.timeNow()
```

Note the `UpsertAuto` no-op comparison (`cur.ID == e.ID && cur.Name == e.Name && ...`) must NOT compare `UpdatedAt` — leave it as is.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/`
Expected: PASS (all existing registry/reconciler tests plus the new one).

- [ ] **Step 5: Commit**

```bash
gofmt -w cmd/registry.go cmd/registry_test.go
git add cmd/registry.go cmd/registry_test.go
git commit -m "feat(registry): stamp connection entries with updatedAt"
```

---

### Task 2: Registry dismissal tombstone

**Files:**
- Modify: `cmd/registry.go`
- Test: `cmd/registry_test.go`

**Interfaces:**
- Consumes: `ConnEntry`, `normPath`, `timeNow` (Task 1), `entryByName`/`tickClock` test helpers (Task 1).
- Produces: `ConnEntry.Dismissed bool` (`json:"dismissed,omitempty"`); changed `Delete(id string) error` semantics (manual: remove; auto: tombstone); new `Undismiss(path string) error`. Task 3 filters on `Dismissed`; Task 5 calls `Undismiss`.

- [ ] **Step 1: Write the failing test**

Append to `cmd/registry_test.go`:

```go
func TestRegistry_DeleteDismissesAutoRemovesManual(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.NoError(t, r.Add(ConnEntry{Name: "pg", Type: "state.postgresql"}))
	autoID := entryByName(t, r, "s").ID
	manualID := entryByName(t, r, "pg").ID

	// Manual: removed outright.
	require.NoError(t, r.Delete(manualID))
	require.Len(t, r.List(), 1)

	// Auto: kept, marked dismissed — durable across reload.
	require.NoError(t, r.Delete(autoID))
	require.Len(t, r.List(), 1, "auto entry is tombstoned, not removed")
	require.True(t, r.List()[0].Dismissed)
	require.True(t, LoadRegistry(home).List()[0].Dismissed, "tombstone must persist")

	// UpsertAuto keeps a dismissed entry current but preserves the tombstone.
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s2", Type: "state.sqlite", Path: "/a/statestore.yaml"}))
	got := r.List()[0]
	require.Equal(t, "s2", got.Name)
	require.True(t, got.Dismissed, "upsert must not resurrect a dismissed entry")
}

func TestRegistry_UndismissByPath(t *testing.T) {
	home := t.TempDir()
	r := LoadRegistry(home)
	r.now = tickClock(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))
	require.NoError(t, r.UpsertAuto(ConnEntry{Name: "s", Type: "state.redis", Path: "/a/statestore.yaml"}))
	require.NoError(t, r.Delete(r.List()[0].ID))
	dismissedAt := r.List()[0].UpdatedAt
	require.True(t, r.List()[0].Dismissed)

	// Non-matching path: no-op.
	require.NoError(t, r.Undismiss("/other/path.yaml"))
	require.True(t, r.List()[0].Dismissed)

	// Matching path clears the tombstone, bumps updatedAt, and persists.
	require.NoError(t, r.Undismiss("/a/statestore.yaml"))
	require.False(t, r.List()[0].Dismissed)
	require.True(t, r.List()[0].UpdatedAt.After(dismissedAt), "undismiss counts as recent activity")
	require.False(t, LoadRegistry(home).List()[0].Dismissed)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run 'TestRegistry_DeleteDismisses|TestRegistry_Undismiss' ./cmd/`
Expected: FAIL — compile error: `e.Dismissed undefined` / `r.Undismiss undefined`.

- [ ] **Step 3: Write minimal implementation**

In `cmd/registry.go`:

Add to `ConnEntry` (after `UpdatedAt`):

```go
	Dismissed bool              `json:"dismissed,omitempty"`
```

Replace the whole `Delete` method (including its doc comment):

```go
// Delete removes a manual entry by ID. An auto entry is kept but marked
// dismissed — a durable tombstone: UpsertAuto preserves the flag so discovery
// never resurrects it; only Undismiss (the store being elected active again)
// brings it back. An absent id is a no-op.
func (r *ConnRegistry) Delete(id string) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := r.entries[:0]
	changed := false
	for _, e := range r.entries {
		if e.ID == id {
			changed = true
			if e.Source == SourceManual {
				continue // manual: remove outright
			}
			e.Dismissed = true // auto: durable tombstone
		}
		out = append(out, e)
	}
	r.entries = out
	if !changed {
		return nil
	}
	return r.save()
}
```

Add below `Delete`:

```go
// Undismiss clears the tombstone on the auto entry matching path (used when
// that store is elected active again: running apps are using it, so it must
// reappear). Clearing counts as activity, so updatedAt is bumped. A path with
// no dismissed entry is a no-op.
func (r *ConnRegistry) Undismiss(path string) error {
	key := normPath(path)
	r.mu.Lock()
	defer r.mu.Unlock()
	for i := range r.entries {
		e := &r.entries[i]
		if e.Source != SourceManual && e.Dismissed && normPath(e.Path) == key {
			e.Dismissed = false
			e.UpdatedAt = r.timeNow()
			return r.save()
		}
	}
	return nil
}
```

`UpsertAuto` needs no change: its changed-entry branch assigns `cur.ID/Name/Type/Path/Metadata/UpdatedAt` individually and never touches `cur.Dismissed` — the test proves it.

- [ ] **Step 4: Update the existing test that asserts the old delete behavior**

`TestRegistry_SaveLeavesNoTempLitter` (in `cmd/registry_test.go`, around line 261) deletes an auto entry and then asserts `List()` contains only the manual `pg` entry. Under the tombstone the auto entry is kept. Update its final assertions to:

```go
	// And the atomically-written content still round-trips through LoadRegistry.
	// The deleted auto entry survives as a dismissed tombstone alongside pg.
	got := LoadRegistry(home).List()
	require.Len(t, got, 2)
	byName := map[string]ConnEntry{}
	for _, e := range got {
		byName[e.Name] = e
	}
	require.Equal(t, "host=a", byName["pg"].Metadata["connectionString"])
	require.False(t, byName["pg"].Dismissed)
	require.True(t, byName["s"].Dismissed, "the deleted auto entry is tombstoned, not removed")
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
gofmt -w cmd/registry.go cmd/registry_test.go
git add cmd/registry.go cmd/registry_test.go
git commit -m "feat(registry): durable dismissal tombstone for auto connections"
```

---

### Task 3: `Stores()` — exclude dismissed, expose `updatedAt`, sort by recency

**Files:**
- Modify: `pkg/server/workflows.go` (StoreInfo), `cmd/reconciler.go` (Stores)
- Test: `cmd/reconciler_test.go`

**Interfaces:**
- Consumes: `ConnEntry.UpdatedAt`/`Dismissed` (Tasks 1–2), existing `Stores()`, `tickClock` helper (Task 1).
- Produces: `StoreInfo.UpdatedAt time.Time` (`json:"updatedAt"`); `Stores()` returns only non-dismissed entries ordered active-first → `updatedAt` desc → name. The web panel (Task 8) renders API order as-is.

- [ ] **Step 1: Write the failing test**

Append to `cmd/reconciler_test.go`:

```go
func TestReconciler_StoresOrderingAndDismissedFilter(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	reg.now = tickClock(time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC))

	// Insertion order: autostore (oldest), then manual m1, m2 (newest).
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))
	require.NoError(t, reg.Add(ConnEntry{Name: "m1", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=h1 dbname=d1"}}))
	require.NoError(t, reg.Add(ConnEntry{Name: "m2", Type: "state.postgresql", Source: SourceManual,
		Metadata: map[string]string{"connectionString": "host=h2 dbname=d2"}}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(context.Background(), nil, "default", home, "", &http.Client{}, reg, pool, nil)
	t.Cleanup(func() { _ = rc.Close() })

	// No active store: pure recency order, newest first.
	names := func() []string {
		var out []string
		for _, i := range rc.Stores() {
			out = append(out, i.Name)
		}
		return out
	}
	require.Equal(t, []string{"m2", "m1", "autostore"}, names(), "newest updatedAt first")
	for _, i := range rc.Stores() {
		require.False(t, i.UpdatedAt.IsZero(), "Stores must expose updatedAt")
	}

	// Elect autostore active: it is pinned first despite being oldest.
	active := statestore.Component{Name: "autostore", Type: "state.sqlite", Path: autoPath,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "auto.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()
	require.Equal(t, []string{"autostore", "m2", "m1"}, names(), "active store is pinned first")

	// A dismissed entry disappears from Stores() (but stays in the registry).
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry(nil, nil, nil)
	rc.mu.Unlock()
	autoID := rc.Stores()[2].ID
	require.NoError(t, reg.Delete(autoID))
	require.Equal(t, []string{"m2", "m1"}, names(), "dismissed entries are hidden")
	require.Len(t, reg.List(), 3, "the tombstoned entry is still persisted")
}

func TestSortStores_ZeroTimestampsLast(t *testing.T) {
	// Entries from registry files written before updatedAt existed load with a
	// zero timestamp and must sort after stamped entries.
	out := []server.StoreInfo{
		{Name: "legacy"},
		{Name: "recent", UpdatedAt: time.Date(2026, 7, 6, 12, 0, 0, 0, time.UTC)},
	}
	sortStores(out)
	require.Equal(t, "recent", out[0].Name)
	require.Equal(t, "legacy", out[1].Name)
}
```

Add `"time"` to the test file's imports if not already present.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run TestReconciler_StoresOrderingAndDismissedFilter ./cmd/`
Expected: FAIL — compile error `i.UpdatedAt undefined`, or wrong-order assertion once it compiles.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/workflows.go`, add `"time"` to imports and add to `StoreInfo` (after `Connection`):

```go
	UpdatedAt  time.Time `json:"updatedAt"` // last added/updated; drives panel recency order
```

In `cmd/reconciler.go`, add `"sort"` to imports. In `Stores()`:

1. In the auto-paths pre-pass loop, skip tombstoned entries — change the condition to:

```go
		if e.Source != SourceManual && !e.Dismissed && !seen[e.Path] {
```

2. At the top of the output loop over `entries`, skip them too:

```go
	for _, e := range entries {
		if e.Dismissed {
			continue
		}
```

3. Include the timestamp in the constructed `StoreInfo` (after `Connection:`):

```go
			UpdatedAt:  e.UpdatedAt,
```

4. Replace `return out` with:

```go
	sortStores(out)
	return out
```

5. Add below `Stores()`:

```go
// sortStores orders panel entries: the active store first, then most recently
// added/updated, then name as a deterministic tie-break. Zero timestamps
// (entries written before updatedAt existed) sort last.
func sortStores(out []server.StoreInfo) {
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Active != out[j].Active {
			return out[i].Active
		}
		if !out[i].UpdatedAt.Equal(out[j].UpdatedAt) {
			return out[i].UpdatedAt.After(out[j].UpdatedAt)
		}
		return out[i].Name < out[j].Name
	})
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/ ./pkg/server/`
Expected: PASS (existing `TestReconciler_StoresListsAllEntriesAndMutators` indexes by name, so the new ordering does not break it).

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/server/workflows.go cmd/reconciler.go cmd/reconciler_test.go
git add pkg/server/workflows.go cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(stores): hide dismissed entries and sort by active-then-recency"
```

---

### Task 4: Active-store delete guard (409)

**Files:**
- Modify: `pkg/server/api.go` (sentinel + status mapping), `cmd/reconciler.go` (DeleteStore)
- Test: `cmd/reconciler_test.go`, `pkg/server/statestores_test.go`

**Interfaces:**
- Consumes: `identity()`, `ptr()`, `rc.translate`, `rc.activeComponent`, `rc.componentFor` (all existing in `cmd/reconciler.go`); `storeErrStatus` in `pkg/server/api.go`.
- Produces: `server.ErrActiveStore = errors.New("cannot remove the active workflow state store")`, mapped to `409` by `storeErrStatus`; `DeleteStore` returns it for the active entry. The web panel (Task 8) hides Delete on the active row, so this is the race backstop.

- [ ] **Step 1: Write the failing tests**

Append to `cmd/reconciler_test.go`:

```go
func TestReconciler_DeleteStoreRefusesActive(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(context.Background(), nil, "default", home, "", &http.Client{}, reg, pool, nil)
	t.Cleanup(func() { _ = rc.Close() })

	active := statestore.Component{Name: "autostore", Type: "state.sqlite", Path: autoPath,
		Metadata: map[string]string{"connectionString": filepath.Join(dir, "auto.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	id := rc.Stores()[0].ID
	err := rc.DeleteStore(id)
	require.ErrorIs(t, err, server.ErrActiveStore, "deleting the active store must be refused")
	require.False(t, reg.List()[0].Dismissed, "the entry must be untouched")

	// Once no longer active, the same delete succeeds (tombstones the entry).
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry(nil, nil, nil)
	rc.mu.Unlock()
	require.NoError(t, rc.DeleteStore(id))
	require.True(t, reg.List()[0].Dismissed)
}
```

Append to `pkg/server/statestores_test.go`:

```go
func TestDeleteStatestoreActiveConflict(t *testing.T) {
	m := &mutableStoreRegistry{deleteErr: ErrActiveStore}
	h := newAPI(m)

	req := httptest.NewRequest(http.MethodDelete, "/statestores/abc123", nil)
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusConflict, res.StatusCode)
	require.Contains(t, body, "active workflow state store")
	require.Empty(t, m.deleted)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -run 'TestReconciler_DeleteStoreRefusesActive|TestDeleteStatestoreActiveConflict' ./cmd/ ./pkg/server/`
Expected: FAIL — compile error: `server.ErrActiveStore` / `ErrActiveStore` undefined.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/api.go`, extend the existing `var (...)` block holding `ErrUnsupportedStoreType`:

```go
	// ErrActiveStore rejects deleting the elected active store (mapped to 409).
	ErrActiveStore = errors.New("cannot remove the active workflow state store")
```

In `storeErrStatus`, add a case before `errors.Is(err, os.ErrExist)`:

```go
	case errors.Is(err, ErrActiveStore):
		return http.StatusConflict
```

In `cmd/reconciler.go`, replace `DeleteStore` (keep its doc comment style):

```go
// DeleteStore satisfies server.StoreRegistry: removes (manual) or tombstones
// (auto) the entry with the given id and evicts its pooled connection if open.
// The elected active store is refused with server.ErrActiveStore — running
// apps are using it — which the API maps to 409.
func (rc *reconciler) DeleteStore(id string) error {
	if rc.registry == nil {
		return nil
	}
	comp, ok := rc.componentFor(id)
	if ok {
		if active := rc.activeComponent(); active != nil && identity(&comp) == identity(ptr(rc.translate(*active))) {
			return server.ErrActiveStore
		}
	}
	if err := rc.registry.Delete(id); err != nil {
		return err
	}
	if ok && rc.pool != nil {
		rc.pool.evict(comp)
	}
	return nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/ ./pkg/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/server/api.go cmd/reconciler.go cmd/reconciler_test.go pkg/server/statestores_test.go
git add pkg/server/api.go cmd/reconciler.go cmd/reconciler_test.go pkg/server/statestores_test.go
git commit -m "feat(api): refuse deleting the active workflow state store with 409"
```

---

### Task 5: Reconcile un-dismisses the elected active store

**Files:**
- Modify: `cmd/reconciler.go`
- Test: `cmd/reconciler_test.go`

**Interfaces:**
- Consumes: `ConnRegistry.Undismiss` (Task 2), `newReg.active()` inside `reconcile()`.
- Produces: `(*reconciler).undismissActive(active *statestore.Component)`, called from `reconcile()` — the only path by which a tombstoned store reappears.

- [ ] **Step 1: Write the failing test**

Append to `cmd/reconciler_test.go`:

```go
func TestReconciler_UndismissActiveStore(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "autostore", filepath.Join(dir, "auto.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "autostore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	o := &fakeOpener{}
	pool := newConnPool("default", &http.Client{}, nil, o.open)
	rc := newReconciler(context.Background(), nil, "default", home, "", &http.Client{}, reg, pool, nil)
	t.Cleanup(func() { _ = rc.Close() })

	// Tombstone it, then simulate reconcile electing it active.
	require.NoError(t, rc.DeleteStore(reg.List()[0].ID))
	require.Empty(t, rc.Stores(), "dismissed store is hidden")

	rc.undismissActive(&statestore.Component{Name: "autostore", Type: "state.sqlite", Path: autoPath})
	infos := rc.Stores()
	require.Len(t, infos, 1, "the active store must reappear")
	require.Equal(t, "autostore", infos[0].Name)

	// nil / pathless components are safe no-ops.
	rc.undismissActive(nil)
	rc.undismissActive(&statestore.Component{Name: "manual-ish"})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run TestReconciler_UndismissActiveStore ./cmd/`
Expected: FAIL — compile error: `rc.undismissActive undefined`.

- [ ] **Step 3: Write minimal implementation**

In `cmd/reconciler.go`, add below `reconcile()`:

```go
// undismissActive clears the dismissal tombstone for the elected active store
// so it reappears in the panel: the user's running apps are actively using it.
// nil active, pathless components, and a nil registry are no-ops.
func (rc *reconciler) undismissActive(active *statestore.Component) {
	if rc.registry == nil || active == nil || active.Path == "" {
		return
	}
	if err := rc.registry.Undismiss(active.Path); err != nil {
		slog.Default().With("component", "reconciler").Warn("un-dismiss active store failed", "store", active.Name, "err", err)
	}
}
```

In `reconcile()`, call it right after `newReg := newStoreRegistry(detected, loaded, appPaths)`:

```go
	rc.undismissActive(newReg.active())
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w cmd/reconciler.go cmd/reconciler_test.go
git add cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(reconciler): un-dismiss a tombstoned store when it becomes active"
```

---

### Task 6: Stable resource IDs with ID-first lookup

**Files:**
- Modify: `pkg/resources/resources.go`, `pkg/server/resources.go`
- Test: `pkg/resources/resources_test.go`

**Interfaces:**
- Consumes: existing `Resource`, `scan`, `Get`, `Service`.
- Produces: `Resource.ID string` (`json:"id"`); unexported `resourceID(name, typ, path string) string`; `Service.Get(ctx, kind, idOrName)` resolves ID first, then first name match; list sorted by name then path. The frontend (Task 7) navigates with `id` and relies on the name fallback for old links.

- [ ] **Step 1: Write the failing test**

Append to `pkg/resources/resources_test.go`:

```go
func TestResourcesStableIDsAndDuplicateNames(t *testing.T) {
	dirA := t.TempDir()
	dirB := t.TempDir()
	// Two components sharing metadata.name "statestore" in different files.
	require.NoError(t, os.WriteFile(filepath.Join(dirA, "statestore.yaml"), []byte(compYAML), 0o600))
	dupYAML := "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.sqlite\n  version: v1\n"
	require.NoError(t, os.WriteFile(filepath.Join(dirB, "statestore.yaml"), []byte(dupYAML), 0o600))
	svc := New(func() []string { return []string{dirA, dirB} })

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 2, "duplicate names must both be listed")
	require.NotEmpty(t, comps[0].ID)
	require.NotEmpty(t, comps[1].ID)
	require.NotEqual(t, comps[0].ID, comps[1].ID, "distinct files get distinct ids")
	require.Len(t, comps[0].ID, 12, "id mirrors the registry's 12-char entryID shape")
	require.Less(t, comps[0].Path, comps[1].Path, "equal names sort by path")

	// IDs are stable across scans.
	again, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Equal(t, comps[0].ID, again[0].ID)

	// Get by ID returns the exact file, even for the name-collision loser.
	got, err := svc.Get(context.Background(), KindComponent, comps[1].ID)
	require.NoError(t, err)
	require.Equal(t, comps[1].Path, got.Path)
	require.Contains(t, got.Raw, "state.sqlite")

	// Get by name still works (first match) for old deep links.
	byName, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Equal(t, comps[0].Path, byName.Path)

	// Unknown id-or-name -> ErrNotFound.
	_, err = svc.Get(context.Background(), KindComponent, "nosuchthing")
	require.ErrorIs(t, err, ErrNotFound)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run TestResourcesStableIDsAndDuplicateNames ./pkg/resources/`
Expected: FAIL — compile error: `comps[0].ID undefined`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/resources/resources.go`:

Add `"crypto/sha256"` and `"encoding/hex"` to imports.

Add `ID` as the first field of `Resource`:

```go
type Resource struct {
	ID       string   `json:"id"`
	Name     string   `json:"name"`
	...
```

Add below the `Resource` type:

```go
// resourceID derives a stable, URL-safe id for a resource — the entryID
// pattern from cmd/registry.go applied to the name|type|path identity key.
// Distinct files always differ in path, so ids never collide across files.
func resourceID(name, typ, path string) string {
	h := sha256.Sum256([]byte(name + "|" + typ + "|" + path))
	return hex.EncodeToString(h[:])[:12]
}
```

Update the `Service` interface doc line for `Get`:

```go
type Service interface {
	List(ctx context.Context, kind Kind) ([]Resource, error)
	// Get resolves idOrName as a resource ID first, then as a metadata name
	// (first match) so pre-ID deep links keep working.
	Get(ctx context.Context, kind Kind, idOrName string) (Resource, error)
}
```

In `scan`, set the ID in the appended `Resource`:

```go
				out = append(out, Resource{
					ID:      resourceID(rr.Metadata.Name, rr.Spec.Type, absPath),
					Name:    rr.Metadata.Name,
					...
```

Replace the sort at the end of `scan` (path tie-break keeps duplicate names in stable order):

```go
	sort.Slice(out, func(i, j int) bool {
		if out[i].Name != out[j].Name {
			return out[i].Name < out[j].Name
		}
		return out[i].Path < out[j].Path
	})
```

Replace `Get`:

```go
// Get returns the resource matching idOrName (ID first, then first name
// match), with Raw populated from the file. Returns ErrNotFound if none match.
func (s *service) Get(ctx context.Context, kind Kind, idOrName string) (Resource, error) {
	resources, err := s.scan(kind)
	if err != nil {
		return Resource{}, err
	}
	withRaw := func(r Resource) (Resource, error) {
		data, err := os.ReadFile(r.Path)
		if err != nil {
			return Resource{}, err
		}
		r.Raw = string(data)
		return r, nil
	}
	for _, r := range resources {
		if r.ID == idOrName {
			return withRaw(r)
		}
	}
	for _, r := range resources {
		if r.Name == idOrName {
			return withRaw(r)
		}
	}
	return Resource{}, ErrNotFound
}
```

In `pkg/server/resources.go`, rename the detail handler's local for clarity (behavior unchanged — the route param still accepts either form):

```go
		idOrName := chi.URLParam(req, "name")
		got, err := res.Get(req.Context(), kind, idOrName)
```

Note: `pkg/server` has a `fakeResources` test double implementing `resources.Service`; a parameter rename does not break it, but if the compiler complains about signatures, update the double's `Get` parameter name to `idOrName` too.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/resources/resources.go pkg/server/resources.go
git add pkg/resources/resources.go pkg/resources/resources_test.go pkg/server/resources.go
git commit -m "feat(resources): stable hash ids with id-first, name-fallback lookup"
```

---

### Task 7: Web — ID-based component selection + path in the components list

**Files:**
- Modify: `web/src/types/resources.ts`, `web/src/pages/ResourceList.tsx`, `web/src/pages/ResourceDetail.tsx`
- Test: `web/src/pages/ResourceList.test.tsx`, `web/src/pages/ResourceDetail.test.tsx`

**Interfaces:**
- Consumes: `Resource.ID` from the API (Task 6); existing routes `/components/:name` in `web/src/router.tsx` (unchanged — the param now carries an ID).
- Produces: `ResourceSummary.id: string`; `ResourceDetail` prop renamed `name` → `idOrName`. Rows keyed/selected by `id` with name fallback.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/ResourceList.test.tsx`, add `id` to the existing fixtures (`COMPONENT_SUMMARY` gets `id: 'abc123def456'`, `CONFIG_SUMMARY` gets `id: 'cfg111cfg111'`), then add:

```tsx
const DUPLICATE_A = {
  id: 'aaa111aaa111',
  name: 'statestore',
  kind: 'component',
  type: 'state.redis',
  version: 'v1',
  path: '/projA/statestore.yaml',
}

const DUPLICATE_B = {
  id: 'bbb222bbb222',
  name: 'statestore',
  kind: 'component',
  type: 'state.sqlite',
  version: 'v1',
  path: '/projB/statestore.yaml',
}

describe('ResourceList unique selection', () => {
  it('renders both duplicate-name components with their file paths and selects by id', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([DUPLICATE_A, DUPLICATE_B])),
      http.get('/api/resources/component/:idOrName', ({ params }) =>
        HttpResponse.json(
          params.idOrName === 'bbb222bbb222'
            ? { ...DUPLICATE_B, raw: 'spec:\n  type: state.sqlite\n' }
            : { ...DUPLICATE_A, raw: 'spec:\n  type: state.redis\n' },
        ),
      ),
    )
    renderComponents()

    // Both rows render, each showing its file path.
    await waitFor(() => expect(screen.getAllByText('statestore')).toHaveLength(2))
    expect(screen.getByText('/projA/statestore.yaml')).toBeInTheDocument()
    expect(screen.getByText('/projB/statestore.yaml')).toBeInTheDocument()

    // Clicking the second duplicate selects it (not the first).
    fireEvent.click(screen.getByText('/projB/statestore.yaml'))
    await waitFor(() => expect(screen.getByText(/state\.sqlite/)).toBeInTheDocument())
    expect(screen.getByText('/projB/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('/projA/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'false')
  })

  it('still selects by name for old deep links', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([DUPLICATE_A, DUPLICATE_B])),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json({ ...DUPLICATE_A, raw: 'spec:\n  type: state.redis\n' }),
      ),
    )
    renderComponents('/components/statestore')

    await waitFor(() => expect(screen.getAllByText('statestore')).toHaveLength(2))
    expect(screen.getByText('/projA/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('/projB/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'false')
  })
})
```

(Reuse the file's existing imports and `renderComponents` helper; note `renderComponents` accepts an initial entry path.)

Also update the file's existing tests for ID-based fetching:

- Add `id` to the fixtures: `COMPONENT_SUMMARY` gets `id: 'abc123def456'`, `CONFIG_SUMMARY` gets `id: 'cfg111cfg111'` (and any other summary fixtures in the file get an `id`).
- The detail pane now fetches by the selected resource's **id**, so msw handlers registered at literal name URLs (`http.get('/api/resources/component/statestore', ...)` — five occurrences around lines 106–214, plus `/api/resources/component/pubsub`) no longer match. Change each to the param form and keep returning the same detail fixture, e.g.:

```tsx
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json(COMPONENT_DETAIL),
      ),
```

(For tests that register handlers for two different components, branch on `params.idOrName` as shown in the duplicate-selection test above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/ResourceList.test.tsx`
Expected: FAIL — both rows render but path text is missing and duplicate selection collapses onto the first row.

- [ ] **Step 3: Write the implementation**

In `web/src/types/resources.ts`, add to `ResourceSummary`:

```ts
export interface ResourceSummary {
  id: string
  name: string
  ...
```

In `web/src/pages/ResourceDetail.tsx`, rename the prop (`name` → `idOrName`) in `ResourceDetailProps`, the function signature, and the `useResource(kind, idOrName)` call. Update the doc comment: "Fetches and renders the detail for a single resource (kind + id-or-name)." Update `web/src/pages/ResourceDetail.test.tsx` accordingly: it renders `<ResourceDetail kind={kind} name={name} />` (around line 38) — change the prop to `idOrName={name}`.

In `web/src/pages/ResourceList.tsx`:

Replace the param/selection block:

```tsx
  const { name: selectedParam } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const { title, sub } = LABELS[kind]
  const kindPath = kind === 'component' ? 'components' : 'configurations'

  // Resolve the selection: id match first, then name (pre-id deep links),
  // then default to the first item.
  const selected =
    resources?.find((r) => r.id === selectedParam) ??
    resources?.find((r) => r.name === selectedParam) ??
    (resources && resources.length > 0 ? resources[0] : undefined)
```

Replace `handleSelect`:

```tsx
  const handleSelect = (id: string) => {
    navigate(`/${kindPath}/${id}`)
  }
```

Replace the row rendering (`.ci` is a flex column, so the path is a third line):

```tsx
          {resources.map((resource) => {
            const isSelected = resource.id === selected?.id
            const ct =
              kind === 'component'
                ? [resource.type, resource.version].filter(Boolean).join(' · ')
                : resource.type ?? ''
            return (
              <div
                key={resource.id}
                className={`ci${isSelected ? ' sel' : ''}`}
                onClick={() => handleSelect(resource.id)}
                role="button"
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleSelect(resource.id)
                }}
              >
                <span className="cn">{resource.name}</span>
                {ct && <span className="ct">{ct}</span>}
                <span
                  className="ct"
                  title={resource.path}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {resource.path}
                </span>
              </div>
            )
          })}
```

Replace the detail pane:

```tsx
        {selected ? (
          <ResourceDetail kind={kind} idOrName={selected.id} />
        ) : (
```

Remove the now-unused `effectiveName` computation.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/ResourceList.test.tsx src/pages/ResourceDetail.test.tsx`
Expected: PASS, including the pre-existing tests (fixtures now carry `id`, msw detail handlers use `:idOrName`; tests that navigate by name keep passing via the name fallback).

- [ ] **Step 5: Typecheck and full web suite**

Run: `cd web && npx tsc --noEmit && npx vitest run`
Expected: PASS. If other test fixtures construct `ResourceSummary` objects without `id`, add an `id` to them.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/resources.ts web/src/pages/ResourceList.tsx web/src/pages/ResourceDetail.tsx web/src/pages/ResourceList.test.tsx
git commit -m "feat(web): select components by stable id and show file paths"
```

---

### Task 8: Web — connections panel rename, paths, delete on non-active rows

**Files:**
- Modify: `web/src/components/StateStoreConnectionsPanel.tsx`, `web/src/types/workflow.ts`
- Test: `web/src/components/StateStoreConnectionsPanel.test.tsx`

**Interfaces:**
- Consumes: sorted `/api/statestores` payload with `updatedAt` (Task 3); 409 on deleting the active store (Task 4) — the button is hidden for it, the error path already renders API errors in the modal.
- Produces: final panel UI. No new exports.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/components/StateStoreConnectionsPanel.test.tsx` (inside the existing `describe`):

```tsx
  it('renames the panel, shows paths, and offers delete on non-active rows only', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json(stores)))
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByText('statestore')).toBeInTheDocument())
    expect(screen.getByText('Recent workflow state store connections')).toBeInTheDocument()
    // Path shown for the auto (file-backed) row; the manual row has none.
    expect(screen.getByText('/x/a.yaml')).toBeInTheDocument()
    // The active row has no delete button; the non-active row does.
    expect(screen.queryByRole('button', { name: /delete statestore/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument()
  })

  it('explains durable dismissal when removing an auto-discovered connection', async () => {
    const autoInactive = [
      { id: 'a2', name: 'projstore', type: 'state.sqlite', source: 'auto', path: '/y/b.yaml', active: false, connection: 'b.db' },
    ]
    server.use(http.get('/api/statestores', () => HttpResponse.json(autoInactive)))
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByRole('button', { name: /delete projstore/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete projstore/i }))
    expect(
      screen.getByText(/stay hidden unless it becomes the active workflow state store again/i),
    ).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: FAIL — old title, no path text, no delete button on the non-active auto row.

- [ ] **Step 3: Write the implementation**

In `web/src/types/workflow.ts`, add to `StateStore`:

```ts
  updatedAt?: string
```

In `web/src/components/StateStoreConnectionsPanel.tsx`:

Rename the title:

```tsx
        <b style={{ fontSize: 13 }}>Recent workflow state store connections</b>
```

Replace the row rendering (path line added; delete offered on every non-active row — the API is the source of truth for order and refuses deleting the active store as a race backstop):

```tsx
      {(stores ?? []).map((s) => (
        <div key={s.id} style={{ padding: '6px 0', borderTop: '1px solid var(--line-soft)' }}>
          <div className="field-row" style={{ justifyContent: 'space-between' }}>
            <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
              <b style={{ fontSize: 12.5 }}>{s.name}</b>
              <span className="chip">{storeTypeLabel(s.type)}</span>
              {s.connection && <span className="chip">{s.connection}</span>}
              <span className="pill">{s.source}</span>
              {s.active && <span className="pill" style={{ color: 'var(--done-fg)' }}>ACTIVE</span>}
            </span>
            {!s.active && (
              <span style={{ display: 'flex', gap: 6 }}>
                <button className="btn danger" aria-label={`delete ${s.name}`} onClick={() => openDeleteConfirm(s)}>Delete</button>
              </span>
            )}
          </div>
          {s.path && (
            <div
              className="mono"
              title={s.path}
              style={{ fontSize: 11, color: 'var(--muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {s.path}
            </div>
          )}
        </div>
      ))}
```

Replace the confirm-modal paragraph (auto rows get the durable-dismissal copy):

```tsx
        <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 14 }}>
          Remove the connection <b>{pendingDelete?.name}</b>?{' '}
          {pendingDelete?.source === 'auto'
            ? 'It will stay hidden unless it becomes the active workflow state store again.'
            : 'This only removes it from the dashboard registry.'}
        </p>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: PASS. The pre-existing test "shows auto rows read-only and manual rows with actions" still passes because its auto fixture is the *active* row (no delete button); update its comment from "auto row has neither" to "the active row has neither" for accuracy.

- [ ] **Step 5: Full verification**

Run: `cd web && npx tsc --noEmit && npx vitest run && cd .. && make test-go`
Expected: PASS across both suites.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/StateStoreConnectionsPanel.tsx web/src/components/StateStoreConnectionsPanel.test.tsx web/src/types/workflow.ts
git commit -m "feat(web): recent connections panel with paths and durable removal"
```
