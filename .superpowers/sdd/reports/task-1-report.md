# Task 1 Report: Foundation & Shell

## What was implemented

### 1. Design tokens + global stylesheet (`web/src/styles/theme.css`)
- Replaced the old token block (`:root`, `:root[data-theme='light/dark']`) with the mock's `.app[data-theme=…]` scoped tokens — light and dark values verbatim from spec §1.
- Added `--mono`, `--sans`, `--sbw` font/size tokens (on `:root` for global access).
- Removed density tokens (`--row-pad`, `--font`, `--gap`) and `[data-density]` rules.
- Ported the FULL `<style>` block from both mock A and mock B into `theme.css` — union of all class groups listed in spec §2, de-duplicated. No separate `app.css` was needed.
- Kept `@media (prefers-reduced-motion: reduce)` rule.

### 2. Theme mechanism — approach (a) from spec §2
- `App.tsx` wraps the SPA in `<div className="app" data-theme={theme}>`. The `.app[data-theme="…"]` selectors are verbatim from the mock.
- `prefs.ts`: removed `setDensity`, `getDensity`, `applyPrefs` density logic. `setTheme` now only persists to localStorage (no longer sets `data-theme` on `documentElement` — the `.app` div owns it via React state).

### 3. `App.tsx`
- Replaced flex-column shell with mock layout: `.app` root holding `<TopNav/>`, `<ResourcesSidebar/>`, `<div className="body"><Outlet/></div>`.
- No `<StatusFooter/>`. `SmallScreenGuard` kept.
- Theme, collapsed, and hasNew state live in `App.tsx` and are passed down as props to children.

### 4. `TopNav.tsx`
- Renders `.topbar` with `.brand` (Logo + `.dot` + `.app-name`), `.nav` with text-only `<NavLink>` items (no Icon), `.topright` with only `<ThemeToggle/>` as `.tbtn`.
- Removed `<RefreshControl/>` and `<DensityToggle/>` from the top bar.
- `NavItem` type no longer has `icon` field.
- Theme toggle is now controlled (receives `theme`/`onThemeChange` props from App).

### 5. `ThemeToggle.tsx`
- Lifted state to `App.tsx`; ThemeToggle is now a controlled component accepting `theme: Theme` and `onThemeChange`.
- Renders as `.tbtn` with label "◐ Theme".

### 6. `ResourcesSidebar.tsx`
- Full rewrite to match mock markup: `.sidebar` > `.sbhead` (SVG bell, Resources label, `«/»` collapse button) > `.sbscroll` (news + static sections using `.sbsection`/`.sbtitle`/`.sblink`) > `.sbvert` (collapsed vertical label + bell) > `.sbfoot` (version string).
- Collapse state lifted to `App.tsx` via `onCollapsedChange` prop; `collapsed`/`hasNew` classes applied to the `.app` root in `App.tsx`.
- `has-new` class on `.app` drives bell visibility via CSS (mock approach). 
- Emoji bells replaced with mock's inline SVG bell.
- Existing news seen/unseen logic preserved; uses `useVersion` for version in footer.

### 7. `Logo.tsx`
- Added `className="dglogo"` (replacing `style={{ display: 'block', color: '…' }}`).

### 8. Deleted components
- `StatusFooter.tsx` — deleted (component + import/usage in App.tsx).
- `DensityToggle.tsx` — deleted (component).
- `DensityToggle.test.tsx` — deleted.

## Files changed
- `web/src/styles/theme.css` — full replacement
- `web/src/lib/prefs.ts` — removed density
- `web/src/App.tsx` — new shell
- `web/src/components/TopNav.tsx` — mock layout, no icons
- `web/src/components/ThemeToggle.tsx` — controlled, .tbtn
- `web/src/components/Logo.tsx` — className="dglogo"
- `web/src/components/ResourcesSidebar.tsx` — full rewrite
- `web/src/components/StatusFooter.tsx` — deleted
- `web/src/components/DensityToggle.tsx` — deleted
- `web/src/components/DensityToggle.test.tsx` — deleted
- `web/src/components/TopNav.test.tsx` — updated (no icon, no DensityToggle)
- `web/src/components/ThemeToggle.test.tsx` — updated (controlled props API)
- `web/src/components/ResourcesSidebar.test.tsx` — rewritten (lifted state wrapper, regex link names)
- `web/src/App.test.tsx` — updated (StatusFooter → does not render; data-theme on .app)
- `web/src/lib/prefs.test.ts` — updated (removed density tests)

