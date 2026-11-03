# Workflow Details — Event History Order Toggle

**Date:** 2026-06-29
**Status:** Approved design

## Summary

Add a control to the Workflow Details page that toggles the event-history
timeline between chronological (oldest first) and reverse-chronological
(newest first) order. This is a front-end-only change: no new backend calls,
no query parameters, and no change to the data fetched from the server.

## Current behavior

- `web/src/pages/WorkflowDetail.tsx` renders a `.timeline` of `EventRow`
  components from `orderedHistory`.
- Ordering is produced by `sortHistoryForDisplay()` in
  `web/src/lib/eventOrder.ts`: `ExecutionStarted` is pinned first, terminal
  `Execution*` events (`ExecutionCompleted`, `ExecutionFailed`,
  `ExecutionTerminated`) are pinned last, and everything in between is
  stable-sorted by timestamp ascending.
- `orderedHistory` is also the source for derived data:
  - `lastEvent` / `lastEventLabel` read `orderedHistory[length - 1]` as the
    chronologically newest event.
  - The `EventRow` reveal animation uses `isNewest={idx === orderedHistory.length - 1}`.
- There is no UI to change ordering today.

## Requirements

1. A toggle on the Workflow Details page flips the timeline between
   oldest-first and newest-first.
2. Front-end only — reuse the already-fetched history; no backend changes.
3. "Newest first" is a **full flip** of the displayed list: the terminal end
   event moves to the top, `ExecutionStarted` moves to the bottom, and the
   middle events are reversed.
4. The chosen order **persists across page loads and visits** via
   `localStorage`.
5. Default order on first visit (no stored preference) is **oldest first**
   (`asc`), matching today's behavior.

## Design

### Canonical vs. display ordering

`sortHistoryForDisplay()` remains unchanged and stays the single source of
chronological truth.

In `WorkflowDetail.tsx`:

- `orderedHistory` (ascending, canonical) continues to feed all derived data
  (`lastEvent`, `lastEventLabel`, newest-event detection).
- A new `displayHistory` is what the timeline maps over:

  ```ts
  const displayHistory = order === 'desc' ? [...orderedHistory].reverse() : orderedHistory
  ```

  `reverse()` operates on a copy so the canonical array is never mutated.
  Because `reverse()` preserves object references, identity comparisons against
  `orderedHistory` still work on the reversed array.

### State and persistence

- Local component state: `order: 'asc' | 'desc'`, default `'asc'`.
- Persistence key: `workflow-history-order` in `localStorage`.
- Read lazily in the `useState` initializer; an invalid or missing value falls
  back to `'asc'`.
- A small `useEffect` writes the value to `localStorage` whenever `order`
  changes.
- Wrap `localStorage` access defensively (it can throw in restricted contexts);
  on failure, behave as if no preference is stored.

### Toggle control

- A `.tbtn` button placed inline in the "Event history" heading row
  (`<h2 className="sech">`), next to the existing event-count `.meta` span.
- Uses `aria-pressed` to reflect state, following the `RefreshControl` button
  pattern.
- Label reflects the current order:
  - `asc` → **"Oldest first"**
  - `desc` → **"Newest first"**
- Clicking toggles `order` between `asc` and `desc`.
- Hidden or disabled when there are no history events (the timeline is not
  rendered in that case).

### Newest-event handling

The reveal animation must always land on the chronologically newest event,
regardless of display direction. Replace the index-based check with an
identity comparison against the canonical array:

```ts
const newestEvent =
  orderedHistory.length > 0 ? orderedHistory[orderedHistory.length - 1] : undefined
// in the map:
isNewest={event === newestEvent}
```

`lastEvent` / `lastEventLabel` are unchanged — they keep reading from
`orderedHistory`.

## Out of scope

- Backend changes, query parameters, or server-side sorting.
- Filtering events by type.
- Changing the pinning rules inside `sortHistoryForDisplay()`.

## Testing

- Unit: a small reverse/display helper (if extracted) — verify `desc` is the
  exact reverse of `asc` and that the canonical array is not mutated.
- Behavioral checks:
  - Default load with no stored preference shows oldest-first.
  - Toggling to newest-first flips the list (terminal event on top,
    `ExecutionStarted` at bottom).
  - Preference persists across reload.
  - The reveal animation highlights the newest event in both orders.
  - `lastEventLabel` continues to show the chronologically newest event in
    both orders.
