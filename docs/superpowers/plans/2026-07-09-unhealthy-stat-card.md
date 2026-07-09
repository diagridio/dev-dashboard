# Unhealthy Stat Card Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the "Run template" stat card on the Applications overview with an "Unhealthy" count card.

**Architecture:** Pure frontend change to the Applications page stats row. The card counts apps with `health === 'unhealthy'` (not `'unknown'`) and renders the number in the fail color only when the count is greater than 0. The per-row "Run template" table column and its `sourceLabel` logic are unchanged. No backend/API changes.

**Tech Stack:** React + TypeScript, vitest + @testing-library/react + msw, plain CSS (`web/src/styles/theme.css`).

**Spec:** `docs/superpowers/specs/2026-07-09-unhealthy-stat-card-design.md`

## Global Constraints

- Vitest does NOT typecheck: after any `.ts`/`.tsx` change, run `cd web && npx tsc -b` before claiming done.
- Card order in the stats row must be: Apps running · Healthy · Starting · Unhealthy · Components loaded.
- Apps with `health === 'unknown'` are NOT counted as unhealthy.
- The number uses class `bad` (color `var(--fail-fg)`) only when the count > 0; at 0 it is the default neutral color.

---

### Task 1: Replace the Run template stat card with an Unhealthy count card

**Files:**
- Modify: `web/src/pages/Applications.tsx:44-77` (stats derivation + stats row)
- Modify: `web/src/styles/theme.css:208` (add `.stat .n.bad` rule next to `.stat .n.mint`)
- Test: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `AppSummary.health` (`'healthy' | 'starting' | 'unhealthy' | 'unknown'`) from `web/src/types/api.ts` — already present, no type changes.
- Produces: nothing consumed by other tasks (single-task plan).

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/Applications.test.tsx`:

1. Update the existing stats-row test (currently asserts `/run template/i` appears). Note the table header still contains a "Run template" column, so instead assert the stat *label* moved: the string `Unhealthy` (capital U, exact match — the table's health cells render lowercase `unhealthy` so they don't collide) exists, and `Run template` now appears exactly once (the column header only). Replace the test body:

```tsx
  it('renders a stats row with running/healthy/starting/unhealthy counts', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    // Wait for data
    await screen.findByRole('link', { name: 'order' })
    // Stat labels (uppercased via CSS; assert on the source text)
    expect(screen.getByText(/apps running/i)).toBeInTheDocument()
    expect(screen.getAllByText(/^healthy$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/^starting$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Unhealthy')).toBeInTheDocument()
    // The run-template stat card is gone; only the table column header remains.
    expect(screen.getAllByText(/run template/i)).toHaveLength(1)
  })
```

2. Add two new tests after it (the stat number is the element immediately before the label inside the same `.stat` card):

```tsx
  it('unhealthy stat shows 0 without the bad class when all apps are fine', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    const num = screen.getByText('Unhealthy').previousElementSibling as HTMLElement
    expect(num).toHaveTextContent('0')
    expect(num).not.toHaveClass('bad')
  })

  it('unhealthy stat counts unhealthy apps (not unknown) and turns bad', async () => {
    mockApps([
      { ...baseApp },
      { ...baseApp, appId: 'billing', health: 'unhealthy' },
      { ...baseApp, appId: 'primes-go', source: 'compose', sidecarReachable: false, health: 'unknown' },
    ])
    renderAt()
    await screen.findByRole('link', { name: 'billing' })
    const num = screen.getByText('Unhealthy').previousElementSibling as HTMLElement
    expect(num).toHaveTextContent('1')
    expect(num).toHaveClass('bad')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: the updated stats-row test FAILS (`Unable to find an element with the text: Unhealthy`) and both new tests FAIL for the same reason. The other tests in the file still PASS.

- [ ] **Step 3: Implement the card in `web/src/pages/Applications.tsx`**

Replace the `runTemplate` derivation (lines 47–50):

```tsx
  // Prefer a real run-template name; else label Aspire-managed apps; else label compose; else '—'.
  const runTemplate =
    apps.find((a) => a.runTemplate)?.runTemplate ||
    (apps.some((a) => a.isAspire) ? 'Aspire' : apps.some((a) => a.source === 'compose') ? 'Compose' : '—')
```

with:

```tsx
  const unhealthy = apps.filter((a) => a.health === 'unhealthy').length
```

Replace the Run template stat card (lines 72–77):

```tsx
        <div className="stat">
          <div className="n mono" style={{ fontSize: 18 }}>
            {runTemplate}
          </div>
          <div className="l">Run template</div>
        </div>
```

with an Unhealthy card, and move it BEFORE the Components loaded card so the row reads Apps running · Healthy · Starting · Unhealthy · Components loaded:

```tsx
        <div className="stat">
          <div className={unhealthy > 0 ? 'n bad' : 'n'}>{unhealthy}</div>
          <div className="l">Unhealthy</div>
        </div>
```

Do NOT touch `AppRow`'s `sourceLabel` or the "Run template" table column.

- [ ] **Step 4: Add the CSS rule in `web/src/styles/theme.css`**

Directly after the existing rule on line 208 (`.stat .n.mint { color: var(--accent2); }`) add:

```css
.stat .n.bad { color: var(--fail-fg); }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: all tests PASS.

- [ ] **Step 6: Typecheck and full test suite**

Run: `cd web && npx tsc -b && npx vitest run`
Expected: no type errors; all tests PASS (vitest does not typecheck, so `tsc -b` is mandatory).

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx web/src/styles/theme.css
git commit -m "feat(web): replace Run template stat card with Unhealthy count"
```
