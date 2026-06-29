# Workflow Detail Deeplinks & Anchors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the workflow detail page navigable — deeplink the App ID to its app page, drop App ID from the breadcrumbs, and give event-history rows stable, order-independent anchors that the "Last event" cell deeplinks to.

**Architecture:** All work is in the existing `web/src/pages/WorkflowDetail.tsx` React component plus a small pure helper in `web/src/lib/eventOrder.ts`. Anchors are derived from each event's intrinsic `sequenceId` (with a canonical-index fallback for replay sentinels), so the asc/desc display toggle never changes a row's `id`. A hash-listener effect scrolls the targeted row into view and pulses it.

**Tech Stack:** React 18 + TypeScript, react-router-dom v6, Vitest + @testing-library/react + MSW, plain CSS (`web/src/styles/theme.css`).

## Global Constraints

- App detail route is `apps/:appId` (defined in `web/src/router.tsx`); workflow detail is `workflows/:appId/:instanceId`.
- In-app text links use the existing `celllink` CSS class.
- `sortHistoryForDisplay()` and `orderHistoryForDisplay()` return **new arrays of the same event object references** — object identity is preserved, so a `Map<WorkflowHistoryEvent, number>` keyed by reference is valid.
- Replay/sentinel events carry `sequenceId === -1` (durabletask `OrchestratorStarted`) and are NOT unique by sequenceId.
- Copy actions use the existing `copyText(text)` from `../lib/clipboard` and `toast.show(msg)` from the `useToast()` handle.
- Respect `@media (prefers-reduced-motion: reduce)` — it already disables all animations/transitions globally in `theme.css`, so no extra handling needed for the pulse.

---

### Task 1: `eventAnchorId` helper

A pure function that maps an event to its order-independent DOM id, shared by both the row rendering and the last-event link.

**Files:**
- Modify: `web/src/lib/eventOrder.ts` (append a new exported function)
- Test: `web/src/lib/eventOrder.test.ts` (append cases; create file only if it does not exist)

**Interfaces:**
- Consumes: `WorkflowHistoryEvent` from `../types/workflow` (already imported in `eventOrder.ts`).
- Produces: `export function eventAnchorId(event: WorkflowHistoryEvent, canonicalIndex: number): string`
  - Returns `event-${event.sequenceId}` when `event.sequenceId >= 0`.
  - Returns `event-replay-${canonicalIndex}` when `event.sequenceId < 0`.

- [ ] **Step 1: Write the failing test**

First check whether `web/src/lib/eventOrder.test.ts` exists. If it does, append the `describe` block below; if not, create it with this content:

```ts
import { describe, it, expect } from 'vitest'
import { eventAnchorId } from './eventOrder'
import type { WorkflowHistoryEvent } from '../types/workflow'

function ev(partial: Partial<WorkflowHistoryEvent>): WorkflowHistoryEvent {
  return { type: 'TaskScheduled', sequenceId: 0, timestamp: '2026-06-28T10:00:00Z', ...partial }
}

describe('eventAnchorId', () => {
  it('uses the sequenceId for real events (>= 0)', () => {
    expect(eventAnchorId(ev({ sequenceId: 0 }), 5)).toBe('event-0')
    expect(eventAnchorId(ev({ sequenceId: 7 }), 5)).toBe('event-7')
  })

  it('falls back to the canonical index for replay sentinels (-1)', () => {
    expect(eventAnchorId(ev({ sequenceId: -1 }), 3)).toBe('event-replay-3')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: FAIL — `eventAnchorId is not a function` / no matching export.

- [ ] **Step 3: Add the helper**

Append to `web/src/lib/eventOrder.ts`:

```ts
/**
 * Stable, display-order-independent DOM id for an event row.
 * Real events use their unique sequenceId; replay sentinels (sequenceId -1)
 * fall back to their index in the canonical ascending order.
 */
