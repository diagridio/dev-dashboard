# Frontend redesign — match the design mocks

**Status:** Draft spec
**Date:** 2026-06-28
**Scope:** `web/` (React SPA) only. No Go/backend/API changes.

## Goal

Make the dashboard frontend look **exactly** like the two design mocks:

- **Mock A — core views** (Applications, App detail, Components, Subscriptions, Actors,
  Configurations, Logs): artifact `994929af-f174-482f-bc1a-5aaaa20811b7`.
- **Mock B — workflows** (Workflow overview + Workflow detail): artifact
  `68761574-fce6-45eb-8d33-b824f7bfd739`.

Both mocks share one design system (identical token block, top bar, and Resources sidebar).
Mock B adds workflow-specific classes (timeline, filter segments, selection bar, JSON viewer,
live clock). Verbatim copies of both mocks are saved under the session `tool-results/` directory
and are the source of truth for every hex value, px size, and class name referenced below.

## Why this is a large change

The current frontend and the mock are architecturally different:

| Aspect | Current (`web/src`) | Mock |
|---|---|---|
| Styling | ~99% inline `style={{}}` objects per component | One centralized class-based stylesheet |
| Token set | `--border`, `--surface`, `--text-muted`, `--accent`, `--wf-*-bg/fg` | `--line`, `--line-soft`, `--surface`/`--surface-2`/`--raise`, `--muted`, `--faint`, `--dapr`, `--accent2`, `--run/done/fail/term/susp/pend-bg/fg` |
| Shell | flex column: TopNav + (sidebar + outlet) + **StatusFooter** | sticky 46px topbar + **fixed left sidebar** + `.body{margin-left:var(--sbw)}`; **no footer** |
| Top bar | logo + nav **with icons** + RefreshControl + **DensityToggle** + ThemeToggle | logo + `/` + "Dev Dashboard" + **text-only** nav + Theme only |
| Refresh UX | global RefreshControl in top bar | per-page `.live` indicator + `.refreshbar`/`.ctrlset` |
| Tables | inline `tableStyle/thStyle/tdStyle` | `.card` > `.tablewrap` > `table.t` / `table.wf` |

## Decisions (confirmed)

1. **Adopt the mock's stylesheet.** Port the mock CSS verbatim into a global stylesheet +
   token set, and convert components to use `className`. Do **not** keep the inline-style
   architecture.
2. **Match the top bar / chrome exactly.** Remove the **Density toggle**, remove the global
   **RefreshControl** from the top bar, and remove the bottom **StatusFooter**. Refresh
   controls move into page headers (`.live`, `.refreshbar`, `.ctrlset`). Top bar = logo +
   `/ Dev Dashboard` + nav + `◐ Theme`.
3. **Text-only nav.** Remove per-item icons from the top nav.

## Out of scope

- Backend/API, data shapes, hooks (`useApps`, `useWorkflows`, …) — behavior unchanged.
- New features. The news bell, live wall-clock, expandable history, copy-to-clipboard,
  level filtering, search, and bulk purge/force-delete all already exist functionally; this
  spec only changes their **appearance** to match the mock.
- The `Icon` component may become unused after the nav change — see §10.

---

## 1. Design tokens (`web/src/styles/theme.css`)

Replace the current token block with the mock's. The mocks scope tokens under `.app[data-theme=…]`;
we already toggle `data-theme` on `:root`, so define them on `:root[data-theme=…]` (and keep
`:root` defaulting to light). Keep the existing `data-theme` mechanism in `prefs.ts`.

