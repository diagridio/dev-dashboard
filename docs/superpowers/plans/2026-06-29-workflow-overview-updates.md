# Workflow Overview Page Updates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workflow overview page's status badges show true per-status totals, turn the statestore chip into a link to its component, and add a select-all checkbox to the table header.

**Architecture:** A new backend `Stats` service method + `GET /workflows/stats` route returns per-status counts independent of the active filter and paging; the frontend consumes it via a new `useWorkflowStats` hook. Two further frontend-only changes turn the header chip into a router `<Link>` and surface the existing `toggleAll` selection logic as a header checkbox.

**Tech Stack:** Go (chi router, testify, `//go:build unit` tests), React + TypeScript, TanStack Query, React Router, Vitest + Testing Library + MSW.

## Global Constraints

- Go unit tests use the `//go:build unit` tag and run via `go test -tags unit -race ./...` (or `make test-go`).
- The `workflow.Service` interface is implemented by the real `*service` AND by `fakeWF` in `pkg/server/workflows_test.go` — any interface change must update both or `./...` fails to compile.
- JSON result structs use explicit camelCase `json:"..."` tags (e.g. `json:"items"`, `json:"nextToken"`).
- Frontend tests use MSW handlers mounted at `/api/...` paths and wrap components in `<QueryProvider><RefreshProvider>…`.
- Workflow statuses: `Pending`, `Running`, `Completed`, `Failed`, `Terminated`, `Suspended`. The status filter UI only shows the five in `ALL_STATUSES` (`Running`, `Completed`, `Failed`, `Terminated`, `Suspended`).
- Frontend run from `web/`: tests `npm test` (vitest run), type-check via `npx tsc -b`.

---

## Task 1: Backend `Stats` service method

**Files:**
- Modify: `pkg/workflow/types.go` (add `StatsResult`)
- Modify: `pkg/workflow/service.go` (add `Stats` to `Service` interface + `*service` impl)
- Modify: `pkg/server/workflows_test.go:70-81` (add `Stats` stub to `fakeWF` so the interface stays satisfied)
- Test: `pkg/workflow/service_test.go`

**Interfaces:**
- Consumes: existing `s.store.Keys`, `s.load`, `matches`, `statestore.InstanceMetaPattern`, `statestore.ParseInstanceID`.
- Produces: `StatsResult{ Counts map[Status]int; Total int }` and `Service.Stats(ctx, ListQuery) (StatsResult, error)`. Later tasks (HTTP route) rely on these exact names/types.

- [ ] **Step 1: Write the failing test**

Add to `pkg/workflow/service_test.go`:

```go
func TestServiceStats(t *testing.T) {
	f := newFakeStore()
	// two Running (started only)
	seedWorkflow(t, f, "default", "order", "inst-a", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	seedWorkflow(t, f, "default", "order", "inst-b", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	// one Completed
	completed := &protos.HistoryEvent{EventId: 1, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionCompleted{
		ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"ok"`},
		},
	}}
	seedWorkflow(t, f, "default", "order", "inst-c", "OrderWorkflow",
		[]*protos.HistoryEvent{startedEvent("OrderWorkflow"), completed})

	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })

	// A status filter must NOT affect counts: every status is still tallied.
	res, err := svc.Stats(context.Background(), ListQuery{Status: []Status{StatusCompleted}})
	require.NoError(t, err)
	require.Equal(t, 2, res.Counts[StatusRunning])
	require.Equal(t, 1, res.Counts[StatusCompleted])
	require.Equal(t, 3, res.Total)

	// Search narrows the tally (honored), still ignoring status.
	res, err = svc.Stats(context.Background(), ListQuery{Search: "inst-c"})
	require.NoError(t, err)
	require.Equal(t, 1, res.Total)
	require.Equal(t, 1, res.Counts[StatusCompleted])
	require.Equal(t, 0, res.Counts[StatusRunning])
}

