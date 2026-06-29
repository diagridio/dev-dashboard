# Compact Top-Nav Refresh Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Relocate the global auto-refresh control into the top navigation bar as a compact dot-plus-dropdown control, and remove the two in-page copies.

**Architecture:** The refresh state is already global (`RefreshContext` in `web/src/lib/refresh.tsx`, persisted to `localStorage`, consumed by every data hook). This is a UI-only change: reshape the existing `RefreshControl` component into a compact inline form, mount it once in `TopNav`, delete the two in-page instances, and add supporting CSS. No state, persistence, hook, or polling behavior changes.

**Tech Stack:** React 18 + TypeScript, Vite, React Router, TanStack Query, Vitest + @testing-library/react, plain CSS in `web/src/styles/theme.css`.

## Global Constraints

- All commands run from the `web/` directory: `cd web` first (paths below are relative to `web/`).
- Test runner: `npx vitest run <file>` for a single file; `npm test` for the full suite.
- Type-check + build: `npm run build` (`tsc -b && vite build`).
- Preserve these test hooks exactly: `data-cy="refresh-pause"` (pause/resume control) and `data-cy="refresh-interval"` (interval `<select>`).
- Preserve `aria-label="Refresh interval"` on the select and a toggling `aria-label` of `"Pause auto-refresh"` / `"Resume auto-refresh"` with `aria-pressed={paused}` on the pause control.
- Interval options unchanged: 1s=1000, 3s=3000, 5s=5000, 10s=10000, Off=0. Default 3000.
- Reuse existing CSS tokens (`--accent-bright`, `--muted`, `--line`, `--text`, `--accent2`, `--surface`) and the existing `@keyframes beat`. Do not introduce new tokens.
- Do NOT stage the pre-existing dirty files (`web/dist/index.html`, `web/package-lock.json`); only `git add` the files each task names.

---

### Task 1: Reshape `RefreshControl` into the compact inline form + CSS

**Files:**
- Modify: `web/src/components/RefreshControl.tsx` (full rewrite of the component body)
- Modify: `web/src/components/RefreshControl.test.tsx` (rewrite for new markup)
- Modify: `web/src/styles/theme.css` (add `.refresh-compact`, `.beatbtn`, `.select.compact`)

**Interfaces:**
- Consumes: `useRefreshInterval()` from `../lib/refresh` → `{ intervalMs: number, paused: boolean, setInterval: (ms:number)=>void, setPaused: (b:boolean)=>void }`.
- Produces: `export function RefreshControl()` — a self-contained control reading/writing the global context. No props. Renders root `<div className="refresh-compact">` containing a `<button className="beatbtn">` (with a `.beat` child span) and a `<select className="select compact">`.

- [ ] **Step 1: Rewrite the test for the new compact markup**

Replace the entire contents of `web/src/components/RefreshControl.test.tsx` with:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { RefreshProvider } from '../lib/refresh'
import { RefreshControl } from './RefreshControl'

