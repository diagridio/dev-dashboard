# Workflows: list all app-ids in the connected store — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow page list instances for every app-id present in the connected state store (not only running apps), mark non-running app-ids, and default the dropdown to the active app-id when it has data.

**Architecture:** `workflow.List`/`Stats` enumerate app-ids directly from the store via a wildcard `LIKE` scan over instance-metadata keys, parsing the app-id from each key — replacing the old "iterate running app-ids" loop and removing the injected `appIDs` discovery dependency. The frontend adds a "not running" badge (cross-referencing `useApps`) and a one-time default dropdown selection computed from the active store + running apps' loaded components.

**Tech Stack:** Go (chi, components-contrib state stores, testify), React + TypeScript (TanStack Query, vitest, MSW).

## Global Constraints

- **Build tags (Go):** new/changed Go test files start with `//go:build unit` (unit) or `//go:build integration`. Run unit tests with `go test -tags unit ./...`; integration with `go test -tags integration ./cmd/...`. A bare `go test ./...` finds no tests in `cmd`/`pkg/workflow`/`pkg/statestore`.
- **Web tests:** run from `web/`: `npx vitest run <path>`; typecheck with `npx tsc -b`.
- **Commit hygiene:** commit ONLY the task's files via explicit `git add <paths>`; never `git commit -am`. Leave the pre-existing uncommitted artifacts `web/dist/index.html` and `web/package-lock.json` untouched.
- **Namespace stays configured** (`--namespace`, default `default`): only the app-id becomes dynamic. Workflow key shape: `<appID>||dapr.internal.<namespace>.<appID>.workflow||<instanceID>||<suffix>`.
- **Active app-id** (frontend) = the running app (from `/api/apps`) whose loaded `components` include the active store's `name` (from `/api/statestores`); if more than one, the lexicographically-first.
- **Out of scope (Spec 2):** connecting to non-active/disconnected stores, known-store memory, store selector, cross-backend history.

---

### Task 1: Store key helpers — all-apps pattern + app-id parse

**Files:**
- Modify: `pkg/statestore/keys.go`
- Test: `pkg/statestore/keys_test.go`

**Interfaces:**
- Consumes: existing `KeyDelimiter`, `SuffixMetadata`, `WorkflowActorType` (same file).
- Produces:
  - `AllInstanceMetaPattern(namespace string) string` → `%||dapr.internal.<namespace>.%.workflow||%||metadata`
  - `ParseAppID(key string) (string, bool)` → segment[0], `ok=false` if fewer than 3 `||`-segments or empty segment[0].

- [ ] **Step 1: Write the failing tests**

Append to `pkg/statestore/keys_test.go`:

```go
func TestAllInstanceMetaPattern(t *testing.T) {
	require.Equal(t,
		"%||dapr.internal.default.%.workflow||%||metadata",
		AllInstanceMetaPattern("default"))
	require.Equal(t,
		"%||dapr.internal.prod.%.workflow||%||metadata",
		AllInstanceMetaPattern("prod"))
}

func TestParseAppID(t *testing.T) {
	id, ok := ParseAppID("pr-digest||dapr.internal.default.pr-digest.workflow||abc-123||metadata")
	require.True(t, ok)
	require.Equal(t, "pr-digest", id)

	_, ok = ParseAppID("too||few")
	require.False(t, ok)

	_, ok = ParseAppID("||dapr.internal.default..workflow||x||metadata")
	require.False(t, ok) // empty app-id segment
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/statestore/ -run 'TestAllInstanceMetaPattern|TestParseAppID' -v`
Expected: FAIL — `undefined: AllInstanceMetaPattern` / `undefined: ParseAppID`.

- [ ] **Step 3: Implement the helpers**

Add to `pkg/statestore/keys.go`:

```go
// AllInstanceMetaPattern is a KeysLike LIKE pattern matching every instance's
// metadata key across ALL app-ids in the namespace ("%" matches both the
// leading app-id segment and the app-id inside the actor type).
func AllInstanceMetaPattern(namespace string) string {
	return "%" + KeyDelimiter +
		"dapr.internal." + namespace + "." + "%" + ".workflow" + KeyDelimiter +
		"%" + KeyDelimiter + SuffixMetadata
}

// ParseAppID returns the app-id segment (segment[0]) of a "||"-joined workflow
// key. Returns ok=false for a malformed key (fewer than three segments or an
// empty app-id segment).
func ParseAppID(key string) (string, bool) {
	parts := strings.Split(key, KeyDelimiter)
	if len(parts) < 3 || parts[0] == "" {
		return "", false
	}
	return parts[0], true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/statestore/ -v`
Expected: PASS (new tests + existing `TestPatterns`/`TestParseInstanceID`).

- [ ] **Step 5: Commit**

```bash
git add pkg/statestore/keys.go pkg/statestore/keys_test.go
git commit -m "feat(statestore): add all-apps meta pattern and ParseAppID"
```

---

### Task 2: Enumerate app-ids from the store; drop the discovery `appIDs` coupling

`workflow.List`/`Stats` stop iterating running app-ids and instead scan the store for all instance-metadata keys (or the scoped pattern when an app is selected), parsing the app-id per key. The injected `appIDs func(...)` is removed from `workflow.New`, which ripples to `newStoreBackend`, the reconciler, and tests. This keeps the whole build green at the task boundary.

**Files:**
- Modify: `pkg/workflow/service.go`
- Modify (test): `pkg/workflow/service_test.go` (fake matcher + call sites + new tests), `pkg/workflow/golden_test.go:61`, `pkg/workflow/workflow_integration_test.go:67`
- Modify: `cmd/workflow.go` (drop `appIDs` param from `newStoreBackend`; `workflow.New` calls), `cmd/reconciler.go` (remove `appIDs` method; drop arg)
- Modify (test): `cmd/workflow_test.go:219-220,273,292`

**Interfaces:**
- Consumes: `statestore.AllInstanceMetaPattern`, `statestore.ParseAppID` (Task 1); existing `statestore.InstanceMetaPattern`, `statestore.ParseInstanceID`.
- Produces: `workflow.New(store statestore.Store, namespace string) Service` (no `appIDs`); `newStoreBackend(ctx, comps, loaded, namespace, client, apps, open)` (no `appIDs`).

- [ ] **Step 1: Upgrade the test fake's LIKE matcher (multi-wildcard)**

The current `fakeStore.Keys` (`pkg/workflow/service_test.go`) only handles a single wildcard. Replace its body with a proper SQL-`LIKE`→regexp matcher so the all-apps pattern works. Add `"regexp"` to the test file's imports, and replace the `Keys` method:

```go
func (f *fakeStore) Keys(_ context.Context, pattern, _ string, _ int) ([]string, string, error) {
	parts := strings.Split(pattern, "%")
	for i, p := range parts {
		parts[i] = regexp.QuoteMeta(p)
	}
	re := regexp.MustCompile("^" + strings.Join(parts, ".*") + "$")
	var out []string
	for k := range f.kv {
		if re.MatchString(k) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, "", nil
}
```

- [ ] **Step 2: Write the failing test (two app-ids enumerated from the store)**

Add to `pkg/workflow/service_test.go`. This replaces the now-obsolete `TestServiceListDedupesByInstanceID` (its premise — duplicate app-ids in the discovery list — cannot occur with store enumeration); delete that test and add:

```go
func TestServiceListEnumeratesAllAppIDsFromStore(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "i1", "OrderWorkflow", nil)
	seedWorkflow(t, f, "default", "pr-digest", "i2", "AgentRunWorkflow", nil)
	svc := New(f, "default")

	// No app filter: both app-ids' instances appear, even though neither was
	// supplied by a running-apps list.
	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	got := map[string]bool{}
	for _, it := range res.Items {
		got[it.AppID] = true
	}
	require.True(t, got["order"], "order instance must be listed")
	require.True(t, got["pr-digest"], "pr-digest instance must be listed")

	// Scoped to one app: only that app's instances.
	scoped, err := svc.List(context.Background(), ListQuery{AppID: "pr-digest"})
	require.NoError(t, err)
	require.Len(t, scoped.Items, 1)
	require.Equal(t, "pr-digest", scoped.Items[0].AppID)

	// Stats across all app-ids counts both.
	stats, err := svc.Stats(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Equal(t, 2, stats.Total)
}
```

