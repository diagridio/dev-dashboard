# Event Pair Selection & Auto-Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent, toggleable "selected pair" state to the workflow event timeline: clicking a paired row (or navigating to it via its pair-ID chip) highlights both rows of the pair with a border and expands the acted-on row; clicking the selected row again clears it.

**Architecture:** Selection is a single piece of state in `WorkflowDetail` (`{ pairId, index } | null`). `EventRow` becomes *controlled* for paired rows: its `<details>` `open` is driven by whether it is the active (acted-on) row, its header click drives selection instead of native toggle, and a `pair-selected` class draws a border via the existing `::after` overlay. Unpaired rows keep native uncontrolled behavior. Navigation reuses the existing `hashchange` handler, extended to set selection.

**Tech Stack:** React 19 + TypeScript, Vitest + `@testing-library/react` + `@testing-library/user-event` + MSW (`server.use`), plain CSS (`theme.css`). All frontend, in `web/`.

## Global Constraints

- Run frontend tests from `web/`: `npx vitest run`; typecheck: `npx tsc --noEmit`.
- Single selection: at most one pair selected at a time; selecting another replaces it.
- Only paired rows participate in selection. Unpaired rows keep native `<details>` expand/collapse and never set/clear selection.
- Only the acted-on row expands; its partner is highlighted (border) but stays collapsed until navigated/clicked.
- Deselect (toggle off) happens only when re-clicking the *active* row of the selected pair. Clicking the highlighted-but-inactive partner moves the active row to it (selects+expands it), it does not toggle off.
- Inner controls must not toggle selection: the pair chip `<a>`, the `#` copy-link button (`.evanchor`), and the child-instance link (`.evchildlink`) call `e.stopPropagation()`.
- `EventRow`'s new props (`pairSelected`, `isActive`, `onToggleSelect`) MUST be optional so the existing `EventRow` unit tests in `WorkflowDetail.test.tsx` and `WorkflowDetail.pairing.test.tsx` (which omit them) keep compiling and passing.
- Selection state must survive the asc/desc order toggle and data refetch: it is keyed by canonical index (`pairIndex`/`canonicalIndex` are memoized on history and order-independent).
- Border overlay reuses the inset `::after` geometry established for hover: `left:-8px; right:-8px; top:4px; bottom:-6px; border-radius:10px; z-index:-1; pointer-events:none`.

---

### Task 1: `EventRow` selection/expansion rendering + CSS

Make `EventRow` render paired rows as controlled (selectable + expand-on-active) and draw the selected border, without changing unpaired-row behavior.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (`EventRow`, lines 76-256)
- Modify: `web/src/styles/theme.css` (add `.ev.pair-selected::after` after the `.ev.pair-hover::after` rule, ~line 411; add a selectable-static cursor rule)
- Test: `web/src/pages/WorkflowDetail.pairing.test.tsx` (add a describe block)

**Interfaces:**
- Consumes (from Task 2): `pairSelected?: boolean`, `isActive?: boolean`, `onToggleSelect?: () => void` passed by `WorkflowDetail`.
- Produces: `EventRow` renders `<details open>` when `isActive`, applies `pair-selected` class when `pairSelected`, calls `onToggleSelect()` on header click for paired rows, and stops propagation on inner controls.

- [ ] **Step 1: Write the failing EventRow tests**

Append to `web/src/pages/WorkflowDetail.pairing.test.tsx`. First extend `renderRow` to accept optional extra props, then add the describe block:

```tsx
import { fireEvent } from '@testing-library/react'

function renderRowEx(
  event: WorkflowHistoryEvent,
  pair: Parameters<typeof EventRow>[0]['pair'],
  extra?: Partial<Parameters<typeof EventRow>[0]>,
) {
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
        {...extra}
      />
    </MemoryRouter>,
  )
}

describe('EventRow selection', () => {
  const scheduled: WorkflowHistoryEvent = {
    type: 'TaskScheduled', sequenceId: 1, timestamp: '2026-06-28T10:00:00.100Z', name: 'Charge', input: '{"x":1}',
  }
  const startPair = { pairId: 1, role: 'start' as const, partnerIndex: 4, durationMs: null }

  it('renders the details open when isActive', () => {
    const { container } = renderRowEx(scheduled, startPair, { isActive: true })
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(true)
  })

  it('renders the details closed when not active', () => {
    const { container } = renderRowEx(scheduled, startPair, { isActive: false })
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(false)
  })

  it('adds the pair-selected class to the row when pairSelected', () => {
    const { container } = renderRowEx(scheduled, startPair, { pairSelected: true })
    expect(container.querySelector('.ev')!.className).toContain('pair-selected')
  })

  it('calls onToggleSelect and suppresses native toggle when the summary is clicked', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { isActive: false, onToggleSelect: () => { calls++ } })
    const summary = container.querySelector('details.evd > summary')!
    fireEvent.click(summary)
    expect(calls).toBe(1)
    // Controlled: still closed because state (isActive) did not change in this shallow render.
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(false)
  })

  it('does NOT call onToggleSelect when the pair chip is clicked (stopPropagation)', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { onToggleSelect: () => { calls++ } })
    const chip = container.querySelector('a.pairchip') as HTMLAnchorElement
    fireEvent.click(chip)
    expect(calls).toBe(0)
  })

  it('does NOT call onToggleSelect when the copy-link (#) button is clicked (stopPropagation)', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { onToggleSelect: () => { calls++ } })
    fireEvent.click(container.querySelector('.evanchor') as HTMLElement)
    expect(calls).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.pairing.test.tsx`
Expected: FAIL — `EventRow` has no `pairSelected`/`isActive`/`onToggleSelect` props (TS error) and the details is not controlled / clicks not intercepted.

- [ ] **Step 3: Extend the `EventRow` prop list**

