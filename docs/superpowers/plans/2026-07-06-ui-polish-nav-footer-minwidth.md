# UI Polish (nav order, footer feedback link, 768px min width) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Swap the Configurations/Resiliency top-nav order, add an "Issues & feedback" GitHub link to the sidebar footer, and lower the small-screen warning threshold from 1024px to 768px.

**Architecture:** Three independent, single-file UI tweaks in the React web dashboard (`web/`). Each change is pinned by a Vitest unit test. No new components, routes, or dependencies.

**Tech Stack:** React 19 + TypeScript, Vitest + Testing Library, plain CSS (`web/src/styles/theme.css`).

**Spec:** `docs/superpowers/specs/2026-07-06-ui-polish-nav-footer-minwidth-design.md`

## Global Constraints

- All commands run from `web/` (`npm test`, `npm run build`).
- Footer link text is exactly `Issues & feedback`; href is exactly `https://github.com/diagridio/dev-dashboard` (repo root, NOT `/issues`).
- New small-screen threshold is exactly `768` (75% of 1024). Width-only; no height guard.
- External links use `target="_blank" rel="noopener noreferrer"`, matching the existing Diagrid link.
- No other nav labels/routes change; only the order of two items moves.

---

### Task 1: Swap Configurations and Resiliency in the top nav

**Files:**
- Modify: `web/src/components/TopNav.tsx:12-22` (the `NAV_ITEMS` array)
- Test: `web/src/components/TopNav.test.tsx:9-43`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `NAV_ITEMS: NavItem[]` export keeps the same shape (`{ label: string, to: string }[]`); only element order changes (Resiliency now index 5, Configurations index 6).

- [ ] **Step 1: Update the order-asserting tests to expect the new order**

In `web/src/components/TopNav.test.tsx`, in the `describe('NAV_ITEMS')` block, swap the two entries in both assertions so they read:

```tsx
  it('has exactly 9 items in the correct order', () => {
    const labels = NAV_ITEMS.map((i) => i.label)
    expect(labels).toEqual([
      'Applications',
      'Workflows',
      'Actors',
      'Subscriptions',
      'Components',
      'Resiliency',
      'Configurations',
      'Control Plane',
      'Logs',
    ])
  })

  it('has correct paths', () => {
    const paths = NAV_ITEMS.map((i) => i.to)
    expect(paths).toEqual([
      '/',
      '/workflows',
      '/actors',
      '/subscriptions',
      '/components',
      '/resiliency',
      '/configurations',
      '/control-plane',
      '/logs',
    ])
  })
```

(Leave the `includes a Control Plane nav item` test and everything else untouched.)

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npm test -- src/components/TopNav.test.tsx`
Expected: FAIL — both order tests report the array mismatch (Configurations/Resiliency swapped).

- [ ] **Step 3: Swap the two entries in NAV_ITEMS**

In `web/src/components/TopNav.tsx`, change the `NAV_ITEMS` array to:

```tsx
export const NAV_ITEMS: NavItem[] = [
  { label: 'Applications', to: '/' },
  { label: 'Workflows', to: '/workflows' },
  { label: 'Actors', to: '/actors' },
  { label: 'Subscriptions', to: '/subscriptions' },
  { label: 'Components', to: '/components' },
  { label: 'Resiliency', to: '/resiliency' },
  { label: 'Configurations', to: '/configurations' },
  { label: 'Control Plane', to: '/control-plane' },
  { label: 'Logs', to: '/logs' },
]
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `web/`): `npm test -- src/components/TopNav.test.tsx`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -m "feat(web): move Resiliency before Configurations in top nav"
```

---

### Task 2: Add "Issues & feedback" link to the sidebar footer

**Files:**
- Modify: `web/src/components/ResourcesSidebar.tsx:245-257` (the `.sbfoot` block)
- Modify: `web/src/styles/theme.css:98` (the `.sbfoot` rule)
- Test: `web/src/components/ResourcesSidebar.test.tsx:317-335` (the `ResourcesSidebar footer` describe block)

**Interfaces:**
- Consumes: nothing from other tasks. Uses the file's existing `renderSidebar()` helper (defined at the top of the test file) and the existing `screen` import.
- Produces: nothing consumed by other tasks.

- [ ] **Step 1: Write the failing test**

In `web/src/components/ResourcesSidebar.test.tsx`, add a second `it` inside the existing `describe('ResourcesSidebar footer', ...)` block (after the `renders Powered by Diagrid link and version in sbfoot` test):

```tsx
  it('renders Issues & feedback link to the GitHub repo', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: 'Issues & feedback' })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // Lives inside the footer, below the Powered by line
    expect(link.closest('.sbfoot')).not.toBeNull()
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npm test -- src/components/ResourcesSidebar.test.tsx`
Expected: FAIL — `Unable to find role="link" and name "Issues & feedback"`.

- [ ] **Step 3: Add the link to the footer**

In `web/src/components/ResourcesSidebar.tsx`, extend the `.sbfoot` div so it reads:

```tsx
      <div className="sbfoot">
        <span className="pw">
          Powered by{' '}
          <a
            href="https://diagrid.io/?utm_source=dev-dashboard&utm_medium=footer"
            target="_blank"
            rel="noopener noreferrer"
          >
            Diagrid
          </a>
          {' · '}v{version}
        </span>
        <span className="pw">
          <a
            href="https://github.com/diagridio/dev-dashboard"
            target="_blank"
            rel="noopener noreferrer"
          >
            Issues &amp; feedback
          </a>
        </span>
      </div>