Also update the **existing** `New(...)` call sites in this file (lines ~94, 114, 130, 157, 175) by dropping the third argument, e.g. `New(f, "default")` and `New(nil, "default")`.

- [ ] **Step 3: Run the new test to verify it fails**

Run: `go test -tags unit ./pkg/workflow/ -run TestServiceListEnumeratesAllAppIDsFromStore -v`
Expected: FAIL to compile — `New(...)` currently requires 3 args / `too many arguments`.

- [ ] **Step 4: Change the service to enumerate from the store and drop `appIDs`**

In `pkg/workflow/service.go`, replace the `service` struct, `New`, `List`, and `Stats`, and add a `metaKeys` helper:

```go
type service struct {
	store     statestore.Store
	namespace string
}

func New(store statestore.Store, namespace string) Service {
	if namespace == "" {
		namespace = "default"
	}
	return &service{store: store, namespace: namespace}
}

// metaKeys returns instance-metadata keys: scoped to one app when appID != "",
// otherwise across every app-id in the namespace.
func (s *service) metaKeys(ctx context.Context, appID, token string, pageSize int) ([]string, string, error) {
	pattern := statestore.AllInstanceMetaPattern(s.namespace)
	if appID != "" {
		pattern = statestore.InstanceMetaPattern(s.namespace, appID)
	}
	return s.store.Keys(ctx, pattern, token, pageSize)
}

func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if s.store == nil {
		return ListResult{}, ErrNoStore
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	metaKeys, next, err := s.metaKeys(ctx, q.AppID, q.PageToken, pageSize)
	if err != nil {
		return ListResult{}, err
	}

	var items []ExecutionSummary
	seen := make(map[string]struct{})
	for _, k := range metaKeys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		id, ok := statestore.ParseInstanceID(k)
		if !ok {
			continue
		}
		dedupKey := appID + "/" + id
		if _, dup := seen[dedupKey]; dup {
			continue
		}
		seen[dedupKey] = struct{}{}
		ex, err := s.load(ctx, appID, id)
		if err != nil {
			continue
		}
		if matches(ex.ExecutionSummary, q) {
			items = append(items, ex.ExecutionSummary)
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	if len(items) > pageSize {
		items = items[:pageSize]
	}
	return ListResult{Items: items, NextToken: next}, nil
}

// Stats scans all instances across the relevant app-ids, honoring AppID and
// Search but ignoring Status and paging, and tallies a count per status.
func (s *service) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if s.store == nil {
		return StatsResult{}, ErrNoStore
	}
	searchQ := ListQuery{Search: q.Search}
	res := StatsResult{Counts: map[Status]int{}}
	seen := make(map[string]struct{})

	metaKeys, _, err := s.metaKeys(ctx, q.AppID, "", 0)
	if err != nil {
		return StatsResult{}, err
	}
	for _, k := range metaKeys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		id, ok := statestore.ParseInstanceID(k)
		if !ok {
			continue
		}
		dedupKey := appID + "/" + id
		if _, dup := seen[dedupKey]; dup {
			continue
		}
		seen[dedupKey] = struct{}{}
		ex, err := s.load(ctx, appID, id)
		if err != nil {
			continue
		}
		if !matches(ex.ExecutionSummary, searchQ) {
			continue
		}
		res.Counts[ex.Status]++
		res.Total++
	}
	return res, nil
}
```

- [ ] **Step 5: Update the in-package integration/golden test call sites**

In `pkg/workflow/golden_test.go` (~line 61) and `pkg/workflow/workflow_integration_test.go` (~line 67), drop the third argument to `workflow.New`. Each currently reads:

```go
	svc := workflow.New(store, "default", func(context.Context) ([]string, error) {
		return []string{"order"}, nil   // (or similar)
	})
```

Replace with:

```go
	svc := workflow.New(store, "default")
```

- [ ] **Step 6: Update `cmd` call sites (newStoreBackend + reconciler)**

