# Dev Dashboard — UI Style Guide

A practical reference for building new pages and components in the dashboard so they
look and behave like the rest of the app.

This guide **describes** the system that already lives in
[`src/styles/theme.css`](src/styles/theme.css) — it is not a second source of truth.
When the CSS and this doc disagree, the CSS wins; fix the doc (or the CSS) so they
agree again.

## TL;DR for a new page

1. Wrap everything in `<div className="page">`.
2. Open with a `.phead` (title + optional sub + right-aligned action/live indicator)
   or a `.crumbs` breadcrumb for detail pages.
3. Build the body from existing primitives: `.card` + `table.t` for lists,
   `.panel` + `.kv` for detail sections, `.stats` for summary tiles, `.metagrid`
   for dense key/value headers.
4. **Never hardcode a color.** Use a `var(--…)` token so both themes work.
5. Labels (column heads, section titles, key names) are **mono, uppercase,
   letter-spaced, `var(--muted)`**. Any number/time/duration/GUID value is **mono**
   — in table cells use **`td.mono.tabnum`**.
6. Handle loading / empty / error states explicitly (see the pattern below).

---

## 1. How styling works here

- **One global stylesheet.** `src/styles/theme.css` is imported once in
  `src/main.tsx`. There is no CSS framework (no Tailwind), no CSS modules, and no
  CSS-in-JS library. You style by applying the existing class vocabulary.
- **Everything is scoped under `.app`.** The root element in `App.tsx` is
  `<div className="app" data-theme={theme}>`. All tokens are defined on
  `.app[data-theme="light"]` and `.app[data-theme="dark"]`, so components only work
  inside that tree (which is the whole app).
- **Theme is a data attribute.** Light/dark is switched by `data-theme` on `.app`,
  not by a class on `<body>`. You never read the theme in CSS directly — you read
  tokens, and the tokens change with the theme.

### The golden rule: use tokens, not literals

```tsx
// ✅ adapts to light + dark automatically
<p style={{ color: 'var(--muted)' }}>…</p>

// ❌ breaks in one theme, drifts from the palette
<p style={{ color: '#637381' }}>…</p>
```

The only raw hex values in the codebase are intentional one-offs: language swatch
colors (`runtimeSwatch` in `Applications.tsx`/`AppDetail.tsx`) and the dark ink on
mint/bright backgrounds (`#06231a`). If you reach for a hex, it should be that rare.

---

## 2. Design tokens

All tokens are CSS custom properties. Reference them with `var(--name)`.

### Surfaces & lines
| Token | Use |
|---|---|
| `--bg` | App background (behind cards) |
| `--surface` | Card / panel / table background |
| `--surface-2` | Subtle raised fill: table headers, hover rows, chips, inputs |
| `--raise` | Elevated control (active segment in `.segs`) |
| `--line` | Default 1px border |
| `--line-soft` | Lighter divider (rows inside a card) |
| `--shadow` | The one box-shadow used by cards/panels/stats |

### Text
| Token | Use |
|---|---|
| `--text` | Primary text |
| `--muted` | Secondary text, labels, column headers |
| `--faint` | Tertiary / placeholder / em-dash `—` / disabled |
| `--link` | Hyperlinks and breadcrumb links |

### Brand & accents
| Token | Use |
|---|---|
| `--primary` `#0BDDA3` | Brand mint (theme-independent) |
| `--accent2` | Theme-aware accent: focus rings, primary buttons, selection tints |
| `--accent-bright` / `--ok-bright` | Brighter mint for LEDs, "beat" pulse, checkboxes |
| `--dapr` | Dapr-specific blue (sidecar badges, daprd log source) |

### Status palette (paired bg/fg)
Each status has a background and foreground token, used together:

| Status | Tokens | Pill class | Semantic |
|---|---|---|---|
| Running | `--run-bg` / `--run-fg` | `.s-run` | in progress |
| Completed / OK | `--done-bg` / `--done-fg` | `.s-done` | success |
| Failed / Error | `--fail-bg` / `--fail-fg` | `.s-fail` | error |
| Terminated | `--term-bg` / `--term-fg` | `.s-term` | neutral/stopped |
| Suspended | `--susp-bg` / `--susp-fg` | `.s-susp` | paused/special |
| Pending | `--pend-bg` / `--pend-fg` | `.s-pend` | waiting/warn |

