# Workflow History Order Toggle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persisted, front-end-only toggle on the Workflow Details page that flips the event-history timeline between oldest-first and newest-first.

**Architecture:** `sortHistoryForDisplay()` stays the canonical chronological (ascending) source. A new `orderHistoryForDisplay(history, order)` helper wraps it and returns a full reverse when `order === 'desc'`. `WorkflowDetail.tsx` holds an `order` state initialized from / written to `localStorage` via new `prefs.ts` helpers, renders the timeline from the helper's output, and keeps all derived data (last/newest event) reading the canonical ascending array.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library, CSS custom properties (no CSS-in-JS).

## Global Constraints

- Front-end only: no backend calls, no query params, no change to fetched data.
- "Newest first" is a **full flip** of the displayed list (terminal end event to top, `ExecutionStarted` to bottom, middle reversed).
- Persist the chosen order across loads/visits in `localStorage`.
- Default on first visit (no stored value) is **oldest first** (`asc`).
- Reuse existing patterns: `prefs.ts` keys are dot-namespaced (`devdash.*`); the toggle uses the `.tbtn` + `aria-pressed` pattern from `RefreshControl.tsx`.
- Run all web commands from the `web/` directory.

---

### Task 1: `HistoryOrder` type + `orderHistoryForDisplay` helper

**Files:**
- Modify: `web/src/lib/eventOrder.ts`
- Test: `web/src/lib/eventOrder.test.ts`

**Interfaces:**
- Consumes: existing `sortHistoryForDisplay(history: WorkflowHistoryEvent[]): WorkflowHistoryEvent[]`.
- Produces:
  - `type HistoryOrder = 'asc' | 'desc'`
  - `orderHistoryForDisplay(history: WorkflowHistoryEvent[], order: HistoryOrder): WorkflowHistoryEvent[]` — returns the canonical ascending array for `'asc'`, and a full reverse (new array) for `'desc'`. Never mutates the input.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/eventOrder.test.ts` (the `ev` helper already exists at the top of that file):

```ts
import { sortHistoryForDisplay, orderHistoryForDisplay } from './eventOrder'

describe('orderHistoryForDisplay', () => {
  const input = [
    ev('ExecutionStarted', 0, 0),
    ev('TaskScheduled', 1, 100),
    ev('TaskCompleted', 2, 200),
    ev('ExecutionCompleted', 3, 300),
  ]

  it("'asc' matches sortHistoryForDisplay exactly", () => {
    expect(orderHistoryForDisplay(input, 'asc')).toEqual(sortHistoryForDisplay(input))
  })

  it("'desc' is the full reverse of the ascending order", () => {
    const asc = sortHistoryForDisplay(input)
    const desc = orderHistoryForDisplay(input, 'desc')
    expect(desc.map((e) => e.type)).toEqual([...asc].reverse().map((e) => e.type))
    // full flip: terminal event on top, ExecutionStarted at the bottom
    expect(desc[0].type).toBe('ExecutionCompleted')
    expect(desc[desc.length - 1].type).toBe('ExecutionStarted')
  })

  it('does not mutate the input array', () => {
    const copy = [...input]
    orderHistoryForDisplay(input, 'desc')
    expect(input).toEqual(copy)
  })
})
```

Note: change the existing top-of-file import line from `import { sortHistoryForDisplay } from './eventOrder'` to also import `orderHistoryForDisplay` (as shown above) — do not add a duplicate import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: FAIL — `orderHistoryForDisplay is not a function` (or an import/type error).

- [ ] **Step 3: Implement the helper**

Append to `web/src/lib/eventOrder.ts`:

```ts
export type HistoryOrder = 'asc' | 'desc'

/**
 * Order history for display in the requested direction. `'asc'` returns the
 * canonical chronological order from sortHistoryForDisplay(); `'desc'` returns
 * a full reverse of it (terminal event on top, ExecutionStarted at the bottom).
 * Returns a new array; the input is not mutated.
 */