In `cmd/workflow.go`, remove the `appIDs func(context.Context) ([]string, error),` parameter from `newStoreBackend`'s signature, and change both `workflow.New` calls in its body from `workflow.New(st, namespace, appIDs)` / `workflow.New(nil, namespace, appIDs)` to `workflow.New(st, namespace)` / `workflow.New(nil, namespace)`.

In `cmd/reconciler.go`: delete the `appIDs` method (the `// appIDs lists current app IDs...` func), and change the `newStoreBackend` call (currently `newStoreBackend(octx, detected, loaded, rc.namespace, rc.client, rc.apps, rc.appIDs, rc.open)`) to drop `rc.appIDs`:

```go
	newBackend, newClosers := newStoreBackend(octx, detected, loaded, rc.namespace, rc.client, rc.apps, rc.open)
```

In `cmd/workflow_test.go`: remove the `appIDs := func(...)` locals (~lines 219, 273) and drop the `appIDs` argument from both `newStoreBackend(...)` calls (~lines 220, 292), e.g.:

```go
	_, closers := newStoreBackend(context.Background(), nil, nil, "default", &http.Client{}, nil, statestore.New)
```
```go
	b, closers := newStoreBackend(context.Background(), comps, nil, "default", &http.Client{}, nil, statestore.New)
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `go build ./...`
Expected: success.
Run: `go test -tags unit ./pkg/workflow/ ./cmd/ -v`
Expected: PASS — including the new `TestServiceListEnumeratesAllAppIDsFromStore`.
Run: `go test -tags integration ./cmd/... ./pkg/workflow/...`
Expected: PASS — `TestAssembleServerServesSeededWorkflow` still green (its single seeded instance is now found via store enumeration).

- [ ] **Step 8: Commit**

```bash
git add pkg/workflow/service.go pkg/workflow/service_test.go pkg/workflow/golden_test.go pkg/workflow/workflow_integration_test.go cmd/workflow.go cmd/reconciler.go cmd/workflow_test.go
git commit -m "feat(workflow): enumerate app-ids from the store; drop discovery appIDs coupling"
```

---

### Task 3: Frontend — "not running" badge

The workflow list already renders whatever rows the API returns and the dropdown auto-populates from them, so no change is needed for stored app-ids to appear. This task only adds the running/stopped cue.

**Files:**
- Modify: `web/src/pages/Workflows.tsx`
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: existing `useApps()` (`web/src/hooks/useApps.ts`), returning `AppSummary[]` with `appId`.
- Produces: a `runningAppIds: Set<string>` + `appsLoaded: boolean` used by the row cell and dropdown options.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Workflows.test.tsx` (inside the top-level `describe('Workflows', ...)`):

```tsx
it('marks app-ids that are not currently running', async () => {
  server.use(
    http.get('/api/apps', () =>
      HttpResponse.json([{ appId: 'wf-app', health: 'healthy', components: [] }]),
    ),
    http.get('/api/workflows', () =>
      HttpResponse.json({
        items: [
          { appId: 'pr-digest', instanceId: 'i1', name: 'AgentRunWorkflow', status: 'Completed', createdAt: '2026-06-29T10:00:00Z' },
          { appId: 'wf-app', instanceId: 'i2', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:01:00Z' },
        ],
      }),
    ),
  )
  renderAt()
  // Row for the running app: no badge.
  await screen.findByRole('link', { name: 'i2' })
  // Row for the stopped app-id shows the badge.
  expect(await screen.findAllByText('not running')).toHaveLength(1)
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx -t "not currently running"`
Expected: FAIL — no element with text "not running".

- [ ] **Step 3: Implement the badge**

In `web/src/pages/Workflows.tsx`:

Add the import near the other hook imports:

```tsx
import { useApps } from '../hooks/useApps'
```

After the `useStateStores()` block, add:

```tsx
  // Running apps — used to flag workflow rows whose app-id is not currently running.
  const { data: appsData } = useApps()
  const appsLoaded = appsData !== undefined
  const runningAppIds = useMemo(
    () => new Set((appsData ?? []).map((a) => a.appId)),
    [appsData],
  )
```

Change the app-id table cell (currently `<td>{wf.appId}</td>`) to:

```tsx
                      <td>
                        {wf.appId}
                        {appsLoaded && !runningAppIds.has(wf.appId) && (
                          <span className="typechip" style={{ marginLeft: '6px' }}>
                            not running
                          </span>
                        )}
                      </td>
```

Change the dropdown options block (currently maps `appIds` to plain `<option>`s) to append a suffix for non-running app-ids:

```tsx
          {appIds.map((id) => (
            <option key={id} value={id}>
              {id}
              {appsLoaded && !runningAppIds.has(id) ? ' (not running)' : ''}
            </option>
          ))}
```

- [ ] **Step 4: Run the test + typecheck to verify they pass**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS (new test + existing tests).
Run (from `web/`): `npx tsc -b`
Expected: clean (no type errors).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): badge workflow app-ids that are not currently running"
```

---

### Task 4: Frontend — default dropdown to the active app-id (else All apps)

On initial load, default the dropdown to the active app-id when it has workflow data; otherwise leave "All apps". Applied once; a `?app=` URL param always wins.

**Files:**
- Modify: `web/src/types/api.ts` (add `components` to `AppSummary`)
- Modify: `web/src/pages/Workflows.tsx`
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: `appsData` + `runningAppIds`/`appsLoaded` (Task 3), `activeStore` (existing), `appIds` (existing), `urlApp`/`selectedApp`/`setSelectedApp` (existing), `isLoading` from `useWorkflows` (existing `data`/`isLoading`).
- Produces: a one-time default selection; no new exported symbols.

- [ ] **Step 1: Add `components` to the `AppSummary` type**

In `web/src/types/api.ts`, add `components` to `AppSummary` (the `/api/apps` response already includes it at runtime; it was only typed on `AppDetail`):

```ts
export interface AppSummary {
  appId: string
  health: HealthStatus
  runtime: string
  httpPort: number
  grpcPort: number
  appPort: number
  daprdPid: number
  appPid: number
  cliPid: number
  age: string
  created: string
  runTemplate: string
  components?: { name: string; type: string; version?: string }[]
}
```

Then remove the now-redundant `components?: { name: string; type: string; version?: string }[]` line from `AppDetail` (it is inherited from `AppSummary`).

- [ ] **Step 2: Write the failing tests**

Add to `web/src/pages/Workflows.test.tsx`:

```tsx
it('defaults the dropdown to the active app-id when it has workflows', async () => {
  server.use(
    http.get('/api/statestores', () =>
      HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
    ),
    http.get('/api/apps', () =>
      HttpResponse.json([{ appId: 'order', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
    ),
    http.get('/api/workflows', () =>
      HttpResponse.json({
        items: [{ appId: 'order', instanceId: 'i1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
      }),
    ),
  )
  renderAt()
  const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('order'))
})

it('falls back to All apps when the active app has no workflows', async () => {
  server.use(
    http.get('/api/statestores', () =>
      HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
    ),
    // Running app wf-app loaded the active store but has no workflows.
    http.get('/api/apps', () =>
      HttpResponse.json([{ appId: 'wf-app', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
    ),
    http.get('/api/workflows', () =>
      HttpResponse.json({
        items: [{ appId: 'pr-digest', instanceId: 'i1', name: 'AgentRunWorkflow', status: 'Completed', createdAt: '2026-06-29T10:00:00Z' }],
      }),
    ),
  )
  renderAt()
  await screen.findByRole('link', { name: 'i1' })
  const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
  expect(select.value).toBe('') // All apps
})

it('a ?app= URL param overrides the computed default', async () => {
  server.use(
    http.get('/api/statestores', () =>
      HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
    ),
    http.get('/api/apps', () =>
      HttpResponse.json([{ appId: 'order', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
    ),
    http.get('/api/workflows', () =>
      HttpResponse.json({
        items: [{ appId: 'order', instanceId: 'i1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
      }),
    ),
  )
  renderAt('/workflows?app=pr-digest')
  const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
  await waitFor(() => expect(select.value).toBe('pr-digest'))
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx -t "default"`
Expected: FAIL — the dropdown stays `''` (no default-selection logic yet); the "active app-id" case expects `order`.

- [ ] **Step 4: Implement the one-time default selection**

First, make the app `<select>` (currently `data-cy="app-select"`, ~line 310) queryable by the tests — there are two `<select>`s on the page (this one and `RefreshControl`'s), so add a `data-testid` alongside the existing `data-cy`:

```tsx
        <select
          className="select"
          data-cy="app-select"
          data-testid="app-select"
```

Then add the active-app derivation after `runningAppIds` (Task 3):

```tsx
  // Active app-id = the running app that loaded the active store. Used to default
  // the dropdown to the most relevant workflows on first load.
  const activeAppId = useMemo(() => {
    if (!activeStore) return undefined
    const matched = (appsData ?? [])
      .filter((a) => a.components?.some((c) => c.name === activeStore.name))
      .map((a) => a.appId)
      .sort()
    return matched[0]
  }, [appsData, activeStore])
```

Add the apply-once default effect (place it after `appIds` is defined, since it reads `appIds`):

```tsx
  // One-time default: prefer the active app-id when it has workflows, else leave
  // "All apps". A ?app= URL param always wins. Never overrides a later manual change.
  const defaultAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultAppliedRef.current) return
    if (urlApp !== '') {
      defaultAppliedRef.current = true
      return
    }
    // Wait until the initial "All apps" workflows result, the apps list, and the
    // store list are all available before deciding.
    if (isLoading || appsData === undefined || storeList === undefined) return
    if (activeAppId && appIds.includes(activeAppId)) {
      setSelectedApp(activeAppId)
    }
    defaultAppliedRef.current = true
  }, [urlApp, isLoading, appsData, storeList, activeAppId, appIds])
```

(`useRef`/`useEffect`/`useMemo` are already imported; `isLoading` is already destructured from `useWorkflows`; `storeList` and `activeStore` already exist.)

- [ ] **Step 5: Run the tests + typecheck to verify they pass**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS (all three default-selection tests + Task 3 badge test + existing tests).
Run (from `web/`): `npx tsc -b`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/api.ts web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): default workflow dropdown to active app-id when it has data"
```

---

## Self-Review

**Spec coverage:**
- "Enumerate app-ids from the connected store" → Task 1 (helpers) + Task 2 (`metaKeys`/`List`/`Stats`). ✓
- "Keep configured namespace" → `AllInstanceMetaPattern(s.namespace)`; namespace unchanged in `load`/`Get`. ✓
- "Drop the discovery `appIDs` coupling" → Task 2 (Steps 4–6). ✓
- "Not running badge (table + dropdown suffix)" → Task 3. ✓
- "Default dropdown to active app-id, else All apps; URL wins; apply once" → Task 4. ✓
- "Active app-id derived client-side from /api/apps components + active /api/statestores" → Task 4 (`activeAppId`) + the `AppSummary.components` type add. ✓
- "Paging from a single Keys call" → Task 2 `List` uses `next` from `metaKeys`. ✓
- "Tests: keys, two-app service, badge, default cases, integration still green" → Tasks 1–4 + Task 2 Step 7. ✓
- "Out of scope: connecting to other/disconnected stores" → not implemented. ✓

**Placeholder scan:** No TBD/TODO; every code/step is concrete.

**Type consistency:** `AllInstanceMetaPattern(namespace) string` and `ParseAppID(key) (string,bool)` are defined in Task 1 and consumed identically in Task 2. `workflow.New(store, namespace)` (Task 2) matches all updated call sites (service_test, golden_test, workflow_integration_test, cmd/workflow.go). `newStoreBackend(ctx, comps, loaded, namespace, client, apps, open)` matches the reconciler call and both `cmd/workflow_test.go` calls. Frontend `runningAppIds`/`appsLoaded`/`activeAppId`/`appsData` names are consistent between Tasks 3 and 4; `AppSummary.components` (Task 4) backs `activeAppId`'s `a.components`. The default-selection tests query the dropdown via `findByTestId('app-select')`; Task 4 Step 4 adds that `data-testid` to the `<select>` (two `<select>`s render on the page, so a `data-testid` is required for an unambiguous query).
