# UI tweaks: news items, brighter green, no purple text — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three scoped front-end refinements — (1) news items in the Resources sidebar show only title + content type + publish date (no description), (2) a brighter green (the dark-theme green) for four light-theme elements, (3) App ID / Instance ID render in the default text color instead of the browser's purple visited-link color.

**Architecture:** Pure front-end. Item 1 changes the news subtitle logic in `ResourcesSidebar.tsx`. Item 2 adds two theme-independent "bright green" tokens to `theme.css` and repoints five selectors. Item 3 adds one CSS utility class and applies it to two `<Link>`s. No backend/API/hook changes.

**Tech Stack:** React 18 + TypeScript + Vite, Vitest + Testing Library, CSS custom properties in `web/src/styles/theme.css`.

## Global Constraints

- Frontend-only. Do not change Go, API, or data hooks.
- Per-task gate (BOTH must pass, pristine output): `cd web && npm test` and `cd web && npx tsc -b`. Do **NOT** run `npm run build` per task (it overwrites the tracked `web/dist/index.html` placeholder). Never `git add -A` or stage anything under `web/dist`.
- Match the existing mock-derived design system (`web/src/styles/theme.css`). Keep the SUSPENDED status purple (`--susp-fg`, used by `.s-susp` and `.rulebadge`) — it is an intentional status color and is **out of scope** for the "no purple" change.
- Conventional Commit messages; end each commit body with `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Tests query by role/text/class; keep them real (no zero-width-space hacks, no distorting product text, no weakening).
- Execute in an isolated git worktree (this repo uses the native worktree tool → `.claude/worktrees/`). Create it via superpowers:using-git-worktrees before Task 1; run `npm install` in `web/` once after creating it.

## File Structure

- `web/src/components/ResourcesSidebar.tsx` — Task 1 (news subtitle = type + date; drop excerpt; add a date formatter).
- `web/src/components/ResourcesSidebar.test.tsx` — Task 1 (assert type+date shown, excerpt not shown).
- `web/src/styles/theme.css` — Task 2 (bright-green tokens + repoint 5 selectors) and Task 3 (`.celllink` utility).
- `web/src/pages/Applications.tsx` — Task 3 (App ID link → `.celllink`).
- `web/src/pages/Applications.test.tsx` — Task 3 (assert App ID link class).
- `web/src/pages/Workflows.tsx` — Task 3 (Instance ID link → `.celllink`).
- `web/src/pages/Workflows.test.tsx` — Task 3 (assert Instance ID link class).

---

### Task 1: News sidebar shows title + content type + publish date only

**Why:** `newsSubtitle()` currently returns `item.excerpt` (the description) for blog/report, and `eventStartDate · eventLocation` for webinar/event. The requirement is: show only the **title**, the **content type** (Blog / Report / Webinar / Event), and the **publish date excluding time**. (`NewsResponse` has four slots — blog, report, webinar, event; there is no separate "ebook" slot, reports-and-ebooks map to "report".)

**Files:**
- Modify: `web/src/components/ResourcesSidebar.tsx` (replace `newsSubtitle`, add `formatPublishDate`, pass the slot label into `NewsSection`'s rows)
- Test: `web/src/components/ResourcesSidebar.test.tsx`

**Interfaces:**
- Consumes: `NewsItem` (`web/src/types/logs.ts`) — fields used: `title`, `url`, `publishedAt?` (ISO string like `2026-06-22` or `2026-06-22T09:00:00Z`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Update the test to require type + date and forbid the excerpt**

In `web/src/components/ResourcesSidebar.test.tsx`, find the news-rendering test(s). Ensure the `useNews` mock for a blog item includes an `excerpt` and a `publishedAt`, then assert the subtitle shows `Blog · <date>` and the excerpt text is absent. Add/replace with this test (adapt the existing `useNews` mock/wrapper already in the file):

```tsx
it('news item shows type + publish date, not the description', async () => {
  // Arrange: blog item with an excerpt that must NOT render, and a publish date
  server.use(
    http.get('/api/news', () =>
      HttpResponse.json({
        blog: {
          title: 'Durable Execution',
          url: 'https://example.com/blog',
          excerpt: 'THIS DESCRIPTION SHOULD NOT RENDER',
          publishedAt: '2026-06-22T09:00:00Z',
        },
        report: null,
        webinar: null,
        event: null,
      }),
    ),
  )
  renderSidebar() // use the existing render helper in this file
  expect(await screen.findByText('Durable Execution')).toBeInTheDocument()
  // Type + date (time excluded)
  expect(screen.getByText('Blog · Jun 22')).toBeInTheDocument()
  // Description must not appear
  expect(screen.queryByText(/THIS DESCRIPTION SHOULD NOT RENDER/)).not.toBeInTheDocument()
})
```

If the file already has a test asserting the excerpt renders, delete that assertion (it now contradicts the requirement).

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/components/ResourcesSidebar.test.tsx`
Expected: FAIL — the excerpt currently renders (subtitle returns `item.excerpt`), and `Blog · Jun 22` is not present.