**Light (`:root`, `:root[data-theme='light']`):**
```
--bg:#F4F6F8; --surface:#FFFFFF; --surface-2:#F9FAFB; --raise:#FFFFFF;
--line:#DFE3E8; --line-soft:#ECEFF2;
--text:#212B36; --muted:#637381; --faint:#919EAB;
--link:#007AD3; --dapr:#0D2192; --accent2:#0A8A6E; --primary:#0BDDA3;
--run-bg:#E4F4FE; --run-fg:#0a6ebd;  --done-bg:#E3FBEA; --done-fg:#0a8a2c;
--fail-bg:#FCE4EB; --fail-fg:#b30a45; --term-bg:#EEF1F4; --term-fg:#5c6770;
--susp-bg:#F0E8FF; --susp-fg:#6b21d6; --pend-bg:#FBF8D6; --pend-fg:#6e6800;
/* YAML highlight (mock A) */ --yk:#637381; --ys:#0a8a2c; --yc:#919EAB;
/* JSON highlight (mock B) */ --jkey:#637381; --jstr:#0a8a2c; --jnum:#b06a00; --jpun:#919EAB;
--shadow:0 1px 2px rgba(16,24,40,.06),0 8px 24px rgba(16,24,40,.06);
```

**Dark (`:root[data-theme='dark']`):**
```
--bg:#161C24; --surface:#1B232D; --surface-2:#212B36; --raise:#252f3a;
--line:#2A333D; --line-soft:#222b34;
--text:#F2F5F7; --muted:#94A1AD; --faint:#6B7682;
--link:#63B8F6; --dapr:#3EA9F5; --accent2:#2FE3AD; --primary:#0BDDA3;
--run-bg:#0c3450; --run-fg:#7cc6ff;  --done-bg:#0c3a1c; --done-fg:#5fdd86;
--fail-bg:#421321; --fail-fg:#ff8198; --term-bg:#2a323b; --term-fg:#aab4be;
--susp-bg:#2b1b46; --susp-fg:#c4a0ff; --pend-bg:#332f0a; --pend-fg:#d8d24a;
--yk:#8aa0b3; --ys:#8fd6a8; --yc:#6b7682;
--jkey:#8aa0b3; --jstr:#8fd6a8; --jnum:#e6c07b; --jpun:#6b7682;
--shadow:0 1px 0 rgba(255,255,255,.02),0 8px 24px rgba(0,0,0,.35);
```

**Fonts** (define as tokens so all components share them):
```
--mono:ui-monospace,"SF Mono",SFMono-Regular,"JetBrains Mono",Menlo,Consolas,monospace;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
--sbw:240px;  /* sidebar width; .collapsed → 44px; ≤760px → 44px */
```

**Token migration map** (old → new), to apply mechanically across all files:

| Old | New |
|---|---|
| `--border` | `--line` |
| `--border-soft` | `--line-soft` |
| `--surface` (as page bg) | `--surface-2` (zebra/headers) or `--surface` (cards) — see usage |
| `--text-muted` | `--muted` |
| `--text-faint` | `--faint` |
| `--accent` | `--accent2` |
| `--ok` / `--warn` / `--bad` | `--done-fg` / `--pend-fg` / `--fail-fg` |
| `--wf-running-bg/fg` … | `--run-bg/fg`, `--done-…`, `--fail-…`, `--term-…`, `--susp-…`, `--pend-…` |
| `--dapr-accent` | `--dapr` |

**Remove** the density tokens (`--row-pad`, `--font`, `--gap`) and the `[data-density]` rules
(density is dropped — §3). Keep the `@media (prefers-reduced-motion: reduce)` rule.

## 2. Global stylesheet

Port the mock's full `<style>` block into the global stylesheet (extend `theme.css` or add
`web/src/styles/app.css` imported once in `main.tsx`). The mock scopes everything under `.app`;
either (a) wrap the SPA root in `<div className="app" data-theme={…}>` and keep the `.app …`
selectors verbatim, or (b) drop the `.app` prefix and attach `data-theme` to that same root.
**Recommended: (a)** — lets us paste the mock CSS verbatim and minimizes transcription error.

Class groups to port verbatim (names must match the mock exactly so components can reference them):

- **Shell:** `.topbar`, `.brand`/`.mark`/`.wm`/`.dot`/`.app-name`, `.nav`/`.nav a`/`.nav a.active`,
  `.topright`, `.tbtn`, `.sidebar`/`.sbhead`/`.sbtoggle`/`.sbscroll`/`.sbsection`/`.sbtitle`/
  `.sblink`/`.sbfoot`/`.sbvert`, bell (`.bellbtn`/`.badge`), `.body`.