```

- [ ] **Step 4: Stack the two footer lines in CSS**

In `web/src/styles/theme.css`, change the `.sbfoot` rule (line 98) from:

```css
.sbfoot { padding: 10px 14px; border-top: 1px solid var(--line-soft); }
```

to:

```css
.sbfoot { padding: 10px 14px; border-top: 1px solid var(--line-soft); display: grid; gap: 2px; }
```

(Leave `.sbfoot .pw`, `.pw a`, and the collapsed/media-query rules untouched — they already hide the whole footer when collapsed or narrow, which covers the new link too.)

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `web/`): `npm test -- src/components/ResourcesSidebar.test.tsx`
Expected: PASS (all tests in the file, including the pre-existing footer test).

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx web/src/styles/theme.css
git commit -m "feat(web): add Issues & feedback link to sidebar footer"
```

---

### Task 3: Lower the small-screen warning threshold to 768px

**Files:**
- Modify: `web/src/components/SmallScreenGuard.tsx:4` (the `MIN_WIDTH` constant)
- Test: `web/src/components/SmallScreenGuard.test.tsx`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: nothing consumed by other tasks. `SmallScreenGuard` keeps its `{ children: ReactNode }` props.

- [ ] **Step 1: Write the failing test**

The existing tests mock `matchMedia` with a fixed boolean and never inspect the query string, so the threshold is currently untested. Add a test that captures the query. In `web/src/components/SmallScreenGuard.test.tsx`, add inside the `describe('SmallScreenGuard')` block:

```tsx
  it('uses a 768px minimum width media query', () => {
    const queries: string[] = []
    vi.stubGlobal('matchMedia', (query: string) => {
      queries.push(query)
      return {
        matches: true, media: query, onchange: null,
        addEventListener: vi.fn(), removeEventListener: vi.fn(),
        addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
      }
    })
    render(<SmallScreenGuard><div>content</div></SmallScreenGuard>)
    expect(queries).toContain('(min-width: 768px)')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npm test -- src/components/SmallScreenGuard.test.tsx`
Expected: FAIL — the new test reports `queries` containing `'(min-width: 1024px)'`, not `'(min-width: 768px)'`. The two pre-existing tests still pass.

- [ ] **Step 3: Change the constant**

In `web/src/components/SmallScreenGuard.tsx`, change line 4 from:

```tsx
const MIN_WIDTH = 1024
```

to:

```tsx
const MIN_WIDTH = 768
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `web/`): `npm test -- src/components/SmallScreenGuard.test.tsx`
Expected: PASS (all 3 tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SmallScreenGuard.tsx web/src/components/SmallScreenGuard.test.tsx
git commit -m "feat(web): allow windows down to 768px before small-screen warning"
```

---

### Task 4: Full-suite verification and manual spot-check

**Files:**
- No file changes expected (fix regressions if any appear).

**Interfaces:**
- Consumes: the three completed tasks above.
- Produces: a verified, buildable main-ready branch.

- [ ] **Step 1: Run the full web test suite**

Run (from `web/`): `npm test`
Expected: PASS — no failures anywhere (other suites reference nav items and the sidebar; confirm nothing else pinned the old order or footer text).

- [ ] **Step 2: Run the production build**

Run (from `web/`): `npm run build`
Expected: `tsc -b` and `vite build` both succeed with no errors.

- [ ] **Step 3: Manual verification in the running app**

Start the dashboard (from `web/`): `npm run dev`, open the printed URL, then confirm:

1. Top nav reads: Applications, Workflows, Actors, Subscriptions, Components, **Resiliency, Configurations**, Control Plane, Logs.
2. The sidebar footer shows "Powered by Diagrid · v…" with "Issues & feedback" beneath it; the link opens `https://github.com/diagridio/dev-dashboard` in a new tab. Collapse the sidebar: the footer (including the new link) disappears.
3. Resize the window to ~800px wide: the dashboard stays usable (no overlay); pages render acceptably (sidebar/media-query layout kicks in below 760px). Resize to ~700px: the "designed for a wider screen" overlay appears; widening past 768px dismisses it.

Expected: all three behaviors confirmed; no console errors.

- [ ] **Step 4: Commit (only if fixes were needed)**

If Steps 1-3 forced any changes, re-run the affected tests, then:

```bash
git add -A
git commit -m "fix(web): regressions found during ui-polish verification"
```