export function orderHistoryForDisplay(
  history: WorkflowHistoryEvent[],
  order: HistoryOrder,
): WorkflowHistoryEvent[] {
  const ascending = sortHistoryForDisplay(history)
  return order === 'desc' ? [...ascending].reverse() : ascending
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: PASS (all `sortHistoryForDisplay` and `orderHistoryForDisplay` cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/eventOrder.ts web/src/lib/eventOrder.test.ts
git commit -m "feat(workflow): add orderHistoryForDisplay helper for display direction"
```

---

### Task 2: Persist order preference in `prefs.ts`

**Files:**
- Modify: `web/src/lib/prefs.ts`
- Test: `web/src/lib/prefs.test.ts`

**Interfaces:**
- Consumes: `HistoryOrder` from `./eventOrder` (Task 1).
- Produces:
  - `getHistoryOrder(): HistoryOrder` — returns the stored order, or `'asc'` when missing/invalid or when `localStorage` access throws.
  - `setHistoryOrder(order: HistoryOrder): void` — persists the value; swallows `localStorage` errors.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/prefs.test.ts`:

```ts
import { getHistoryOrder, setHistoryOrder } from './prefs'

describe('history order pref', () => {
  it("defaults to 'asc' when nothing is stored", () => {
    expect(getHistoryOrder()).toBe('asc')
  })

  it("falls back to 'asc' for an invalid stored value", () => {
    localStorage.setItem('devdash.workflowHistoryOrder', 'sideways')
    expect(getHistoryOrder()).toBe('asc')
  })

  it('persists the order via setHistoryOrder', () => {
    setHistoryOrder('desc')
    expect(getHistoryOrder()).toBe('desc')
  })
})
```

(The file's top-level `beforeEach(() => localStorage.clear())` already isolates each test.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/prefs.test.ts`
Expected: FAIL — `getHistoryOrder is not a function`.

- [ ] **Step 3: Implement the helpers**

In `web/src/lib/prefs.ts`, add the import at the top (after the existing first line):

```ts
import type { HistoryOrder } from './eventOrder'
```

Then append:

```ts
const HISTORY_ORDER_KEY = 'devdash.workflowHistoryOrder'

export function getHistoryOrder(): HistoryOrder {
  try {
    const v = localStorage.getItem(HISTORY_ORDER_KEY)
    if (v === 'asc' || v === 'desc') return v
  } catch {
    // localStorage may be unavailable (private mode / restricted context)
  }
  return 'asc'
}

export function setHistoryOrder(order: HistoryOrder) {
  try {
    localStorage.setItem(HISTORY_ORDER_KEY, order)
  } catch {
    // ignore persistence failures
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/prefs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/prefs.ts web/src/lib/prefs.test.ts
git commit -m "feat(workflow): persist event-history order preference"
```

---

### Task 3: Wire the toggle into the Workflow Details page

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx`
- Modify: `web/src/styles/theme.css`

**Interfaces:**
- Consumes: `orderHistoryForDisplay`, `HistoryOrder` from `../lib/eventOrder` (Task 1); `getHistoryOrder`, `setHistoryOrder` from `../lib/prefs` (Task 2).
- Produces: no new exports.

- [ ] **Step 1: Update imports**

In `web/src/pages/WorkflowDetail.tsx`, change line 13 from:

```ts
import { sortHistoryForDisplay } from '../lib/eventOrder'
```

to:

```ts
import { sortHistoryForDisplay, orderHistoryForDisplay, type HistoryOrder } from '../lib/eventOrder'
import { getHistoryOrder, setHistoryOrder } from '../lib/prefs'
```

- [ ] **Step 2: Add order state and persistence effect**

In the `WorkflowDetail()` component body, near the other `useState` declarations, add:

```ts
const [order, setOrder] = useState<HistoryOrder>(() => getHistoryOrder())

useEffect(() => {
  setHistoryOrder(order)
}, [order])
```

- [ ] **Step 3: Derive display array and newest event**

Replace the existing block (currently around lines 255–256):

```ts
const history = execution.history ?? []
const orderedHistory = sortHistoryForDisplay(history)
```

with:

```ts
const history = execution.history ?? []
const orderedHistory = sortHistoryForDisplay(history) // canonical ascending — used for derived data
const displayHistory = orderHistoryForDisplay(history, order) // what the timeline renders
const newestEvent =
  orderedHistory.length > 0 ? orderedHistory[orderedHistory.length - 1] : undefined
```

`lastEvent` / `lastEventLabel` (around lines 269–275) keep reading `orderedHistory` — leave them unchanged.

- [ ] **Step 4: Add the toggle button to the heading and render from `displayHistory`**

Replace the "Event history" heading and timeline block (currently around lines 500–521) with:

```tsx
<h2 className="sech">
  Event history{' '}
  <span className="meta">
    {terminal ? `${history.length} events` : 'live — populating as the run progresses'}
  </span>
  {history.length > 0 && (
    <button
      className="tbtn ordbtn"
      data-cy="history-order"
      aria-label={order === 'asc' ? 'Show newest first' : 'Show oldest first'}
      aria-pressed={order === 'desc'}
      onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
    >
      {order === 'asc' ? 'Oldest first' : 'Newest first'}
    </button>
  )}
</h2>

{history.length === 0 ? (
  <p className="hint">No history events.</p>
) : (
  <div className="timeline">
    {displayHistory.map((event, idx) => (
      <EventRow
        key={idx}
        event={event}
        createdAt={execution.createdAt}
        isNewest={event === newestEvent}
        toast={toast}
      />
    ))}
  </div>
)}
```

- [ ] **Step 5: Right-align the toggle in the heading**

In `web/src/styles/theme.css`, directly after the `.sech .meta { ... }` rule (line 151), add:

```css
.sech .ordbtn { margin-left: auto; }
```

- [ ] **Step 6: Typecheck and run the full test suite**

Run: `cd web && npx tsc -b && npx vitest run`
Expected: typecheck passes with no errors; all tests PASS (no regressions).

- [ ] **Step 7: Manual verification in the browser**

Run: `cd web && npm run dev`, open a workflow with history at `/workflows/:appId/:instanceId`, and confirm:
- Default shows oldest-first; button reads "Oldest first".
- Clicking flips to newest-first: terminal end event on top, `ExecutionStarted` at the bottom; button reads "Newest first".
- The reveal/highlight lands on the chronologically newest event in both orders.
- The "last event" label is unchanged when toggling.
- Reload the page — the last-chosen order is retained.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/styles/theme.css
git commit -m "feat(workflow): add oldest/newest order toggle to event history"
```

---

## Notes on testing scope

The ordering logic (full-flip semantics, non-mutation) is covered by unit tests in Task 1, and persistence by Task 2. Task 3 is thin wiring over those tested units; it is verified by typecheck, the existing suite (no regressions), and the manual checks in Step 7 rather than a full page-render test, which would require standing up router + react-query + MSW scaffolding disproportionate to a display toggle.