- [ ] **Step 3: Replace the subtitle logic in `ResourcesSidebar.tsx`**

Replace the existing `newsSubtitle` function (lines ~67–75) with a date formatter + a type+date subtitle. The date is timezone-safe by parsing the `YYYY-MM-DD` prefix directly (avoids `new Date()` UTC/local drift):

```tsx
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Formats an ISO publish date as "Jun 22" (time excluded). Returns undefined if unparseable. */
function formatPublishDate(iso?: string): string | undefined {
  if (!iso) return undefined
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) // matches date prefix of YYYY-MM-DD[THH:MM…]
  if (!m) return undefined
  const month = MONTHS[Number(m[2]) - 1]
  if (!month) return undefined
  return `${month} ${Number(m[3])}`
}

/** Subtitle = content type, plus publish date when available (e.g. "Blog · Jun 22"). */
function newsSubtitle(item: NewsItem, label: string): string {
  const date = formatPublishDate(item.publishedAt)
  return date ? `${label} · ${date}` : label
}
```

Then update `NewsSection` to pass the slot's human label and always render the subtitle. Change the `.map` body (around lines 106–124) so it reads:

```tsx
{NEWS_SLOTS.map(({ key, label }) => {
  const item = news[key]
  if (item) {
    const subtitle = newsSubtitle(item, label)
    return (
      <a
        key={key}
        href={item.url}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onMarkSeen}
        className="sblink"
      >
        <span className="col">
          <span className="txt">{item.title}</span>
          <span className="sub">{subtitle}</span>
        </span>
        <span className="ext">↗</span>
      </a>
    )
  }
  return (
    <div key={key} style={{ padding: '7px 10px', fontSize: '12.5px', color: 'var(--faint)' }}>
      {emptyStateText(key)}
    </div>
  )
})}
```

Remove the now-unused `eventLocation`/`eventStartDate`/`excerpt` handling (the old `newsSubtitle` body). `eventStartDate`, `eventLocation`, and `excerpt` remain on the `NewsItem` type (other code/back end may use them) but are no longer rendered here. The `'blog' | 'report' | 'webinar' | 'event'` type param is gone — `newsSubtitle` now takes the `label: string`.

> Note (date source): per the requirement we use `publishedAt` (the publish date) for **all** content types, including webinar/event. If you later want webinar/event to show their `eventStartDate` instead, that is a separate change — out of scope here.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && npx vitest run src/components/ResourcesSidebar.test.tsx`
Expected: PASS.

- [ ] **Step 5: Run both gates**

Run: `cd web && npm test` → all pass, pristine.
Run: `cd web && npx tsc -b` → no errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx
git commit -m "fix(web): news items show type + publish date, not the description"
```

---

### Task 2: Brighter green (dark-theme green) for four light-theme elements

**Why:** In the light theme these four elements use the darker greens (`--done-fg: #0a8a2c`, `--accent2: #0A8A6E`). The requirement is a brighter green — the same green the dark theme already uses (`--done-fg: #5fdd86`, `--accent2: #2FE3AD`) — for: (a) the `healthy` app indicator dot, (b) the "refreshing" live indicator dot, (c) the green event-history timeline nodes (Workflow detail), (d) the multi-select checkbox. These are all small fills/dots, so contrast on light backgrounds is not a concern.

