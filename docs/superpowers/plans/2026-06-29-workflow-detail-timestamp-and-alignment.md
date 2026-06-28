# Workflow Detail — Timestamps & Row Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add date+offset timestamps to the Workflow detail page's event rows and meta fields, and fix two row-alignment issues (event-name left alignment across caret/non-caret rows; copy-button vertical alignment).

**Architecture:** Two pure formatting helpers (`formatOffset`, `formatDateTime`) are added to the existing `web/src/lib/wallclock.ts` time library and unit-tested there. `web/src/pages/WorkflowDetail.tsx` consumes them in the `EventRow` timestamp column and the meta grid, replacing the local `relativeTime` function and the inline `fmt`/`absTime` logic. The remaining two changes are CSS (plus one small JSX spacer span) in `web/src/styles/theme.css`.

**Tech Stack:** React 18 + TypeScript, Vite, Vitest + Testing Library, plain global CSS with CSS custom properties (no CSS modules/Tailwind).

## Global Constraints

- Date and time use **local time and localization** — `Date.prototype.toLocaleDateString()` / `toLocaleTimeString()`, no hard-coded format.
- Offset format: `+<s>s`, with minutes prefix only when total ≥ 60s and hours prefix only when total ≥ 60m. Seconds always carry **two decimals (hundredths)**. Examples: `+5.60s`, `+6m9.31s`, `+2h30m10.01s`.
- Offset text and date-time text share the **same color, `var(--muted)`**.
- In the event-row timestamp column: **offset is right-aligned** (so s/m/h values line up across rows); **date-time is left-aligned**.
- Styling lives in `web/src/styles/theme.css` only; use existing CSS variables (`--muted`, `--line`, etc.). No new styling library.
- All commands run from `web/` (the package root). Test runner: `npm test` (`vitest run`).

---

## File Structure

- `web/src/lib/wallclock.ts` — **Modify.** Add `formatOffset` and `formatDateTime` exports alongside `elapsed`/`elapsedTenths`.
- `web/src/lib/wallclock.test.ts` — **Modify.** Add unit tests for both new functions.
- `web/src/pages/WorkflowDetail.tsx` — **Modify.** Import the two helpers; remove the local `relativeTime`; restructure the `EventRow` `.t` column; add a hidden caret spacer to the static (non-expandable) row head; redefine meta-grid `fmt` to include the date.
- `web/src/pages/WorkflowDetail.test.tsx` — **Modify.** Extend the `EventRow` tests for the new timestamp markup and the caret spacer.
- `web/src/styles/theme.css` — **Modify.** Widen the event-row timestamp column; restyle `.ev .t` into two aligned lines; add `.caretspace`; fix `.evbody .lblrow`/`.lbl` so the copy button aligns with the label.

---

## Task 1: Add `formatOffset` and `formatDateTime` to wallclock library

**Files:**
- Modify: `web/src/lib/wallclock.ts` (append after `elapsedTenths`, currently ends line 26)
- Test: `web/src/lib/wallclock.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `formatOffset(fromTs: string | undefined, toTs: string | undefined): string` — returns `''` when either input is missing/unparseable; otherwise `+<[Hh][Mm]>S.SSs` per Global Constraints. Negative deltas are clamped to `0` (`+0.00s`).
  - `formatDateTime(ts: string | undefined): string | undefined` — returns `undefined` when `ts` is missing/unparseable; otherwise `` `${d.toLocaleDateString()} - ${d.toLocaleTimeString()}` ``.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/wallclock.test.ts`. Also update the import on line 2 from `import { elapsed, elapsedTenths } from './wallclock'` to include the new functions:

```ts
import { elapsed, elapsedTenths, formatOffset, formatDateTime } from './wallclock'
```

Add these describe blocks at the end of the file:

```ts
describe('formatOffset', () => {
  const created = '2026-06-28T10:00:00.000Z'

  it('returns +0.00s for a zero offset', () => {
    expect(formatOffset(created, created)).toBe('+0.00s')
  })

  it('formats sub-minute offsets as seconds with hundredths', () => {
    expect(formatOffset(created, '2026-06-28T10:00:05.600Z')).toBe('+5.60s')
  })

  it('adds a minutes prefix once the offset reaches 60s', () => {
    expect(formatOffset(created, '2026-06-28T10:06:09.310Z')).toBe('+6m9.31s')
  })

  it('adds hours and minutes prefixes for long offsets', () => {
    expect(formatOffset(created, '2026-06-28T12:30:10.010Z')).toBe('+2h30m10.01s')
  })

  it('clamps negative offsets to +0.00s', () => {
    expect(formatOffset(created, '2026-06-28T09:59:59.000Z')).toBe('+0.00s')
  })

  it('returns empty string when an input is missing or unparseable', () => {
    expect(formatOffset(undefined, created)).toBe('')
    expect(formatOffset(created, undefined)).toBe('')
    expect(formatOffset(created, 'not-a-date')).toBe('')
  })
})

describe('formatDateTime', () => {
  it('returns undefined for missing or unparseable input', () => {
    expect(formatDateTime(undefined)).toBeUndefined()
    expect(formatDateTime('not-a-date')).toBeUndefined()
  })

  it('joins the localized date and time with " - "', () => {
    const ts = '2026-06-28T10:00:05.600Z'
    const d = new Date(ts)
    expect(formatDateTime(ts)).toBe(`${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/lib/wallclock.test.ts`
Expected: FAIL — `formatOffset`/`formatDateTime` are not exported (import error or "is not a function").

- [ ] **Step 3: Implement the two functions**

Append to `web/src/lib/wallclock.ts`:

```ts
/**
 * Format the signed offset between two timestamps as +[Hh][Mm]S.SSs.
 * Minutes appear only at >= 60s, hours only at >= 60m; seconds always carry
 * two decimals. Negative deltas clamp to +0.00s. Returns '' on bad input.
 */
export function formatOffset(fromTs: string | undefined, toTs: string | undefined): string {
  if (!fromTs || !toTs) return ''
  const from = Date.parse(fromTs)
  const to = Date.parse(toTs)
  if (isNaN(from) || isNaN(to)) return ''
  const totalSecs = Math.max(0, to - from) / 1000
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = totalSecs % 60
  let out = '+'
  if (h > 0) out += `${h}h`
  if (h > 0 || m > 0) out += `${m}m`
  out += `${s.toFixed(2)}s`
  return out
}

/** Format a timestamp as localized "date - time", or undefined on bad input. */
export function formatDateTime(ts: string | undefined): string | undefined {
  if (!ts) return undefined
  const d = new Date(ts)
  if (isNaN(d.getTime())) return undefined
  return `${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/lib/wallclock.test.ts`
Expected: PASS — all `formatOffset` and `formatDateTime` cases green, plus the existing `elapsed`/`elapsedTenths` tests.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/wallclock.ts web/src/lib/wallclock.test.ts
git commit -m "feat(web): add formatOffset and formatDateTime time helpers"
```

---

## Task 2: Render offset + localized date-time in the event-row timestamp column

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (import line 8; remove `relativeTime` lines 97-103; `EventRow` lines 120-135)
- Modify: `web/src/styles/theme.css` (`.ev` line 342; `.ev .t` line 343; `.ev .t .abs` line 344)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (`EventRow` describe block, lines 629-664)

**Interfaces:**
- Consumes: `formatOffset`, `formatDateTime` from Task 1.
- Produces: event rows whose `.t` column contains `<span class="off">` (offset, right-aligned) and `<span class="dt">` (date-time, left-aligned).

- [ ] **Step 1: Write the failing test**

Add to the `EventRow` describe block in `web/src/pages/WorkflowDetail.test.tsx` (the block at line 629; `createdAt` is `'2026-06-28T10:00:00.000Z'` from line 621):

```tsx
  it('renders the offset and a localized date-time in the timestamp column', () => {
    const ts = '2026-06-28T10:00:05.600Z'
    const { container } = row({
      type: 'ExecutionCompleted',
      sequenceId: 2,
      timestamp: ts,
      output: '"ok"',
    })
    expect(container.querySelector('.t .off')?.textContent).toBe('+5.60s')
    const d = new Date(ts)
    expect(container.querySelector('.t .dt')?.textContent).toBe(
      `${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`,
    )
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "localized date-time"`
Expected: FAIL — `.t .off` / `.t .dt` do not exist yet (current markup uses `.abs`).

- [ ] **Step 3: Update the import**

In `web/src/pages/WorkflowDetail.tsx` line 8, change:

```tsx
import { elapsed, elapsedTenths } from '../lib/wallclock'
```

to:

```tsx
import { elapsed, elapsedTenths, formatOffset, formatDateTime } from '../lib/wallclock'
```

- [ ] **Step 4: Remove the local `relativeTime` helper**

Delete lines 93-103 in `web/src/pages/WorkflowDetail.tsx` (the comment banner plus the function):

```tsx
// ---------------------------------------------------------------------------
// Relative time from createdAt
// ---------------------------------------------------------------------------

function relativeTime(eventTs: string | undefined, createdAt: string | undefined): string {
  if (!eventTs || !createdAt) return ''
  const delta = Date.parse(eventTs) - Date.parse(createdAt)
  if (isNaN(delta)) return ''
  const secs = delta / 1000
  return `+${secs.toFixed(3)}s`
}
```

- [ ] **Step 5: Restructure the `EventRow` timestamp column**

In `web/src/pages/WorkflowDetail.tsx`, replace lines 120-121:

```tsx
  const relTime = relativeTime(event.timestamp, createdAt)
  const absTime = event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ''
```

with:

```tsx
  const offset = formatOffset(createdAt, event.timestamp)
  const dateTime = formatDateTime(event.timestamp) ?? ''
```

Then replace the `.t` block at lines 132-135:

```tsx
      <div className="t">
        {relTime}
        <span className="abs">{absTime}</span>
      </div>
```

with:

```tsx
      <div className="t">
        <span className="off">{offset}</span>
        <span className="dt">{dateTime}</span>
      </div>
```

- [ ] **Step 6: Update the CSS for the timestamp column**

In `web/src/styles/theme.css`, widen the first grid track so the localized date-time fits on one line. Change line 342:

```css
.ev { display: grid; grid-template-columns: 96px 26px 1fr; gap: 0; align-items: start; --ev-head: 40px; --ev-head-top: 8px; }
```

to:

```css
.ev { display: grid; grid-template-columns: 170px 26px 1fr; gap: 0; align-items: start; --ev-head: 40px; --ev-head-top: 8px; }
```

Replace `.ev .t` (line 343) and `.ev .t .abs` (line 344):

```css
.ev .t { font-family: var(--mono); font-size: 11px; color: var(--muted); text-align: right; padding-top: var(--ev-head-top); padding-right: 12px; min-height: var(--ev-head); box-sizing: content-box; display: flex; flex-direction: column; align-items: flex-end; justify-content: center; white-space: nowrap; }
.ev .t .abs { display: block; color: var(--faint); font-size: 10px; margin-top: 2px; }
```

with:

```css
.ev .t { font-family: var(--mono); font-size: 11px; color: var(--muted); padding-top: var(--ev-head-top); padding-right: 12px; min-height: var(--ev-head); box-sizing: content-box; display: flex; flex-direction: column; align-items: stretch; justify-content: center; white-space: nowrap; }
.ev .t .off { text-align: right; }
.ev .t .dt { text-align: left; color: var(--muted); font-size: 10px; margin-top: 2px; }
```

- [ ] **Step 7: Run the EventRow tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS — including the new offset/date-time test and the existing static/expandable tests.

- [ ] **Step 8: Type-check the build**

Run: `cd web && npx tsc -b`
Expected: no errors (confirms `relativeTime` has no remaining references).

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "feat(web): show offset and localized date-time in workflow event rows"
```

---

## Task 3: Add the date to Created, Ended, and Last updated meta fields

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (meta-grid `fmt`, lines 271-272)

**Interfaces:**
- Consumes: `formatDateTime` from Task 1 (already imported in Task 2).
- Produces: the three meta values render localized `date - time` instead of time-only.

- [ ] **Step 1: Redefine `fmt` to delegate to `formatDateTime`**

In `web/src/pages/WorkflowDetail.tsx`, replace lines 271-272:

```tsx
  const fmt = (ts: string | undefined) =>
    ts ? new Date(ts).toLocaleTimeString() : undefined
```

with:

```tsx
  const fmt = (ts: string | undefined) => formatDateTime(ts)
```

The three call sites (`Created` line ~380, `Ended` line ~386, `Last updated` line ~400) and their `?? <span className="faint">—</span>` fallbacks are unchanged — `formatDateTime` returns `undefined` for empty/invalid input, preserving the em-dash fallback.

- [ ] **Step 2: Run the WorkflowDetail tests to confirm no regression**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS. (Existing tests assert on event labels, not on the meta time strings, so they remain green.)

- [ ] **Step 3: Type-check**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx
git commit -m "feat(web): include date in Created/Ended/Last updated meta fields"
```

---

## Task 4: Left-align event names across caret and non-caret rows

**Problem:** Expandable rows render a `<span class="caret">▸</span>` before the event name inside `<summary>` (flex, `gap: 10px`), so the name is indented by the caret width + gap. Static (non-expandable) rows render `.evstatic-head` with no caret, so their event name sits flush against the left padding and is misaligned. Fix: add an invisible caret-width spacer to the static head so all event names start at the same x.

> A distinct class `caretspace` (not `caret`) is used so the existing assertion `expect(container.querySelector('.caret')).toBeNull()` for static rows (WorkflowDetail.test.tsx line 648) keeps passing.

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (`.evstatic-head`, lines 186-192)
- Modify: `web/src/styles/theme.css` (add `.caretspace` near `.caret`, line 366)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (`EventRow` static test, line 641)

**Interfaces:**
- Consumes: nothing new.
- Produces: static event rows contain a `.caretspace` spacer and still contain no `.caret`.

- [ ] **Step 1: Write the failing test**

Extend the existing static-row test in `web/src/pages/WorkflowDetail.test.tsx` (the `it('renders an empty OrchestratorStarted event as static …')` at line 641). Add these assertions inside that test, after the existing expectations:

```tsx
    // Caret-width spacer keeps the event name aligned with expandable rows,
    // without introducing a real caret.
    expect(container.querySelector('.caretspace')).not.toBeNull()
    expect(container.querySelector('.caret')).toBeNull()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t "static"`
Expected: FAIL — `.caretspace` does not exist yet.

- [ ] **Step 3: Add the spacer span to the static head**

In `web/src/pages/WorkflowDetail.tsx`, replace the static head block (lines 186-192):

```tsx
          <div className="evd evstatic">
            <div className="evstatic-head">
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
            </div>
          </div>
```

with (adds the spacer as the first child, mirroring the caret position in `<summary>`):

```tsx
          <div className="evd evstatic">
            <div className="evstatic-head">
              <span className="caretspace" aria-hidden="true">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
            </div>
          </div>
```

- [ ] **Step 4: Add the `.caretspace` CSS rule**

In `web/src/styles/theme.css`, immediately after the `.caret` rules (lines 366-367):

```css
.caret { color: var(--faint); transition: transform .15s ease; }
details[open] .caret { transform: rotate(90deg); }
```

add:

```css
.caretspace { visibility: hidden; }
```

`.evstatic-head` already uses `display: flex; gap: 10px` (line 365), identical to `summary`, so the hidden `▸` reserves exactly the caret's width and the 10px gap — aligning every event name.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS — the static row now has `.caretspace` and still no `.caret`; all other EventRow tests stay green.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/styles/theme.css
git commit -m "fix(web): left-align event names across caret and non-caret rows"
```

---

## Task 5: Align the copy button with the Input/Output label

**Problem:** Inside an expanded event row, `.evbody .lbl` carries `margin-bottom: 5px` while the sibling `.copybtn` does not. With `.lblrow { align-items: center }`, the row centers on the label's taller (margin-inclusive) box, pushing the button down — too close to the `pre.json`. Fix: move the 5px gap from the label to the row, so the label and button share one centered baseline and the gap separates the whole row from the `pre`.

> CSS-only change; there is no unit test for visual spacing in this repo. Verification is: existing tests still pass, the build type-checks, and a visual check in the running app.

**Files:**
- Modify: `web/src/styles/theme.css` (`.evbody .lbl` line 369; `.evbody .lblrow` line 371)

**Interfaces:**
- Consumes: nothing.
- Produces: copy button vertically centered on the label; 5px gap below the row before the `pre.json`.

- [ ] **Step 1: Move the bottom margin from the label to the row**

In `web/src/styles/theme.css`, change line 369:

```css
.evbody .lbl { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); margin-bottom: 5px; }
```

to (drop `margin-bottom`):

```css
.evbody .lbl { font-family: var(--mono); font-size: 10px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
```

and change line 371:

```css
.evbody .lblrow { display: flex; align-items: center; gap: 8px; }
```

to (add `margin-bottom: 5px`):

```css
.evbody .lblrow { display: flex; align-items: center; gap: 8px; margin-bottom: 5px; }
```

- [ ] **Step 2: Run the full web test suite (no regression)**

Run: `cd web && npm test`
Expected: PASS — full suite green.

- [ ] **Step 3: Type-check / build**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 4: Visual verification**

Run: `cd web && npm run dev`, open a workflow detail page, expand an event row with Input/Output, and confirm:
- The `⧉ Copy` button is vertically centered with the `INPUT` / `OUTPUT` label.
- There is a small gap between the label/button row and the `pre.json` block (button no longer touches it).

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/theme.css
git commit -m "fix(web): align event-row copy button with its Input/Output label"
```

---

## Self-Review

**1. Spec coverage:**
- Requirement 1 (event rows show offset + date-time, offset right-aligned, date-time left-aligned, both `--muted`, localized) → Tasks 1 & 2.
- Requirement 2 (date added to Created/Ended/Last updated) → Tasks 1 & 3.
- Requirement 3 (event names left-aligned across caret/non-caret rows) → Task 4.
- Requirement 4 (copy button aligned with label, off the `pre.json`) → Task 5.

**2. Placeholder scan:** No TBD/TODO; every code and CSS step shows the exact before/after content.

**3. Type consistency:** `formatOffset(from, to)` and `formatDateTime(ts)` signatures defined in Task 1 are used with the same names/argument order in Tasks 2 and 3. `formatDateTime` returns `string | undefined`, matching the existing `fmt` contract and the `?? —` fallback. New CSS classes `.off`, `.dt`, `.caretspace` are introduced in CSS (Task 2/4) and referenced in the matching JSX/tests.

**4. Note on the offset spec:** Your earlier `YYYY:MMM:DD` date format is intentionally superseded by your clarification to use local/localized date+time. The date-time line therefore uses `toLocaleDateString()`/`toLocaleTimeString()`, not a fixed `YYYY:MMM:DD` string.
