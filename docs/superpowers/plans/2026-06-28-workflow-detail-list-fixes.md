# Workflow Detail & List Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix six reported issues on the Workflows list and Workflow Detail pages: duplicate list rows, truncated Instance ID, mis-aligned event rows, expandable empty events, an unlabeled sequence number, and confusing event ordering.

**Architecture:** Pure, presentational logic (event ordering, list dedup) is extracted into small testable modules under `web/src/lib/` and unit-tested with vitest. Display/markup changes live in `WorkflowDetail.tsx` and `Workflows.tsx`. The duplicate root cause is also fixed server-side in `pkg/workflow/service.go`. CSS alignment is fixed in `theme.css`.

**Tech Stack:** React 18 + TypeScript + Vite, vitest + @testing-library/react + MSW for frontend tests; Go with `testify` and a build tag `unit` for backend tests.

## Global Constraints

- Frontend tests run with: `cd web && npx vitest run <path>` (config: `web/vitest.config.ts`, setup: `web/src/test/setup.ts`, globals enabled).
- Backend unit tests require the `unit` build tag: `go test -tags unit ./pkg/workflow/...`.
- API calls are prefixed with `/api` by `fetchJSON` (`web/src/lib/api.ts`), so MSW handlers use paths like `/api/workflows/:appId/:instanceId`.
- The durabletask sentinel `sequenceId === -1` marks `OrchestratorStarted` (replay) events — they are not user-facing event indices.
- Terminal execution event types: `ExecutionCompleted`, `ExecutionFailed`, `ExecutionTerminated`.
- Event-history sort is presentational only; the backend `history` array order is unchanged.
- Commit after every task.

---

## File Structure

- **Create** `web/src/lib/eventOrder.ts` — `sortHistoryForDisplay(history)`; pure.
- **Create** `web/src/lib/eventOrder.test.ts` — unit tests for the sort.
- **Create** `web/src/lib/dedupeWorkflows.ts` — `dedupeWorkflows(items)`; pure.
- **Create** `web/src/lib/dedupeWorkflows.test.ts` — unit tests for dedup.
- **Create** `web/src/pages/WorkflowDetail.test.tsx` — EventRow component tests + a breadcrumb/ordering render test.
- **Modify** `web/src/pages/WorkflowDetail.tsx` — export & restructure `EventRow`, sort history, full Instance ID breadcrumb.
- **Modify** `web/src/pages/Workflows.tsx` — apply `dedupeWorkflows`.
- **Modify** `web/src/styles/theme.css` — vertically center event rows; breadcrumb wrap; static-event header styles.
- **Modify** `pkg/workflow/service.go` — dedup `List` results by `(appID, instanceID)`.
- **Modify** `pkg/workflow/service_test.go` — dedup test.

---

## Task 1: Backend — de-duplicate List results by (appID, instanceID)

Fixes the root cause of the same workflow appearing twice in the list. `List` loops over discovered app IDs and appends every instance with no dedup; if app discovery or key matching yields the same instance twice, it renders twice. Add a `seen` set keyed by `appID + "/" + instanceID`.

**Files:**
- Modify: `pkg/workflow/service.go:64-87` (the assembly loop in `List`)
- Test: `pkg/workflow/service_test.go` (add one test)

**Interfaces:**
- Consumes: existing `service.List(ctx, ListQuery) (ListResult, error)`, `statestore.ParseInstanceID`, `matches`.
- Produces: no signature change; `ListResult.Items` now contains each `(AppID, InstanceID)` at most once.

- [ ] **Step 1: Write the failing test**

Add to `pkg/workflow/service_test.go`:

```go
func TestServiceListDedupesByInstanceID(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	seedWorkflow(t, f, "default", "order", "inst-b", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})

	// App discovery returns "order" twice — without dedup the loop appends each instance twice.
	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order", "order"}, nil })

	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 2, "each instance must appear exactly once")

	seen := map[string]bool{}
	for _, it := range res.Items {
		key := it.AppID + "/" + it.InstanceID
		require.False(t, seen[key], "duplicate item: %s", key)
		seen[key] = true
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -run TestServiceListDedupesByInstanceID ./pkg/workflow/...`
Expected: FAIL — `res.Items` has length 4 (each instance appended twice).

- [ ] **Step 3: Add the dedup set to the assembly loop**