**Approach:** Add two theme-independent "bright green" tokens (same value in both themes) and repoint exactly these selectors. Because the new tokens equal the dark theme's existing green values, the dark theme is visually unchanged; only the light theme gets brighter.

**Files:**
- Modify: `web/src/styles/theme.css`

**Interfaces:** none (CSS only).

- [ ] **Step 1: Add the bright-green tokens**

In `web/src/styles/theme.css`, inside the base `.app { … }` block (the one starting at line ~26 that also defines `--primary`), add two tokens:

```css
  --accent-bright: #2FE3AD; /* dark-theme --accent2; brighter green for light-theme dots/fills */
  --ok-bright: #5fdd86;     /* dark-theme --done-fg; brighter "ok/healthy" green */
```

These live on `.app` (not the per-theme blocks), so both themes resolve them to the same bright green. The `.app[data-theme=…]` blocks do not redefine them, so the base value always wins.

- [ ] **Step 2: Repoint the five selectors**

Make these exact edits in `web/src/styles/theme.css`:

1. `.live .beat` (line ~136) — refreshing indicator dot:
   - From: `.live .beat { width: 8px; height: 8px; border-radius: 50%; background: var(--accent2); animation: beat 2.4s ease-out infinite; }`
   - To: same rule but `background: var(--accent-bright);`
2. `.led.ok` (line ~169) — healthy app indicator:
   - From: `.led.ok { background: var(--done-fg); }`
   - To: `.led.ok { background: var(--ok-bright); }`
3. `.cbx.on` (line ~297) — multi-select checkbox fill + border:
   - From: `.cbx.on { background: var(--accent2); border-color: var(--accent2); position: relative; }`
   - To: `.cbx.on { background: var(--accent-bright); border-color: var(--accent-bright); position: relative; }`
   - (Leave the `.cbx.on::after` checkmark border color `#06231a` — it still contrasts on the brighter fill, same as the dark theme.)
4. `.n-start` (line ~343) — green "started" timeline node:
   - From: `.n-start { background: var(--accent2); }`
   - To: `.n-start { background: var(--accent-bright); }`
5. `.n-done` and `.n-end` (lines ~345 and ~348) — green "completed"/"end" timeline nodes:
   - From: `.n-done { background: var(--done-fg); }` and `.n-end { background: var(--done-fg); }`
   - To: both `background: var(--ok-bright);`

Do **not** change other users of `--done-fg`/`--accent2` (e.g. `.s-done` pill text, `.stat .n.mint` stat number, focus outlines, `.followbtn .d`, `tr.sel` row tint, `.ci.sel`) — those are out of scope and some are text where brightening would reduce contrast.

- [ ] **Step 3: Verify gates**

Run: `cd web && npx tsc -b` → no errors.
Run: `cd web && npm test` → all pass (no test asserts these computed colors, so the count is unchanged).

- [ ] **Step 4: Visual check (manual, in the worktree)**

Build and run once to eyeball the change in the **light** theme: `cd web && npm run build && cd .. && ./bin/dev-dashboard --no-open` then open the dashboard. Confirm: the healthy dot, the "refreshing every Ns" dot, the green workflow-detail timeline nodes, and a selected workflow checkbox are all the brighter green; dark theme is unchanged. **After this manual build, restore the placeholder so it is not committed:** `git checkout 146520e -- web/dist/index.html`.

- [ ] **Step 5: Commit**

```bash
git add web/src/styles/theme.css
git commit -m "style(web): use the brighter (dark-theme) green for healthy/refresh/timeline/select in light mode"
```

---

### Task 3: App ID and Instance ID use the default text color (no purple visited-link)

**Why:** App ID (`Applications.tsx:138`) and Instance ID (`Workflows.tsx:463`) are `<Link>`s with no color rule, so they fall back to the browser's default link colors — notably **purple when visited**. The requirement is the theme's default text color, and purple must not appear for these. (Per the recorded decision, the SUSPENDED status pill and the "N rules" badge keep their intentional purple and are out of scope.)