func TestServiceStatsNoStore(t *testing.T) {
	svc := New(nil, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	_, err := svc.Stats(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
}
```

- [ ] **Step 2: Run test to verify it fails (does not compile)**

Run: `go test -tags unit ./pkg/workflow/ -run TestServiceStats`
Expected: FAIL — `res.Counts undefined` / `svc.Stats undefined` (StatsResult and Stats don't exist yet).

- [ ] **Step 3: Add the `StatsResult` type**

In `pkg/workflow/types.go`, after the `ListResult` struct (around line 76):

```go
type StatsResult struct {
	Counts map[Status]int `json:"counts"`
	Total  int            `json:"total"`
}
```

- [ ] **Step 4: Add `Stats` to the `Service` interface**

In `pkg/workflow/service.go`, extend the interface (around lines 30-33):

```go
type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Stats(ctx context.Context, q ListQuery) (StatsResult, error)
	Get(ctx context.Context, appID, instanceID string) (Execution, error)
}
```

- [ ] **Step 5: Implement `Stats` on `*service`**

In `pkg/workflow/service.go`, add after the `List` method (after line 101):

```go
// Stats scans all instances across the relevant apps, honoring AppID and
// Search but ignoring Status and paging, and tallies a count per status.
func (s *service) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if s.store == nil {
		return StatsResult{}, ErrNoStore
	}
	apps, err := s.appIDs(ctx)
	if err != nil {
		return StatsResult{}, err
	}
	if q.AppID != "" {
		apps = []string{q.AppID}
	}
	// Reuse matches() for search only — never filter counts by status.
	searchQ := ListQuery{Search: q.Search}
	res := StatsResult{Counts: map[Status]int{}}
	seen := make(map[string]struct{})
	for _, appID := range apps {
		// pageSize 0 = all keys (same convention load() relies on).
		keys, _, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), "", 0)
		if err != nil {
			return StatsResult{}, err
		}
		for _, k := range keys {
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
	}
	return res, nil
}
```

- [ ] **Step 6: Add a `Stats` stub to `fakeWF` to keep the interface satisfied**

In `pkg/server/workflows_test.go`, add this method next to `fakeWF`'s `List` (after line 72):

```go
func (f fakeWF) Stats(context.Context, workflow.ListQuery) (workflow.StatsResult, error) {
	return f.stats, f.err
}
```

And add a `stats` field to the `fakeWF` struct (lines 64-68):

```go
type fakeWF struct {
	list  workflow.ListResult
	stats workflow.StatsResult
	one   workflow.Execution
	err   error
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/workflow/ ./pkg/server/`
Expected: PASS (including `TestServiceStats`, `TestServiceStatsNoStore`, and existing server tests still compile/pass).

- [ ] **Step 8: Commit**

```bash
git add pkg/workflow/types.go pkg/workflow/service.go pkg/workflow/service_test.go pkg/server/workflows_test.go
git commit -m "feat(workflow): add Stats service method for per-status counts"
```

---

## Task 2: Backend `GET /workflows/stats` route

**Files:**
- Modify: `pkg/server/workflows.go` (add `/stats` route in `workflowsRouter`)
- Test: `pkg/server/workflows_test.go`

**Interfaces:**
- Consumes: `workflow.Service.Stats` (Task 1), `parseListQuery`, `backend.ServiceFor`, `writeJSON`.
- Produces: HTTP `GET /api/workflows/stats` returning JSON `{ "counts": {<status>: n}, "total": n }`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/server/workflows_test.go`:

```go
func TestWorkflowsStats(t *testing.T) {
	svc := fakeWF{stats: workflow.StatsResult{
		Counts: map[workflow.Status]int{workflow.StatusRunning: 2, workflow.StatusCompleted: 1},
		Total:  3,
	}}
	h := workflowsRouter(newFakeBackend(svc), nil)
	res, body := get(t, h, "/stats?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"total":3`)
	require.Contains(t, body, `"Running":2`)
	require.Contains(t, body, `"Completed":1`)
}