- **Page frame:** `.page` (max-width 1240px, centered), `.phead`/`h1`/`.sub`, `.live`/`.beat`
  (+ `@keyframes beat`), `.crumbs`/`.sep`/`.cur`, `.sec-title`/`.sech`.
- **Primitives:** `.card`, `.tablewrap`, `table.t` (th/td/`.click`), `.pill` + `.s-run/.s-done/
  .s-fail/.s-term/.s-susp/.s-pend`, `.health`/`.led`(`.ok/.warn/.bad`), `.lang`/`.sw`, `.chip`
  (`.k`/`.link`), `.typechip`, `.appref`, `.mono`/`.muted`/`.faint`/`.b`/`.tabnum`, `.kebab`,
  `.stats`/`.stat`/`.n`/`.l`(`.mint`), `.select`, `.search`, `.btn`(`.primary/.ghost/.danger`),
  `.copybtn`, `.toast`, `.hint`, `.none`, `.hidden`.
- **App detail:** `.twocol`, `.panel`/`.ph`/`.ic`, `.kv`/`.kk`/`.vv`, `.paths`, `.compchips`.
- **Master-detail (components/configs):** `.md`, `.complist`, `.ci`(`.sel`/`.cn`/`.ct`),
  `pre.code` + `.yk/.ys/.yc/.yd`.
- **Logs:** `.logbar`, `.lvchips`/`.lvchip`, `.followbtn`, `.logwin`, `.logrow`(`.error`),
  `.ltime`/`.lvl`(`.info/.debug/.warn/.error`)/`.lsrc`(`.daprd`/`.app`)/`.lmsg`, `.hl`, `.logfoot`.
- **Workflows (mock B):** `.refreshbar`/`.clock`(`.stopped`)/`.lbl2`, `.ctrlset`, `.filters`/
  `.segs`(`button[aria-pressed]`/`.n`), `table.wf`, `.wfname`/`.iid`/`.appcell`/`.dprchip`,
  `.cbx`(`.on`)/`tr.sel`, `.selbar`/`.cnt`/`.grow`, `.pager`/`.pgbtns`, `.dhead`/`.dtitle`/
  `.dactions`, `.metagrid`/`.m`(`.span2`)/`.k`/`.v`, `.io`, `pre.json` + `.json .k/.s/.n/.p/.b`,
  `.pendingout`, `.timeline`/`.ev`/`.t`(`.abs`)/`.rail`/`.node`(`.n-start/.n-sched/.n-done/
  .n-fail/.n-timer/.n-end/.n-endfail`)/`.c`, `details.evd`/`summary`/`.evtype`/`.evname`/
  `.evtag`/`.caret`/`.evbody`/`.lbl`, `.retrybadge`, `.err`, `.copy`.

## 3. App shell — `App.tsx`, `TopNav.tsx`, `ResourcesSidebar.tsx`, remove `StatusFooter`

**`App.tsx`** — replace the flex-column shell with the mock's layout:
- Root `<div className="app" data-theme={theme}>` (theme from `prefs.ts`; collapse class toggled
  by the sidebar — see below; add `has-new` when unseen news exists, `collapsed` when collapsed).
- Order: `<TopNav/>`, `<ResourcesSidebar/>` (fixed, left), then
  `<div className="body"><Outlet/></div>`. **No `<StatusFooter/>`.**
- Each page renders its own `<div className="page">` wrapper (move the page padding out of
  ad-hoc inline containers into `.page`).
- Keep `SmallScreenGuard` (the mock collapses the sidebar at ≤760px; the guard's existing
  small-screen message behavior is unchanged unless we decide otherwise — leave as-is).

**`TopNav.tsx`** — render `.topbar`:
- `.brand`: `<Logo height={21}/>` + `<span className="dot">/</span>` +
  `<span className="app-name">Dev Dashboard</span>`.
- `.nav`: map `NAV_ITEMS` to `<NavLink className={({isActive})=> 'nav-a' + (isActive?' active':'')}>`
  with **label text only** — drop `<Icon>`. Use the `.nav a` / `.nav a.active` styles. (NavLink
  renders an `<a>`, so the `.nav a` selector applies; add the `active` class via the callback.)
