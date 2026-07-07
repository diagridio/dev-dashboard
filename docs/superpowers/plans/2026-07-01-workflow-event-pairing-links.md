# Workflow Event Pairing Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user navigate between the start and end rows of a paired workflow history event (e.g. `TaskScheduled` ↔ `TaskCompleted`) via a shared, clickable pair-ID chip shown on both rows, with elapsed duration on the end row.

**Architecture:** The durabletask protobuf carries a back-reference on every completion event to its start event's `EventId` (`TaskScheduledId` / `TimerId`). We surface that ID through the backend decode step and the API type, then a pure frontend helper matches starts to ends and drives a chip in the existing timeline. No new libraries; the timeline layout, sorting, and order-flip toggle are untouched.

**Tech Stack:** Go (backend decode, `durabletask-go@v0.12.1`), React 19 + TypeScript (frontend), Vitest (frontend tests), Go `testing` + `testify` (backend tests), plain CSS (`theme.css`).

## Global Constraints

- Backend unit tests use the build tag `//go:build unit`; run them with `go test -tags unit ./pkg/workflow/...`.
- `sequenceId` (durabletask `EventId`) is NOT globally unique across a history: replay/`OrchestratorStarted` events use `-1`, and the per-episode action counter can restart. Only **start-type** events (`TaskScheduled`, `TimerCreated`, `SubOrchestrationCreated`) carry meaningful `EventId >= 0` used as pairing keys; completion events reference them. Matching MUST be done with an open/close pass, not a naive global id→row map.
- DOM anchor ids are `event-<canonicalIndex>` (from `eventAnchorId(i)` in `web/src/lib/eventOrder.ts`), where `canonicalIndex` is the position in the ascending `sortHistoryForDisplay` order — stable across the asc/desc toggle. Pair links target these ids.
- Event-type strings emitted by the backend are the contract between backend and frontend. This plan introduces `"SubOrchestrationCompleted"` and `"SubOrchestrationFailed"` and relies on the existing `"TaskCompleted"`, `"TaskFailed"`, `"TimerFired"`, `"SubOrchestrationCreated"`, `"TaskScheduled"`, `"TimerCreated"`.

---

### Task 1: Backend — surface the pairing back-reference (`scheduledId`)

Adds `ScheduledID` to the decoded history event and populates it for every completion event, including the two sub-orchestration completion events that are currently decoded as `"Unknown"`.

**Files:**
- Modify: `pkg/workflow/types.go` (the `HistoryEvent` struct, around line 45-53)
- Modify: `pkg/workflow/decode.go` (the `decodeEvent` switch, lines 74-132; add a helper)
- Test: `pkg/workflow/decode_test.go` (add one test)

**Interfaces:**
- Produces: `HistoryEvent.ScheduledID *int32` with JSON tag `scheduledId,omitempty`. Non-nil only on completion events (`TaskCompleted`, `TaskFailed`, `TimerFired`, `SubOrchestrationCompleted`, `SubOrchestrationFailed`); holds the start event's `EventId`.
- Produces: event-type strings `"SubOrchestrationCompleted"` and `"SubOrchestrationFailed"` (previously `"Unknown"`).

- [ ] **Step 1: Write the failing test**

Add to `pkg/workflow/decode_test.go`:

```go
func i32(v int32) *int32 { return &v }

func TestDecodeScheduledID(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "A"}}},
		{EventId: 2, Timestamp: now, EventType: &protos.HistoryEvent_TaskCompleted{TaskCompleted: &protos.TaskCompletedEvent{TaskScheduledId: 1, Result: &wrapperspb.StringValue{Value: `"ok"`}}}},
		{EventId: 3, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "B"}}},
		{EventId: 4, Timestamp: now, EventType: &protos.HistoryEvent_TaskFailed{TaskFailed: &protos.TaskFailedEvent{TaskScheduledId: 3}}},
		{EventId: 5, Timestamp: now, EventType: &protos.HistoryEvent_TimerCreated{TimerCreated: &protos.TimerCreatedEvent{}}},
		{EventId: 6, Timestamp: now, EventType: &protos.HistoryEvent_TimerFired{TimerFired: &protos.TimerFiredEvent{TimerId: 5}}},
		{EventId: 7, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCreated{ChildWorkflowInstanceCreated: &protos.ChildWorkflowInstanceCreatedEvent{InstanceId: "c1", Name: "Child"}}},
		{EventId: 8, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCompleted{ChildWorkflowInstanceCompleted: &protos.ChildWorkflowInstanceCompletedEvent{TaskScheduledId: 7, Result: &wrapperspb.StringValue{Value: `"cdone"`}}}},
		{EventId: 9, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceFailed{ChildWorkflowInstanceFailed: &protos.ChildWorkflowInstanceFailedEvent{TaskScheduledId: 7}}},
	}
	ex := DecodeExecution("app", "inst", history, "")

	byType := map[string]HistoryEvent{}
	for _, e := range ex.History {
		byType[e.Type] = e
	}

	require.NotNil(t, byType["TaskCompleted"].ScheduledID)
	require.Equal(t, int32(1), *byType["TaskCompleted"].ScheduledID)
	require.Equal(t, `"ok"`, *byType["TaskCompleted"].Output)

	require.NotNil(t, byType["TaskFailed"].ScheduledID)
	require.Equal(t, int32(3), *byType["TaskFailed"].ScheduledID)

	require.NotNil(t, byType["TimerFired"].ScheduledID)
	require.Equal(t, int32(5), *byType["TimerFired"].ScheduledID)

	require.Equal(t, "SubOrchestrationCompleted", byType["SubOrchestrationCompleted"].Type)
	require.NotNil(t, byType["SubOrchestrationCompleted"].ScheduledID)
	require.Equal(t, int32(7), *byType["SubOrchestrationCompleted"].ScheduledID)
	require.Equal(t, `"cdone"`, *byType["SubOrchestrationCompleted"].Output)

	require.Equal(t, "SubOrchestrationFailed", byType["SubOrchestrationFailed"].Type)
	require.NotNil(t, byType["SubOrchestrationFailed"].ScheduledID)
	require.Equal(t, int32(7), *byType["SubOrchestrationFailed"].ScheduledID)

	// Start events carry no back-reference.
	require.Nil(t, byType["TaskScheduled"].ScheduledID)
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links && go test -tags unit ./pkg/workflow/ -run TestDecodeScheduledID`
Expected: FAIL — compile error `ex.History[…].ScheduledID undefined (type HistoryEvent has no field or method ScheduledID)`.

- [ ] **Step 3: Add the `ScheduledID` field to the type**

In `pkg/workflow/types.go`, change the `HistoryEvent` struct (lines 45-53) to add the field. Pointer type because `0` is a valid `EventId`, so a plain `int32` with `omitempty` would wrongly drop id `0`:

```go
type HistoryEvent struct {
	SequenceID  int32     `json:"sequenceId"`
	Timestamp   time.Time `json:"timestamp"`
	Type        string    `json:"type"`
	Name        string    `json:"name,omitempty"`
	InstanceID  string    `json:"instanceId,omitempty"` // child instance id for SubOrchestrationCreated
	ScheduledID *int32    `json:"scheduledId,omitempty"` // start event's EventId; set on completion/fired events
	Input       *string   `json:"input,omitempty"`
	Output      *string   `json:"output,omitempty"`
}
```

- [ ] **Step 4: Populate `ScheduledID` in `decodeEvent`**

In `pkg/workflow/decode.go`:

First, replace the `TaskCompleted`, `TaskFailed`, and `TimerFired` cases (lines 100-108) and add the two sub-orchestration completion cases immediately after the existing `SubOrchestrationInstanceCreated` case (line 123-127). The final switch region should read:

```go
	case e.GetTaskCompleted() != nil:
		ev.Type = "TaskCompleted"
		c := e.GetTaskCompleted()
		ev.Output = strval(c.GetResult())
		ev.ScheduledID = i32ptr(c.GetTaskScheduledId())
	case e.GetTaskFailed() != nil:
		ev.Type = "TaskFailed"
		ev.ScheduledID = i32ptr(e.GetTaskFailed().GetTaskScheduledId())
	case e.GetTimerCreated() != nil:
		ev.Type = "TimerCreated"
	case e.GetTimerFired() != nil:
		ev.Type = "TimerFired"
		ev.ScheduledID = i32ptr(e.GetTimerFired().GetTimerId())
```

