# Workflow Detail Page — Deeplinks & Anchors

**Date:** 2026-06-29
**Status:** Approved design
**File touched:** `web/src/pages/WorkflowDetail.tsx` (+ `WorkflowDetail.test.tsx`, styles)

## Goal

Make the workflow detail page more navigable:

1. The **App ID** in the meta grid deeplinks to the application detail page.
2. The **App ID** is removed from the breadcrumbs (low-value duplication).
3. The **event-history** rows get stable, order-independent anchors, and the
   **Last event** meta-grid value deeplinks to the matching row.

## Context

- Route table (`web/src/router.tsx`): app detail lives at `apps/:appId`; workflow
  detail at `workflows/:appId/:instanceId`.
- Existing in-app link styling uses the `celllink` class (see `Applications.tsx`).
- The event history supports an asc/desc display toggle. `displayHistory` is what
  renders; `orderedHistory` (`sortHistoryForDisplay`) is the canonical ascending
  order used for derived data. The newest event is the last item of `orderedHistory`.
- Replay/sentinel events carry `sequenceId === -1` (durabletask's OrchestratorStarted
  marker) and are therefore not unique by sequenceId.

## Changes

### 1. App ID deeplink (meta grid)

The `App ID` value (currently plain text, `WorkflowDetail.tsx:373-376`) becomes:

```tsx
<Link className="celllink" to={`/apps/${execution.appId}`}>{execution.appId}</Link>
```

`Link` is already imported.

### 2. Remove App ID from breadcrumbs

Drop the `{execution.appId}` segment and its trailing separator from the crumbs
(`WorkflowDetail.tsx:298-299`). Result: `Workflows / {instanceId}`.

### 3. Order-independent anchors + Last-event deeplink

**Anchor id scheme (order-independent by construction).**
An HTML anchor jump targets an element by its `id` wherever it sits in the DOM, so
basing the id on an intrinsic event property (not display position) makes it work
identically under asc and desc ordering.

Helper:

```ts
function eventAnchorId(event: WorkflowHistoryEvent, canonicalIndex: number): string {
  return event.sequenceId >= 0
    ? `event-${event.sequenceId}`
    : `event-replay-${canonicalIndex}`
}
```

- `event-{sequenceId}` for real events (unique, human-meaningful, toggle-independent).
- `event-replay-{canonicalIndex}` for `sequenceId === -1` sentinels, where
  `canonicalIndex` is the index in the canonical ascending `orderedHistory` — also
  independent of the display toggle.

`EventRow` receives its resolved `anchorId` as a prop and sets it as the row's `id`.
The parent computes a map from event → canonical index from `orderedHistory` so each
row (rendered from `displayHistory`) resolves the same id regardless of display order.

**Visible `#` anchor on hover.**
Each row shows a `#` affordance (hidden until row hover) that, on click, copies the
full deep link (`location` origin+path + `#${anchorId}`) and fires a toast
("Link copied"), reusing the existing `copyText` + `toast.show` pattern.

**Last-event deeplink.**
The `Last event` meta-grid value (`WorkflowDetail.tsx:411-416`) becomes a link to
`#${eventAnchorId(newestEvent, …)}`. Keep the existing `lastEventLabel` text as the
link content. When there is no event yet, keep the current "awaiting first event…"
placeholder (no link).

**Scroll + highlight pulse.**
Add a hash effect to `WorkflowDetail`: on mount (if `location.hash` present) and on
hash change, find the element by id, `scrollIntoView({ behavior: 'smooth', block:
'center' })`, and toggle a `target-pulse` class for ~1.5s, then remove it. The
existing `reveal` animation for the live-newest row is unchanged. Add a
`.target-pulse` style (brief background/outline fade) alongside the existing event
styles.

## Testing

Extend `WorkflowDetail.test.tsx`:

- App ID renders as a link with `href="/apps/<appId>"`.
- Breadcrumbs no longer contain the appId text.
- Event rows carry the expected `id` (`event-<sequenceId>`, and the replay fallback).
- The `Last event` value is a link whose `href` ends with the newest event's anchor id.

## Out of scope

- No change to event ordering logic or the asc/desc toggle itself.
- No change to the app detail page.
- No router changes (the `apps/:appId` route already exists).