Syntax-highlight tokens also exist for YAML (`--yk/--ys/--yc`) and JSON
(`--jkey/--jstr/--jnum/--jpun`) — see `lib/yaml-highlight.tsx` and
`lib/json-highlight.tsx`.

### Layout tokens
| Token | Use |
|---|---|
| `--sbw` | Sidebar width (240px; 44px when `.collapsed` or ≤760px) |
| `--mono` | Monospace stack |
| `--sans` | Sans stack (default body font) |

### Mixing a tint
For selection/hover tints, follow the existing pattern with `color-mix` against a
token rather than inventing a new color:

```css
background: color-mix(in srgb, var(--accent2) 10%, var(--surface));
```

---

## 3. Typography conventions

- **Body / values:** `--sans`, ~13px, `--text`.
- **Monospace data values — numbers, times, durations, GUIDs/IDs, ports, metrics:**
  always `--mono`. Add `.mono` to opt in. This is a hard rule: any field whose value
  is a number, a timestamp/time, a duration, or a GUID/ID renders in the mono stack.
  - **In table cells, use `td.mono.tabnum`** — `.tabnum`
    (`font-variant-numeric: tabular-nums`) on top of `.mono` so columns align.
    Combine with color/weight helpers as needed (e.g. `muted mono tabnum` for a
    secondary timestamp, `mono tabnum faint` for an em-dash placeholder in a numeric
    column).
  - **Outside tables** (`.kv .vv`, `.metagrid .v`, stat tiles) just add `.mono`;
    `.tabnum` is only required for aligned table columns.
  - **Stat tiles** (`.stat .n`) are mono by default — the rule is baked into the
    class, so you get it for free. The caption (`.stat .l`) stays a mono label.
- **Labels** (column headers, section titles, key names, stat captions): the
  signature look — `--mono`, ~10–11.5px, `text-transform: uppercase`,
  `letter-spacing: .08–.15em`, color `--muted`. Don't restyle these per-page; reuse
  `.sec-title`, `.sech`, `table th`, `.kv .kk`, `.metagrid .k`, `.stat .l`.
- **Page titles:** `font-weight: 680`, slight negative tracking (handled by `.phead h1`).
- **Bold emphasis:** `.b` (= `font-weight: 600`).

Color helpers: `.muted`, `.faint`, `.none` (faint, for empty values).

---

## 4. Page anatomy

Every page is `<div className="page">` (max-width 1240px, centered, responsive
padding). Two header styles:

### List / index page

```tsx
<div className="page">
  <div className="phead">
    <div>
      <h1>Applications</h1>
      <div className="sub">Dapr apps &amp; sidecars discovered on this machine</div>
    </div>
    <LiveIndicator />        {/* right-aligned: live dot, actions, etc. */}
  </div>

  <div className="stats">…</div>      {/* optional summary tiles */}
  <div className="card">              {/* the main list */}
    <div className="tablewrap">
      <table className="t click">…</table>
    </div>
  </div>
  <p className="hint">Tip — click a row to open the detail.</p>
</div>
```

### Detail page

```tsx
<div className="page">
  <div className="crumbs">
    <Link to="/">Applications</Link>
    <span className="sep">/</span>
    <span className="cur">{app.appId}</span>      {/* mono, current entity */}
  </div>

  <div className="phead"> … title + status + actions … </div>

  <div className="twocol">      {/* or .metagrid, .io, .md depending on content */}
    <div className="panel">…</div>
    <div className="panel">…</div>
  </div>
</div>
```

### Required: loading / empty / error states

Pages render explicit states before the happy path. Match the existing copy and
classes (from `Applications.tsx`, `ResourceDetail.tsx`, `Workflows.tsx`):

```tsx
if (isLoading) return <div className="page">{HEADER}<p className="muted">Loading…</p></div>
if (!data?.length) return <div className="page">{HEADER}<p className="muted">No items found</p></div>
if (error) return <div className="page">{HEADER}<p className="err">Error loading: {String(error)}</p></div>
```