and, next to the existing `SubOrchestrationInstanceCreated` case:

```go
	case e.GetSubOrchestrationInstanceCreated() != nil:
		ev.Type = "SubOrchestrationCreated"
		s := e.GetSubOrchestrationInstanceCreated()
		ev.Name = s.GetName()
		ev.InstanceID = s.GetInstanceId()
	case e.GetSubOrchestrationInstanceCompleted() != nil:
		ev.Type = "SubOrchestrationCompleted"
		c := e.GetSubOrchestrationInstanceCompleted()
		ev.Output = strval(c.GetResult())
		ev.ScheduledID = i32ptr(c.GetTaskScheduledId())
	case e.GetSubOrchestrationInstanceFailed() != nil:
		ev.Type = "SubOrchestrationFailed"
		ev.ScheduledID = i32ptr(e.GetSubOrchestrationInstanceFailed().GetTaskScheduledId())
```

Then add the helper at the bottom of `decode.go`, next to `strval`:

```go
func i32ptr(v int32) *int32 { return &v }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links && go test -tags unit ./pkg/workflow/ -run TestDecodeScheduledID`
Expected: PASS (`ok  ...pkg/workflow`).

- [ ] **Step 6: Run the full package tests to check for regressions**

Run: `go test -tags unit ./pkg/workflow/...`
Expected: PASS. (The golden test in `golden_test.go` may assert on serialized output; if it fails only because `scheduledId` is now present in expected-vs-actual JSON, update its golden fixture to include the new field — do NOT weaken unrelated assertions.)

- [ ] **Step 7: Commit**

```bash
git add pkg/workflow/types.go pkg/workflow/decode.go pkg/workflow/decode_test.go
git commit -m "feat(workflow): decode scheduledId back-reference on completion events

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Frontend — pairing helper + duration formatter + type field

Pure, UI-free logic: the API type gains `scheduledId`, a new `buildPairIndex` matches starts to ends via an open/close pass, and `formatDuration` renders the elapsed time. All independently unit-tested.

**Files:**
- Modify: `web/src/types/workflow.ts` (the `WorkflowHistoryEvent` interface, lines 13-21)
- Create: `web/src/lib/pairing.ts`
- Create: `web/src/lib/pairing.test.ts`
- Modify: `web/src/lib/wallclock.ts` (add `formatDuration`)
- Modify: `web/src/lib/wallclock.test.ts` (add tests for `formatDuration`)

**Interfaces:**
- Consumes: `WorkflowHistoryEvent` (now with `scheduledId?: number`), `eventAnchorId(index: number): string` from `./eventOrder`.
- Produces: `buildPairIndex(ascending: WorkflowHistoryEvent[]): Map<number, PairInfo>` keyed by canonical index (position in the `ascending` array). `PairInfo = { pairId: number; role: 'start' | 'end'; partnerIndex: number | null; durationMs: number | null }`.
- Produces: `formatDuration(ms: number): string`.

- [ ] **Step 1: Write the failing test for `buildPairIndex`**

Create `web/src/lib/pairing.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildPairIndex } from './pairing'
import type { WorkflowHistoryEvent } from '../types/workflow'

function ev(
  type: string,
  sequenceId: number,
  ms: number,
  scheduledId?: number,
): WorkflowHistoryEvent {
  return {
    type,
    sequenceId,
    timestamp: new Date(Date.UTC(2026, 5, 28, 10, 0, 0, ms)).toISOString(),
    ...(scheduledId !== undefined ? { scheduledId } : {}),
  }
}