In `pkg/workflow/service.go`, replace the loop block (currently lines 64-87):

```go
	var items []ExecutionSummary
	var next string
	for _, appID := range apps {
		keys, tok, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), q.PageToken, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		if tok != "" {
			next = tok
		}
		for _, k := range keys {
			id, ok := statestore.ParseInstanceID(k)
			if !ok {
				continue
			}
			ex, err := s.load(ctx, appID, id)
			if err != nil {
				continue
			}
			if matches(ex.ExecutionSummary, q) {
				items = append(items, ex.ExecutionSummary)
			}
		}
	}
```

with:

```go
	var items []ExecutionSummary
	seen := make(map[string]struct{})
	var next string
	for _, appID := range apps {
		keys, tok, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), q.PageToken, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		if tok != "" {
			next = tok
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
			if matches(ex.ExecutionSummary, q) {
				items = append(items, ex.ExecutionSummary)
			}
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/workflow/...`
Expected: PASS (new test plus existing `TestServiceListAndFilter`, `TestServiceGetDetail`, etc.).

- [ ] **Step 5: Commit**

```bash
git add pkg/workflow/service.go pkg/workflow/service_test.go
git commit -m "fix(workflow): de-duplicate List results by appID/instanceID"
```

> **Note (out of scope):** `List` reuses one `q.PageToken` across all apps and overwrites `next` per app. This is a separate latent multi-app pagination issue; it does not produce duplicates (the dedup set above covers the reported symptom) and fixing it would change the `NextToken` contract. Left unchanged deliberately.

---

## Task 2: Frontend — de-duplicate workflow list rows (safety net)

Add a pure dedup used by the list page so a duplicate can never render even from a stale or pre-fix API response.

**Files:**
- Create: `web/src/lib/dedupeWorkflows.ts`
- Create: `web/src/lib/dedupeWorkflows.test.ts`
- Modify: `web/src/pages/Workflows.tsx:110` (where `items` is derived)

**Interfaces:**
- Consumes: `WorkflowSummary` from `web/src/types/workflow.ts` (`{ appId, instanceId, name, status, createdAt?, lastUpdatedAt? }`).
- Produces: `dedupeWorkflows(items: WorkflowSummary[]): WorkflowSummary[]` — first occurrence of each `appId/instanceId` wins, input order preserved.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/dedupeWorkflows.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { dedupeWorkflows } from './dedupeWorkflows'
import type { WorkflowSummary } from '../types/workflow'

function wf(appId: string, instanceId: string, name = 'W'): WorkflowSummary {
  return { appId, instanceId, name, status: 'Running' }
}

