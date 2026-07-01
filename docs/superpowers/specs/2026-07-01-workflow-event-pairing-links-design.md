# Workflow Event Pairing Links — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)

## Problem

The workflow event history timeline (`web/src/pages/WorkflowDetail.tsx`) renders each
durabletask history event as a row in chronological order. A single activity produces two
rows that are not adjacent: a start event (`TaskScheduled`) carrying the input, and an end
event (`TaskCompleted` / `TaskFailed`) carrying the output. Under fan-out/fan-in, many start
events fire before any completion arrives, so the matching completion for a given schedule can
be dozens of rows away. Today there is no way to navigate between the two halves of a pair.

## Key finding: the events are reliably linkable

The durabletask protobuf that Dapr Workflow persists (`durabletask-go@v0.12.1`) carries an
explicit back-reference on every completion event to its start event's `EventId`:

| Start event | carries | End event | back-reference field |
|---|---|---|---|
| `TaskScheduled` | its own `EventId` | `TaskCompleted` / `TaskFailed` | `TaskScheduledId` = start `EventId` |
| `TimerCreated` | its own `EventId` | `TimerFired` | `TimerId` = start `EventId` |
| `SubOrchestrationInstanceCreated` | its own `EventId` | `SubOrchestrationInstanceCompleted` / `...Failed` | `TaskScheduledId` = start `EventId` |

This is the same mechanism the runtime uses to match results to pending tasks, so it is exact,
not heuristic. Start events (`TaskScheduled`, `TimerCreated`, `SubOrchestrationInstanceCreated`)
get real sequential `EventId`s (`>= 0`); replay events use the `-1` sentinel. A completion's
back-reference always points at a real start `EventId`, so `completion.scheduledId ==
start.sequenceId` is an unambiguous match.

**Current gap:** `pkg/workflow/decode.go` and the `HistoryEvent` / `WorkflowHistoryEvent`
types keep only `sequenceId` (the `EventId`), `type`, `name`, `input`, `output`. They drop the
back-reference. Surfacing it is the prerequisite for the feature.

## Concept

Display a **shared pair-ID chip** on both rows of a pair. The same number
(`#<startEventId>`) appears on:

- the **start** row with a `↓` arrow — jumps to the completion (result);
- the **end** row with a `↑` arrow plus **elapsed duration** — jumps to the scheduled event.

```
TaskScheduled  ProcessOrder  [ #12 ↓ ]
   ⋮   (other fan-out tasks interleaved)
TaskCompleted  ProcessOrder  [ #12 ↑ 340ms ]
```

Hovering either chip cross-highlights both rows of the pair. Navigation reuses the existing
anchor-jump + `target-pulse` animation. The timeline layout, sorting, and order-flip toggle are
otherwise unchanged.

### Scope: all correlated pairs

- `TaskScheduled` ↔ `TaskCompleted` / `TaskFailed`
- `TimerCreated` ↔ `TimerFired`
- `SubOrchestrationCreated` ↔ `SubOrchestrationInstanceCompleted` / `...Failed`

## Backend changes (`pkg/workflow`)

- **`types.go`** — add to `HistoryEvent`:
  `ScheduledID *int32 \`json:"scheduledId,omitempty"\``. Set only on completion/fired events;
  holds the start event's `EventId`. Pointer type because `0` is a valid `EventId`, so a plain
  `int32` with `omitempty` would incorrectly drop id `0`.
- **`decode.go`** — in the `decodeEvent` type switch, populate `ScheduledID` for each
  completion case:
  - `TaskCompleted` → `GetTaskCompleted().GetTaskScheduledId()`
  - `TaskFailed` → `GetTaskFailed().GetTaskScheduledId()`
  - `TimerFired` → `GetTimerFired().GetTimerId()`
  - `SubOrchestrationInstanceCompleted` → `GetSubOrchestrationInstanceCompleted().GetTaskScheduledId()`
  - `SubOrchestrationInstanceFailed` → `GetSubOrchestrationInstanceFailed().GetTaskScheduledId()`
- **Decode gap to close (in scope):** the current switch decodes
  `SubOrchestrationInstanceCreated` but not its `Completed` / `Failed` counterparts. Those
  cases must be added (with the correct event-type strings) or child-workflow pairs will not
  render at all.

## Frontend changes (`web/src`)

- **`types/workflow.ts`** — add `scheduledId?: number` to `WorkflowHistoryEvent`.
- **New pure helper** `buildPairIndex(sortedEvents)` (in `lib/eventOrder.ts` or a new
  `lib/pairing.ts`): from the canonical ascending-sorted event list, return a map keyed by
  start `EventId` → `{ startAnchor, endAnchor, durationMs }`.
  - `startAnchor` / `endAnchor` are the canonical anchor ids (`event-<index>` by
    ascending-sort position) so they stay stable when the display is flipped newest-first.
  - `durationMs` = `end.timestamp − start.timestamp`.
  - Kept pure and separate so it is independently unit-testable.
- **`WorkflowDetail.tsx` (`EventRow`)** — render the chip from the pair index:
  - Start row (`sequenceId >= 0`, is a start event type): `[ #<id> ↓ ]` linking to
    `endAnchor`.
  - End row (`scheduledId` present): `[ #<scheduledId> ↑ <duration> ]` linking to
    `startAnchor`.
  - Reuse the existing anchor-jump + `target-pulse` behavior for the click.
  - Cross-highlight: put `data-pair="<startId>"` on both rows; a small hovered-pair state
    toggles a highlight class on all rows with the matching `data-pair`.
- **`theme.css`** — a `.pair-chip` style derived from the existing event-ID tag, plus a
  `.pair-hover` row-highlight style.

## Edge cases

- **Still running** (start event with no completion yet): render `[ #<id> ]` muted, no arrow,
  tooltip "awaiting result".
- **Orphan completion** (start event missing from history — should not occur): render the id
  chip un-linked/muted rather than emit a broken anchor.
- **Replay events** (`sequenceId == -1`): no chip; already gated by the existing `>= 0` check.
- **Duplicate matching**: exactly one completion per start id and one start per id, so the map
  is 1:1.

## Testing

- **Frontend** — unit tests for `buildPairIndex` alongside `lib/eventOrder.test.ts`:
  fan-out/fan-in interleaving, missing completion (running), timers, sub-orchestrations, failed
  activities, and stable anchors under order-flip.
- **Backend** — extend the decode test to assert `scheduledId` is populated for
  `TaskCompleted`, `TaskFailed`, `TimerFired`, `SubOrchestrationInstanceCompleted`, and
  `SubOrchestrationInstanceFailed`.

## Out of scope

- No separate graph/DAG/Gantt view; the existing timeline is retained.
- No new visualization libraries.
- No changes to how history is fetched or stored.
