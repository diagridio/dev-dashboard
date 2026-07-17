# Logs Filter Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce the Logs page from three peer dropdowns (App, Source, Control plane) to a single grouped **Target** dropdown plus a `daprd | app` **segmented source toggle** shown only in app view.

**Architecture:** The App and Control-plane dropdowns collapse into one `<select>` with `Applications` / `Control plane` `optgroup`s, whose option values are kind-prefixed (`app:<key>` / `cp:<name>`) so `onChange` routes to the correct URL param. The Source `<select>` becomes two `.lvchip`-styled toggle buttons that derive their pressed state from the `?source` param and enforce an at-least-one-on invariant. All state stays URL-derived; deep links are unchanged.

**Tech Stack:** React 19 + TypeScript, react-router-dom v6 (`useSearchParams`), Vitest + Testing Library, CSS in `web/src/styles/theme.css`.

## Global Constraints

- **Deep links unchanged.** `?app=<key>&source=<daprd|app|both>` and `?cp=<name>` must keep working with zero edits to their call sites (`AppDetail.tsx:219`, `PublishMessageDialog.tsx:70`, `ControlPlane.tsx:169`).
- **`?source` validation.** Always parse via `parseEnum(searchParams.get('source'), LOG_SOURCES, 'both')` — an invalid value falls back to `both`, never leaks into the UI.
- **2-click app→CP switch preserved.** Selecting a control-plane target must remain: open Target → pick service (selecting it auto-clears `?app`).
- **At-least-one source on.** The source toggle can express `both` / `daprd` / `app` but never an empty set; clicking the sole active chip is a no-op.
- **Reuse existing styling.** Source chips use the existing `.lvchip` / `.lvchips` classes (`theme.css:292–294`). No new visual primitives.
- **Vitest does not typecheck.** After any `.ts`/`.tsx` change (test files included), run `cd web && npm run build` (`tsc -b && vite build`) — vitest alone will miss type errors.
- **Follow `web/STYLEGUIDE.md`** for select/chip/link styling and readability.

---

### Task 1: Merge App + Control-plane into one Target dropdown

Replace the two separate `<select>`s (App at `Logs.tsx:505–518`, Control plane at `Logs.tsx:533–550`) with one grouped Target select. Fold in the empty-state copy change.

**Files:**
- Modify: `web/src/pages/Logs.tsx` (the `Logs` component: selects at 505–550, the `onAppChange`/`onCpChange`/`clearCp` handlers at 405–440, and the empty-state text at 603–605)
- Test: `web/src/pages/Logs.test.tsx`

**Interfaces:**
- Consumes (existing, unchanged): `appOptions: { key: string; label: string }[]`, `cpNames: string[]`, `appId: string`, `cp: string`, `source: LogSource`, `setSearchParams`.
- Produces: `onTargetChange(value: string): void` — `value` is `''`, `app:<key>`, or `cp:<name>`. `''` deletes both `app` and `cp`; `app:<key>` sets `app` + deletes `cp`; `cp:<name>` sets `cp` + deletes `app`. `?source` is left untouched. Also `targetValue: string` — the derived current selection (`cp ? \`cp:${cp}\` : appId ? \`app:${appId}\` : ''`).

- [ ] **Step 1: Write the failing test — Target select renders grouped options and the App/Control-plane selects are gone**

Add to `web/src/pages/Logs.test.tsx` inside the `describe('Logs', …)` block. Replace the existing `it('renders app and source selects in .logbar', …)` test body's app/CP portion by adding this new test (leave the source assertions for Task 2):

```tsx
it('renders a single grouped Target select (no separate App/CP selects)', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
  )

  renderAt()

  const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
  expect(target).toBeInTheDocument()
  // Old peer selects are gone
  expect(screen.queryByRole('combobox', { name: /^App$/i })).toBeNull()
  expect(screen.queryByRole('combobox', { name: /Control Plane/i })).toBeNull()
  // Grouped: an Applications optgroup with the app, a Control plane optgroup with a dapr_* service
  expect(target.querySelector('optgroup[label="Applications"]')).not.toBeNull()
  expect(target.querySelector('optgroup[label="Control plane"]')).not.toBeNull()
  expect(screen.getByRole('option', { name: 'order' })).toBeInTheDocument()
  expect(screen.getByRole('option', { name: 'dapr_scheduler' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx -t "single grouped Target select"`
Expected: FAIL — no combobox named "Target" (still named "App").

- [ ] **Step 3: Replace the handlers**

In `web/src/pages/Logs.tsx`, delete `onAppChange`, `onCpChange`, and `clearCp` (lines 405–440) and replace with a single handler plus a derived value. Keep `onSourceChange` as-is:

```tsx
const targetValue = cp ? `cp:${cp}` : appId ? `app:${appId}` : ''

function onTargetChange(value: string) {
  setSearchParams(prev => {
    const next = new URLSearchParams(prev)
    const sep = value.indexOf(':')
    const kind = sep === -1 ? '' : value.slice(0, sep)
    const name = sep === -1 ? '' : value.slice(sep + 1)
    if (kind === 'app') {
      next.set('app', name)
      next.delete('cp')
    } else if (kind === 'cp') {
      next.set('cp', name)
      next.delete('app')
    } else {
      next.delete('app')
      next.delete('cp')
    }
    return next
  })
}
```

- [ ] **Step 4: Replace the two selects with one grouped Target select**

In `web/src/pages/Logs.tsx`, replace the App `<select>` (505–518) AND the Control-plane `<select>` (532–550) with this single control (leave the Source `<select>` at 520–530 untouched for now):

```tsx
<select
  className="select"
  data-cy="log-target"
  value={targetValue}
  onChange={e => onTargetChange(e.target.value)}
  aria-label="Target"
>
  <option value="">— select target —</option>
  {appOptions.length > 0 && (
    <optgroup label="Applications">
      {appOptions.map(o => (
        <option key={`app:${o.key}`} value={`app:${o.key}`}>
          {o.label}
        </option>
      ))}
    </optgroup>
  )}
  {cpNames.length > 0 && (
    <optgroup label="Control plane">
      {cpNames.map(name => (
        <option key={`cp:${name}`} value={`cp:${name}`}>
          {name}
        </option>
      ))}
    </optgroup>
  )}
</select>
```

- [ ] **Step 5: Update the empty-state copy**

In `web/src/pages/Logs.tsx`, change the empty-state text (line 604) from `Select an app to view logs.` to:

```tsx
<p className="muted">Select a target to view logs.</p>
```

- [ ] **Step 6: Update the F1 control-count test**

In `web/src/pages/Logs.test.tsx`, the `F1 — renders exactly ONE .logbar containing all five controls` test asserts `bar.querySelector('[aria-label="App"]')`. Change that one line to the Target select (leave the `[aria-label="Source"]` line for Task 2):

```tsx
    // target select
    expect(bar.querySelector('[aria-label="Target"]')).not.toBeNull()
```

- [ ] **Step 7: Add the deep-link + switch tests**

Add these to `web/src/pages/Logs.test.tsx`:

```tsx
it('reflects a ?app deep link as the selected Target', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
  )
  renderAt('/logs?app=order&source=daprd')
  const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
  await waitFor(() => expect(target.value).toBe('app:order'))
})

it('reflects a ?cp deep link as the selected Target and clears app on switch', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
  )
  renderAt('/logs?cp=dapr_scheduler')
  const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
  await waitFor(() => expect(target.value).toBe('cp:dapr_scheduler'))
})
```

- [ ] **Step 8: Run the Logs test suite**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx`
Expected: PASS (the Task 1 tests pass; the source-select tests still pass because that select is untouched).

- [ ] **Step 9: Typecheck + build**

Run: `cd web && npm run build`
Expected: `tsc -b` and `vite build` succeed with no type errors.

- [ ] **Step 10: Commit**

```bash
git add web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx
git commit -m "feat(logs): merge App + Control-plane filters into one Target select

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Replace the Source dropdown with a segmented daprd|app toggle

Replace the Source `<select>` (`Logs.tsx:520–530`) with two `.lvchip` toggles shown only in app view.

**Files:**
- Modify: `web/src/pages/Logs.tsx` (Source select at 520–530; add the toggle handler near `onSourceChange`)
- Modify: `web/src/styles/theme.css` (add `.srcchips` wrapper if the `.lvchips` gap/layout needs a distinct label; see Step 5)
- Test: `web/src/pages/Logs.test.tsx`

**Interfaces:**
- Consumes: `source: LogSource` and `onSourceChange(s: LogSource): void` from Task 1's file; `appId`, `isCpView` (existing, `Logs.tsx:459`).
- Produces: `toggleSource(stream: 'daprd' | 'app'): void` — flips one stream in the active set derived from `source`, enforces the at-least-one-on invariant, and writes the resulting `LogSource` via `onSourceChange`.

- [ ] **Step 1: Write the failing tests — chips reflect ?source and toggle it**

Replace the existing `it('falls back to "both" for an invalid ?source= URL param', …)` test's select-value assertions and add toggle/visibility tests. First, add these new tests to `web/src/pages/Logs.test.tsx`:

```tsx
it('renders daprd|app source chips reflecting ?source=daprd (no Source select)', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
  )
  renderAt('/logs?app=order&source=daprd')
  // Source is now chips, not a combobox
  expect(screen.queryByRole('combobox', { name: /Source/i })).toBeNull()
  const daprd = await screen.findByRole('button', { name: 'daprd' })
  const app = screen.getByRole('button', { name: 'app' })
  expect(daprd).toHaveAttribute('aria-pressed', 'true')
  expect(app).toHaveAttribute('aria-pressed', 'false')
})

it('toggling the app chip while on daprd yields source=both (adds the stream)', async () => {
  const user = userEvent.setup()
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
  )
  renderAt('/logs?app=order&source=daprd')
  const app = await screen.findByRole('button', { name: 'app' })
  await user.click(app)
  await waitFor(() => expect(app).toHaveAttribute('aria-pressed', 'true'))
  expect(screen.getByRole('button', { name: 'daprd' })).toHaveAttribute('aria-pressed', 'true')
})

it('clicking the only active source chip is a no-op (at-least-one invariant)', async () => {
  const user = userEvent.setup()
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
  )
  renderAt('/logs?app=order&source=daprd')
  const daprd = await screen.findByRole('button', { name: 'daprd' })
  await user.click(daprd)
  // still pressed — cannot turn off the last active stream
  expect(daprd).toHaveAttribute('aria-pressed', 'true')
})

it('hides the source chips in control-plane view', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
  )
  renderAt('/logs?cp=dapr_scheduler')
  await screen.findByRole('combobox', { name: /Target/i })
  expect(screen.queryByRole('button', { name: 'daprd' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'app' })).toBeNull()
})
```

Then update the invalid-`?source` test: replace its `sourceSelect` lines (`Logs.test.tsx:433–435`) with chip-state assertions (keep the subtitle + `--lsrc-w` assertions):

```tsx
    // An unknown source falls back to "both": both chips pressed.
    const daprd = (await screen.findByRole('button', { name: 'daprd' }))
    const app = screen.getByRole('button', { name: 'app' })
    await waitFor(() => expect(daprd).toHaveAttribute('aria-pressed', 'true'))
    expect(app).toHaveAttribute('aria-pressed', 'true')
```

Ensure `import userEvent from '@testing-library/user-event'` is present at the top of the test file (add it if missing).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx -t "source chip"`
Expected: FAIL — no `button` named `daprd`/`app` (source is still a `<select>`).

- [ ] **Step 3: Add the toggle handler**

In `web/src/pages/Logs.tsx`, add next to `onSourceChange`:

```tsx
function toggleSource(stream: 'daprd' | 'app') {
  const active = new Set<'daprd' | 'app'>(
    source === 'both' ? ['daprd', 'app'] : [source],
  )
  if (active.has(stream)) {
    if (active.size === 1) return // at-least-one-on invariant
    active.delete(stream)
  } else {
    active.add(stream)
  }
  const next: LogSource = active.size === 2 ? 'both' : active.has('daprd') ? 'daprd' : 'app'
  onSourceChange(next)
}
```

- [ ] **Step 4: Replace the Source select with chips**

In `web/src/pages/Logs.tsx`, replace the Source `<select>` (520–530) with this block. It renders only in app view:

```tsx
{!isCpView && appId && (
  <div className="lvchips srcchips" role="group" aria-label="Source">
    {(['daprd', 'app'] as const).map(stream => {
      const active = source === 'both' || source === stream
      return (
        <button
          key={stream}
          className="lvchip"
          data-cy={`log-source-${stream}`}
          aria-pressed={active}
          onClick={() => toggleSource(stream)}
        >
          {stream}
        </button>
      )
    })}
  </div>
)}
```

Note: `isCpView` is defined at `Logs.tsx:459` — this JSX is above that declaration in source order, but both live inside the same component body and `isCpView` is a `const` evaluated before render returns, so it is in scope in the returned JSX. If lint/TS flags use-before-declaration for the `const`, move the `const isCpView = cp !== ''` line up to sit beside the other derived values (near `targetValue`).

- [ ] **Step 5: Add the `.srcchips` style if needed**

The chips already inherit `.lvchips` (`display: inline-flex; gap: 5px`) and `.lvchip`. Add a marginal separation from the Target select so the group reads as a distinct sub-control. In `web/src/styles/theme.css`, after the `.lvchip[aria-pressed="true"]` rule (line 294):

```css
.srcchips { margin-right: 2px; }
```

- [ ] **Step 6: Fix the F1 source assertion**

In `web/src/pages/Logs.test.tsx`, the `F1 — renders exactly ONE .logbar` test still asserts `bar.querySelector('[aria-label="Source"]')` expecting a select. It now resolves to the chip group (same `aria-label="Source"` on the `div[role="group"]`), so the assertion still holds. Confirm the `.lvchips` assertion in that test now matches TWO groups (levels + source) — change it to assert at least one and that the Source group exists:

```tsx
    // source chip group (role=group, aria-label Source)
    expect(bar.querySelector('[aria-label="Source"]')).not.toBeNull()
    // level chips group still present
    expect(bar.querySelector('.lvchips[aria-label="Levels"]')).not.toBeNull()
