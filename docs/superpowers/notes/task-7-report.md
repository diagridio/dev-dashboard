# Task 7 — Workflows Overview Restyle Report

## What changed

### `web/src/pages/Workflows.tsx`
Complete restyle to match mock B `#view-overview`. All existing data behaviour (status filter,
search, store, bulk selection + remove, pagination, row navigation) is preserved; only the
markup/classes changed.

Key structural changes:
- Wrapped in `<div className="page">`.
- `.phead` with `<h1>Workflow executions</h1>` + `.sub` ("Across N apps · newest first") and a
  `.ctrlset` containing a `.chip` statestore indicator (store type derived from
  `activeStore.type.split('.').pop()`) plus the page-level `<RefreshControl/>`.
- `.filters` row: `.segs` status group (All / Running / Completed / Failed / Terminated /
  Suspended, each with `.n` count and `aria-pressed`), an app `.select` dropdown ("All apps" +
  unique appIds collected from loaded items), and a `.search` label+input.
- `.card` containing:
  - `.selbar` (shown when `selected.size > 0`) with `.cbx.on` select-all, `.cnt`, `.grow`,
    `.btn.ghost` "Purge via Dapr API", `.btn.danger` "Force delete…".
  - `.tablewrap > table.wf` with columns: ☐, Status, Workflow, Instance ID, App, Created,
    Duration, Last event, ⋯. Selected rows get `tr.sel`. Status uses `<StatusPill>`. Instance ID
    is a `<Link>` for keyboard/accessible navigation. Duration computed from
    `createdAt`/`lastUpdatedAt` (terminal) or `createdAt`/now (live). Last event shows
    `lastUpdatedAt` formatted as a local time string (see concern below).
- `.pager` with "N loaded" range + `.pgbtns` Prev / Next.

### `web/src/components/ConfirmRemoveDialog.tsx`
Restyled as a centred modal. Inner container now uses `className="card"` (removes inline
`background`/`border`/`borderRadius`/`padding` for those properties). Buttons use `.btn.ghost`
(Cancel) and `.btn.danger` (Remove). All logic, props, focus-trap, and Escape-key handler are
unchanged.

### `web/src/pages/Workflows.test.tsx`
Updated queries for new markup. Previous store-select tests (which targeted a store-switcher
dropdown that no longer exists in the UI) replaced by tests covering:
- Statestore chip presence.
- Status filter segment count + default `aria-pressed`.
- Clicking a segment passes status param to API.
- Row selection shows selbar with correct count and buttons.
- Force-delete button opens ConfirmRemoveDialog.
- Pager: Prev disabled on page 0; Next enabled when `nextToken` present; Next disabled when absent.

## Pager → nextToken mapping

The API returns a forward-only `nextToken` in `WorkflowListResult`. The pager maps as follows:
- **Next →**: enabled when `data?.nextToken` is set; clicking sets `page = data.nextToken` and
  increments `pageIndex`.
- **← Prev**: always disabled (API provides no back-token and no cursor history is stored).
- The "N loaded" range is derived by tracking `loadedCount` (cumulative max of items seen), so
  no fake total is shown. The range reads e.g. "1–20 loaded" rather than "1–20 of M".

## Gate results

| Gate | Result |
|---|---|
| `npm test` | 213 passed (38 files) — 5 new tests added |
| `npx tsc -b` | Clean — no errors |

## Concerns / data gaps

1. **Last event column** — `WorkflowSummary` has no `lastEvent` field (only `lastUpdatedAt`).
   The "Last event" cell shows `lastUpdatedAt` as a local time string, which is semantically
   different from the mock's "event type · detail" format. A future enhancement could add a
   `lastEvent: { type, name }` field to `WorkflowSummary`.

2. **Duration (live workflows)** — For non-terminal workflows, duration is computed client-side
   from `createdAt` to `Date.now()`. This is a snapshot at render time, not a live-updating
   counter (the mock's detail view has a live clock but the overview does not).

3. **Pager total count** — The API has no total-count field, so "1–N of M" is impossible.
   Displaying "N loaded" is honest. If a total is added to `WorkflowListResult` later, the pager
   label should be updated.

4. **App filter dropdown** — Populated only from currently loaded page of items (no separate
   `/api/apps` call). Switching pages may reveal new app IDs not in the dropdown. A future
   enhancement could use the `/api/apps` endpoint or an `apps` field from the workflow list
   response.

5. **Store switcher removed from UI** — The original store-select dropdown was removed; the
   active store is now display-only in the `.chip`. If users need to switch stores, they must
   change the `?store=` URL param manually or via another mechanism. This matches the mock, which
   shows a static chip.
