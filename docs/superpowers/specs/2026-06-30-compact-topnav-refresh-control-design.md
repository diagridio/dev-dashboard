# Compact top-nav refresh control

**Date:** 2026-06-30
**Status:** Approved design (pending spec review)

## Problem

The auto-refresh setting is already global: it lives in a single `RefreshContext`
(`web/src/lib/refresh.tsx`), is persisted to `localStorage`, and drives the
`refetchInterval` of every data hook (`useWorkflows`, `useApps`, `useActors`,
`useSubscriptions`, `useWorkflow`, …). Changing the interval or pause state on one
page immediately changes polling on every page.

However, the **control UI** to change that global setting is mounted on only two
pages — Workflows (`Workflows.tsx:291`, inside `.ctrlset`) and Workflow detail
(`WorkflowDetail.tsx:412`, inside `.refreshbar`). The other polling pages
(Applications, Actors, Subscriptions, Logs, App detail) show at most a passive
`LiveIndicator` and offer no way to pause or change the interval.

This creates two problems:

1. **Placement implies false scope.** The control sits on workflow pages, implying
   it is workflow-scoped, when it actually governs the whole app.
2. **No global access.** A user on Actors or Subscriptions cannot pause or slow
   polling without navigating to a workflow page first.

## Goal

Relocate the refresh control to the one element present on every page — the top
navigation bar — in a compact inline form, so the control's placement matches its
already-global scope. Keep passive per-page status where it adds local value.

## Non-goals

- No change to refresh **state, persistence, hooks, or polling behavior**. This is a
  UI relocation only; `RefreshContext`, `refetchMs`, and all consuming hooks are
  untouched.
- No move toward per-page refresh intervals. The architecture is already fully
  global and stays that way.

## Design

### 1. Reshape `RefreshControl` into a compact inline form

`web/src/components/RefreshControl.tsx` currently renders three loose elements for
`.ctrlset` / `.refreshbar`: a `.live` text indicator, a `.tbtn` Pause/Resume button,
and a `.select` interval picker. Both page usages are being removed, so rather than
leave a dead component, this same component is repurposed into the compact nav form.

Compact form:

```
● 3s ▾     live    — green beating dot (button) + interval dropdown
⏸ 3s ▾     paused  — static muted dot (button) + interval dropdown
```

- **The dot is the pause/resume button.** A borderless `<button>` wraps the `.beat`
  dot; clicking toggles `paused`. Preserves `data-cy="refresh-pause"`, sets
  `aria-pressed={paused}`, and uses a toggling `aria-label`
  ("Pause auto-refresh" / "Resume auto-refresh"). A `title` attribute provides a
  hover tooltip ("Auto-refresh every 3s — click to pause" / "Auto-refresh paused —
  click to resume") to retain discoverability now that the inline text label is gone.
- When `paused` (or interval is `Off`), the dot drops its animation and renders in a
  muted style so the paused state is visually obvious.
- **The interval `<select>`** is retained, keeping `data-cy="refresh-interval"` and
  `aria-label="Refresh interval"`, rendered in a smaller compact style. Options are
  unchanged: 1s / 3s / 5s / 10s / Off.
- The component is wrapped in a `<div className="refresh-compact">` container.

The component's doc comment is updated (it currently states "NOT placed in the top
bar"; it is now the top-bar control).

### 2. Mount it in `TopNav`

`web/src/components/TopNav.tsx` — add the control inside the existing `.topright`
cluster, before `ThemeToggle`:

```jsx
<div className="topright">
  <RefreshControl />
  <ThemeToggle theme={theme} onThemeChange={onThemeChange} />
</div>
```

No prop wiring is needed — `RefreshControl` reads the context directly.

### 3. Remove the two in-page controls

- `web/src/pages/Workflows.tsx` — remove `<RefreshControl/>` (line ~291) and its
  import (line ~7). The statestore chip remains in `.ctrlset`.
- `web/src/pages/WorkflowDetail.tsx` — remove `<RefreshControl/>` (line ~412) and its
  import (line ~8). The `.refreshbar` and its `lastRefreshed` timestamp remain.

### 4. Keep passive status as-is

- `LiveIndicator` on Applications, Actors, Subscriptions — unchanged. It already reads
  the context read-only and shows "refreshing every Ns" / "auto-refresh off".
- The Workflow-detail `lastRefreshed` timestamp in `.refreshbar` — unchanged.

### 5. CSS

Add to `web/src/styles/theme.css`, reusing existing design tokens
(`--accent-bright`, `--muted`, `--line`, `--text`) and the existing
`@keyframes beat`:

- `.refresh-compact` — `inline-flex`, vertically centered, small gap.
- A borderless dot-button style with a visible `:focus-visible` ring (matching the
  existing `.tbtn:focus-visible` treatment: `outline: 2px solid var(--accent2)`).
- A paused/off state where the dot is muted and not animating.
- A compact interval `<select>` style (smaller padding/font than the existing
  `.select`), scoped under `.refresh-compact`.

The existing `@media (prefers-reduced-motion: reduce)` block already governs the beat
animation; the compact dot reuses the same `.beat` class so it is covered.

### 6. Responsiveness

The control is small (dot + short dropdown) and lives in `.topright`, which is pushed
right by `margin-left: auto`. The `.nav` already uses `flex-wrap`. No new breakpoint
work is anticipated; the compact footprint is the mitigation for the limited top-bar
space that ruled out moving the full-size control.

## Testing

- **`RefreshControl.test.tsx`** — update for the new markup: assert pause/resume
  toggles via the dot button (`data-cy="refresh-pause"`, `aria-pressed`) and that the
  interval changes via the select (`data-cy="refresh-interval"`). Both test hooks are
  preserved precisely so the assertions map cleanly.
- **`TopNav.test.tsx`** — assert the refresh control renders within the bar (e.g. the
  `refresh-interval` select is present).
- **Page tests** — if any Workflows/WorkflowDetail test asserts the presence of the
  refresh control, update it to reflect the control's removal from those pages.
- Run the full `web` test suite and the type check / lint to confirm no regressions.

## Files touched

| File | Change |
| --- | --- |
| `web/src/components/RefreshControl.tsx` | Reshape into compact inline form |
| `web/src/components/TopNav.tsx` | Mount control in `.topright` |
| `web/src/pages/Workflows.tsx` | Remove control + import |
| `web/src/pages/WorkflowDetail.tsx` | Remove control + import |
| `web/src/styles/theme.css` | Add `.refresh-compact` styles |
| `web/src/components/RefreshControl.test.tsx` | Update for new markup |
| `web/src/components/TopNav.test.tsx` | Assert control present |

## Rollback

Single-commit, UI-only change. Reverting the commit restores the prior in-page
controls; no data migration or persisted-state changes are involved (the
`localStorage` keys and their semantics are untouched).
