# Workflow Detail & List Fixes — Design

**Date:** 2026-06-28
**Status:** Approved

## Context

Six issues were reported across the Workflow Detail page (`web/src/pages/WorkflowDetail.tsx`) and the Workflows list page (`web/src/pages/Workflows.tsx`). Backend list assembly lives in `pkg/workflow/service.go`; history-event decoding lives in `pkg/workflow/decode.go`. Event styling lives in `web/src/styles/theme.css`.

Investigation findings that shaped the design:

- The `#<number>` tag on each event row is `sequenceId`, set directly from the durabletask `HistoryEvent.EventId` (`pkg/workflow/decode.go:66`). For real workflow steps it is a sequential index (0, 1, 2…). `-1` is durabletask's sentinel for `OrchestratorStarted` events — internal orchestrator replay/episode markers with no user-visible payload.
- Event **timing is correct**: each event carries its own real timestamp; relative time = `event.timestamp − createdAt`.
- Event **ordering is durabletask's canonical stored (episode) order**, not timestamp order. `OrchestratorStarted` (EventId -1) is persisted first (`history-000000`) but its timestamp is genuinely ~27ms after `ExecutionStarted` (the logical t=0, equal to `createdAt`). This is why the first row can read `+0.027s` while the second reads `0.000s`.
- `OrchestratorStarted` is the single cause behind three of the reported issues (empty/expandable rows, the `#-1` tag, and the apparent out-of-order first row).
- The list endpoint (`service.List`) loops over app IDs and appends summaries with no dedup, and reuses a single `PageToken` across all apps — the likely cause of the same instance reappearing when loading additional pages. The frontend accumulates pages with no dedup safety net.

## Requirements & Decisions

### 1. Instance ID never truncated in the breadcrumb
**File:** `web/src/pages/WorkflowDetail.tsx`

- Remove the `shortId` slice logic (currently ~lines 234–239) and render the full `execution.instanceId` in the breadcrumb.
- Verify the breadcrumb CSS does not clip the ID (no `text-overflow: ellipsis` / `overflow: hidden` cutting it off). It must display in full, wrapping if ever necessary.
- The full ID in the meta grid (with copy button) is unchanged.

### 2. Vertically center the event row (time · dot · info bar)
**File:** `web/src/styles/theme.css` (`.ev` rules, ~340–347)

- Current layout uses `align-items: start` plus hand-tuned offsets (`.t` `padding-top: 11px`, `.node` `margin-top: 13px`) that only approximate alignment — the source of the slight misalignment.
- Replace with deterministic vertical centering: give the event header (`summary`, and the static header from item 3) a fixed `min-height`, and vertically center the time column (`.t`) and the timeline dot (`.node`) against that same height using flexbox `justify-content: center` rather than magic top offsets.
- The rail connecting line (`.rail::before`) must still span the full row height so the timeline stays continuous; only the dot centers on the header row.
- Outcome: time, colored dot, and info bar sit centered on one row regardless of font metrics.

### 3. Empty events are not expandable
**File:** `web/src/pages/WorkflowDetail.tsx` (`EventRow`, ~125–159)

- When `hasDetails` is false (no `input` and no `output` — e.g. `OrchestratorStarted`), render a **static** header instead of a `<details>` element: no caret, no pointer cursor, no toggle behavior.
- When `hasDetails` is true, keep the existing expandable `<details>`.
- Add a small CSS class for the static, non-interactive header so it visually matches the expandable summary (same padding, border, layout).

### 4. Label the sequence number as "Event ID"
**File:** `web/src/pages/WorkflowDetail.tsx` (~121, 140)

- Change the tag from bare `#${sequenceId}` to a labeled form: `Event ID ${sequenceId}`.
- **Omit the tag entirely when `sequenceId === -1`** (the durabletask sentinel for `OrchestratorStarted`), so `Event ID -1` is never shown. Real events show `Event ID 0`, `Event ID 1`, etc.

### 5. Event ordering / timing — no code change
- Timing and ordering are both correct as implemented: real per-event timestamps, displayed in durabletask's canonical stored (episode) order.
- The `+0.027s`-before-`0.000s` appearance is `OrchestratorStarted` being an episode-boundary marker stored ahead of the `ExecutionStarted` it precedes. Events remain in stored order — no re-sort.
- Items 3 and 4 already de-emphasize the `OrchestratorStarted` row (static, no tag). This section is documented so the behavior is not re-investigated as a bug later.

### 6. De-duplicate workflows by Instance ID
**Backend** — `pkg/workflow/service.go` (`List`, ~48–95):
- Dedup by `(appId, instanceId)` while assembling `items`.
- Fix the shared-pagination-token bug where one `PageToken` is reused across all apps (the likely cause of the same instance reappearing on "load more").

**Frontend** — `web/src/pages/Workflows.tsx`:
- Dedup the accumulated `items` by `appId/instanceId` as a safety net so a duplicate can never render even from a stale page.

## Testing

- Backend: unit test in `pkg/workflow` covering `List` dedup — same `(appId, instanceId)` present across pages/iterations yields a single item; pagination token handling per app.
- Frontend: verify breadcrumb renders a full instance ID without truncation; event rows are vertically centered; `OrchestratorStarted` rows are static (non-expandable) and show no Event ID tag; real events show `Event ID N`; the list shows each instance once.

## Out of Scope

- Re-sorting events by timestamp.
- Any change to how replay count is computed/displayed (already shown separately).
- Unrelated refactoring of the list/detail pages.