func TestWorkflowsStatsUnknownStore(t *testing.T) {
	h := workflowsRouter(newFakeBackend(fakeWF{}), nil)
	res, _ := get(t, h, "/stats?store=unknown")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestWorkflowsStats`
Expected: FAIL — `/stats` returns 404 (route not registered) so `TestWorkflowsStats` gets 404 not 200.

- [ ] **Step 3: Add the `/stats` route**

In `pkg/server/workflows.go`, inside `workflowsRouter`, add after the `r.Get("/", …)` block (after line 79):

```go
	r.Get("/stats", func(w http.ResponseWriter, req *http.Request) {
		svc, _, _, ok := backend.ServiceFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return
		}
		res, err := svc.Stats(req.Context(), parseListQuery(req))
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
```

(Register it before the `/{appId}/{instanceId}` route so chi matches the literal `/stats` path first.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/server/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/workflows.go pkg/server/workflows_test.go
git commit -m "feat(server): add GET /workflows/stats route"
```

---

## Task 3: Frontend `useWorkflowStats` hook + type

**Files:**
- Modify: `web/src/types/workflow.ts` (add `WorkflowStats`)
- Modify: `web/src/hooks/useWorkflows.ts` (add `useWorkflowStats`)
- Test: `web/src/hooks/useWorkflows.test.tsx`

**Interfaces:**
- Consumes: `fetchJSON`, `useRefreshInterval`, `refetchMs`, existing `WorkflowsParams.queryString` logic.
- Produces: `WorkflowStats { counts: Partial<Record<WorkflowStatus, number>>; total: number }` and `useWorkflowStats(params: { appId?: string; search?: string; store?: string })`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/hooks/useWorkflows.test.tsx`:

```tsx
import { useWorkflowStats } from './useWorkflows'

function StatsProbe() {
  const { data } = useWorkflowStats({ appId: 'order', search: 'ab' })
  return <div>total:{data?.total ?? '-'} running:{data?.counts.Running ?? '-'}</div>
}

describe('useWorkflowStats', () => {
  it('requests /workflows/stats with appId and search but no status', async () => {
    server.use(http.get('/api/workflows/stats', ({ request }) => {
      const url = new URL(request.url)
      expect(url.searchParams.get('appId')).toBe('order')
      expect(url.searchParams.get('search')).toBe('ab')
      expect(url.searchParams.get('status')).toBeNull()
      return HttpResponse.json({ counts: { Running: 2, Completed: 1 }, total: 3 })
    }))
    render(<QueryProvider><RefreshProvider><StatsProbe /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('total:3 running:2')).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npm test -- useWorkflows`
Expected: FAIL — `useWorkflowStats` is not exported.

- [ ] **Step 3: Add the `WorkflowStats` type**

In `web/src/types/workflow.ts`, after `WorkflowListResult` (after line 33):

```ts
export interface WorkflowStats {
  counts: Partial<Record<WorkflowStatus, number>>
  total: number
}
```

- [ ] **Step 4: Add the `useWorkflowStats` hook**

In `web/src/hooks/useWorkflows.ts`, update the import on line 4 to include `WorkflowStats`:

```ts
import type { WorkflowExecution, WorkflowListResult, WorkflowStats, StateStore, WorkflowStatus } from '../types/workflow'
```

Then add after `useWorkflows` (after line 35):

```ts
export function useWorkflowStats(params: { appId?: string; search?: string; store?: string }) {
  const ctx = useRefreshInterval()
  const sp = new URLSearchParams()
  if (params.appId) sp.set('appId', params.appId)
  if (params.search) sp.set('search', params.search)
  if (params.store) sp.set('store', params.store)
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  return useQuery<WorkflowStats>({
    queryKey: ['workflow-stats', qs],
    queryFn: () => fetchJSON<WorkflowStats>(`/workflows/stats${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run (from `web/`): `npm test -- useWorkflows`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/workflow.ts web/src/hooks/useWorkflows.ts web/src/hooks/useWorkflows.test.tsx
git commit -m "feat(web): add useWorkflowStats hook"
```

---

## Task 4: Wire per-status counts into the Workflows page

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (replace `statusCounts`/`totalCount` with stats hook)
- Test: `web/src/pages/Workflows.test.tsx` (create)

**Interfaces:**
- Consumes: `useWorkflowStats` (Task 3).
- Produces: status badges driven by stats, independent of `activeStatus`.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/Workflows.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Workflows } from './Workflows'

function renderPage(initialEntry = '/workflows?status=Failed') {
  return render(
    <QueryProvider>
      <RefreshProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Workflows />
        </MemoryRouter>
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Workflows page — status counts', () => {
  it('shows per-status counts from /stats even when a status filter is active', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ items: [{ appId: 'order', instanceId: 'f1', name: 'W', status: 'Failed' }] }),
      ),
      http.get('/api/workflows/stats', () =>
        HttpResponse.json({ counts: { Running: 5, Completed: 9, Failed: 1 }, total: 15 }),
      ),
      http.get('/api/statestores', () => HttpResponse.json([])),
    )
    renderPage('/workflows?status=Failed')
    // "Completed" badge stays populated (9) even though the active filter is Failed.
    const completedBtn = await screen.findByRole('button', { name: /Completed/ })
    await waitFor(() => expect(completedBtn).toHaveTextContent('9'))
    const allBtn = screen.getByRole('button', { name: /^All/ })
    expect(allBtn).toHaveTextContent('15')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npm test -- Workflows`
Expected: FAIL — `Completed` badge shows `0` (counts still derived from the loaded, status-filtered page).

- [ ] **Step 3: Replace the count derivation with the stats hook**

In `web/src/pages/Workflows.tsx`:

a) Update the hook import on line 3:

```tsx
import { useWorkflows, useWorkflowStats, useStateStores } from '../hooks/useWorkflows'
```

b) Add the stats query next to the `useWorkflows` call (after line 107):

```tsx
  const { data: stats } = useWorkflowStats({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
  })
```

c) Delete the `statusCounts` `useMemo` and the `totalCount` line (current lines 133-141):

```tsx
  // Status counts from current items (for segment badge numbers)
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = {}
    items.forEach((w) => {
      counts[w.status] = (counts[w.status] ?? 0) + 1
    })
    return counts
  }, [items])
  const totalCount = items.length
```

d) Update the "All" badge (current line 295) to read the stats total:

```tsx
            All <span className="n">{stats?.total ?? 0}</span>
```

e) Update the per-status badge (current line 303) to read stats counts:

```tsx
              {s} <span className="n">{stats?.counts[s] ?? 0}</span>
```

- [ ] **Step 4: Run test + type-check to verify they pass**

Run (from `web/`): `npm test -- Workflows && npx tsc -b`
Expected: PASS, no type errors. (`useMemo` stays imported — it is still used by the `items` and `appIds` memos.)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): drive status badges from /workflows/stats"
```

---

## Task 5: Statestore chip links to its component

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (chip → `<Link>`)
- Test: `web/src/pages/Workflows.test.tsx` (add case)

**Interfaces:**
- Consumes: existing `activeStore` (from `useStateStores`), `Link` (already imported on line 2), the `/components/:name` route handled by `ResourceList`.
- Produces: a clickable chip linking to `/components/<storeName>`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Workflows.test.tsx`:

```tsx
describe('Workflows page — statestore chip', () => {
  it('renders the statestore chip as a link to its component', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/statestores', () =>
        HttpResponse.json([
          { name: 'statestore', type: 'state.redis', path: '/x', active: true, connection: 'localhost:6379' },
        ]),
      ),
    )
    renderPage('/workflows')
    const chip = await screen.findByRole('link', { name: /statestore/ })
    expect(chip).toHaveAttribute('href', '/components/statestore')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npm test -- Workflows`
Expected: FAIL — no `link` with accessible name `statestore` (chip is still a `<span>`).

- [ ] **Step 3: Render the chip as a link when a store exists**

In `web/src/pages/Workflows.tsx`, replace the chip block (current lines 247-251):

```tsx
          <span className="chip">
            <span className="led" />
            statestore{' '}
            <b>{storeLabel}</b>
          </span>
```

with:

```tsx
          {activeStore ? (
            <Link className="chip link" to={`/components/${activeStore.name}`}>
              <span className="led" />
              statestore <b>{storeLabel}</b>
            </Link>
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
```

- [ ] **Step 4: Run test to verify it passes**

Run (from `web/`): `npm test -- Workflows`
Expected: PASS.

- [ ] **Step 5: Verify the link-chip style exists**

Run: `grep -n "chip.link\|\.chip\.link\|chip .* link" web/src/styles/theme.css` and confirm a `.chip.link` (or `.chip` + `.link`) rule renders an anchor as a chip (the pattern `AppDetail.tsx` uses via `.chip.k.link`). If no `.chip.link` rule exists, add one mirroring the existing `.chip` rule plus `text-decoration: none; cursor: pointer;` to `web/src/styles/theme.css` near the `.chip` block (around line 182).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx web/src/styles/theme.css
git commit -m "feat(web): link statestore chip to its component page"
```

---

## Task 6: Select-all checkbox in the table header

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (header `<th>` → checkbox)
- Test: `web/src/pages/Workflows.test.tsx` (add case)

**Interfaces:**
- Consumes: existing `allSelected` boolean (line 210) and `toggleAll` (lines 160-167).
- Produces: an always-visible select-all checkbox in the first header cell.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Workflows.test.tsx`:

```tsx
import { fireEvent } from '@testing-library/react'

describe('Workflows page — select all', () => {
  it('select-all header checkbox selects then clears all loaded rows', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'a', name: 'W', status: 'Running' },
            { appId: 'order', instanceId: 'b', name: 'W', status: 'Running' },
          ],
        }),
      ),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: { Running: 2 }, total: 2 })),
      http.get('/api/statestores', () => HttpResponse.json([])),
    )
    renderPage('/workflows')
    const selectAll = await screen.findByRole('checkbox', { name: /select all/i })
    fireEvent.click(selectAll)
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument())
    fireEvent.click(selectAll)
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run (from `web/`): `npm test -- Workflows`
Expected: FAIL — no `checkbox` named "select all" in the header.

- [ ] **Step 3: Replace the empty header cell with a checkbox**

In `web/src/pages/Workflows.tsx`, replace the first header cell (current line 390):

```tsx
                  <th style={{ width: 34 }} />
```

with:

```tsx
                  <th style={{ width: 34 }}>
                    <span
                      className={allSelected ? 'cbx on' : 'cbx'}
                      role="checkbox"
                      aria-checked={allSelected}
                      aria-label="Select all"
                      tabIndex={0}
                      onClick={toggleAll}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleAll(e as unknown as React.MouseEvent)
                        }
                      }}
                    />
                  </th>
```

- [ ] **Step 4: Run test + type-check to verify they pass**

Run (from `web/`): `npm test -- Workflows && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): add select-all checkbox to workflow table header"
```

---

## Task 7: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full Go unit suite**

Run: `make test-go` (or `go test -tags unit -race ./...`)
Expected: PASS.

- [ ] **Step 2: Run the full frontend suite + type-check**

Run (from `web/`): `npm test && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 3: Manual smoke check (optional, if a dev environment is available)**

Start the dashboard, open the Workflow overview page, and confirm:
- Clicking a status filter (e.g. Failed) keeps the other badge counts populated.
- Clicking the statestore chip navigates to the components page with that component highlighted.
- The header checkbox selects all visible rows and the selection bar appears; clicking it again clears them.
```