**Files:**
- Modify: `web/src/styles/theme.css` (add `.celllink` utility)
- Modify: `web/src/pages/Applications.tsx` (App ID link)
- Modify: `web/src/pages/Workflows.tsx` (Instance ID link)
- Test: `web/src/pages/Applications.test.tsx`, `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Produces: CSS class `.celllink` (default text color, no underline, underline on hover) used by in-table entity links.

- [ ] **Step 1: Add a failing test for each link's class**

In `web/src/pages/Applications.test.tsx`, in a test that renders the app rows, assert the App ID link carries `celllink`:

```tsx
// The App ID link must use the table text color (class celllink), not a default/visited link color.
expect(screen.getByRole('link', { name: 'order-processing' })).toHaveClass('celllink')
```

In `web/src/pages/Workflows.test.tsx`, in a test that renders workflow rows, assert the Instance ID link carries `celllink` (use an instance id present in that test's mock data):

```tsx
expect(screen.getByRole('link', { name: 'b1f4c0a9…7e2d' })).toHaveClass('celllink')
```

(Match the actual app id / instance id strings used by each test's existing mock fixtures.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx src/pages/Workflows.test.tsx`
Expected: FAIL — links do not yet have the `celllink` class.

- [ ] **Step 3: Add the `.celllink` utility to `theme.css`**

Add near the other primitive/link rules in `web/src/styles/theme.css` (e.g. just after the `.crumbs` rules around line 141, or anywhere in the primitives block):

```css
/* In-table entity links (App ID, Instance ID): default text color, never the browser's blue/purple link color. */
.celllink { color: var(--text); text-decoration: none; }
.celllink:hover { text-decoration: underline; }
```

- [ ] **Step 4: Apply the class to the App ID link**

In `web/src/pages/Applications.tsx` (line ~138), add `className="celllink"`:

```tsx
<td className="b">
  <Link className="celllink" to={`/apps/${app.appId}`} onClick={(e) => e.stopPropagation()}>
    {app.appId}
  </Link>
</td>
```

- [ ] **Step 5: Apply the class to the Instance ID link**

In `web/src/pages/Workflows.tsx` (line ~463), add `className="celllink"`:

```tsx
<td className="iid">
  <Link
    className="celllink"
    to={`/workflows/${wf.appId}/${wf.instanceId}`}
    onClick={(e) => e.stopPropagation()}
  >
    {wf.instanceId}
  </Link>
</td>
```

> Note: `.celllink` sets `color: var(--text)`, which overrides the `.iid` cell's muted color for the Instance ID **link text** specifically (the cell's mono font/size from `.iid` still apply). This satisfies "default text color"; the App ID link likewise renders in `var(--text)`. Neither can show the browser's purple visited color anymore.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx src/pages/Workflows.test.tsx`
Expected: PASS.

- [ ] **Step 7: Run both gates**

Run: `cd web && npm test` → all pass, pristine.
Run: `cd web && npx tsc -b` → no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/styles/theme.css web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "fix(web): App ID and Instance ID use default text color, not browser visited-link purple"
```

---

## Self-Review

- **Spec coverage:** Item 1 → Task 1 (title + type + date, no description). Item 2 → Task 2 (brighter green for healthy indicator, refreshing indicator, event-history green nodes, multi-select box). Item 3 → Task 3 (App ID + Instance ID default text color, no purple); SUSPENDED purple intentionally retained per decision. All three covered.
- **Placeholder scan:** No TBD/TODO; all steps contain concrete code and commands.
- **Type consistency:** `newsSubtitle(item, label: string)` — both definition and call site updated in Task 1. `.celllink` — defined in Task 3 Step 3, used in Steps 4–5, asserted in Step 1. Token names `--accent-bright` / `--ok-bright` consistent across Task 2 steps.
- **Out-of-scope guardrails stated:** keep SUSPENDED purple; don't change other `--done-fg`/`--accent2` users; don't run `npm run build` per task; don't stage `web/dist`.