function renderWithProvider() {
  return render(
    <RefreshProvider>
      <RefreshControl />
    </RefreshProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('RefreshControl (compact)', () => {
  it('renders the .beatbtn pause control with a .beat dot', () => {
    const { container } = renderWithProvider()
    const btn = container.querySelector('button.beatbtn')
    expect(btn).not.toBeNull()
    expect(container.querySelector('button.beatbtn .beat')).not.toBeNull()
    expect(btn).toHaveAttribute('data-cy', 'refresh-pause')
  })

  it('renders the interval <select> with classes "select compact"', () => {
    const { container } = renderWithProvider()
    const sel = container.querySelector('select.select.compact')
    expect(sel).not.toBeNull()
    expect(sel).toHaveAttribute('data-cy', 'refresh-interval')
    expect(screen.getByRole('combobox', { name: /refresh interval/i })).toBeInTheDocument()
  })

  it('is live (not paused) by default: aria-pressed=false, pause label, title names interval', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn).toHaveAttribute('title', expect.stringContaining('every 3s'))
    expect(btn.className).not.toContain('off')
  })

  it('toggles to the resumed/paused state when clicked', () => {
    renderWithProvider()
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    const resumeBtn = screen.getByRole('button', { name: /resume auto-refresh/i })
    expect(resumeBtn).toHaveAttribute('aria-pressed', 'true')
    expect(resumeBtn).toHaveAttribute('title', expect.stringContaining('paused'))
    expect(resumeBtn.className).toContain('off')
  })

  it('updates the title interval when a different interval is selected', () => {
    renderWithProvider()
    fireEvent.change(screen.getByRole('combobox', { name: /refresh interval/i }), {
      target: { value: '5000' },
    })
    expect(screen.getByRole('button', { name: /pause auto-refresh/i })).toHaveAttribute(
      'title',
      expect.stringContaining('every 5s'),
    )
  })

  it('shows the off state and "Auto-refresh off" title when interval is Off', () => {
    renderWithProvider()
    fireEvent.change(screen.getByRole('combobox', { name: /refresh interval/i }), {
      target: { value: '0' },
    })
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn.className).toContain('off')
    expect(btn).toHaveAttribute('title', 'Auto-refresh off')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/RefreshControl.test.tsx`
Expected: FAIL — old component renders `.live`/`.tbtn`, so `button.beatbtn`, `select.select.compact`, and `.off`/`title` assertions fail.

- [ ] **Step 3: Rewrite the component**

Replace the entire contents of `web/src/components/RefreshControl.tsx` with:

```tsx
import { useRefreshInterval } from '../lib/refresh'

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: 'Off', value: 0 },
]

/**
 * Compact global refresh control for the top navigation bar. Renders a beating
 * dot that doubles as a pause/resume button, plus an interval picker. Reads and
 * writes the global RefreshContext, so it governs polling on every page.
 */
export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === intervalMs)?.label ?? `${intervalMs / 1000}s`

  const off = intervalMs === 0
  const live = !paused && !off

  const title = paused
    ? 'Auto-refresh paused — click to resume'
    : off
      ? 'Auto-refresh off'
      : `Auto-refresh every ${intervalLabel} — click to pause`

  return (
    <div className="refresh-compact">
      <button
        className={`beatbtn${live ? '' : ' off'}`}
        data-cy="refresh-pause"
        aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        aria-pressed={paused}
        title={title}
        onClick={() => setPaused(!paused)}
      >
        <span className="beat" />
      </button>

      <select
        className="select compact"
        data-cy="refresh-interval"
        aria-label="Refresh interval"
        value={intervalMs}
        onChange={(e) => setInterval(Number(e.target.value))}
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
```

- [ ] **Step 4: Add the CSS**

In `web/src/styles/theme.css`, immediately after the `.select { ... }` rule (currently line 203), add:

```css
.refresh-compact { display: inline-flex; align-items: center; gap: 7px; }
.beatbtn { display: inline-flex; align-items: center; justify-content: center; padding: 5px; background: transparent; border: 1px solid var(--line); border-radius: 8px; cursor: pointer; }
.beatbtn:hover { border-color: var(--faint); }
.beatbtn:focus-visible { outline: 2px solid var(--accent2); outline-offset: 2px; }
.beatbtn .beat { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-bright); animation: beat 2.4s ease-out infinite; }
.beatbtn.off .beat { background: var(--muted); animation: none; box-shadow: none; }
.select.compact { padding: 4px 8px; font-size: 12px; border-radius: 8px; }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/RefreshControl.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard
git add web/src/components/RefreshControl.tsx web/src/components/RefreshControl.test.tsx web/src/styles/theme.css
git commit -m "feat(web): reshape RefreshControl into compact top-nav form" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: Mount the control in `TopNav`

**Files:**
- Modify: `web/src/components/TopNav.tsx` (import + render in `.topright`)
- Modify: `web/src/components/TopNav.test.tsx` (assert the control renders)

**Interfaces:**
- Consumes: `RefreshControl` from `./RefreshControl` (Task 1). `TopNav` is already rendered inside `RefreshProvider` (in `web/src/App.tsx` and in the test harness), so the context is available — no prop wiring.
- Produces: `TopNav` renders `<RefreshControl />` as the first child of `<div className="topright">`, before `<ThemeToggle/>`.

- [ ] **Step 1: Add the failing test**

In `web/src/components/TopNav.test.tsx`, inside the `describe('TopNav', ...)` block, add this test after the existing `renders ThemeToggle` test (after line 63):

```tsx
  it('renders the compact refresh control', () => {
    renderNav()
    expect(screen.getByRole('combobox', { name: /refresh interval/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pause auto-refresh/i })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx`
Expected: FAIL — `TopNav` does not yet render the refresh control, so the combobox/button are not found.

- [ ] **Step 3: Mount the control in the component**

In `web/src/components/TopNav.tsx`:

Add the import after line 3 (`import { ThemeToggle } ...`):

```tsx
import { RefreshControl } from './RefreshControl'
```

Replace the `.topright` block (currently lines 48-50):

```tsx
      <div className="topright">
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>
```

with:

```tsx
      <div className="topright">
        <RefreshControl />
        <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
      </div>
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx`
Expected: PASS (all existing tests plus the new one).

