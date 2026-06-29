# Workflow Overview Page Updates — Design

**Date:** 2026-06-29
**Status:** Approved (pending spec review)

## Summary

Three independent improvements to the Workflow overview page (`web/src/pages/Workflows.tsx`):

1. **Status filter counts are always accurate** — each status badge shows the true count for that status across all workflows, regardless of which filter is active or which page is loaded. This requires a new backend stats endpoint.
2. **Statestore chip links to its component** — the `statestore …` chip in the page header becomes a link to the components page with that state-store component highlighted.
3. **Select-all checkbox in the table header** — the empty first header cell gets a checkbox that selects/deselects all rows in the current view.

All three are independent and may ship separately.

## Problem Statement

### #1 Status counts
Today the status-filter badges are computed client-side from the **loaded page only** (`statusCounts` / `totalCount` in `Workflows.tsx`, derived from `items`). Two consequences:

- The `/workflows` API only returns rows matching the **active status filter** (`status: activeStatus ? [activeStatus] : undefined`). So selecting "Failed" causes every other badge to drop to `0`.
- Even with no filter, counts only reflect the current paginated page (default 50), not the true totals.

The backend has **no count/stats endpoint**, and `/workflows` is genuinely paginated via opaque cursor tokens. Accurate totals therefore require backend work.

### #2 Statestore chip
The header chip (`<span className="chip">statestore <b>…</b></span>`) is static text. The state store is a Dapr component; users should be able to click it to inspect that component.

### #3 Select-all
A select-all control exists only inside the selection bar (`.selbar`), which appears **after** at least one row is selected. There is no always-visible way to select every row in the current view. The first header cell is currently an empty 34px-wide `<th>`.

## Design

### Part A — Per-status counts (backend + frontend)

#### Backend (Go)

**New service method** in `pkg/workflow/service.go`:

```go
type StatsResult struct {
    Counts map[Status]int
    Total  int
}

// Stats scans all instances across the relevant apps, honoring AppID and
// Search but ignoring Status and paging, and tallies a count per status.
func (s *service) Stats(ctx context.Context, q ListQuery) (StatsResult, error)
```

- Add `Stats` to the `Service` interface.
- Implementation mirrors `List`'s scan loop but:
  - Iterates **all** keys per app (page through until the continuation token is empty, or call `Keys` with pageSize `0` which the codebase already uses for "all" in `load()`), rather than stopping at one page.
  - Applies `matches()` semantics for **Search only** (and AppID via the app loop) — never filters by status.
  - Tallies `Counts[ex.Status]++` and `Total++` for every instance that passes the search/app filter.
- Reuses the existing dedup-by-`appID/instanceID` guard so an instance is counted once.

**New HTTP route** in `pkg/server/workflows.go`:

```go
r.Get("/stats", func(w http.ResponseWriter, req *http.Request) {
    svc, _, _, ok := backend.ServiceFor(req.URL.Query().Get("store"))
    if !ok { /* 404 unknown state store */ }
    q := parseListQuery(req)          // reuses appId/search/store; status & page ignored by Stats
    res, err := svc.Stats(req.Context(), q)
    // ErrNoStore -> 503; other err -> 500; else 200
})
```

JSON response shape:

```json
{ "counts": { "Running": 12, "Completed": 340, "Failed": 7, "Terminated": 2, "Suspended": 1 }, "total": 362 }
```

Statuses absent from the store may be omitted from `counts`; the frontend treats a missing key as `0`.

**Performance tradeoff (documented):** computing stats loads every instance's metadata (status is derived from history), so it is heavier than fetching one list page. This is acceptable at local-dev scale. It is a **separate** query from the table list, so the table remains responsive, and it refetches on the same dashboard refresh interval.

#### Frontend

- New hook `useWorkflowStats({ appId, search, store? })` in `web/src/hooks/useWorkflows.ts`:
  - Calls `GET /workflows/stats` with `appId` and `search` query params (**no `status`**).
  - Typed return `WorkflowStats { counts: Partial<Record<WorkflowStatus, number>>; total: number }` (added to `web/src/types/workflow.ts`).
  - Uses `useRefreshInterval` / `refetchMs` like `useWorkflows`.
- In `Workflows.tsx`:
  - Remove the `statusCounts` `useMemo` and the `totalCount = items.length` derivation that feed the badges.
  - Call `useWorkflowStats({ appId: selectedApp || undefined, search: debouncedSearch || undefined })`.
  - Status badges render `stats?.counts[s] ?? 0`; the "All" badge renders `stats?.total ?? 0`.
  - While stats are loading or unavailable, badges fall back to `0` (or the last value React Query holds). The app-filter dropdown still derives its option list from loaded `items` as today.

### Part B — Statestore chip → component link (frontend only)

In `Workflows.tsx`, when an `activeStore` exists, render the chip as a router link instead of a span:

```tsx
{activeStore ? (
  <Link className="chip link" to={`/components/${activeStore.name}`}>
    <span className="led" /> statestore <b>{storeLabel}</b>
  </Link>
) : (
  <span className="chip"><span className="led" /> statestore <b>unknown</b></span>
)}
```

- Highlighting needs no extra work: `ResourceList` already reads the `:name` route param into `selectedName` and applies the `.sel` class to the matching component, opening its detail pane.
- `StateStore.name` is the Dapr component's `metadata.name`, which equals the component name listed by `/components`, so the link target resolves correctly.
- Reuses the existing link-chip styling pattern from `AppDetail.tsx` (`.chip.link`).
- Edge case: if that component is not present in `/components` (not on disk), `ResourceList` falls back to selecting its first item. Acceptable; no special handling.

### Part C — Header select-all checkbox (frontend only)

Replace the empty first header cell:

```tsx
<th style={{ width: 34 }}>
  <span
    className={allSelected ? 'cbx on' : 'cbx'}
    role="checkbox"
    aria-checked={allSelected}
    aria-label="Select all"
    tabIndex={0}
    onClick={toggleAll}
    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAll(e as unknown as React.MouseEvent) } }}
  />
</th>
```

- Bound to the **existing** `allSelected` boolean and `toggleAll()` function — no new selection logic.
- "Current view" = the loaded rows, which is exactly the set `toggleAll()` operates on (`items.map(...)`).
- Checked when every loaded row is selected; unchecked otherwise. (No indeterminate state, to keep it simple.)
- The existing selection-bar checkbox stays unchanged; the header checkbox is the always-visible control. Both call `toggleAll`, so behavior is consistent.

## Testing

**Backend (Go):**
- Unit test for `Stats`: counts ignore an applied status filter; honor app and search filters; `Total` equals the sum of `Counts` values; dedup prevents double counting.

**Frontend:**
- Status badges remain populated (non-zero for other statuses) while a status filter is active — driven by the stats hook, not the filtered list.
- Header chip renders as a link with `to="/components/<name>"`.
- Header checkbox selects all loaded rows on first activation and clears them on second activation.
- Follow existing test patterns/util in the repo.

## Out of Scope

- Pagination redesign / true server-side total list pagination.
- Multi-select status filtering (remains single-status radio behavior).
- Indeterminate (partial) state styling for the header checkbox.