In `web/src/pages/WorkflowDetail.tsx`, update the destructure (lines 76-98) to add the three optional props:

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
  pairSelected,
  isActive,
  onToggleSelect,
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
  pairSelected?: boolean
  isActive?: boolean
  onToggleSelect?: () => void
}) {
```

- [ ] **Step 4: Stop propagation on the pair chip links**

In the `pairChip` IIFE (lines 125-138), add `onClick={(e) => e.stopPropagation()}` to BOTH `<a className="pairchip">` variants (the `role === 'start'` and the end variant), so a chip click navigates without triggering the row's selection toggle. The pending `<span>` variant is left as-is (clicking it may fall through to select the row — acceptable, it has no navigation of its own).

Start variant:
```tsx
      return (
        <a className="pairchip" href={href} aria-label="Jump to result" title="Jump to result" onClick={(e) => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
          #{pair.pairId} ↓
        </a>
      )
```
End variant:
```tsx
    return (
      <a className="pairchip" href={href} aria-label="Jump to scheduled" title="Jump to scheduled" onClick={(e) => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
        #{pair.pairId} ↑{dur ? ` ${dur}` : ''}
      </a>
    )
```

- [ ] **Step 5: Add a `selectable` flag and the header-click handler**

Immediately after `const hasDetails = !!(event.input || event.output)` (line 149), add:

```tsx
  const selectable = !!pair
  const onHeaderClick = (e: React.MouseEvent) => {
    e.preventDefault() // suppress native <details> toggle; selection drives expansion
    onToggleSelect?.()
  }
```

Add the `React` type import if not already present — the file's first import is `import { useState, useEffect, useMemo } from 'react'`; change it to also import the type:
```tsx
import { useState, useEffect, useMemo, type MouseEvent as ReactMouseEvent } from 'react'
```
and use `ReactMouseEvent` instead of `React.MouseEvent` in the handler signature:
```tsx
  const onHeaderClick = (e: ReactMouseEvent) => {
```

- [ ] **Step 6: Make the row container, details, and header controlled**

Update the row container className (line 158) to add the selected class:
```tsx
    <div id={anchorId} className={`ev${isNewest ? ' reveal' : ''}${pairHovered ? ' pair-hover' : ''}${pairSelected ? ' pair-selected' : ''}`}>
```

Replace the opening of the expandable branch (line 168) so paired rows are controlled and intercept the summary click:
```tsx
          <details className="evd" {...(selectable ? { open: !!isActive } : {})}>
            <summary onClick={selectable ? onHeaderClick : undefined}>
```

Add `stopPropagation` to the `#` copy-link button inside the summary (lines 174-184) — keep its existing `preventDefault`/copy behavior:
```tsx
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.preventDefault() // don't toggle the <details>
                  e.stopPropagation() // don't trigger row selection
                  copyAnchorLink()
                }}
              >
                #
              </button>
```

For the static (body-less) branch, make the head selectable. Replace the wrapper + head opening (lines 224-225):
```tsx
          <div className={`evd evstatic${selectable ? ' selectable' : ''}`}>
            <div className="evstatic-head" onClick={selectable ? () => onToggleSelect?.() : undefined}>
```

Add `stopPropagation` to the child-instance link (lines 232-239):
```tsx
                {event.type === 'SubOrchestrationCreated' && event.instanceId && (
                  <Link
                    className="evchildlink"
                    to={`/workflows/${appId}/${event.instanceId}${store ? `?store=${encodeURIComponent(store)}` : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {event.instanceId}
                  </Link>
                )}
```

Add `stopPropagation` to the static branch's `#` copy-link button (lines 242-249):
```tsx
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.stopPropagation() // don't trigger row selection
                  copyAnchorLink()
                }}
              >
                #
              </button>
```

- [ ] **Step 7: Add the selected-border CSS**

In `web/src/styles/theme.css`, immediately AFTER the `.ev.pair-hover::after { ... }` rule (ends ~line 411), add:

```css
.ev.pair-selected::after {
  content: "";
  position: absolute;
  left: -8px;
  right: -8px;
  top: 4px;
  bottom: -6px;
  background: color-mix(in srgb, var(--accent2) 14%, transparent);
  border: 1.5px solid var(--accent2);
  border-radius: 10px;
  z-index: -1;
  pointer-events: none;
}
.evd.evstatic.selectable { cursor: pointer; }
```

(Placed after `.ev.pair-hover::after` so, when a row is both hovered and selected, the selected declarations win on the shared `::after`.)

- [ ] **Step 8: Run the tests to verify they pass**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.pairing.test.tsx && npx tsc --noEmit`
Expected: PASS (new selection tests + existing chip tests) and no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/styles/theme.css web/src/pages/WorkflowDetail.pairing.test.tsx
git commit -m "feat(web): EventRow selectable pairs with controlled expand + selected border

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `WorkflowDetail` selection state + wiring + navigation

Own the selection state, wire it into every row, and make chip navigation select+expand the target.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (`WorkflowDetail`: state, `jumpToHash` effect, render loop; ~lines 262-688)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (add a describe block)

**Interfaces:**
- Consumes: `EventRow`'s `pairSelected`/`isActive`/`onToggleSelect` props (Task 1); `pairIndex`/`canonicalIndex` maps (existing memo); `eventAnchorId` (existing).
- Produces: end-to-end selection behavior in the rendered timeline.

- [ ] **Step 1: Write the failing integration tests**

Append to `web/src/pages/WorkflowDetail.test.tsx` a new describe block (it reuses the file's existing `renderDetail`, `server`, `http`, `HttpResponse`, `userEvent`, `screen`, `waitFor`, `act` imports). The pairing fixture's canonical ascending order is `[ExecutionStarted(ci0), TaskScheduled(ci1), TaskCompleted(ci2), ExecutionCompleted(ci3)]`:

```tsx
describe('WorkflowDetail — pair selection', () => {
  beforeEach(() => {
    server.use(http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])))
  })

  function seedPair() {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z', lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0, output: '"ok"',
          history: [
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', input: '{"amt":5}', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'TaskCompleted', scheduledId: 1, output: '"charged"', timestamp: '2026-06-28T10:00:00.440Z' },
            { sequenceId: 3, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
          ],
        }),
      ),
    )
  }

  function rowByType(container: HTMLElement, type: string): HTMLElement {
    const row = Array.from(container.querySelectorAll('.timeline .ev')).find(
      (el) => el.querySelector('.evtype')?.textContent === type,
    )
    if (!row) throw new Error(`row ${type} not found`)
    return row as HTMLElement
  }

  it('clicking a paired row selects the pair (both highlighted) and expands the clicked row', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    const scheduled = rowByType(container, 'TaskScheduled')
    await userEvent.click(scheduled.querySelector('summary') as HTMLElement)

    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')
    expect((rowByType(container, 'TaskScheduled').querySelector('details') as HTMLDetailsElement).open).toBe(true)
    // partner highlighted but not expanded
    expect((rowByType(container, 'TaskCompleted').querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('clicking the selected row again clears the selection and collapses it', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const summary = () => rowByType(container, 'TaskScheduled').querySelector('summary') as HTMLElement

    await userEvent.click(summary())
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    await userEvent.click(summary())
    expect(rowByType(container, 'TaskScheduled').className).not.toContain('pair-selected')
    expect(rowByType(container, 'TaskCompleted').className).not.toContain('pair-selected')
    expect((rowByType(container, 'TaskScheduled').querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('clicking an unpaired row does not select anything', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    await userEvent.click(rowByType(container, 'ExecutionStarted').querySelector('summary') as HTMLElement)
    expect(container.querySelector('.ev.pair-selected')).toBeNull()
  })

  it('navigating via hash to a paired event selects the pair and expands the target', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    // TaskCompleted is canonical index 2 -> anchor event-2.
    await act(async () => {
      window.location.hash = '#event-2'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    expect((rowByType(container, 'TaskCompleted').querySelector('details') as HTMLDetailsElement).open).toBe(true)

    // reset hash so it doesn't leak into other tests
    await act(async () => { window.location.hash = '' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: FAIL — clicking rows does not add `pair-selected`, and hash navigation does not select.

- [ ] **Step 3: Add selection state**

In `WorkflowDetail`, next to the other `useState` calls (after line 284, `const [hoveredPair, ...]`), add:

```tsx
  const [selection, setSelection] = useState<{ pairId: number; index: number } | null>(null)
```

- [ ] **Step 4: Move the `jumpToHash` effect below the memo and make it set selection**

The `jumpToHash` effect currently sits at lines 292-309, BEFORE the `const { canonicalIndex, pairIndex } = useMemo(...)` block (lines 322-328). It must reference `pairIndex`, and adding `pairIndex` to its dependency array would read it before declaration (temporal dead zone). So MOVE the effect to immediately AFTER the memo block, and extend it:

First, delete the existing effect at lines 292-309.

Then, immediately after the `useMemo` block (after line 328), insert:

```tsx
  // Scroll to and pulse the row referenced by the URL hash (e.g. #event-2), both
  // on mount and on in-page anchor clicks. If the target is part of a pair, also
  // select it (highlight both rows) and mark it active so its body expands.
  useEffect(() => {
    function jumpToHash() {
      const id = window.location.hash.slice(1)
      if (!id) return
      const el = document.getElementById(id)
      if (!el) return
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        // jsdom / unsupported environments: scrolling is non-essential
      }
      el.classList.add('target-pulse')
      window.setTimeout(() => el.classList.remove('target-pulse'), 1500)
      const m = id.match(/^event-(\d+)$/)
      if (m) {
        const idx = Number(m[1])
        const p = pairIndex.get(idx)
        if (p) setSelection({ pairId: p.pairId, index: idx })
      }
    }
    jumpToHash()
    window.addEventListener('hashchange', jumpToHash)
    return () => window.removeEventListener('hashchange', jumpToHash)
  }, [execution, pairIndex])
```

- [ ] **Step 5: Add the toggle handler**

After the `copyWorkflowLink` definition (around line 335), add:

```tsx
  const togglePairSelection = (pairId: number, index: number) =>
    setSelection((cur) => (cur && cur.pairId === pairId && cur.index === index ? null : { pairId, index }))
```

- [ ] **Step 6: Wire selection into the render loop and use stable keys**

Replace the render loop (lines 668-686) so each row receives its selection props, and change the React `key` from the display index to the canonical index (stable per event, so paired rows stay consistently controlled across the asc/desc flip):

```tsx
          {displayHistory.map((event, idx) => {
            const ci = canonicalIndex.get(event) ?? idx
            const pair = pairIndex.get(ci) ?? null
            return (
              <EventRow
                key={ci}
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
                pairSelected={pair !== null && selection !== null && pair.pairId === selection.pairId}
                isActive={selection !== null && selection.index === ci}
                onToggleSelect={pair !== null ? () => togglePairSelection(pair.pairId, ci) : undefined}
              />
            )
          })}
```

- [ ] **Step 7: Run the integration tests to verify they pass**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS (new pair-selection block + all existing WorkflowDetail tests).

- [ ] **Step 8: Run the full suite + typecheck**

Run: `cd <repo-root>/.claude/worktrees/spec+workflow-event-pairing-links/web && npx vitest run && npx tsc --noEmit`
Expected: all tests PASS, no type errors. (If the repo has a build script, also run `npm run build` to confirm the bundle compiles.)

- [ ] **Step 9: Manual verification (written checklist in report; do not launch the app)**

Confirm the intended behavior for the report:
- Clicking a paired row header highlights both rows (border) and expands the clicked one; the partner is highlighted but collapsed.
- Clicking the same row again clears the highlight and collapses.
- Clicking a different pair moves the highlight.
- Clicking a pair chip jumps to, highlights, and expands the target.
- Clicking the child-instance link, the `#` button, or a chip does not toggle selection.
- Unpaired rows still expand/collapse natively and never highlight.
- Selection persists across the Oldest/Newest-first toggle.

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(web): select and auto-expand event pairs in the workflow timeline

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Navigate → target expands + both highlighted → Task 2 Step 4 (`jumpToHash` sets selection) + Task 1 controlled `open`. ✓
- Persistent highlighted border on the selected event regardless of where the header is clicked → Task 1 `pair-selected` class + `::after` border; header-level click handler. ✓
- Corresponding event same highlight → `pairSelected` computed from shared `pairId` (Task 2 Step 6). ✓
- Click selected event again → highlight disappears → `togglePairSelection` toggle (Task 2 Step 5); deselect only on active row is inherent (toggles on matching `{pairId, index}`). ✓
- Selection drives expansion; unpaired rows unchanged; inner controls don't toggle; single selection; order-flip safe → Global Constraints, Task 1 Steps 4/6, Task 2 Step 6 (stable key). ✓
- Testing (EventRow-level + WorkflowDetail integration) → Tasks 1 & 2. ✓

**Placeholder scan:** No TBD/TODO; every code step is complete.

**Type consistency:** `selection: { pairId: number; index: number } | null` is used identically in state, `togglePairSelection`, `jumpToHash`, and the render loop. `pairSelected`/`isActive`/`onToggleSelect` prop names/types match between Task 1's `EventRow` signature and Task 2's call site. `EventRow`'s new props are all optional (existing tests unaffected).

**Ambiguity check:** Deselect applies only to the active row (toggle keyed on `{pairId, index}`); clicking the inactive partner sets a new `{pairId, index}` (moves active) rather than clearing — matches the spec's edge case.