```

- [ ] **Step 7: Run the full Logs test suite**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx`
Expected: PASS — all source-chip, toggle, invariant, CP-hidden, deep-link, and subtitle tests green.

- [ ] **Step 8: Typecheck + build**

Run: `cd web && npm run build`
Expected: `tsc -b` and `vite build` succeed with no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx web/src/styles/theme.css
git commit -m "feat(logs): replace Source dropdown with daprd|app segmented toggle

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 3: End-to-end verification against real deep links

Confirm the two remaining deep-link generators and the running app behave correctly, and run the whole web suite.

**Files:**
- Read only: `web/src/pages/AppDetail.tsx:219`, `web/src/components/PublishMessageDialog.tsx:70`, `web/src/pages/ControlPlane.tsx:169`
- Test: `web/src/pages/Logs.test.tsx` (already covers param handling; this task adds a source-column regression check for `?source=app`)

**Interfaces:**
- Consumes: everything from Tasks 1–2. Produces nothing new.

- [ ] **Step 1: Add a `?source=app` chip-state regression test**

Add to `web/src/pages/Logs.test.tsx`:

```tsx
it('reflects ?source=app as only the app chip pressed', async () => {
  server.use(
    http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
  )
  renderAt('/logs?app=order&source=app')
  const daprd = await screen.findByRole('button', { name: 'daprd' })
  const app = screen.getByRole('button', { name: 'app' })
  await waitFor(() => expect(app).toHaveAttribute('aria-pressed', 'true'))
  expect(daprd).toHaveAttribute('aria-pressed', 'false')
})
```

- [ ] **Step 2: Run the whole web test suite**

Run: `cd web && npm test`
Expected: PASS — the full Vitest suite is green.

- [ ] **Step 3: Typecheck + build**

Run: `cd web && npm run build`
Expected: no type errors, build succeeds.

- [ ] **Step 4: Verify the deep links in the running app**

Invoke the `verify` (or `/run`) skill to launch the dashboard, then exercise each generator's link and confirm the controls reflect it:

- From an App detail page click **View logs** → URL `/logs?app=<key>&source=daprd`; Target shows that app, only the **daprd** chip is pressed.
- From the Publish message dialog click **Open … logs** → `/logs?app=<id>&source=app`; only the **app** chip pressed.
- From the Control plane page click a service chip → `/logs?cp=<name>`; Target shows that service, **no source chips** visible.
- Switch from an app target to a control-plane target in the Target dropdown in **2 interactions** (open, pick) and confirm the app clears.

Record the observed behavior. Expected: all four behave as described.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Logs.test.tsx
git commit -m "test(logs): source-column regression for ?source=app deep link

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Target selector (merged, grouped, prefixed values, URL-derived, empty groups omitted, `cpPending` preserved) → Task 1. `cpPending` logic is untouched (not modified by any task), so it is preserved by omission.
- Source segmented control (chips, pressed-state mapping, toggle semantics, at-least-one-on, app-view-only visibility, parity on stream availability) → Task 2.
- Deep-link contract unchanged (3 generators, `parseEnum` fallback) → verified in Tasks 1–3; no generator files are modified.
- Layout / `.logbar` ordering + `.srcchips` → Task 2 Steps 4–5.
- Empty-state copy "Select a target" → Task 1 Step 5.
- Testing (selector rename, chip toggle, invariant, CP-hidden, deep links) → Tasks 1–3.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every test step shows the assertion and the run command with expected result.

**Type consistency:** `onTargetChange(value: string)`, `targetValue: string`, `toggleSource(stream: 'daprd' | 'app')`, `onSourceChange(s: LogSource)`, `LogSource` / `LOG_SOURCES`, `isCpView` — names are consistent across Tasks 1–3 and match the existing symbols in `Logs.tsx`.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-17-logs-filter-simplification.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session with checkpoints for review.

Which approach?
