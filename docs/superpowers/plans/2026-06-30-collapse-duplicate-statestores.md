# Collapse Duplicate State Stores in the Workflow-Page Selector — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the Workflow-page state-store dropdown, collapse stores that share the same name + type + connection (differing only by file path) into a single option, preferring the active member.

**Architecture:** A new pure helper `dedupeStores` (mirroring the existing `dedupeWorkflows`) groups stores by `name|type|connection` and emits one representative per group. `Workflows.tsx` applies it to derive a `displayStores` list used for rendering the dropdown options and for resolving the persisted/selected store id. The shared `useStateStores` hook, the backend, and the connection-management panel are untouched.

**Tech Stack:** React + TypeScript, Vitest, Testing Library, MSW.

## Global Constraints

- Dedup key is exactly `name + "|" + type + "|" + connection` — path is excluded. This mirrors the backend's `identity()` (`cmd/reconciler.go:69`).
- Change is **dropdown-only**: do NOT modify `web/src/hooks/useWorkflows.ts` (`useStateStores`), the Go backend, or `web/src/components/StateStoreConnectionsPanel.tsx`.
- Collapsed options must render **identically** to single stores (no "(N paths)" indicator) — reuse the existing `storeOptionLabel`.
- Tie-break when a group has no active member: keep the **first** member in input order.
- **Git note (user instruction):** Do NOT run `git add`/`git commit` automatically. The "Commit" steps below are part of the plan, but the executor must ask the user for explicit approval before running any git command.

---

### Task 1: `dedupeStores` pure helper

**Files:**
- Create: `web/src/lib/dedupeStores.ts`
- Test: `web/src/lib/dedupeStores.test.ts`

**Interfaces:**
- Consumes: `StateStore` from `web/src/types/workflow.ts` (`{ id, name, type, source, path, active, connection }`).
- Produces: `export function dedupeStores(stores: StateStore[]): StateStore[]` — returns one `StateStore` per unique `name|type|connection` group, in order of each group's first appearance; the representative is the group's active member if any, else its first member. Input is not mutated.

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/dedupeStores.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dedupeStores } from './dedupeStores'
import type { StateStore } from '../types/workflow'

function store(over: Partial<StateStore>): StateStore {
  return {
    id: 'id',
    name: 'redis',
    type: 'state.redis',
    source: 'auto',
    path: '/c/redis.yaml',
    active: false,
    connection: 'localhost:6379',
    ...over,
  }
}