export function eventAnchorId(event: WorkflowHistoryEvent, canonicalIndex: number): string {
  return event.sequenceId >= 0 ? `event-${event.sequenceId}` : `event-replay-${canonicalIndex}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/eventOrder.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/eventOrder.ts web/src/lib/eventOrder.test.ts
git commit -m "feat(workflow): add eventAnchorId helper for order-independent row ids"
```

---

### Task 2: App ID deeplink + remove App ID from breadcrumbs

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (breadcrumbs block ~298-301; App ID meta cell ~373-376)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (append cases)

**Interfaces:**
- Consumes: `Link` from `react-router-dom` (already imported); `execution.appId`, `execution.instanceId`.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('WorkflowDetail', ...)` block in `web/src/pages/WorkflowDetail.test.tsx`:

```tsx
it('App ID in the metagrid links to the app detail page', async () => {
  server.use(
    http.get('/api/workflows/order/abc', () =>
      HttpResponse.json({
        appId: 'order',
        instanceId: 'abc',
        name: 'OrderWorkflow',
        status: 'Running',
        createdAt: '2026-06-26T10:00:00Z',
        replayCount: 0,
        history: [],
      }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
  const link = screen.getByRole('link', { name: 'order' })
  expect(link).toHaveAttribute('href', '/apps/order')
})

it('breadcrumbs do not contain the appId segment', async () => {
  server.use(
    http.get('/api/workflows/order/abc', () =>
      HttpResponse.json({
        appId: 'order',
        instanceId: 'abc',
        name: 'OrderWorkflow',
        status: 'Running',
        createdAt: '2026-06-26T10:00:00Z',
        replayCount: 0,
        history: [],
      }),
    ),
  )
  const { container } = renderDetail()
  await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
  const crumbs = container.querySelector('.crumbs') as HTMLElement
  // appId 'order' must not appear as a crumb (instanceId 'abc' is the only cur segment)
  expect(crumbs.textContent).not.toContain('order')
  expect((crumbs.querySelector('.cur') as HTMLElement).textContent).toBe('abc')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "App ID in the metagrid links"`
Expected: FAIL — no `link` named "order" (App ID is plain text).
Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "breadcrumbs do not contain"`
Expected: FAIL — crumbs still contain "order".

- [ ] **Step 3: Remove appId from breadcrumbs**

In `web/src/pages/WorkflowDetail.tsx`, replace the breadcrumbs block:

```tsx
      <div className="crumbs">
        <Link to="/workflows">Workflows</Link>
        <span className="sep">/</span>
        <span className="muted">{execution.appId}</span>
        <span className="sep">/</span>
        <span className="cur">{execution.instanceId}</span>
      </div>
```

with:

```tsx
      <div className="crumbs">
        <Link to="/workflows">Workflows</Link>
        <span className="sep">/</span>
        <span className="cur">{execution.instanceId}</span>
      </div>
```

- [ ] **Step 4: Make the App ID cell a link**

In the meta grid, replace the App ID cell:

```tsx
        <div className="m span2">
          <div className="k">App ID</div>
          <div className="v">{execution.appId}</div>
        </div>
```

with:

```tsx
        <div className="m span2">
          <div className="k">App ID</div>
          <div className="v">
            <Link className="celllink" to={`/apps/${execution.appId}`}>
              {execution.appId}
            </Link>
          </div>
        </div>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS for the two new tests. The existing test `renders metagrid with instance ID, app ID...` asserts `getByText('App ID')` (the label) — still passes.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(workflow): deeplink App ID to app page, drop appId from breadcrumbs"
```

---

### Task 3: Event-row anchors (stable id + visible `#` on hover)

Give every `EventRow` a stable `id` and a hover-revealed `#` button that copies a deep link to that row.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (`EventRow` signature + render; parent timeline wiring ~262-266, ~531-541)
- Modify: `web/src/styles/theme.css` (add `.evanchor` styles near the `.ev` rules ~343-380)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (append cases)

**Interfaces:**
- Consumes: `eventAnchorId(event, canonicalIndex)` from `../lib/eventOrder` (Task 1) — add to the existing import line; `copyText`, `toast.show`.
- Produces: `EventRow` now requires an `anchorId: string` prop. Its outer `.ev` div carries `id={anchorId}`. A `.evanchor` button is the last child of both the `<summary>` and the `.evstatic-head`.

- [ ] **Step 1: Write the failing tests**

Append inside `describe('WorkflowDetail', ...)`:

```tsx
it('event rows carry stable sequenceId-based ids (and replay fallback)', async () => {
  seedFullId() // history: seq -1 OrchestratorStarted, 0 ExecutionStarted, 1 TaskScheduled, 2 ExecutionCompleted
  const { container } = renderDetail()
  await screen.findByRole('heading', { name: 'OrderWorkflow' })
  expect(container.querySelector('#event-0')).not.toBeNull()
  expect(container.querySelector('#event-1')).not.toBeNull()
  expect(container.querySelector('#event-2')).not.toBeNull()
  // The OrchestratorStarted sentinel (seq -1) uses the canonical-index fallback.
  expect(container.querySelector('[id^="event-replay-"]')).not.toBeNull()
})
```

And add an `EventRow` unit test inside `describe('EventRow', ...)` (note: `row()` must now pass `anchorId`):

```tsx
it('sets the row id from anchorId and shows a copy-link button', async () => {
  const { container } = render(
    <EventRow
      event={{ type: 'ExecutionCompleted', sequenceId: 2, timestamp: '2026-06-28T10:00:01.000Z', output: '"ok"' }}
      createdAt={createdAt}
      isNewest={false}
      toast={stubToast}
      anchorId="event-2"
    />,
  )
  expect(container.querySelector('#event-2')).not.toBeNull()
  expect(container.querySelector('.evanchor')).not.toBeNull()
})
```

Also update the existing `row()` helper in the `EventRow` describe block so all existing unit tests still compile — change:

```tsx
function row(event: WorkflowHistoryEvent) {
  return render(<EventRow event={event} createdAt={createdAt} isNewest={false} toast={stubToast} />)
}
```

to:

```tsx
function row(event: WorkflowHistoryEvent) {
  return render(
    <EventRow event={event} createdAt={createdAt} isNewest={false} toast={stubToast} anchorId="event-test" />,
  )
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "carry stable"`
Expected: FAIL — no `#event-0` element (rows have no id yet).

- [ ] **Step 3: Update the import**

In `web/src/pages/WorkflowDetail.tsx`, extend the existing eventOrder import:

```tsx
import { sortHistoryForDisplay, orderHistoryForDisplay, eventAnchorId, type HistoryOrder } from '../lib/eventOrder'
```

- [ ] **Step 4: Add `anchorId` to `EventRow` and render id + `#` button**

Change the `EventRow` props signature:

```tsx
export function EventRow({
  event,
  createdAt,
  isNewest,
  toast,
  anchorId,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
  anchorId: string
}) {
```

Add the outer-div `id` — change `<div className={\`ev${isNewest ? ' reveal' : ''}\`}>` to:

```tsx
    <div id={anchorId} className={`ev${isNewest ? ' reveal' : ''}`}>
```

Define a copy-link handler just before the `return` of `EventRow`:

```tsx
  const copyAnchorLink = () => {
    const { origin, pathname } = window.location
    copyText(`${origin}${pathname}#${anchorId}`)
    toast.show('Link copied')
  }
```

Add the `#` button as the LAST child of the `<summary>` (after the `eventIdTag` span):

```tsx
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.preventDefault() // don't toggle the <details>
                  copyAnchorLink()
                }}
              >
                #
              </button>
```

And as the LAST child of the `.evstatic-head` div (after the `eventIdTag` span):

```tsx
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={copyAnchorLink}
              >
                #
              </button>
```

- [ ] **Step 5: Wire anchor ids in the parent timeline**

In `WorkflowDetail`, after `const orderedHistory = sortHistoryForDisplay(history)` (~263), build a reference→canonical-index map:

```tsx
  const canonicalIndex = new Map<WorkflowHistoryEvent, number>()
  orderedHistory.forEach((e, i) => canonicalIndex.set(e, i))
```

Update the timeline render to pass `anchorId`:

```tsx
          {displayHistory.map((event, idx) => (
            <EventRow
              key={idx}
              event={event}
              createdAt={execution.createdAt}
              isNewest={event === newestEvent}
              toast={toast}
              anchorId={eventAnchorId(event, canonicalIndex.get(event) ?? idx)}
            />
          ))}
```

- [ ] **Step 6: Add `.evanchor` styles**

In `web/src/styles/theme.css`, after the `.evtag` rule (~365), add:

```css
.evanchor { margin-left: auto; font-family: var(--mono); font-size: 12px; line-height: 1; color: var(--muted); background: transparent; border: 1px solid transparent; border-radius: 6px; padding: 2px 6px; cursor: pointer; opacity: 0; transition: opacity .12s ease, color .12s ease, border-color .12s ease; }
.ev:hover .evanchor, .evanchor:focus-visible { opacity: 1; }
.evanchor:hover { color: var(--text); border-color: var(--line); }
.evanchor:focus-visible { outline: 2px solid var(--accent2); outline-offset: 2px; }
```

Note: when an `evtag` ("Event ID N") is present it already takes `margin-left: auto`, so it consumes the free space and the `.evanchor` sits immediately to its right. On replay rows (no `evtag`), the `.evanchor`'s own `margin-left: auto` pushes it to the right edge. Both cases render the button at the right.

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS — including updated `EventRow` unit tests and the new id tests.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "feat(workflow): add stable anchors and copy-link buttons to event rows"
```

---

### Task 4: Last-event deeplink + scroll/highlight pulse

Make the "Last event" meta cell a hash link to the newest event's row, and add a hash-listener effect that scrolls the targeted row into view and pulses it.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (last-event cell ~411-416; add hash effect; compute newest anchor id)
- Modify: `web/src/styles/theme.css` (add `.target-pulse` + keyframes near `.ev.reveal` ~379)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (append case)

**Interfaces:**
- Consumes: `eventAnchorId`, `canonicalIndex` (Task 3), `newestEvent`, `lastEventLabel` (existing).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Append inside `describe('WorkflowDetail', ...)`:

```tsx
it('Last event cell links to the newest event row anchor', async () => {
  seedFullId() // newest event is ExecutionCompleted, sequenceId 2
  renderDetail()
  await screen.findByRole('heading', { name: 'OrderWorkflow' })
  const link = screen.getByRole('link', { name: /ExecutionCompleted · Event ID 2/ })
  expect(link).toHaveAttribute('href', '#event-2')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "Last event cell links"`
Expected: FAIL — the last-event label is plain text, not a link.

- [ ] **Step 3: Compute the newest event's anchor id**

In `WorkflowDetail`, after `lastEventLabel` is computed (~285), add:

```tsx
  const lastEventAnchor =
    lastEvent !== undefined ? eventAnchorId(lastEvent, canonicalIndex.get(lastEvent) ?? orderedHistory.length - 1) : undefined
```

(`lastEvent` and `newestEvent` are the same object — both are the last item of `orderedHistory`.)

- [ ] **Step 4: Make the Last event cell a link**

Replace the Last event meta cell:

```tsx
        <div className="m span2">
          <div className="k">Last event</div>
          <div className="v mono">
            {lastEventLabel ?? <span className="faint">awaiting first event…</span>}
          </div>
        </div>
```

with:

```tsx
        <div className="m span2">
          <div className="k">Last event</div>
          <div className="v mono">
            {lastEventLabel && lastEventAnchor ? (
              <a className="celllink" href={`#${lastEventAnchor}`}>
                {lastEventLabel}
              </a>
            ) : (
              <span className="faint">awaiting first event…</span>
            )}
          </div>
        </div>
```

- [ ] **Step 5: Add the scroll + pulse effect**

In `WorkflowDetail`, add this effect alongside the other hooks (after the `useEffect` that persists `order`, ~209). It must be declared before the early `isLoading`/`isError` returns so hook order stays stable:

```tsx
  // Scroll to and pulse the row referenced by the URL hash (e.g. #event-2),
  // both on mount and whenever the hash changes via an in-page anchor click.
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
    }
    jumpToHash()
    window.addEventListener('hashchange', jumpToHash)
    return () => window.removeEventListener('hashchange', jumpToHash)
  }, [execution])
```

(Depending on `execution` re-runs the jump once history has rendered after a load/refetch.)

- [ ] **Step 6: Add `.target-pulse` styles**

In `web/src/styles/theme.css`, after the `.ev.reveal` / `fadein` rules (~379-380), add:

```css
.ev.target-pulse { animation: targetpulse 1.5s ease; }
@keyframes targetpulse {
  0% { background: color-mix(in srgb, var(--accent2) 22%, transparent); }
  100% { background: transparent; }
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS — all WorkflowDetail + EventRow tests green.

- [ ] **Step 8: Full check — lint, types, build, full test run**

Run: `cd web && npm run lint && npx tsc --noEmit && npx vitest run`
Expected: no lint errors, no type errors, all tests pass.

(If `npm run lint`/`tsc` script names differ, check `web/package.json` "scripts" and run the project's equivalent.)

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "feat(workflow): deeplink Last event to its row with scroll-to and pulse"
```

---

## Self-Review Notes

- **Spec coverage:** (1) App ID deeplink → Task 2 Step 4. (2) Remove appId from crumbs → Task 2 Step 3. (3a) order-independent anchor ids → Task 1 + Task 3. (3b) visible `#` on hover → Task 3 Steps 4/6. (3c) Last-event deeplink → Task 4 Steps 3/4. (3d) scroll + highlight pulse → Task 4 Steps 5/6. Testing requirements → covered in each task.
- **Type consistency:** `eventAnchorId(event, canonicalIndex)` signature is identical in Tasks 1, 3, and 4. `EventRow`'s new `anchorId: string` prop is added in Task 3 and the test `row()` helper is updated in the same task so existing unit tests keep compiling.
- **No placeholders:** every code/CSS/test block is concrete.
