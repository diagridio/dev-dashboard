# Event Pair Selection & Auto-Expand — Design

**Date:** 2026-07-01
**Status:** Approved (pending spec review)
**Builds on:** the workflow event pairing links feature (shared pair-ID chips + hover cross-highlight).

## Problem

The timeline already lets a user hover a pair-ID chip to transiently highlight a
scheduled/completion pair and click the chip to jump between the two rows. But
after jumping, the user has to manually expand the target row to see its body,
the highlight is only transient (gone as soon as the pointer leaves), and there
is no persistent indication of *which* two rows form the pair they're looking
at. This makes it hard to keep a related pair in view while reading their
input/output.

## Goal

Introduce a persistent, toggleable **selected pair** state:

1. Navigating to a paired event (via its pair-ID chip) auto-expands the target
   row's body so the user immediately sees where they landed.
2. The selected event shows a persistent highlighted **border** regardless of
   where in its header the user clicked.
3. The corresponding paired event (its scheduled/completion counterpart) shows
   the same highlight, so the relationship is obvious.
4. Clicking the selected event again clears the highlight (toggle off).

## Interaction model

**Selection drives expansion** for paired rows. At most one pair is selected at
a time.

- **Click a paired row header** (the always-visible summary/head, anywhere on
  it): if that row is already the active row of the currently selected pair,
  toggle *off* — clear the selection and collapse it. Otherwise select this
  pair (highlight both its rows) and expand this row.
- **Chip navigation** (clicking a pair-ID chip performs the existing hash jump):
  in addition to the existing scroll + pulse, the target event becomes selected
  (both rows highlighted) and its row expands.
- **Only the acted-on row expands.** Its partner is highlighted but stays
  collapsed until the user navigates to (or clicks) it.
- **Unpaired rows are unchanged** — native `<details>` expand/collapse, and they
  never participate in selection.
- **Inner controls do not toggle selection.** Clicks on the pair chip, the `#`
  copy-link button, and a child-instance link perform their own action and stop
  propagation so they never trigger the row-level selection toggle.

### Clickable toggle region

The toggle target is the row's always-visible header (`<summary>` for rows with
a body, the static head for rows without one) — not the expanded body content,
so selecting JSON text inside an open row never collapses it.

## Components & state

### `WorkflowDetail`
Owns two new state values:
- `selectedPairId: number | null` — the pair whose two rows carry the persistent
  highlight border. `null` when nothing is selected.
- `activeIndex: number | null` — the single canonical index that is
  force-expanded because it is the acted-on / navigated-to row.

Derived per row (using the existing `pairIndex` / `canonicalIndex` maps):
- `isSelected = pair != null && pair.pairId === selectedPairId` (true for BOTH
  rows of the selected pair).
- `isActive = canonicalIndex === activeIndex` (the one expanded row).

Handlers:
- `togglePairSelection(pairId, index)`: if `selectedPairId === pairId &&
  activeIndex === index` → set both to `null`; else → `selectedPairId = pairId`,
  `activeIndex = index`.
- The existing `jumpToHash` effect additionally resolves the target event's
  canonical index; if that event is part of a pair, it sets `selectedPairId` to
  the pair and `activeIndex` to that index. (Scroll + `target-pulse` behavior is
  retained unchanged.)

### `EventRow`
New props: `pairSelected: boolean` (draws the border), `isActive: boolean`
(controls expansion), and `onToggleSelect: () => void`.

- **Paired rows** render a *controlled* `<details open={isActive}>`. The summary's
  `onClick` calls `e.preventDefault()` (suppressing native toggle) and invokes
  `onToggleSelect()`. The static (body-less) paired row variant gets an
  equivalent header `onClick`.
- **Unpaired rows** keep the current uncontrolled `<details>` / static markup
  untouched.
- The pair chip, the `#` copy-link button, and the child-instance link each call
  `e.stopPropagation()` in their handlers so a click on them does not bubble to
  the header's selection toggle. (The `#` button already calls
  `preventDefault`; add `stopPropagation`.)
- A `pair-selected` class is applied to the row container when `pairSelected`.

## Styling (`theme.css`)

Reuse the single `::after` overlay introduced for hover (a positioned inset
overlay on `.ev`). Add a selected variant:

- `.ev.pair-selected::after` — a solid accent **border**
  (`border: 1.5px solid var(--accent2)`) plus a slightly stronger tint than
  hover, using the same inset geometry (`left/right: -8px; top: 4px;
  bottom: -6px; border-radius: 10px`).
- Precedence: when a row is both hovered and selected, the selected style wins
  (place `.ev.pair-selected::after` after `.ev.pair-hover::after` in the
  stylesheet, or scope so selected overrides). The hover tint remains for
  non-selected pairs.

No new elements or libraries; the border is drawn by the existing overlay
pseudo-element with different properties.

## Edge cases

- **Deselect on re-click** applies only to the active row of the selected pair.
  Clicking the *partner* (highlighted but not active) selects/expands the partner
  (moving `activeIndex`), rather than toggling off — the partner was never the
  active row.
- **Selecting a different pair** replaces the current selection (single-selection
  invariant) — no explicit clear needed.
- **Order-flip toggle (asc/desc)** does not change canonical indices, so
  `selectedPairId`/`activeIndex` remain valid and the highlight/expansion persist
  across a flip.
- **Data refetch** (react-query poll) re-renders with the same canonical indices
  for existing events; selection persists. If the selected events somehow leave
  the history, the derived `isSelected`/`isActive` simply match nothing (no
  crash); no explicit reset required.
- **Running / orphan chips** (a start with no completion yet) are still clickable
  to select+expand the single row; there is no partner to co-highlight.

## Testing

Extend `web/src/pages/WorkflowDetail.pairing.test.tsx` (Vitest +
`@testing-library/react`) at the `WorkflowDetail` level so real click/selection
wiring is exercised:

1. Clicking a paired row header selects the pair — both rows get
   `pair-selected`, and the clicked row's body is expanded (`<details open>`).
2. Clicking the same row again clears selection and collapses it.
3. Clicking a row of a *different* pair moves the selection (previous pair no
   longer `pair-selected`).
4. Navigating via a pair chip (hash change to the partner's anchor) selects the
   partner's pair and expands the partner row.
5. Clicking an unpaired row does not apply `pair-selected` and does not affect an
   existing selection.
6. Clicking an inner control (the `#` copy-link button) does not toggle
   selection.

## Out of scope

- Expanding both rows of a pair simultaneously (only the acted-on row expands).
- Multi-pair selection.
- Persisting selection across full page reloads or in the URL.
- Any change to unpaired-row behavior or to the pairing/decode logic.