Tip: hoist a static `PAGE_HEADER` const (as `Applications.tsx` does) so every state
shows the same header.

---

## 5. Component catalog

Reusable React components — prefer these over re-implementing.

| Component | File | Use |
|---|---|---|
| `StatusPill` | `components/StatusPill.tsx` | Workflow status → correct `.pill .s-*` class + uppercased label. **Use this; don't hand-map statuses.** |
| `LiveIndicator` | `components/LiveIndicator.tsx` | The pulsing "live" dot for `.phead`. |
| `RefreshControl` | `components/RefreshControl.tsx` | Auto-refresh control inside a `.refreshbar`. |
| `ConfirmRemoveDialog` | `components/ConfirmRemoveDialog.tsx` | Modal confirm for destructive actions. |
| `ThemeToggle` | `components/ThemeToggle.tsx` | Light/dark switch (lives in `TopNav`). |
| `useToast()` | `lib/toast.tsx` | Transient confirmation (e.g. "Instance ID copied"). |
| `copyText()` | `lib/clipboard.ts` | Clipboard write; pair with a toast. |
| `highlightJson` / YAML | `lib/json-highlight.tsx`, `lib/yaml-highlight.tsx` | Render `<pre className="json">` / `<pre className="code">` with token colors. |

### CSS primitives (class → what it is)

**Containers**
- `.card` — rounded bordered surface with shadow; wrap a `table.t` in
  `.card > .tablewrap`.
- `.panel` — like a card, with a `.ph` header row (`> .ph`); body is usually `.kv`,
  `.compchips`, or a `<pre>`. Use `.ph .ic` for the little square glyph,
  `.ph .tagdot` for a colored dot, `.ph .copybtn` auto-right-aligns.
- `.stats` / `.stat` — auto-fit grid of summary tiles. `.stat .n` (big number —
  **mono** + tabular-nums by default; add `.mint` for accent), `.stat .l` (caption
  label).
- `.metagrid` — dense 4-col key/value header grid (`.m` cell, `.m.span2` to span,
  `.k` label, `.v` value, `.v.mono`). Used on detail headers.
- `.kv` — 2-col key/value list inside a panel (`.kk` key, `.vv` value, `.vv.mono`).
- `.twocol` / `.io` — two equal columns (collapse to 1 on narrow screens).
- `.md` — master-detail split (300px list + flexible pane); list items are `.ci`
  (`.ci.sel` = selected).

**Tables**
- `table.t` — standard table; add `.click` to make rows clickable (cursor + hover).
- `table.wf` — the workflows table variant (sticky header, min-width, selection).
- Wrap in `.tablewrap` for horizontal scroll. Row-selection: `tr.sel`. Toolbar
  above selection: `.selbar`. Pagination: `.pager` / `.pgbtns`.

**Inline elements / badges**
- `.pill .s-*` — status pill (use `StatusPill`).
- `.health` + `.led.{ok,warn,bad}` — colored LED + label.
- `.chip`, `.typechip`, `.appref`, `.dprchip`, `.rulebadge`, `.tag-int` — small
  mono badges for types, app refs, Dapr tags. `.appref.link` adds a hover
  affordance (border/colour change, **no arrow**). **There is no `.chip.link`** —
  a chip that navigates renders as a plain `.chip` wrapped in a `<Link>` (internal
  navigation, no `↗`); see §6. The old `.chip.link` appended an `↗` that read as an
  *external* link, which these never are, so it was removed.
- `.lang .sw` — language label with a color swatch.
- `.kebab` — the `⋯` row-actions glyph.

**Controls**
- `.btn` + `.btn.primary` / `.btn.ghost` / `.btn.danger` — buttons.
- `.tbtn` — topbar/secondary button (used for Back / View logs).
- `.copybtn` (+ `.ok` state) — small copy button; pairs with `copyText` + toast.
- `.search` (wraps an `<input>`), `.select` — filter inputs.
- `.segs` — segmented toggle group (`button[aria-pressed]`).
- `.lvchip` — log-level toggle chips; `.followbtn` — log follow toggle.