describe('dedupeStores', () => {
  it('returns the list unchanged when there are no duplicates', () => {
    const input = [
      store({ id: 'a', connection: 'localhost:6379' }),
      store({ id: 'b', connection: 'localhost:16379' }),
    ]
    expect(dedupeStores(input).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('does NOT collapse stores that differ by connection', () => {
    const input = [
      store({ id: 'a', name: 'statestore', connection: 'localhost:6379' }),
      store({ id: 'b', name: 'statestore', connection: 'localhost:16379' }),
    ]
    expect(dedupeStores(input)).toHaveLength(2)
  })

  it('collapses same name+type+connection differing only by path, keeping the active member', () => {
    const input = [
      store({ id: 'p1', path: '/c/a.yaml', active: false }),
      store({ id: 'p2', path: '/c/b.yaml', active: true }),
    ]
    const out = dedupeStores(input)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p2') // the active member represents the group
  })

  it('keeps the first member when no member of the group is active', () => {
    const input = [
      store({ id: 'p1', path: '/c/a.yaml', active: false }),
      store({ id: 'p2', path: '/c/b.yaml', active: false }),
    ]
    const out = dedupeStores(input)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p1')
  })

  it('emits one entry per group in first-appearance order', () => {
    const input = [
      store({ id: 'r1', name: 'redis', path: '/c/r1.yaml' }),
      store({ id: 'pg1', name: 'pg', type: 'state.postgresql', connection: 'db:5432', path: '/c/pg1.yaml' }),
      store({ id: 'r2', name: 'redis', path: '/c/r2.yaml' }),
    ]
    const out = dedupeStores(input)
    expect(out.map((s) => s.name)).toEqual(['redis', 'pg'])
    expect(out[0].id).toBe('r1')
  })

  it('does not mutate the input array', () => {
    const input = [store({ id: 'p1', active: false }), store({ id: 'p2', active: true })]
    const snapshot = input.map((s) => s.id)
    dedupeStores(input)
    expect(input.map((s) => s.id)).toEqual(snapshot)
  })

  it('returns an empty array for empty input', () => {
    expect(dedupeStores([])).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/lib/dedupeStores.test.ts`
Expected: FAIL — `dedupeStores` cannot be imported (module not found).

- [ ] **Step 3: Write the minimal implementation**

Create `web/src/lib/dedupeStores.ts`:

```ts
import type { StateStore } from '../types/workflow'

/**
 * Collapse state stores that share the same metadata name, type, and connection
 * but live at different file paths into a single representative. Several
 * component files pointing at the same store read identical data, so they need
 * not appear as separate dropdown options.
 *
 * Grouping key is `name|type|connection` (path excluded) — matching the
 * backend's identity() notion. One entry is emitted per group in order of the
 * group's first appearance; the representative is the group's active member if
 * one exists, otherwise the first member encountered. Input is not mutated.
 */
export function dedupeStores(stores: StateStore[]): StateStore[] {
  const indexByKey = new Map<string, number>()
  const out: StateStore[] = []
  for (const s of stores) {
    const key = `${s.name}|${s.type}|${s.connection}`
    const existing = indexByKey.get(key)
    if (existing === undefined) {
      indexByKey.set(key, out.length)
      out.push(s)
      continue
    }
    // Group already represented — upgrade to the active member if this one is it.
    if (s.active && !out[existing].active) {
      out[existing] = s
    }
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/lib/dedupeStores.test.ts`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit** (ask the user for approval first — see Global Constraints)

```bash
git add web/src/lib/dedupeStores.ts web/src/lib/dedupeStores.test.ts
git commit -m "feat(web): add dedupeStores helper for the workflow store selector"
```

---

### Task 2: Apply `dedupeStores` to the Workflow-page dropdown

**Files:**
- Modify: `web/src/pages/Workflows.tsx`
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: `dedupeStores` from `web/src/lib/dedupeStores.ts` (Task 1).
- Produces: a `displayStores` memo used to (a) render the store `<option>`s and (b) validate the persisted/selected store id. No exported API change.

- [ ] **Step 1: Write the failing component test**

Add this test inside the existing `describe('Workflows page — store selector', ...)` block in `web/src/pages/Workflows.test.tsx` (it already calls `window.localStorage.clear()` in `beforeEach`):

```ts
  it('collapses duplicate-path stores (same name+type+connection) into one option, showing the active one', async () => {
    const dupPaths = [
      { id: 'redis-p1', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis-a.yaml', active: false, connection: 'localhost:6379' },
      { id: 'redis-p2', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis-b.yaml', active: true, connection: 'localhost:6379' },
    ]
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(dupPaths)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    // Only one option for the duplicated store.
    await waitFor(() => expect(storeSelect.querySelectorAll('option')).toHaveLength(1))
    // The active member (redis-p2) is the representative shown and selected.
    const opt = storeSelect.querySelector('option') as HTMLOptionElement
    expect(opt.value).toBe('redis-p2')
    expect(opt.textContent).toMatch(/redis — redis · localhost:6379 \(active\)/)
    await waitFor(() => expect(storeSelect.value).toBe('redis-p2'))
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx -t "collapses duplicate-path stores"`
Expected: FAIL — the select renders 2 options (no dedup yet).

- [ ] **Step 3: Add the import**

In `web/src/pages/Workflows.tsx`, add to the existing import block near the top (after the `dedupeWorkflows` import on line 8):

```ts
import { dedupeStores } from '../lib/dedupeStores'
```

- [ ] **Step 4: Derive `displayStores`**

In `web/src/pages/Workflows.tsx`, immediately after the `activeStore` line (currently line 94, `const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]`), add:

```ts
  // Collapse stores that differ only by file path (same name + type + connection)
  // into one dropdown option — they read identical data. The active member, when
  // present, represents its group. This is a display concern for THIS selector
  // only; the shared store list still feeds the connections panel in full.
  const displayStores = useMemo(() => dedupeStores(storeList ?? []), [storeList])
```

- [ ] **Step 5: Validate the persisted id against `displayStores`**

In the `useEffect` that resolves `selectedStore` (currently lines 102–109), replace every reference to `storeList` with `displayStores` so a persisted id pointing at a now-hidden duplicate falls back to the active store. The block becomes:

```ts
  useEffect(() => {
    if (!displayStores || displayStores.length === 0) return
    if (selectedStore !== null && displayStores.some((s) => s.id === selectedStore)) return
    const persisted = window.localStorage.getItem(STORE_KEY)
    const fromPersisted = persisted && displayStores.some((s) => s.id === persisted) ? persisted : undefined
    const fallback = activeStore?.id ?? displayStores[0].id
    setSelectedStore(fromPersisted ?? fallback)
  }, [displayStores, activeStore, selectedStore])
```

Note: `activeStore` is still derived from the full `storeList` (line 94) and remains a representative present in `displayStores`, so the fallback resolves to a visible option.

- [ ] **Step 6: Render options from `displayStores`**

In the store `<select>` (currently lines 347–351), change the mapped list from `storeList` to `displayStores`:

```tsx
                {displayStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {storeOptionLabel(s)}
                  </option>
                ))}
```

Leave the `storeList && storeList.length > 0 ? (...)` guard on line 337 unchanged — `displayStores` is non-empty exactly when `storeList` is.

- [ ] **Step 7: Run the new test to verify it passes**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx -t "collapses duplicate-path stores"`
Expected: PASS.

- [ ] **Step 8: Run the full Workflows test file to check for regressions**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS — including "lists every store with a disambiguating label" (the `twoStores` fixture differs by connection, so it is not collapsed).

- [ ] **Step 9: Commit** (ask the user for approval first — see Global Constraints)

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): collapse duplicate-path state stores in the workflow selector"
```

---

### Task 3: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS — entire suite green.

- [ ] **Step 2: Type-check and lint**

Run: `cd web && npx tsc --noEmit && npm run lint`
Expected: no errors. (If `lint` is not defined in `web/package.json`, run only `npx tsc --noEmit`.)

- [ ] **Step 3: Manual smoke (optional, if a dev environment with duplicate component files is available)**

With two state-store component YAML files of the same name/type/connection at different paths, open the Workflow page and confirm the store dropdown lists a single option (the active one), and the workflow table loads normally.