## Test command + result
```
cd web && npm test
Test Files  34 passed (34)
Tests  128 passed (128)
```
All 128 tests pass, no warnings.

---

## Review Fixes (post-approval)

### I1 — Restore news-bell onHasNewChange contract coverage

Added a new `describe('ResourcesSidebar onHasNewChange contract')` block in `web/src/components/ResourcesSidebar.test.tsx` with three tests:
- Calls `onHasNewChange(true)` when news has unseen URLs (defaultNews with blog u1 + webinar u2, localStorage clear).
- Calls `onHasNewChange(false)` when all news URLs are pre-marked as seen in localStorage.
- Calls `onHasNewChange(false)` when the news API returns all-null slots.

Each test uses a minimal inline wrapper that passes a `vi.fn()` spy as `onHasNewChange` and renders via `QueryProvider`. The MSW server mock pattern from the rest of the file is reused.

### M2 — Remove duplicate ARIA landmark on inner nav

In `web/src/components/ResourcesSidebar.tsx`: removed `aria-label="Resources"` from `<nav className="sbscroll">`. The `<aside aria-label="Resources">` retains its label (role: `complementary`).

In `web/src/App.test.tsx`: updated the test that previously queried `getByRole('navigation', { name: 'Resources' })` to `getByRole('complementary', { name: 'Resources' })` to correctly target the `<aside>`.

### M4 — Eliminate collapsed-state flash on mount

In `web/src/App.tsx`: added `SIDEBAR_COLLAPSED_KEY` constant and `getInitialCollapsed()` function; changed `useState(false)` to `useState(getInitialCollapsed)` (lazy initializer). The very first render now has the correct collapsed value from localStorage.

In `web/src/components/ResourcesSidebar.tsx`: removed the `useEffect(() => { onCollapsedChange(readInitialCollapsed()) }, [])` mount effect and the now-unused `readInitialCollapsed` helper function. `STORAGE_KEY` remains (used by the `toggle` function for persistence on toggle). No changes to the `initialCollapsed` prop on the test `SidebarWrapper`.

### Test commands and output

```
cd web && npx vitest run src/components/ResourcesSidebar.test.tsx src/App.test.tsx
```
```
 Test Files  2 passed (2)
      Tests  33 passed (33)
   Duration  1.15s
```

```
cd web && npm test
```
```
 Test Files  34 passed (34)
      Tests  131 passed (131)
   Duration  5.41s
```

131 tests pass (128 original + 3 new contract tests). No warnings.

---

## Self-review
- **Completeness**: All §1–§3 requirements are implemented. Tokens, stylesheet (both mocks), theme mechanism (approach a), App.tsx shell, TopNav, ThemeToggle, ResourcesSidebar, Logo, StatusFooter deleted, DensityToggle deleted.
- **Quality**: CSS is verbatim from mocks. No inline `style={{}}` for mock-expressed classes. Bell SVG is exact copy from mock.
- **Discipline**: No overbuild. No page refactors (those are later tasks). RefreshControl component file kept (not deleted).
- **Testing**: Suite is green and pristine. Tests updated where components were changed or deleted. No `toHaveStyle` assertions added.

## Concerns
- The `ResourcesSidebar` now calls `useEffect` to initialise collapsed from localStorage on mount, which means the sidebar briefly renders expanded before setting collapsed from localStorage if `initialCollapsed` defaults to `false`. The test wrapper accepts `initialCollapsed` prop to test the collapsed initial state correctly.
- The `SidebarWrapper` in the test file manages the lifted state — a minor pattern change from the original tests. The key behaviour (localStorage persist, bell, news) is preserved.
- Old page files (`Applications.tsx`, `AppDetail.tsx`, etc.) still use old CSS variable names (`--text-muted`, `--border`, etc.) — these are not referenced in `theme.css` anymore. Those variables simply won't resolve (will be empty), but this does not break tests since tests don't assert inline styles. The pages are restyled in later tasks.