describe('buildPairIndex', () => {
  it('pairs a scheduled activity with its completion by scheduledId', () => {
    // ascending canonical order: [ExecutionStarted, TaskScheduled#1, TaskCompleted->1]
    const asc = [
      ev('ExecutionStarted', 0, 0),
      ev('TaskScheduled', 1, 100),
      ev('TaskCompleted', 2, 440, 1),
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(1)).toEqual({ pairId: 1, role: 'start', partnerIndex: 2, durationMs: null })
    expect(idx.get(2)).toEqual({ pairId: 1, role: 'end', partnerIndex: 1, durationMs: 340 })
    expect(idx.has(0)).toBe(false) // ExecutionStarted is not part of a pair
  })

  it('pairs across fan-out/fan-in interleaving (completions out of schedule order)', () => {
    const asc = [
      ev('TaskScheduled', 1, 10), // index 0
      ev('TaskScheduled', 2, 20), // index 1
      ev('TaskCompleted', 3, 60, 2), // index 2 -> pairs with index 1
      ev('TaskCompleted', 4, 90, 1), // index 3 -> pairs with index 0
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.partnerIndex).toBe(3)
    expect(idx.get(1)?.partnerIndex).toBe(2)
    expect(idx.get(2)).toMatchObject({ pairId: 2, role: 'end', partnerIndex: 1 })
    expect(idx.get(3)).toMatchObject({ pairId: 1, role: 'end', partnerIndex: 0 })
  })

  it('marks a still-running scheduled activity as an unmatched start', () => {
    const asc = [ev('TaskScheduled', 1, 10)]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)).toEqual({ pairId: 1, role: 'start', partnerIndex: null, durationMs: null })
  })

  it('marks an orphan completion (no matching start) as an unmatched end', () => {
    const asc = [ev('TaskCompleted', 9, 50, 7)]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)).toEqual({ pairId: 7, role: 'end', partnerIndex: null, durationMs: null })
  })

  it('pairs timers via TimerCreated EventId <- TimerFired scheduledId', () => {
    const asc = [
      ev('TimerCreated', 5, 0), // index 0, EventId 5
      ev('TimerFired', 6, 200, 5), // index 1, scheduledId 5
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.role).toBe('start')
    expect(idx.get(0)?.partnerIndex).toBe(1)
    expect(idx.get(1)).toMatchObject({ pairId: 5, role: 'end', partnerIndex: 0, durationMs: 200 })
  })

  it('pairs sub-orchestration create/completed and create/failed', () => {
    const asc = [
      ev('SubOrchestrationCreated', 2, 0), // index 0
      ev('SubOrchestrationCompleted', 3, 500, 2), // index 1
      ev('SubOrchestrationCreated', 4, 10), // index 2
      ev('SubOrchestrationFailed', 5, 800, 4), // index 3
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.partnerIndex).toBe(1)
    expect(idx.get(1)).toMatchObject({ role: 'end', partnerIndex: 0 })
    expect(idx.get(2)?.partnerIndex).toBe(3)
    expect(idx.get(3)).toMatchObject({ role: 'end', partnerIndex: 2 })
  })

  it('ignores start events with the sentinel sequenceId -1', () => {
    const asc = [ev('OrchestratorStarted', -1, 0)]
    const idx = buildPairIndex(asc)
    expect(idx.size).toBe(0)
  })

  it('yields null duration when the completion predates its start (bad clock)', () => {
    const asc = [
      ev('TaskScheduled', 1, 500), // index 0
      ev('TaskCompleted', 2, 100, 1), // index 1, earlier ms
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(1)?.durationMs).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/lib/pairing.test.ts`
Expected: FAIL — `Failed to resolve import "./pairing"` (the module does not exist yet).

- [ ] **Step 3: Add `scheduledId` to the API type**

In `web/src/types/workflow.ts`, update the `WorkflowHistoryEvent` interface (lines 13-21):

```ts
export interface WorkflowHistoryEvent {
  sequenceId: number
  timestamp: string
  type: string
  name?: string
  instanceId?: string
  scheduledId?: number // start event's EventId; present on completion/fired events
  input?: string
  output?: string
}
```

- [ ] **Step 4: Implement `buildPairIndex`**

Create `web/src/lib/pairing.ts`:

```ts
import type { WorkflowHistoryEvent } from '../types/workflow'

const START_TYPES = new Set(['TaskScheduled', 'TimerCreated', 'SubOrchestrationCreated'])
const END_TYPES = new Set([
  'TaskCompleted',
  'TaskFailed',
  'TimerFired',
  'SubOrchestrationCompleted',
  'SubOrchestrationFailed',
])

export type PairRole = 'start' | 'end'

export interface PairInfo {
  /** The shared pairing id: the start event's EventId (sequenceId). */
  pairId: number
  role: PairRole
  /** Canonical index of the counterpart row, or null if unmatched (running / orphan). */
  partnerIndex: number | null
  /** Elapsed ms (end - start); set only on matched 'end' rows, else null. */
  durationMs: number | null
}

/**
 * Match start events (TaskScheduled / TimerCreated / SubOrchestrationCreated) to
 * their completion events by the durabletask back-reference (completion.scheduledId
 * == start.sequenceId). Uses a per-id open/close pass rather than a global id map
 * because sequenceId is not globally unique across replays/episodes: an id is only
 * ever reused after its previous use has completed, so a stack of open starts per id
 * matches each completion to the correct (most recent still-open) start.
 *
 * Input MUST be the canonical ascending order (from sortHistoryForDisplay); the
 * returned map is keyed by each event's index in that array.
 */
export function buildPairIndex(ascending: WorkflowHistoryEvent[]): Map<number, PairInfo> {
  const result = new Map<number, PairInfo>()
  const open = new Map<number, number[]>() // pairId -> stack of open start indices

  ascending.forEach((event, index) => {
    if (START_TYPES.has(event.type) && event.sequenceId >= 0) {
      const stack = open.get(event.sequenceId) ?? []
      stack.push(index)
      open.set(event.sequenceId, stack)
      return
    }
    if (END_TYPES.has(event.type) && event.scheduledId !== undefined) {
      const pairId = event.scheduledId
      const stack = open.get(pairId)
      const startIndex = stack && stack.length > 0 ? stack.pop()! : null
      if (startIndex === null) {
        // Orphan completion: no matching start in this history.
        result.set(index, { pairId, role: 'end', partnerIndex: null, durationMs: null })
        return
      }
      const start = Date.parse(ascending[startIndex].timestamp)
      const end = Date.parse(event.timestamp)
      const durationMs = Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start
      result.set(startIndex, { pairId, role: 'start', partnerIndex: index, durationMs: null })
      result.set(index, { pairId, role: 'end', partnerIndex: startIndex, durationMs })
    }
  })

  // Any start still on a stack never completed -> running / unmatched.
  for (const [pairId, stack] of open) {
    for (const startIndex of stack) {
      result.set(startIndex, { pairId, role: 'start', partnerIndex: null, durationMs: null })
    }
  }

  return result
}
```

- [ ] **Step 5: Run the `buildPairIndex` test to verify it passes**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/lib/pairing.test.ts`
Expected: PASS (all cases green).

- [ ] **Step 6: Write the failing test for `formatDuration`**

Add to `web/src/lib/wallclock.test.ts` (extend the import on line 2 to include `formatDuration`):

```ts
describe('formatDuration', () => {
  it('renders sub-second durations in ms', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(999)).toBe('999ms')
  })
  it('renders seconds with one decimal below 10s and whole seconds below a minute', () => {
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(9900)).toBe('9.9s')
    expect(formatDuration(12000)).toBe('12s')
  })
  it('renders minutes and padded seconds at or above a minute', () => {
    expect(formatDuration(65000)).toBe('1m 05s')
    expect(formatDuration(600000)).toBe('10m 00s')
  })
  it('returns empty string for invalid input', () => {
    expect(formatDuration(NaN)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})
```

Update line 2 to:

```ts
import { elapsed, elapsedTenths, formatOffset, formatDateTime, formatDuration } from './wallclock'
```

- [ ] **Step 7: Run the `formatDuration` test to verify it fails**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/lib/wallclock.test.ts`
Expected: FAIL — `formatDuration is not a function` / import has no such export.

- [ ] **Step 8: Implement `formatDuration`**

Append to `web/src/lib/wallclock.ts`:

```ts
/**
 * Format a millisecond duration compactly: "340ms" (<1s), "1.2s" (<10s),
 * "12s" (<1min), "1m 05s" (>=1min). Returns '' for NaN or negative input.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSecs = ms / 1000
  if (totalSecs < 60) {
    return totalSecs < 10 ? `${totalSecs.toFixed(1)}s` : `${Math.round(totalSecs)}s`
  }
  const m = Math.floor(totalSecs / 60)
  const s = Math.round(totalSecs % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
```

- [ ] **Step 9: Run both frontend lib test files to verify they pass**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/lib/pairing.test.ts src/lib/wallclock.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add web/src/types/workflow.ts web/src/lib/pairing.ts web/src/lib/pairing.test.ts web/src/lib/wallclock.ts web/src/lib/wallclock.test.ts
git commit -m "feat(web): add buildPairIndex and formatDuration helpers

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Frontend — render the pair chip and cross-highlight in the timeline

Wires `buildPairIndex` into `WorkflowDetail`, renders the clickable chip in `EventRow`'s column-4 tag cell, cross-highlights the paired row on hover, and styles it in `theme.css`. Also gives the newly-visible `SubOrchestrationCompleted` event a proper node color.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (`nodeClass`, `EventRow` props + tag cell, the render loop, and one new state)
- Modify: `web/src/styles/theme.css` (add `.pairchip` + `.ev.pair-hover`; extend node-color rules)
- Test: `web/src/pages/WorkflowDetail.pairing.test.tsx` (new component test)

**Interfaces:**
- Consumes: `buildPairIndex`, `PairInfo` from `../lib/pairing`; `eventAnchorId` from `../lib/eventOrder`; `formatDuration` from `../lib/wallclock`.
- Produces: no new exports; behavioral change to the rendered timeline.

- [ ] **Step 1: Write the failing component test**

Create `web/src/pages/WorkflowDetail.pairing.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventRow } from './WorkflowDetail'
import type { WorkflowHistoryEvent } from '../types/workflow'

function renderRow(event: WorkflowHistoryEvent, pair: Parameters<typeof EventRow>[0]['pair']) {
  const noop = () => {}
  return render(
    <MemoryRouter>
      <EventRow
        event={event}
        createdAt={'2026-06-28T10:00:00.000Z'}
        isNewest={false}
        toast={{ show: noop } as never}
        anchorId="event-1"
        appId="app"
        pair={pair}
        pairHovered={false}
        onPairHover={noop}
      />
    </MemoryRouter>,
  )
}

describe('EventRow pair chip', () => {
  it('renders a start chip linking to the completion row', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskScheduled',
      sequenceId: 1,
      timestamp: '2026-06-28T10:00:00.100Z',
      name: 'Charge',
      input: '{"x":1}',
    }
    renderRow(event, { pairId: 1, role: 'start', partnerIndex: 4, durationMs: null })
    const chip = screen.getByRole('link', { name: /jump to result/i })
    expect(chip.getAttribute('href')).toBe('#event-4')
    expect(chip.textContent).toContain('#1')
  })

  it('renders an end chip with duration linking to the scheduled row', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskCompleted',
      sequenceId: 2,
      timestamp: '2026-06-28T10:00:00.440Z',
      scheduledId: 1,
      output: '"ok"',
    }
    renderRow(event, { pairId: 1, role: 'end', partnerIndex: 1, durationMs: 340 })
    const chip = screen.getByRole('link', { name: /jump to scheduled/i })
    expect(chip.getAttribute('href')).toBe('#event-1')
    expect(chip.textContent).toContain('#1')
    expect(chip.textContent).toContain('340ms')
  })

  it('renders a non-linked pending chip for a still-running scheduled activity', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskScheduled',
      sequenceId: 1,
      timestamp: '2026-06-28T10:00:00.100Z',
      name: 'Charge',
    }
    renderRow(event, { pairId: 1, role: 'start', partnerIndex: null, durationMs: null })
    expect(screen.queryByRole('link', { name: /jump to/i })).toBeNull()
    expect(screen.getByText(/#1/)).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.pairing.test.tsx`
Expected: FAIL — `EventRow` does not accept a `pair` / `pairHovered` / `onPairHover` prop, and no pair-chip link is rendered.

- [ ] **Step 3: Extend `nodeClass` for the newly-visible sub-orchestration completion**

In `web/src/pages/WorkflowDetail.tsx`, update `nodeClass` (lines 83-92) so a completed child gets the success color and a failed child the fail color (the `endsWith('Failed')` rule already covers `SubOrchestrationFailed`). Add one line before the final `return`:

```ts
function nodeClass(eventType: string): string {
  if (eventType === 'ExecutionStarted') return 'n-start'
  if (eventType === 'TaskScheduled') return 'n-sched'
  if (eventType === 'TaskCompleted') return 'n-done'
  if (eventType.endsWith('Failed') && !eventType.startsWith('Execution')) return 'n-fail'
  if (eventType.includes('Timer')) return 'n-timer'
  if (eventType === 'SubOrchestrationCompleted') return 'n-done'
  if (eventType === 'ExecutionCompleted') return 'n-end'
  if (eventType === 'ExecutionFailed' || eventType === 'ExecutionTerminated') return 'n-endfail'
  return 'n-start'
}
```

- [ ] **Step 4: Add the imports and extend `EventRow`'s props**

In `web/src/pages/WorkflowDetail.tsx`, add to the import on line 13 and the `formatDuration` import on line 8, plus the pairing import:

```ts
import { elapsed, elapsedTenths, formatOffset, formatDateTime, formatDuration } from '../lib/wallclock'
```
```ts
import { sortHistoryForDisplay, orderHistoryForDisplay, eventAnchorId, type HistoryOrder } from '../lib/eventOrder'
import { buildPairIndex, type PairInfo } from '../lib/pairing'
```

Extend the `EventRow` prop list (the object destructured at lines 98-114) to accept the pairing props:

```tsx
export function EventRow({
  event,
  createdAt,
  isNewest,
  toast,
  anchorId,
  appId,
  store,
  pair,
  pairHovered,
  onPairHover,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
  anchorId: string
  appId: string
  store?: string
  pair?: PairInfo | null
  pairHovered?: boolean
  onPairHover?: (pairId: number | null) => void
}) {
```

- [ ] **Step 5: Render the pair chip and apply the hover class**

Still in `EventRow`: (a) add the `pair-hover` class to the row container, and (b) replace the two `{eventIdTag && <span className="evtag">...}` sites with a shared tag cell that shows the pair chip when the event is paired.

First, just below the existing `eventIdTag` definition (line 121), add a helper element:

```tsx
  const pairChip = (() => {
    if (!pair) return null
    const enter = () => onPairHover?.(pair.pairId)
    const leave = () => onPairHover?.(null)
    if (pair.partnerIndex === null) {
      // Running (start with no completion yet) or orphan completion.
      const arrow = pair.role === 'end' ? ' ↑' : ''
      return (
        <span
          className="pairchip pending"
          title={pair.role === 'start' ? 'Awaiting result' : 'No matching scheduled event'}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          #{pair.pairId}{arrow}
        </span>
      )
    }
    const href = `#${eventAnchorId(pair.partnerIndex)}`
    if (pair.role === 'start') {
      return (
        <a className="pairchip" href={href} title="Jump to result" onMouseEnter={enter} onMouseLeave={leave}>
          #{pair.pairId} ↓
        </a>
      )
    }
    const dur = pair.durationMs !== null ? formatDuration(pair.durationMs) : ''
    return (
      <a className="pairchip" href={href} title="Jump to scheduled" onMouseEnter={enter} onMouseLeave={leave}>
        #{pair.pairId} ↑{dur ? ` ${dur}` : ''}
      </a>
    )
  })()

  // The column-4 tag cell: the pair chip when paired, else the plain Event ID tag.
  const tagCell =
    pairChip !== null ? (
      <span className="evtag">{pairChip}</span>
    ) : eventIdTag ? (
      <span className="evtag">{eventIdTag}</span>
    ) : null
```

Change the row container (line 132) to include the hover class:

```tsx
    <div id={anchorId} className={`ev${isNewest ? ' reveal' : ''}${pairHovered ? ' pair-hover' : ''}`}>
```

In the `<details>` summary branch, replace line 147 (`{eventIdTag && <span className="evtag">{eventIdTag}</span>}`) with:

```tsx
              {tagCell}
```

In the static branch, replace line 215 (`{eventIdTag && <span className="evtag">{eventIdTag}</span>}`) with:

```tsx
              {tagCell}
```

- [ ] **Step 6: Build the pair index in `WorkflowDetail` and pass it to each row**

In `WorkflowDetail`, add hover state near the other `useState` calls (after line 257):

```tsx
  const [hoveredPair, setHoveredPair] = useState<number | null>(null)
```

After the `canonicalIndex` map is built (lines 346-347), build the pair index from the canonical ascending order:

```tsx
  const pairIndex = buildPairIndex(orderedHistory)
```

Update the render loop (lines 643-654) to pass the pairing props. Because `pairIndex` is keyed by canonical index, resolve each row's canonical index once and reuse it for both the anchor and the pair lookup:

```tsx
          {displayHistory.map((event, idx) => {
            const ci = canonicalIndex.get(event) ?? idx
            const pair = pairIndex.get(ci) ?? null
            return (
              <EventRow
                key={idx}
                event={event}
                createdAt={execution.createdAt}
                isNewest={event === newestEvent}
                toast={toast}
                anchorId={eventAnchorId(ci)}
                appId={appId ?? ''}
                store={store}
                pair={pair}
                pairHovered={pair !== null && pair.pairId === hoveredPair}
                onPairHover={setHoveredPair}
              />
            )
          })}
```

- [ ] **Step 7: Add the chip and hover styles**

In `web/src/styles/theme.css`, immediately after the `.evtag` rule (line 392), add:

```css
a.pairchip, span.pairchip {
  font-family: var(--mono); font-size: 10px; color: var(--muted);
  text-decoration: none; border: 1px solid var(--line); border-radius: 6px;
  padding: 1px 6px; display: inline-flex; gap: 5px; align-items: center; white-space: nowrap;
}
a.pairchip { cursor: pointer; }
a.pairchip:hover { color: var(--text); border-color: var(--accent2); }
a.pairchip:focus-visible { outline: 2px solid var(--accent2); outline-offset: 2px; }
span.pairchip.pending { border-style: dashed; color: var(--faint); cursor: default; }
.ev.pair-hover { background: color-mix(in srgb, var(--accent2) 10%, transparent); border-radius: 10px; }
```

- [ ] **Step 8: Run the component test to verify it passes**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.pairing.test.tsx`
Expected: PASS. (If `@testing-library/react` is not installed, the import in Step 1 will fail to resolve; in that case install it with `npm install -D @testing-library/react` and re-run. Check `web/package.json` first — do not add it if an equivalent render utility is already present.)

- [ ] **Step 9: Run the full frontend test + typecheck + build**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS and no type errors. (If the repo has a build script, also run `npm run build` to confirm the production bundle compiles.)

- [ ] **Step 10: Manual verification**

Run the app (per the repo's run instructions), open a workflow with fan-out/fan-in and at least one timer and one sub-orchestration, and confirm:
- Each `TaskScheduled` row shows `#N ↓`; clicking scrolls to and pulses its `TaskCompleted`/`TaskFailed` row.
- Each completion row shows `#N ↑ <duration>`; clicking scrolls back to the scheduled row.
- Hovering a chip highlights both rows of the pair.
- A still-running activity shows a dashed `#N` chip with no link.
- Flipping the Oldest/Newest-first toggle keeps every link working.

- [ ] **Step 11: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.pairing.test.tsx web/src/styles/theme.css
git commit -m "feat(web): pair-ID chips linking scheduled and completion events in the timeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Backend `scheduledId` field + decode for all completion types, incl. the sub-orchestration-completion decode gap → Task 1. ✓
- Frontend `scheduledId` type field → Task 2 Step 3. ✓
- Pure `buildPairIndex` helper with stable canonical anchors → Task 2. ✓
- Shared pair-ID chip on both rows (`↓` on start, `↑` + duration on end) → Task 3 Step 5. ✓
- Elapsed duration on the completion chip → `formatDuration` (Task 2) + rendered in Task 3. ✓
- Hover cross-highlight of both rows → Task 3 Steps 5-6 (`data`-free React state approach). ✓
- Edge cases: running (unmatched start), orphan completion, `-1` sentinel → covered in `buildPairIndex` tests (Task 2) and the pending-chip render test (Task 3). ✓
- Testing (frontend unit for pairing + backend decode) → Tasks 1-3. ✓
- Out of scope (no graph view, no new libs, no fetch/storage change) → respected. ✓

**Placeholder scan:** No TBD/TODO; every code step shows complete code. ✓

**Type consistency:** `PairInfo` shape (`pairId`, `role`, `partnerIndex`, `durationMs`) is identical across `pairing.ts`, its tests, `EventRow` props, and the render loop. `scheduledId` is `*int32`/`number?` on backend/frontend respectively. Event-type strings (`SubOrchestrationCompleted`/`SubOrchestrationFailed`) match between Task 1 (emit), Task 2 (`END_TYPES`), and Task 3 (`nodeClass`). ✓
