# Dev Dashboard — UI Style Guide

A practical reference for building new pages and components in the dashboard so they
look and behave like the rest of the app.

This guide **describes** the system that already lives in
[`src/styles/theme.css`](src/styles/theme.css) — it is not a second source of truth.
When the CSS and this doc disagree, the CSS wins; fix the doc (or the CSS) so they
agree again.

## TL;DR for a new page

1. Wrap everything in `<div className="page">`.
2. Open with a `.phead` (title + optional sub + right-aligned actions/filters)
   or a `.crumbs` breadcrumb for detail pages. Auto-refresh is **global**
   (`RefreshControl` in the top nav) — don't add per-page refresh/live controls.
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

The only raw hex values in the codebase are intentional one-offs: the Diagrid logo
mark (`components/Logo.tsx` — fixed brand fills), the `runtimeSwatch` map of
language-brand swatch colors (one shared lookup keyed by runtime; external brand
colors have no theme token), and the dark ink placed on mint/bright backgrounds
(`#06231a`). If you reach for a hex, it should be that rare — a guard test
(`src/test/styleguide.test.ts`) fails on any new hex literal outside those
allowlisted spots.

### ⚠️ Antipattern: never build a class name from raw data

Because there is **one flat global stylesheet** (no CSS modules / scoping) and the
whole app lives under the global `.app` class, a class token you interpolate from a
data value can silently collide with an unrelated global class and inherit its rules.

```tsx
// ❌ if `src` is "app", this renders class="lsrc app" — the token `app` matches the
//    global `.app` shell rule (min-height: 100vh, font-family, …) and blows up layout
<span className={`lsrc ${src}`}>{src}</span>

// ✅ namespace the modifier so it can only match its own rule
<span className={`lsrc lsrc-${src}`}>{src}</span>   // .lsrc.lsrc-app { … }
```

This actually happened: app log rows grew to full viewport height because the source
tag `<span class="lsrc app">` picked up `.app { min-height: 100vh }`.

**Rule:** any class token derived from runtime data (log source, status, type, id)
should be **prefixed with its component name** so it lives in its own namespace — the
way status pills use `.s-run` / `.s-fail` (via `StatusPill`) rather than bare `run` /
`fail`. Never let a bare data word (`app`, `error`, `run`, …) stand alone as a class;
it may already mean something globally. The existing `.lvl.info` / `.logrow.error`
pattern uses bare level words and is safe only because no global `.info` / `.error`
rule exists today — don't rely on that for new dynamic classes; prefix them.

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
| `--accent-bright` / `--ok-bright` | Brighter mint (theme-independent) — the single interactive accent: `.btn.primary`, focus rings, selection tints, active nav tab, LEDs, "beat" pulse, checkboxes |
| `--dapr` | Dapr-specific blue (sidecar badges, daprd log source) |
| `--gold` / `--purple` | Catalyst-brand secondary accents — available for highlights / category chips (not yet used in default UI) |

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
| `--mono` | Monospace stack (system: SF Mono / JetBrains Mono / Menlo…) |
| `--sans` | Sans stack — **Public Sans** (bundled via `@fontsource-variable/public-sans`, imported in `main.tsx`), system-ui fallback |

### Implicit scales (radius & padding)

There are no radius/spacing tokens, but the values are a deliberate scale — match
the tier, don't invent a new value:

| Radius | Tier |
|---|---|
| `13px` | Top-level surfaces: `.card`, `.panel` (and the modal card, which composes `.card`) |
| `12px` | Tiles & framed insets: `.stat`, `.metagrid`, `.logwin`, panels inside `.io` |
| `10px` | Cards nested *inside* a card/panel (e.g. the event cards in the workflow timeline) |
| `8–9px` | Controls: `.btn`/`.tbtn` 8px; `.select`/`.search`/`.inp`/`.segs` 9px |
| `5–7px` | Chips & small badges: `.chip` 7px, `.typechip`/`.copybtn` 6px, `.appref`/`.dprchip` 5px |
| `999px` | Pills (`.pill`) and round dots/LEDs (50%) |

Padding rhythm: **`11px 14px`** is the row/cell unit — table `th`/`td`, panel
headers (`.ph`), list items (`.ci`), the pager all use it (values drift by ±2px
vertically: `.kv` rows are `9px 14px`). Compact controls use **`7px 11px`**
(`.inp`, `.search`, `.btn` at `7px 13px`). Stick to the 14px horizontal gutter so
new rows align with existing ones.

### Mixing a tint
For selection/hover tints, follow the existing pattern with `color-mix` against a
token rather than inventing a new color:

```css
background: color-mix(in srgb, var(--accent-bright) 10%, var(--surface));
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
    <div className="ctrlset">…</div>   {/* right-aligned actions/filters (optional) */}
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

Reusable React components — prefer these over re-implementing. The table is
pattern-first with one-line pointers (paths relative to `src/`). The pointers
are kept honest by `src/test/styleguide.test.ts`, which asserts every
backtick-quoted `components/….tsx` path in this doc exists — deleting a
component fails the suite until the doc is updated.

| Pattern | Pointer |
|---|---|
| Status → pill | `components/StatusPill.tsx` — status string → `.pill .s-*` + uppercased label. **Don't hand-map statuses.** |
| Modal dialog | `components/Modal.tsx` — focus-trapped shell (`.modal-backdrop` + `.card.modal-card`); `components/ConfirmRemoveDialog.tsx` for destructive confirms. Both trap/restore focus via `hooks/useModalFocus.ts` — reuse it, don't hand-roll traps. |
| Save/cancel form dialog | `components/form/DialogShell.tsx` — titled `Modal` with Save/Cancel footer + `duplicateNameError` name-collision guard; the builder dialogs are the reference usage. |
| Follow-scroll log pane | `hooks/useFollowScroll.ts` — pin-to-bottom with scroll-away disengage (24px threshold); both Logs viewers use it. |
| Descriptor-driven form control | `components/MetadataFieldInput.tsx` — one `.inp` control from a component-metadata field descriptor (vs hand-composed forms: see §6). |
| Hand-composed form fields | `components/form/` primitives (`Field`, `TextInput`, `NumberInput`, `SelectInput`, `Toggle`) — see §6. |
| Multi-step builder shell | `components/wizard/` (`Wizard`, `Stepper`, `StepNav`) — see §6. |
| YAML output step | `components/YamlPreview.tsx` — highlighted preview + Copy/Download — see §6. |
| Connection manager | `components/StateStoreConnectionDialog.tsx` (a `Modal` of `.field` rows driven by `MetadataFieldInput`) + `components/StateStoreConnectionsPanel.tsx`. |
| Global chrome | `components/TopNav.tsx` hosts `components/RefreshControl.tsx` (the app-wide auto-refresh, whose dot is also the backend-offline indicator — never mount a per-page one) and `components/ThemeToggle.tsx`. |
| Toast + clipboard | `useToast()` in `lib/toast.tsx`; `copyText()` in `lib/clipboard.ts` — pair them. |
| Syntax highlight | `lib/json-highlight.tsx` / `lib/yaml-highlight.tsx` → `<pre className="json">` / `<pre className="code">`. |

### CSS primitives (class → what it is)

**Containers**
- `.card` — rounded bordered surface with shadow; wrap a `table.t` in
  `.card > .tablewrap`.
- `.panel` — like a card, with a `.ph` header row (`> .ph`); body is usually `.kv`,
  `.compchips`, or a `<pre>`. Use `.ph .ic` for the little square glyph,
  `.ph .tagdot` for a colored dot, `.ph .copybtn` auto-right-aligns.
- `.stats` / `.stat` — auto-fit grid of summary tiles. `.stat .n` (big number —
  **mono** + tabular-nums by default), `.stat .l` (caption label).
- `.metagrid` — dense 4-col key/value header grid (`.m` cell, `.m.span2` to span,
  `.k` label, `.v` value, `.v.mono`). Used on detail headers.
- `.kv` — 2-col key/value list inside a panel (`.kk` key, `.vv` value, `.vv.mono`).
- `.twocol` / `.io` — two equal columns (collapse to 1 on narrow screens).
- `.md` — master-detail split (300px list + flexible pane); list items are `.ci`
  (`.ci.sel` = selected).
- **Modal shell** — `.modal-backdrop` (fixed full-screen overlay, centers its child) wraps
  `.card.modal-card` (the dialog surface; composes `.card`), with `.modal-title` for the
  heading and `.modal-actions` for the right-aligned footer button row. Prefer the `Modal`
  component over assembling these by hand.

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
  navigation, no `↗`); see §7. The old `.chip.link` appended an `↗` that read as an
  *external* link, which these never are, so it was removed.
- `.lang .sw` — language label with a color swatch.
- `.kebab` — the `⋯` row-actions glyph.

**Controls**
- `.btn` + `.btn.primary` / `.btn.ghost` / `.btn.danger` — buttons.
  `.primary` = solid green affirmative action; `.danger` = red outline for
  destructive / disruptive actions (Stop / Remove / Force delete / Disconnect);
  `.ghost` = neutral outline.
- `.tbtn` — topbar/secondary button (used for Back / View logs).
- `.copybtn` (+ `.ok` state) — small copy button; pairs with `copyText` + toast.
- `.search` (wraps an `<input>`), `.select` — filter inputs.
- `.segs` — segmented toggle group (`button[aria-pressed]`).
- `.lvchip` — log-level toggle chips; `.followbtn` — log follow toggle.

**Form fields** (used in modal dialogs — see `StateStoreConnectionDialog`)
- `.inp` — full-width text input / `<select>` (the metadata-form control style). `.select` is
  the compact filter variant; `.inp` is the form-field variant.
- `.field` — a label-over-control row (`grid`, `gap`); `.field > label` is the muted caption.
  `.req` marks a required-field asterisk; `.field-err` is the inline error line under a control;
  `.field-row` lays out a control plus adjacent element horizontally.

**Feedback**
- `.toast` (`.show`) — driven by `useToast`.
- `.hint` — centered faint helper line under content.
- `.refresh-compact` — the compact global refresh control in the top nav (`.beatbtn` + `.beat`
  pulse toggle, `.select.compact` interval dropdown); rendered by `RefreshControl`. The dot
  doubles as the backend-connection indicator: `.beatbtn.offline` (red `--fail-fg` pulse) +
  `.offline-label` when the `/api/health` probe fails.

**Code blocks**
- `<pre className="json">` + `highlightJson(...)` for JSON.
- `<pre className="code">` + YAML highlighter for component/config YAML.
- `<pre className="evbody pre">` patterns for workflow event payloads.

**Workflow event timeline** — a self-contained vocabulary in `theme.css`
(the workflows section). Reuse it for anything event-feed-shaped; don't fork it:
- `.timeline` > `.ev` rows — each row is a 3-col grid: timestamp (`.t`), rail
  (`.rail` vertical line + `.node` dot, colored by kind via `.n-start` /
  `.n-sched` / `.n-done` / `.n-fail` / `.n-timer` / `.n-end` / `.n-endfail`),
  and the event card.
- The card is `details.evd` (collapsible; `.caret`) or `.evd.evstatic` (flat).
  Header cells — `.evtype`, `.evname` / `.evnamecell`, `.evtag`, `.evanchor` —
  are pinned to explicit columns of a shared grid so they align vertically
  across every row, even when a cell is absent.
- Payloads go in `.evbody` (`.lbl` / `.lblrow` captions + bounded `pre`).
- Related-event pairing: `a.pairchip` / `span.pairchip` (`.pending` dashed),
  with `.ev.pair-hover` / `.ev.pair-selected` highlight states; `.retrybadge`
  flags retries.

**Control Plane cards** — `.cp-*`: structural classes for labelled fields in a
service card: `.cp-card` (padding), `.cp-field` (stack), `.cp-label` (the
standard mono/uppercase label), `.cp-value`, `.cp-logpath` (break-all). This is
the model for page-scoped structural CSS: short page prefix as namespace,
structure only, every color still a token.

---

## 6. Builders & wizards

The YAML builders (component & resiliency) share one wizard shell and one form
vocabulary. Any new "compose a thing step by step, preview YAML, download it"
flow should be assembled from these — not hand-rolled.

### Wizard shell — `components/wizard/`

- **`Wizard`** — the whole shell: a `Stepper`, the active step's content in
  `.wizard-body`, and a `StepNav`. It is fully controlled — you own the state
  and pass `steps` (`{ label, content }`), `activeStep`, `canContinue`, and
  `onBack` / `onContinue` / `onFinish`; the wizard renders, it doesn't decide.
- **`Stepper`** — the step-pill breadcrumb: `.stepper` > `.step` pills
  (`.active` = current, `.done` = completed, mint) separated by `.step-arrow`
  `→` glyphs. Display-only; steps aren't clickable.
- **`StepNav`** — the Back / Continue / Finish row (`.stepnav`; a `.spacer`
  keeps the primary action right-aligned when Back is absent). The forward
  action (Continue / Finish) is `.btn.primary`; Back is `.btn.ghost`. Gate
  progression by passing `canContinue={false}` — disable the button, don't hide it.

The matching CSS is the wizard section of `theme.css` (`.wizard`, `.stepper` /
`.step`, `.wizard-body` — a min-height so the pane doesn't jump between steps —
and `.stepnav`).

### Form primitives — `components/form/`

`Field`, `TextInput`, `NumberInput`, `SelectInput`, `Toggle` — thin wrappers
over the `.field` / `.inp` / `.select` / `.childtoggle` classes with a
`value`/`onChange` string API. `Field` owns the muted label, the `.req`
required asterisk, and the inline `.field-err` line; put exactly one control
inside it. `NumberInput` deliberately keeps its value as a **string** so the
field can be empty — coerce when you emit.

**Descriptor-driven vs hand-composed:**
- Have component-metadata **field descriptors** (e.g. the metadata fields of a
  component type)? Use `MetadataFieldInput` — it derives
  text/password/number/select/checkbox from the descriptor. Don't hand-build
  those inputs.
- Designing the form **yourself** (builder steps, settings, filters-as-form)?
  Use the `components/form/` primitives inside `Field`s.
- Break long forms into groups with **`.section-label`** — the muted uppercase
  divider with a top border (defined alongside the `.field` rules in
  `theme.css`).

### YAML preview & download

`YamlPreview` (`components/YamlPreview.tsx`) is the standard final step: the
emitted YAML as a highlighted `<pre className="code">`, plus right-aligned
**Copy** (clipboard + toast) and **Download** (`downloadText()` from
`lib/download.ts`, client-side blob download) actions. Don't re-implement
copy/download buttons per builder.

---

## 7. Recurring patterns

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

## 8. Responsiveness & accessibility

- **Breakpoints in use:** 760px (sidebar collapses; `.twocol`/`.md` → 1 col),
  820px (`.md`), 720px (`.io`), 640px (`.metagrid` → 2 col). Reuse these; multi-col
  grids should already collapse — verify new ones do too.
- **Wide content scrolls, the page doesn't.** Wrap wide tables in `.tablewrap`
  (`overflow-x: auto`). Never let the page body scroll horizontally.
- **Focus rings are standard:** interactive elements use
  `:focus-visible { outline: 2px solid var(--accent-bright); }`. Keep it — don't remove
  outlines.
- **Reduced motion:** a global `@media (prefers-reduced-motion: reduce)` disables
  all animation/transition. Any new animation is automatically covered.
- **Small screens:** `SmallScreenGuard` blocks very narrow widths app-wide; you
  don't need a phone layout, but do keep tablet widths usable.

---

## 9. When to add new CSS

Default to **composing existing classes**. Add to `theme.css` only when:

1. You have a genuinely new structural pattern (not a restyle of an existing one).
2. You've checked no primitive already covers it.

When you do add CSS:
- Put it in `theme.css` under the most relevant `/* ---- section ---- */`.
- Use `var(--…)` tokens for every color, border, and shadow.
- Verify it in **both** light and dark before committing.
- Prefer a small composable class (like `.mono`, `.tabnum`) over a one-off rule.

### Per-component CSS variables — structural geometry only

Some components coordinate geometry through a component-scoped custom property:
the log row exposes `--ltime-w` / `--lsrc-w` (column widths computed in JS from
the widest visible timestamp/source and set inline on the container), and the
event timeline uses `--ev-head` / `--ev-head-top` (header height/offset shared
by the rail, the node dot, and the card header so they stay aligned). That is
the sanctioned pattern: a locally-named variable for **structural geometry**
(widths, heights, offsets) that JS must compute or several rules must share.
Never use this mechanism for colors — colors only come from theme tokens.

### About inline `style={{…}}`
Inline styles are used sparingly and deliberately — for genuine one-offs (a single
swatch color, a `marginBottom` nudge, an icon background). That's fine. But if you
find yourself writing the same inline style twice, or re-declaring something a class
already provides (e.g. re-specifying the whole `.ph` rule inline as
`ResourceDetail.tsx` currently does), promote it to a class instead.

---

## 10. Quick checklist before you commit a new page

- [ ] Root is `.page`; header is `.phead` or `.crumbs`.
- [ ] Loading, empty, and error states are handled.
- [ ] No hardcoded colors — everything is `var(--…)`.
- [ ] Any class name built from runtime data is prefixed (e.g. `lsrc-${src}`), not a
      bare data word that could collide with a global class (see §1 antipattern).
- [ ] Labels are mono/uppercase/muted via existing classes; every number/time/
      duration/GUID value is mono, and table cells use `td.mono.tabnum`.
- [ ] Used `StatusPill` / toast where relevant. No per-page refresh or live
      indicator — auto-refresh is global (`RefreshControl` in the top nav).
- [ ] Wide tables wrapped in `.tablewrap`; grids collapse on narrow screens.
- [ ] Checked it in **both** light and dark themes.