- [ ] **Step 5: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard
git add web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -m "feat(web): mount compact refresh control in top nav" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Remove the two in-page refresh controls

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (remove `<RefreshControl/>` + import)
- Modify: `web/src/pages/WorkflowDetail.tsx` (remove `<RefreshControl/>` + import)

**Interfaces:**
- Consumes: nothing new. After this task, `RefreshControl` is imported only by `TopNav` (Task 2) and its test.
- Produces: Workflows `.ctrlset` retains only the statestore chip; WorkflowDetail `.refreshbar` retains the `.sp` spacer and the `lastRefreshed` timestamp.

Note: no page test asserts the in-page control (verified via grep of `src/pages/*.test.tsx`), so no page-test changes are needed. Verification is the full suite + build.

- [ ] **Step 1: Edit `Workflows.tsx`**

Remove the import line (currently line 7):

```tsx
import { RefreshControl } from '../components/RefreshControl'
```

In the `.ctrlset` block, remove the `<RefreshControl />` line (currently line 291) so the block ends:

```tsx
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
        </div>
```

- [ ] **Step 2: Edit `WorkflowDetail.tsx`**

Remove the import line (currently line 8):

```tsx
import { RefreshControl } from '../components/RefreshControl'
```

Replace the refresh-bar block (currently lines 411-415):

```tsx
      <div className="refreshbar">
        <RefreshControl />
        <span className="sp" />
        <span className="mono faint">{lastRefreshed}</span>
      </div>
```

with:

```tsx
      <div className="refreshbar">
        <span className="sp" />
        <span className="mono faint">{lastRefreshed}</span>
      </div>
```

- [ ] **Step 3: Verify no stray references remain**

Run: `cd web && grep -rn "RefreshControl" src | grep -v "components/RefreshControl"`
Expected: only `src/components/TopNav.tsx` and `src/components/TopNav.test.tsx` appear (the Task 2 import/usage). No `src/pages/...` lines.

- [ ] **Step 4: Run the affected page tests + type-check**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx src/pages/WorkflowDetail.test.tsx && npm run build`
Expected: tests PASS; `tsc -b && vite build` completes with no unused-import errors.

- [ ] **Step 5: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard
git add web/src/pages/Workflows.tsx web/src/pages/WorkflowDetail.tsx
git commit -m "refactor(web): remove in-page refresh controls (now in top nav)" \
  -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full test suite**

Run: `cd web && npm test`
Expected: all suites PASS. Pay attention to `RefreshControl.test.tsx`, `TopNav.test.tsx`, `Workflows.test.tsx`, `WorkflowDetail.test.tsx`, `LiveIndicator.test.tsx`.

- [ ] **Step 2: Type-check + production build**

Run: `cd web && npm run build`
Expected: completes with no TypeScript errors.

- [ ] **Step 3: Manual smoke check (optional but recommended)**

Run: `cd web && npm run dev`, open the app. Confirm:
- The compact control (beating dot + interval dropdown) appears in the top bar left of the theme toggle, on every page.
- Clicking the dot toggles paused (dot stops/greys); the tooltip text updates.
- Changing the interval updates polling everywhere; the Applications/Actors/Subscriptions `LiveIndicator` text reflects the new interval / "auto-refresh off".
- The Workflows page shows only the statestore chip in its header; the Workflow-detail page still shows the `lastRefreshed` timestamp.

---

## Self-Review

**Spec coverage:**
- Reshape `RefreshControl` to compact form → Task 1. ✅
- Mount in `TopNav` `.topright` before `ThemeToggle` → Task 2. ✅
- Remove control from Workflows + WorkflowDetail, keep statestore chip and `lastRefreshed` → Task 3. ✅
- Keep `LiveIndicator` and `lastRefreshed` passive status → untouched (Tasks confirm via verification). ✅
- CSS using existing tokens + `@keyframes beat`, focus ring like `.tbtn` → Task 1 Step 4. ✅
- Tests for new markup + nav presence → Tasks 1 & 2; page tests confirmed unaffected → Task 3 note. ✅
- No state/persistence/hook/polling changes → no task touches `lib/refresh.tsx` or any hook. ✅
- prefers-reduced-motion coverage → reuses `.beat` class governed by the existing media block. ✅

**Placeholder scan:** No TBD/TODO; every code step shows full content. ✅

**Type consistency:** `RefreshControl` is a no-prop component throughout; `data-cy`/`aria` hooks match the Global Constraints and the tests in Tasks 1–2; class names (`refresh-compact`, `beatbtn`, `beat`, `select compact`, `off`) are consistent between component, CSS, and tests. ✅