**Feedback**
- `.toast` (`.show`) — driven by `useToast`.
- `.hint` — centered faint helper line under content.
- `.refreshbar` — the refresh/clock strip on auto-refreshing pages.

**Code blocks**
- `<pre className="json">` + `highlightJson(...)` for JSON.
- `<pre className="code">` + YAML highlighter for component/config YAML.
- `<pre className="evbody pre">` patterns for workflow event payloads.

---

## 6. Recurring patterns

- **In-table entity links:** use `.celllink` (not a bare `<a>`) so links render in
  `--text`, not browser blue/purple, and only underline on hover. Stop propagation
  if the row is also clickable:
  ```tsx
  <Link className="celllink" to={`/apps/${id}`} onClick={(e) => e.stopPropagation()}>{id}</Link>
  ```
- **Internal-link chips:** a chip that navigates *within* the app is a plain
  `.chip` wrapped in a `<Link>` — never add an external-link `↗`. Reserve the `↗`
  affordance for links that genuinely leave the app. Example (the workflow store's
  link to its component page):
  ```tsx
  <Link className="chip" to={`/components/${name}`}>component</Link>
  ```
  The App-detail component chips follow the same rule (`.chip.k` wrapped in a
  `<Link>`). In tables, prefer `.celllink` (above).
- **Em dash for empty values:** render `<span className="faint">—</span>`, not an
  empty cell.
- **Copy-to-clipboard:** `.copybtn` (or click-to-copy on a `.vv.mono`) → `copyText()`
  → `toast.show('… copied')`. The `⧉ Copy` label is the convention.
- **Clickable card rows:** `table.t.click` (or `table.wf`) handles cursor + hover;
  navigate from the row's `onClick`.

---

## 7. Responsiveness & accessibility

- **Breakpoints in use:** 760px (sidebar collapses; `.twocol`/`.md` → 1 col),
  820px (`.md`), 720px (`.io`), 640px (`.metagrid` → 2 col). Reuse these; multi-col
  grids should already collapse — verify new ones do too.
- **Wide content scrolls, the page doesn't.** Wrap wide tables in `.tablewrap`
  (`overflow-x: auto`). Never let the page body scroll horizontally.
- **Focus rings are standard:** interactive elements use
  `:focus-visible { outline: 2px solid var(--accent2); }`. Keep it — don't remove
  outlines.
- **Reduced motion:** a global `@media (prefers-reduced-motion: reduce)` disables
  all animation/transition. Any new animation is automatically covered.
- **Small screens:** `SmallScreenGuard` blocks very narrow widths app-wide; you
  don't need a phone layout, but do keep tablet widths usable.

---

## 8. When to add new CSS

Default to **composing existing classes**. Add to `theme.css` only when:

1. You have a genuinely new structural pattern (not a restyle of an existing one).
2. You've checked no primitive already covers it.

When you do add CSS:
- Put it in `theme.css` under the most relevant `/* ---- section ---- */`.
- Use `var(--…)` tokens for every color, border, and shadow.
- Verify it in **both** light and dark before committing.
- Prefer a small composable class (like `.mono`, `.tabnum`) over a one-off rule.

### About inline `style={{…}}`
Inline styles are used sparingly and deliberately — for genuine one-offs (a single
swatch color, a `marginBottom` nudge, an icon background). That's fine. But if you
find yourself writing the same inline style twice, or re-declaring something a class
already provides (e.g. re-specifying the whole `.ph` rule inline as
`ResourceDetail.tsx` currently does), promote it to a class instead.

---

## 9. Quick checklist before you commit a new page

- [ ] Root is `.page`; header is `.phead` or `.crumbs`.
- [ ] Loading, empty, and error states are handled.
- [ ] No hardcoded colors — everything is `var(--…)`.
- [ ] Labels are mono/uppercase/muted via existing classes; every number/time/
      duration/GUID value is mono, and table cells use `td.mono.tabnum`.
- [ ] Used `StatusPill` / `LiveIndicator` / `RefreshControl` / toast where relevant.
- [ ] Wide tables wrapped in `.tablewrap`; grids collapse on narrow screens.
- [ ] Checked it in **both** light and dark themes.