- `.topright`: only `<ThemeToggle/>` styled as `.tbtn` showing `◐ Theme`.
- **Remove** `<RefreshControl/>` and `<DensityToggle/>` from here.

**`ResourcesSidebar.tsx`** — render the mock `.sidebar` markup:
- `.sbhead` (bell `#bell-h` + `Resources` label + `.sbtoggle` collapse button),
  `.sbscroll` with `.sbsection`/`.sbtitle`/`.sblink` (News fed by `useNews`; Build/Learn/Read/
  Run & Operate are the static links already present), `.sbvert` (collapsed vertical label +
  `#bell-v`), `.sbfoot` (`Dapr Dev Dashboard · v<version>`).
- Collapse state stays in `prefs`/localStorage; toggling sets `collapsed` on the `.app` root
  (lift the class to `App.tsx` via shared state/context, or keep a `data-collapsed` on `.app`).
- Bell visibility driven by `has-new` on `.app` (from `newsSeen.ts`); preserve existing
  seen/unseen logic, only restyle.
- Replace the current `›/‹` glyphs with the mock's `«/»`; replace emoji bell with the mock's
  inline SVG bell.

**`StatusFooter.tsx`** — **delete** the component and its usage/import/tests. The version string
moves to `.sbfoot`. The health/status that lived in the footer is represented per-page by
`.live` indicators and (on Workflows) the `.chip` statestore indicator.

## 4. Shared component restyle

- **`StatusPill.tsx`** → render `<span className={'pill ' + cls}>` where `cls` maps status →
  `s-run|s-done|s-fail|s-term|s-susp|s-pend`. Text is **UPPERCASE** in the mock (`RUNNING`,
  `COMPLETED`, …). Drop inline `--wf-*` styles.
- **`ThemeToggle.tsx`** → `.tbtn` with `◐ Theme` label (keep toggle behavior + aria).
- **`RefreshControl.tsx`** → repurpose as the page-level control used inside `.refreshbar`/
  `.ctrlset`: a `.live` "refreshing every Ns" indicator, a `.tbtn` `⏸ Pause`, and a `.select`
  interval picker. Keep the existing refresh-interval state/logic (`lib/refresh.tsx`); only the
  markup/placement changes. It is consumed by page headers, not the top bar.
- **`DensityToggle.tsx`** → **delete** (component, usage, test); density tokens removed in §1.
- **`Logo.tsx`** → unchanged (already the Diagrid SVG; `.dglogo` color rules in CSS handle
  light/dark — add `className="dglogo"` and let the stylesheet set color).

## 5. Applications — `pages/Applications.tsx`