describe('dedupeWorkflows', () => {
  it('removes duplicate appId/instanceId pairs, keeping the first occurrence', () => {
    const out = dedupeWorkflows([wf('order', 'a'), wf('order', 'b'), wf('order', 'a')])
    expect(out.map((w) => w.instanceId)).toEqual(['a', 'b'])
  })

  it('keeps same instanceId under different appIds', () => {
    const out = dedupeWorkflows([wf('order', 'a'), wf('cart', 'a')])
    expect(out).toHaveLength(2)
  })

  it('preserves input order', () => {
    const out = dedupeWorkflows([wf('order', 'c'), wf('order', 'a'), wf('order', 'c'), wf('order', 'b')])
    expect(out.map((w) => w.instanceId)).toEqual(['c', 'a', 'b'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/dedupeWorkflows.test.ts`
Expected: FAIL — cannot resolve `./dedupeWorkflows`.

- [ ] **Step 3: Implement the pure function**

Create `web/src/lib/dedupeWorkflows.ts`:

```ts
import type { WorkflowSummary } from '../types/workflow'

/**
 * Remove duplicate workflows by appId/instanceId, keeping the first occurrence
 * and preserving input order. A safety net against duplicate rows from the API.
 */
export function dedupeWorkflows(items: WorkflowSummary[]): WorkflowSummary[] {
  const seen = new Set<string>()
  const out: WorkflowSummary[] = []
  for (const wf of items) {
    const key = `${wf.appId}/${wf.instanceId}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(wf)
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/dedupeWorkflows.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire into the list page**

In `web/src/pages/Workflows.tsx`, add the import near the other lib imports (after line 8):

```ts
import { dedupeWorkflows } from '../lib/dedupeWorkflows'
```

Then replace line 110:

```ts
  // Null-safe guard
  const items: WorkflowSummary[] = data?.items ?? []
```

with:

```ts
  // Null-safe guard + de-duplicate by appId/instanceId (safety net against duplicate rows)
  const rawItems: WorkflowSummary[] = data?.items ?? []
  const items = useMemo(() => dedupeWorkflows(rawItems), [rawItems])
```

(`useMemo` is already imported on line 1.)

- [ ] **Step 6: Verify the page still type-checks and tests pass**

Run: `cd web && npx vitest run src/lib/dedupeWorkflows.test.ts && npx tsc -b --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/dedupeWorkflows.ts web/src/lib/dedupeWorkflows.test.ts web/src/pages/Workflows.tsx
git commit -m "fix(web): de-duplicate workflow list rows by appId/instanceId"
```

---

## Task 3: Frontend — sort Event History for display (ExecutionStarted first, terminal last)

Make the timeline read top-to-bottom as a clean run: `ExecutionStarted` first, terminal `Execution*` event last, everything else stable-sorted by timestamp. This also fixes the `+0.027s`-before-`0.000s` inversion (the first `OrchestratorStarted` moves after `ExecutionStarted`).

**Files:**
- Create: `web/src/lib/eventOrder.ts`
- Create: `web/src/lib/eventOrder.test.ts`
- Modify: `web/src/pages/WorkflowDetail.tsx` (import; timeline `.map` at lines 491-498)

**Interfaces:**
- Consumes: `WorkflowHistoryEvent` from `web/src/types/workflow.ts` (`{ sequenceId, timestamp, type, name?, input?, output? }`).
- Produces: `sortHistoryForDisplay(history: WorkflowHistoryEvent[]): WorkflowHistoryEvent[]` — new array, originals untouched.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/eventOrder.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { sortHistoryForDisplay } from './eventOrder'
import type { WorkflowHistoryEvent } from '../types/workflow'

function ev(type: string, sequenceId: number, ms: number): WorkflowHistoryEvent {
  return { type, sequenceId, timestamp: new Date(Date.UTC(2026, 5, 28, 10, 0, 0, ms)).toISOString() }
}

describe('sortHistoryForDisplay', () => {
  it('puts ExecutionStarted first even when OrchestratorStarted has an earlier array position but later timestamp', () => {
    const input = [
      ev('OrchestratorStarted', -1, 27),
      ev('ExecutionStarted', 0, 0),
      ev('TaskScheduled', 1, 100),
      ev('ExecutionCompleted', 2, 1000),
    ]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[0]).toBe('ExecutionStarted')
    expect(out[out.length - 1]).toBe('ExecutionCompleted')
    expect(out).toEqual(['ExecutionStarted', 'OrchestratorStarted', 'TaskScheduled', 'ExecutionCompleted'])
  })

  it('pins a terminal ExecutionFailed last regardless of timestamp jitter', () => {
    const input = [
      ev('ExecutionStarted', 0, 0),
      ev('ExecutionFailed', 5, 50), // earlier ms than a later task, but must still sort last
      ev('TaskCompleted', 4, 80),
    ]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[out.length - 1]).toBe('ExecutionFailed')
  })

  it('keeps original order for events sharing a timestamp (stable)', () => {
    const input = [ev('TaskScheduled', 1, 100), ev('TaskCompleted', 2, 100), ev('TimerCreated', 3, 100)]
    const out = sortHistoryForDisplay(input).map((e) => e.sequenceId)
    expect(out).toEqual([1, 2, 3])
  })

  it('does not mutate the input array', () => {
    const input = [ev('ExecutionCompleted', 2, 1000), ev('ExecutionStarted', 0, 0)]
    const snapshot = input.map((e) => e.type)
    sortHistoryForDisplay(input)
    expect(input.map((e) => e.type)).toEqual(snapshot)
  })

  it('handles a running workflow with no terminal event', () => {
    const input = [ev('OrchestratorStarted', -1, 27), ev('ExecutionStarted', 0, 0), ev('TaskScheduled', 1, 100)]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[0]).toBe('ExecutionStarted')
    expect(out).toEqual(['ExecutionStarted', 'OrchestratorStarted', 'TaskScheduled'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: FAIL — cannot resolve `./eventOrder`.

- [ ] **Step 3: Implement the sort**

Create `web/src/lib/eventOrder.ts`:

```ts
import type { WorkflowHistoryEvent } from '../types/workflow'

const TERMINAL_EXEC_TYPES = new Set(['ExecutionCompleted', 'ExecutionFailed', 'ExecutionTerminated'])

// Pin rank: ExecutionStarted always first (0), terminal Execution* always last (2),
// everything else in the middle (1) ordered by timestamp.
function pinRank(event: WorkflowHistoryEvent): number {
  if (event.type === 'ExecutionStarted') return 0
  if (TERMINAL_EXEC_TYPES.has(event.type)) return 2
  return 1
}

/**
 * Order history for display: ExecutionStarted first, the terminal Execution*
 * event last, and everything between stable-sorted by timestamp ascending.
 * Events with equal or unparseable timestamps keep their original relative order.
 * Returns a new array; the input is not mutated.
 */
export function sortHistoryForDisplay(history: WorkflowHistoryEvent[]): WorkflowHistoryEvent[] {
  return history
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const rankA = pinRank(a.event)
      const rankB = pinRank(b.event)
      if (rankA !== rankB) return rankA - rankB
      const ta = Date.parse(a.event.timestamp)
      const tb = Date.parse(b.event.timestamp)
      const aOk = !Number.isNaN(ta)
      const bOk = !Number.isNaN(tb)
      if (aOk && bOk && ta !== tb) return ta - tb
      return a.index - b.index // stable: preserve original order
    })
    .map((x) => x.event)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire the sort into the timeline**

In `web/src/pages/WorkflowDetail.tsx`, add the import after line 12 (`import { copyText } ...`):

```ts
import { sortHistoryForDisplay } from '../lib/eventOrder'
```

Then change line 231 from:

```ts
  const history = execution.history ?? []
```

to:

```ts
  const history = execution.history ?? []
  const orderedHistory = sortHistoryForDisplay(history)
```

Then replace the timeline map block (lines 490-499):

```tsx
        <div className="timeline">
          {history.map((event, idx) => (
            <EventRow
              key={event.sequenceId}
              event={event}
              createdAt={execution.createdAt}
              isNewest={idx === history.length - 1}
            />
          ))}
        </div>
```

with (note: `key` switched to `idx` because multiple `OrchestratorStarted` events share `sequenceId === -1`):

```tsx
        <div className="timeline">
          {orderedHistory.map((event, idx) => (
            <EventRow
              key={idx}
              event={event}
              createdAt={execution.createdAt}
              isNewest={idx === orderedHistory.length - 1}
            />
          ))}
        </div>
```

Leave all other uses of `history` (the `history.length` counts and `lastEvent`) unchanged — counts are order-independent.

- [ ] **Step 6: Verify build and tests**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts && npx tsc -b --noEmit`
Expected: PASS; no type errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/eventOrder.ts web/src/lib/eventOrder.test.ts web/src/pages/WorkflowDetail.tsx
git commit -m "fix(web): order event history ExecutionStarted-first, terminal-last"
```

---

## Task 4: Frontend — label sequence as "Event ID" and make empty events non-expandable

Render the sequence tag as `Event ID N`, omit it entirely when `sequenceId === -1`, and render events with no input/output as a static (non-expandable, no-caret) header.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (export & restructure `EventRow`, lines 108-162)
- Create: `web/src/pages/WorkflowDetail.test.tsx` (EventRow component tests)
- Modify: `web/src/styles/theme.css` (static-header styles — minimal here; full alignment in Task 6)

**Interfaces:**
- Consumes: `WorkflowHistoryEvent`; existing `relativeTime`, `nodeClass`, `highlightJson`.
- Produces: `export function EventRow({ event, createdAt, isNewest })` — same props, now exported for testing.

- [ ] **Step 1: Write the failing test**

Create `web/src/pages/WorkflowDetail.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EventRow } from './WorkflowDetail'
import type { WorkflowHistoryEvent } from '../types/workflow'

const createdAt = '2026-06-28T10:00:00.000Z'

function row(event: WorkflowHistoryEvent) {
  return render(<EventRow event={event} createdAt={createdAt} isNewest={false} />)
}

describe('EventRow', () => {
  it('labels a real event with output as "Event ID N" and is expandable', () => {
    const { container } = row({
      type: 'ExecutionCompleted',
      sequenceId: 2,
      timestamp: '2026-06-28T10:00:01.000Z',
      output: '"ok"',
    })
    expect(screen.getByText('Event ID 2')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })

  it('renders an empty OrchestratorStarted event as static (no details, no caret, no Event ID)', () => {
    const { container } = row({
      type: 'OrchestratorStarted',
      sequenceId: -1,
      timestamp: '2026-06-28T10:00:00.027Z',
    })
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('.caret')).toBeNull()
    expect(screen.queryByText(/Event ID/)).toBeNull()
    expect(screen.getByText('OrchestratorStarted')).toBeInTheDocument()
  })

  it('shows "Event ID 0" for ExecutionStarted with input (expandable)', () => {
    const { container } = row({
      type: 'ExecutionStarted',
      sequenceId: 0,
      timestamp: createdAt,
      name: 'OrderWorkflow',
      input: '{}',
    })
    expect(screen.getByText('Event ID 0')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: FAIL — `EventRow` is not exported (import error), and once exported the static/label assertions fail against the current markup.

- [ ] **Step 3: Restructure and export EventRow**

In `web/src/pages/WorkflowDetail.tsx`, replace the entire `EventRow` function (lines 108-162) with:

```tsx
export function EventRow({
  event,
  createdAt,
  isNewest,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
}) {
  const relTime = relativeTime(event.timestamp, createdAt)
  const absTime = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''
  const nCls = nodeClass(event.type)

  // sequenceId -1 is durabletask's sentinel for OrchestratorStarted (replay) events —
  // not a user-facing event index, so it gets no Event ID tag.
  const eventIdTag = event.sequenceId >= 0 ? `Event ID ${event.sequenceId}` : null

  const hasDetails = !!(event.input || event.output)

  return (
    <div className={`ev${isNewest ? ' reveal' : ''}`}>
      <div className="t">
        {relTime}
        <span className="abs">{absTime}</span>
      </div>
      <div className="rail">
        <span className={`node ${nCls}`} />
      </div>
      <div className="c">
        {hasDetails ? (
          <details className="evd">
            <summary>
              <span className="caret">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
            </summary>
            <div className="evbody">
              {event.input && (
                <div>
                  <div className="lbl">Input</div>
                  <pre className="json">{highlightJson(event.input)}</pre>
                </div>
              )}
              {event.output && (
                <div>
                  <div className="lbl">Output</div>
                  <pre className="json">{highlightJson(event.output)}</pre>
                </div>
              )}
            </div>
          </details>
        ) : (
          <div className="evd evstatic">
            <div className="evstatic-head">
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Add static-header styles**

In `web/src/styles/theme.css`, immediately after the `.evtag` rule (line 361), add:

```css
.evd.evstatic { cursor: default; }
.evstatic-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; }
```

(These mirror the `details.evd > summary` look minus the caret. Vertical centering against the time/dot is finalized in Task 6.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "fix(web): label event sequence as 'Event ID' and make empty events non-expandable"
```

---

## Task 5: Frontend — render the full Instance ID in the breadcrumb

Remove the ellipsis truncation so the breadcrumb shows the complete Instance ID, and add a render test asserting the full ID and the corrected event ordering.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (remove `shortId`, lines 234-239; breadcrumb line 270)
- Modify: `web/src/styles/theme.css` (`.crumbs` / `.cur` — allow wrap, never clip)
- Modify: `web/src/pages/WorkflowDetail.test.tsx` (add a full-page render test)

**Interfaces:**
- Consumes: `useWorkflow` hook (mocked via MSW at `/api/workflows/:appId/:instanceId`), `EventRow`, `sortHistoryForDisplay` (already wired in Task 3).
- Produces: breadcrumb renders `execution.instanceId` verbatim.

- [ ] **Step 1: Write the failing test**

Append to `web/src/pages/WorkflowDetail.test.tsx`. First add these imports at the top of the file (alongside the existing imports):

```tsx
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { WorkflowDetail } from './WorkflowDetail'
```

Then add this `describe` block at the end of the file:

```tsx
const FULL_ID = 'eec84589-11a4-4b01-831c-dce363fae52d'

function renderDetail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/workflows', element: <div>list</div> },
      { path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> },
    ],
    { initialEntries: [`/workflows/wf-app/${FULL_ID}`], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('WorkflowDetail page', () => {
  function seedExecution() {
    server.use(
      http.get(`/api/workflows/wf-app/${FULL_ID}`, () =>
        HttpResponse.json({
          appId: 'wf-app',
          instanceId: FULL_ID,
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z',
          lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0,
          output: '"ok"',
          history: [
            { sequenceId: -1, type: 'OrchestratorStarted', timestamp: '2026-06-28T10:00:00.027Z' },
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
          ],
        }),
      ),
    )
  }

  it('renders the full Instance ID in the breadcrumb (no ellipsis)', async () => {
    seedExecution()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const cur = container.querySelector('.crumbs .cur') as HTMLElement
    expect(cur.textContent).toBe(FULL_ID)
    expect(cur.textContent).not.toContain('…')
  })

  it('orders the event timeline ExecutionStarted-first, ExecutionCompleted-last', async () => {
    seedExecution()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const types = Array.from(container.querySelectorAll('.timeline .evtype')).map((n) => n.textContent)
    expect(types[0]).toBe('ExecutionStarted')
    expect(types[types.length - 1]).toBe('ExecutionCompleted')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: FAIL — the breadcrumb test sees the truncated `eec84589…fae52d`, so `cur.textContent` does not equal `FULL_ID`.

- [ ] **Step 3: Remove the truncation and render the full ID**

In `web/src/pages/WorkflowDetail.tsx`, delete the `shortId` block (lines 234-239):

```tsx
  // Short instance ID for breadcrumb (first 8 chars + ellipsis + last 4)
  const id = execution.instanceId
  const shortId =
    id.length > 14
      ? `${id.slice(0, 8)}…${id.slice(-4)}`
      : id
```

Then change the breadcrumb (line 270) from:

```tsx
        <span className="cur">{shortId}</span>
```

to:

```tsx
        <span className="cur">{execution.instanceId}</span>
```

- [ ] **Step 4: Ensure the breadcrumb CSS never clips the ID**

In `web/src/styles/theme.css`, replace the `.crumbs` rule (line 140) and the `.cur` rule (line 143):

```css
.crumbs { display: flex; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
```
→
```css
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 7px; font-size: 12.5px; color: var(--muted); margin-bottom: 14px; }
```

```css
.crumbs .cur { color: var(--text); font-family: var(--mono); font-size: 12px; }
```
→
```css
.crumbs .cur { color: var(--text); font-family: var(--mono); font-size: 12px; word-break: break-all; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS (all EventRow tests plus the two new page tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "fix(web): render full Instance ID in workflow breadcrumb"
```

---

## Task 6: Frontend (CSS) — vertically center the event row (time · dot · info bar)

Replace the hand-tuned top offsets with deterministic centering against a fixed header-row height so the time, colored dot, and event header sit on one centered row. Verified visually (CSS is not unit-tested).

**Files:**
- Modify: `web/src/styles/theme.css` (`.ev` rules, lines 339-355; `details.evd > summary` line 357; `.evstatic-head` from Task 4)

**Interfaces:** none (CSS only).

- [ ] **Step 1: Replace the event-row layout rules**

In `web/src/styles/theme.css`, replace lines 339-355 (from `.timeline` through `.ev .c`):

```css
.timeline { position: relative; padding: 6px 0; }
.ev { display: grid; grid-template-columns: 96px 26px 1fr; gap: 0; align-items: start; }
.ev .t { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; padding: 11px 12px 0 0; white-space: nowrap; }
.ev .t .abs { display: block; color: var(--faint); font-size: 10px; margin-top: 2px; }
.ev .rail { position: relative; display: flex; justify-content: center; }
.ev .rail::before { content: ""; position: absolute; top: 0; bottom: -2px; width: 2px; background: var(--line); }
.ev:first-child .rail::before { top: 14px; }
.ev:last-child .rail::before { bottom: auto; height: 14px; }
.ev .node { width: 13px; height: 13px; border-radius: 50%; margin-top: 13px; z-index: 1; border: 2.5px solid var(--surface); }
.n-start { background: var(--accent-bright); }
.n-sched { background: var(--run-fg); }
.n-done { background: var(--ok-bright); }
.n-fail { background: var(--fail-fg); }
.n-timer { background: var(--pend-fg); }
.n-end { background: var(--ok-bright); }
.n-endfail { background: var(--fail-fg); }
.ev .c { padding: 8px 0 14px 4px; }
```

with (introduces `--ev-head` as the shared header-row height; time and dot center against `8px + --ev-head/2`):

```css
.timeline { position: relative; padding: 6px 0; }
.ev { display: grid; grid-template-columns: 96px 26px 1fr; gap: 0; align-items: start; --ev-head: 40px; --ev-head-top: 8px; }
.ev .t { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; padding-top: var(--ev-head-top); padding-right: 12px; min-height: var(--ev-head); box-sizing: content-box; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; white-space: nowrap; }
.ev .t .abs { display: block; color: var(--faint); font-size: 10px; margin-top: 2px; }
.ev .rail { position: relative; display: flex; justify-content: center; }
.ev .rail::before { content: ""; position: absolute; top: 0; bottom: -2px; width: 2px; background: var(--line); }
.ev:first-child .rail::before { top: calc(var(--ev-head-top) + var(--ev-head) / 2); }
.ev:last-child .rail::before { bottom: auto; height: calc(var(--ev-head-top) + var(--ev-head) / 2); }
.ev .node { width: 13px; height: 13px; border-radius: 50%; margin-top: calc(var(--ev-head-top) + (var(--ev-head) - 13px) / 2); z-index: 1; border: 2.5px solid var(--surface); }
.n-start { background: var(--accent-bright); }
.n-sched { background: var(--run-fg); }
.n-done { background: var(--ok-bright); }
.n-fail { background: var(--fail-fg); }
.n-timer { background: var(--pend-fg); }
.n-end { background: var(--ok-bright); }
.n-endfail { background: var(--fail-fg); }
.ev .c { padding: 8px 0 14px 4px; }
```

- [ ] **Step 2: Give the event header a matching fixed height**

In `web/src/styles/theme.css`, replace the `details.evd > summary` rule (line 357):

```css
details.evd > summary { list-style: none; cursor: pointer; padding: 9px 12px; display: flex; align-items: center; gap: 10px; }
```
→
```css
details.evd > summary { list-style: none; cursor: pointer; min-height: var(--ev-head); box-sizing: border-box; padding: 0 12px; display: flex; align-items: center; gap: 10px; }
```

And update the `.evstatic-head` rule added in Task 4 to match:

```css
.evstatic-head { display: flex; align-items: center; gap: 10px; padding: 9px 12px; }
```
→
```css
.evstatic-head { min-height: var(--ev-head); box-sizing: border-box; display: flex; align-items: center; gap: 10px; padding: 0 12px; }
```

- [ ] **Step 3: Build the web app to confirm CSS is valid and bundles**

Run: `cd web && npx vite build`
Expected: build succeeds with no CSS/parse errors.

- [ ] **Step 4: Verify alignment visually**

Run: `cd web && npx vite preview` (or `npm run dev`), open a workflow detail page with a multi-event history, and confirm: for each event row the time (left), the colored dot (center rail), and the event header bar (right) are vertically centered on the same line; the rail line connects dot-center to dot-center; expanded events still look correct. If the dot/time sit slightly high or low, adjust only `--ev-head` (e.g. 38-42px) on the `.ev` rule and re-check.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/theme.css
git commit -m "fix(web): vertically center event-history rows (time, dot, header)"
```

---

## Self-Review

**Spec coverage:**
- #1 Full Instance ID — Task 5. ✓
- #2 Vertical centering — Task 6. ✓
- #3 Empty events non-expandable — Task 4 (static branch). ✓
- #4 Label sequence as "Event ID", hide -1 — Task 4. ✓
- #5 Ordering ExecutionStarted-first / terminal-last — Task 3 (+ integration assert in Task 5). ✓
- #6 De-dup by Instance ID (backend + frontend) — Task 1 (backend) + Task 2 (frontend). ✓

**Type consistency:** `sortHistoryForDisplay(WorkflowHistoryEvent[])`, `dedupeWorkflows(WorkflowSummary[])`, and `EventRow({ event, createdAt, isNewest })` are referenced with identical names/signatures across tasks and tests. Terminal type set is consistent between Task 3 (`eventOrder.ts`) and the spec.

**Placeholder scan:** none — every step includes concrete code or exact commands.