Match Mock A "Applications":
- `.page` > `.phead` (`<h1>Applications</h1>` + `.sub` "Dapr apps & sidecars discovered on this
  machine"; right side `.live` "refreshing every Ns").
- **`.stats` row** (NEW): stat cards — Apps running (`.n.mint`), Healthy, Starting,
  Components loaded, Run template (mono). Derive counts from `useApps`/`useMeta`.
- `.card` > `.tablewrap` > `table.t.click`. Columns: **Health, App ID, Runtime, App port, HTTP,
  gRPC, daprd PID, App PID, Age, Run template, ⋯**. (Adds Run-template + kebab columns vs current.)
  - Health = `.health` + `.led.ok/.warn/.bad`.
  - Runtime = `.lang` + `.sw` color swatch by language.
  - Numeric cells `.mono.tabnum`; missing values render em-dash `.faint`.
  - Row click → app detail (keep current navigation).
- `.hint` line at the bottom.

## 6. App detail — `pages/AppDetail.tsx`

Match Mock A "App + daprd detail":
- `.crumbs` (Applications / `<app id>` as `.cur`).
- `.phead`: `<h1>` app id + `.health` + `.lang`; right side `.tbtn` "← Back" and "View logs".
- **`.twocol`** grid → two `.panel`s:
  - "Application" panel (`.ic` `A` on `--surface-2`/`--accent2`): `.kv` rows Runtime / App port /
    App protocol / App PID / CLI PID / Command.
  - "Dapr sidecar (daprd)" panel (`.ic` `d` on `--dapr`): `.kv` rows Runtime ver. / HTTP port /
    gRPC port / Metrics port / daprd PID / Placement (`.health`).
- `.panel.paths`: `.kv` of Resources / Config / App log / daprd log — each `.vv.mono` click-to-copy
  (reuse `lib/clipboard.ts`; toast on copy).
- `.sec-title` "Loaded components" + `.panel` > `.compchips` of `.chip.k.link` (name + `.muted`
  type) linking to the component in Components view.
- Keep the metadata-unavailable degradation, restyled as a `.panel`/`.hint` note.

## 7. Actors — `pages/Actors.tsx`

Match Mock A "Actors":
- `.phead` + `.live`.
- **`.stats`**: Active actors (`.mint`), Actor types, Hosting apps, Placement connected
  (`.health.led.ok`).
- `table.t` columns: **Host app, Actor type, Active, Idle timeout, Reminders, Placement**.
  Internal types get a `.tag-int` "internal" badge.
- Preserve the existing `?appId=` filter affordance, restyled (e.g. a `.chip` with a clear `×`).
- `.hint` footer.

## 8. Subscriptions — `pages/Subscriptions.tsx`

Match Mock A "Subscriptions":
- `.phead` + `.live`.
- `table.t` columns: **App, Pub/Sub, Topic, Route(s), Dead-letter topic, Scopes**.
  - Route(s): `.route` + optional `.rulebadge` "N rules".
  - Dead-letter: `.dlq` (red mono) or `.none` em-dash.
  - Scopes: `.appref` chips or `.none`.
- `.hint` footer. Preserve `?appId=` filter, restyled.

## 9. Components & Configurations — `pages/ResourceList.tsx` + `pages/ResourceDetail.tsx`

**Decision: restructure to master-detail** (`.md`) — one route per kind, matching the mock's
side-by-side layout (no separate detail route as the primary UX).

- Layout: `.md` grid (`grid-template-columns:300px 1fr`, →1col ≤820px) inside the `.page`.
  - **Left** `.card.complist`: one `.ci` per resource (`.cn` name + `.ct` "type · vN"). The
    selected item gets `.ci.sel`. Clicking a `.ci` swaps the right pane.
  - **Right** `.card`: a header row (`.ph`) with mono meta + `loaded by`/`used by` `<appref.link>`
    list + `.copybtn` "⧉ Copy YAML" (`margin-left:auto`), then `pre.code` highlighted YAML for the
    selected item.
- **Routing / deep-links:** keep a route that addresses a specific resource (e.g.
  `/components/:name`, `/configurations/:name`) so links from App detail's `.compchips` and
  cross-references still work. That route renders the **same** master-detail container with the
  named item preselected; the bare `/components` route preselects the first item. Selecting an
  item updates the URL (so the right pane is shareable/back-button-friendly) without a full
  navigation. Use a `?name=`/path param via `react-router`.
- **File roles:** `ResourceList.tsx` becomes the master-detail container (renders both panes for a
  kind); `ResourceDetail.tsx`'s YAML/loaded-by rendering becomes the **right-pane** subcomponent
  reused by the container. If `ResourceDetail` no longer needs to be its own routed page, fold it
  into the container; otherwise keep it as the right-pane component only.
- **Selection state:** derived from the URL param (single source of truth), defaulting to the
  first item. Empty kind → render the `.md` with an empty `.complist` and a `.hint`/`.none` right
  pane.

Components right-pane meta = "`<type> · vN · loaded by` `<appref.link>…`"; Configurations meta =
"Configuration · used by `<appref.link>…`". `.appref.link` navigates to the app detail.

## 10. YAML / JSON highlighters — `lib/yaml-highlight.tsx` (+ new JSON helper)

- **YAML:** change the highlighter to emit the mock's classes instead of inline colors:
  keys → `<span className="yk">`, strings/values → `ys`, comments → `yc`, and Dapr/boolean
  literals → `yd` (the `--dapr` color, e.g. `true`/`false` in Configurations). Wrap output in
  `pre.code`. (Current emits inline `var(--link)`/`var(--text)`/`var(--text-faint)` — replace.)
- **JSON (workflow input/output/custom status & event payloads):** the mock renders highlighted
  JSON in `pre.json` with `.k/.s/.n/.p/.b`. Add a small JSON highlighter (mirror the YAML one)
  or render via the same mechanism. Used by WorkflowDetail (§12).

## 11. Logs — `pages/Logs.tsx`

Match Mock A "Logs":
- `.phead` (`<h1>Logs</h1>` + `.sub` "Tailing `<app>` · daprd + application") + `.live`
  "live tail (SSE)".
- **`.logbar`:** app `.select`, source `.select` (daprd + app / daprd only / app only),
  `.lvchips` of `.lvchip[aria-pressed]` (debug/info/warn/error), `.search` (🔍 + input),
  `.followbtn.on` ("● Following"). Keep existing filter/search/follow logic.
- `.card` (padding 0) > `.logwin` of `.logrow` (grid `104px 60px 124px 1fr`):
  `.ltime` · `.lvl.{info|debug|warn|error}` · `.lsrc.{daprd|app}` · `.lmsg`. Error rows get
  `.logrow.error`; search matches wrapped in `.hl`.
- `.logfoot`: line count · highlight summary · tail size. `.hint` footer.

## 12. Workflows — `pages/Workflows.tsx` + `pages/WorkflowDetail.tsx`

**Overview (`Workflows.tsx`)** — Mock B "overview":
- `.phead`: `<h1>Workflow executions</h1>` + `.sub` "Across N apps · newest first"; right
  `.ctrlset` = `.chip` statestore (`<led/> statestore <b>redis</b>`), `.live` refreshing,
  `.tbtn` ⏸ Pause, `.select` interval.
- **`.filters`:** `.segs` status group (All / Running / Completed / Failed / Terminated /
  Suspended, each with `.n` count, `aria-pressed`), app `.select`, `.search`. Replaces the
  current row of toggle buttons.
- `.card` containing:
  - `.selbar` (shown when rows selected): `.cbx.on` select-all, `.cnt` "N selected", spacer,
    `.btn.ghost` "Purge via Dapr API", `.btn.danger` "Force delete…". Wire to existing
    `useWorkflowRemoval` + `ConfirmRemoveDialog`.
  - `.tablewrap` > `table.wf`. Columns: **☐, Status, Workflow, Instance ID, App, Created,
    Duration, Last event, ⋯**. Checkbox = `.cbx`/`.cbx.on`; selected rows `tr.sel`;
    status `.pill.s-*`; instance id `.iid`; failed last-event `.err`.
  - `.pager`: "1–N of M" + `.pgbtns` Prev/Next. (Current uses a "Load more" token button —
    restyle to the pager; if the API only supports forward tokens, keep Next enabled and Prev
    disabled, or keep load-more semantics behind the `.pgbtns` styling.)
- `ConfirmRemoveDialog.tsx`: restyle as a centered modal using `.card`/`.btn` classes; keep logic.

**Detail (`WorkflowDetail.tsx`)** — Mock B "detail":
- `.crumbs` (Workflows / app id / `.cur` instance-id-short).
- `.dhead`: `.dtitle` = `.pill.s-*` status + `<h1>` workflow name + `.clock` live elapsed
  (`.clock.stopped` when terminal); `.dactions` = `.btn.ghost` "← Back", `.btn.ghost`
  "Purge via Dapr API" (enabled only in terminal state), `.btn.danger` "Force delete…".
- `.refreshbar`: `.live` auto-refreshing + `.tbtn` ⏸ Pause + interval `.select` + "updated …".
- **`.metagrid`** (4-col): Instance ID (`.span2`, mono + copy), App ID (`.span2`), Created,
  Ended, Duration, Last updated, Replays, Events, Last event (`.span2`).
- **`.io`** (2-col): Input `.panel` (`pre.json`) and Output `.panel` (`.pendingout` while
  running, else `pre.json`). Each `.ph` has a `tagdot` + `.copybtn`.
- Optional `.panel#d-custom` "Custom status" (shown only when set), `pre.json`.
- **Event history `.timeline`:** `.sech` header + count; each event = `.ev` grid
  (`96px 26px 1fr`): `.t` (rel time + `.abs` clock), `.rail` + `.node.n-*` (start/sched/done/
  fail/timer/end), `.c` > `details.evd` (`summary` with `.caret`/`.evtype`/`.evname`/`.evtag`;
  `.evbody` with `.lbl` + `pre`). Map current `HistoryRow` expand/collapse onto `details/summary`.
  Newest-event reveal uses `.ev.reveal` (`@keyframes fadein`). Retries → `.retrybadge`.
- Keep the live elapsed timer (`lib/wallclock.ts`) and existing copy affordances.

## 13. Responsive / motion

- Sidebar: 240px → 44px collapsed; auto-collapse ≤760px (mock media query). `.body` margin
  follows `--sbw`.
- Grids degrade per mock: `.twocol`/`.io`→1col ≤760/720px; `.md`→1col ≤820px;
  `.metagrid`→2col ≤640px.
- `table.wf` has `min-width:880px` inside `.tablewrap` (horizontal scroll on narrow screens).
- All `@keyframes` (`beat`, `fadein`) honor `prefers-reduced-motion` (already globally guarded).

## 14. Testing impact

Existing tests query by **role/text**, not by inline style or className (no `toHaveStyle`
usage), so most are unaffected. Specific updates required:

- **Delete** `DensityToggle.test.tsx`, `StatusFooter` test/usage, and any assertion of the
  removed top-bar controls.
- `TopNav.test.tsx`: update for text-only nav (no icon) and removal of Refresh/Density controls.
- Tests asserting visible labels that change (e.g. status text now UPPERCASE in pills, "Load
  more" → pager, footer version → sidebar) must be updated to the new strings.
- Add/adjust tests where layout-driving roles change (e.g. status `<select>`/segmented filter on
  Workflows; `details/summary` for history rows).
- `yaml-highlight.test.tsx`: update expected class names (`yk/ys/yc/yd`); add a JSON-highlight test.
- Run `make test-web` (Vitest) after each phase; `make test` before completion.

## 15. Suggested sequencing

Each phase ends green (`make test-web`) and is independently reviewable.

1. **Tokens + global stylesheet + `.app` shell wrapper** (theme.css/app.css; `App.tsx`,
   `TopNav.tsx`, `ResourcesSidebar.tsx`; delete `StatusFooter`, `DensityToggle`). Visual parity
   of chrome; pages temporarily wrapped in `.page` with old inner markup.
2. **Shared primitives**: `StatusPill`, `ThemeToggle`, `RefreshControl` (page-level), table
   classes, `.stats`, `.chip`/`.appref`, YAML→`pre.code`/JSON highlighter.
3. **Core list pages**: Applications, Actors, Subscriptions.
4. **Detail + master-detail**: AppDetail, Components/Configurations (`.md`).
5. **Logs**.
6. **Workflows overview** (`.filters`/`.segs`/`table.wf`/`.selbar`/`.pager`).
7. **Workflow detail** (`.metagrid`/`.io`/`.timeline`).
8. Cleanup: remove dead code (`Icon` if unused, density logic, leftover inline style objects),
   final `make test`, and a manual light/dark pass against both mocks.

## 16. Acceptance

- Every view visually matches its mock in **both** light and dark themes (spot-check against the
  saved mock HTML): same layout, spacing, colors, typography, pills, and component structure.
- Top bar = logo + `/ Dev Dashboard` + text-only nav + `◐ Theme`; no Density toggle, no global
  RefreshControl, no bottom footer.
- Sidebar collapse, theme toggle, news bell, refresh/pause, log filtering/search/follow, workflow
  filters/selection/purge/force-delete, live wall-clock, and copy-to-clipboard all still work.
- `make test` and `make test-web` pass; no remaining references to deleted tokens/components.
