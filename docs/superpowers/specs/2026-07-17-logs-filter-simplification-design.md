# Logs Filter Simplification — Design

**Date:** 2026-07-17
**Status:** Design — awaiting review
**Area:** `web/src/pages/Logs.tsx`, `web/src/styles/theme.css`, `web/src/pages/Logs.test.tsx`

## Problem

The Logs page presents **three equal-looking `<select>` dropdowns**:

1. **App** — pick an application
2. **Source** — `daprd + app` / `daprd only` / `app only`
3. **Control plane** — pick a control-plane service (`dapr_scheduler`, `dapr_placement`, compose-managed containers)

Nothing in the UI communicates the relationships that actually govern them:

- **App and Control plane are mutually exclusive.** `onAppChange` clears `?cp`; `onCpChange` clears `?app` (`Logs.tsx:405–432`). You are always tailing *either* an app *or* a control-plane service — the two dropdowns encode a single decision: **"what am I tailing?"**
- **Source only applies to apps.** `daprd/app/both` is meaningless when a control-plane service is selected, yet the dropdown sits there fully interactive in CP view.

So there are conceptually **two** decisions (target, then which stream within an app), presented as three peer controls with no visible coupling.

## Goals

- Reduce the three controls to their two real decisions.
- Make the app-vs-control-plane choice a single obvious control.
- Remove the Source control from view when it does not apply (control-plane view).
- **Preserve the 2-click "app → control-plane" switch** (open target, pick service).
- **Preserve every existing deep link with zero changes to their call sites.**

## Non-goals

- Changing the log streaming, merging, sorting, or level/search filtering logic.
- Changing the deep-link URL contract (`?app=`, `?cp=`, `?source=`).
- Adding new capabilities to the Logs page.

## Chosen approach (Option C)

Merge **App + Control plane** into one grouped **Target** dropdown, and replace the **Source** dropdown with a **segmented toggle** (`daprd` | `app`) that reuses the existing level-chip styling and only appears in app view.

Two other approaches were considered and rejected:

- **Keep three dropdowns, disable the inactive ones.** Disabling the *target* pair (App/CP) turns the 2-click app→CP switch into 4 clicks (clear app, then open CP), regressing the primary flow. Disabling is only safe for the Source control, which alone does not justify keeping three peers.
- **Merged Target + Source dropdown retained.** Cleaner than today but leaves Source as a dropdown that is visually identical to (and easily confused with) the Target dropdown. The segmented control reads as a sub-choice, not a peer selector.

### Target selector

A single `<select data-cy="log-target">` replaces the two dropdowns, using `optgroup`s:

```
Target ▾
  — select target —
  ── Applications ──
    order-processor
    checkout (compose:checkout)
  ── Control plane ──
    dapr_scheduler
    dapr_placement
```

- **Option value encoding.** Each option carries a kind-prefixed value: `app:<appKey>` for applications, `cp:<name>` for control-plane services. The prefix disambiguates the (theoretical) case where an app and a CP service share a name, and lets `onChange` route to the correct URL param without ambiguity. The empty placeholder value is `''`.
- **Applications** group reuses the existing `appOptions` label logic (`appId (key)` when the key differs from the appId).
- **Control plane** group reuses the existing `cpNames` derivation (static `dapr_*` fallback per mode + actionable services reported by `/api/controlplane`, deduped).
- **Empty groups are omitted.** In compose / test-containers modes with no CP services, the Control-plane `optgroup` is not rendered. Likewise the Applications group is omitted when no apps are discovered.
- **Selected value is derived from the URL**, not stored separately:
  - `?cp=<name>` set and valid → `cp:<name>`
  - else `?app=<key>` set → `app:<key>`
  - else `''`
- **onChange** parses the prefix and writes params in one `setSearchParams`:
  - `app:<key>` → set `app`, delete `cp` (leave `source` untouched)
  - `cp:<name>` → set `cp`, delete `app`
  - `''` → delete both `app` and `cp`
- The existing **`cpPending`** behavior is preserved: a `?cp=` deep link for a compose service not yet returned by `/api/controlplane` still shows "Loading…" rather than "Select a target", and lights up the dropdown once the fetch settles.

The **2-click app→CP switch** is preserved: open Target (1) → pick a service under the Control plane group (1).

### Source segmented control

The Source `<select>` is replaced by a two-chip toggle group styled with the existing `.lvchips` / `.lvchip` classes (the same visual language as the level filter):

```
( daprd | app )
```

- **Pressed state derives from `source`:**
  - `both` → both chips pressed
  - `daprd` → only `daprd` pressed
  - `app` → only `app` pressed
- **Toggle semantics.** Clicking a chip flips that stream in/out of the active set, and the new `source` is derived from the result:
  - `{daprd, app}` → `both`
  - `{daprd}` → `daprd`
  - `{app}` → `app`
  - `{}` → **disallowed.** Clicking the only-active chip is a no-op; at least one stream must stay selected. (This is the one behavioral difference from the level chips, which permit an all-off empty view — an all-off source has no meaning.)
- **Visibility.** The source control renders **only in app view** (`appId` set, not CP view, target chosen). It is entirely absent in control-plane view and before a target is chosen. This removes the "why is this dropdown here?" confusion in CP view.
- **Stream availability.** For parity with today, both chips are always shown regardless of `canStreamDaprd` / `canStreamApp`; the existing "no captured log file" card still handles the unstreamable case. (Disabling a chip when its stream is unavailable is noted as a future enhancement, out of scope here.)

### Layout

The `.logbar` order becomes:

```
[ Target ▾ ]   ( daprd | app )   [ debug info warn error ]   [ 🔍 Search… ]   [ Follow ]
                 └ app view only
```

`.logbar` already wraps (`flex-wrap: wrap`), so no layout-engine changes are needed. The source chip group needs its own small wrapper (e.g. `.srcchips`, or reuse `.lvchips` with an `aria-label="Source"`).

## Deep-link contract (unchanged)

All existing generators keep working with **no edits**:

| Source | Link | Result |
|---|---|---|
| `AppDetail.tsx:219` | `/logs?app=<key>&source=daprd` | Target = that app; source chips show `daprd` only |
| `PublishMessageDialog.tsx:70` | `/logs?app=<id>&source=app` | Target = that app; source chips show `app` only |
| `ControlPlane.tsx:169` | `/logs?cp=<name>` | Target = that CP service; source chips hidden |

`?source=` continues to be parsed via `parseEnum` against `LOG_SOURCES` with a `both` fallback (an invalid value must not blank the control). The chips render the parsed value; they never read the raw param.

## Data flow

No change to state ownership. `source`, `app`, and `cp` remain URL-derived; `activeLevels`, `search`, and `following` remain local component state. The Target dropdown and source chips are pure reflections of URL params, mutated only through the existing `setSearchParams` helpers (renamed/merged as needed):

- `onAppChange` / `onCpChange` / `clearCp` collapse into a single `onTargetChange(value: string)` that parses the `app:` / `cp:` / `''` prefix.
- `onSourceChange` is kept but now invoked by the chip toggle handler, which computes the next `source` from the active set.

## Error handling

Unchanged. The existing content-area branches (`cpPending` "Loading…", "Select an app…" → reworded "Select a target to view logs.", "no captured log file" card, per-view loading) are preserved. Only the empty-state copy that says "Select an app" is updated to "Select a target" since the control now covers both.

## Testing

`web/src/pages/Logs.test.tsx` — most tests assert on URL params and `EventSource` URLs, which are unchanged, so they keep passing. The tests that touch the DOM controls need updates:

- **Selector rename.** Tests referencing `log-app` and `log-cp` selects now drive the single `log-target` select (selecting `app:<key>` / `cp:<name>` values). "renders app and source selects in .logbar" becomes "renders target select and source chips in .logbar".
- **Source control.** The invalid-`?source=` fallback test (currently asserts the select value) now asserts chip pressed-state (`both` → both pressed). Add: toggling a chip updates `?source`; the at-least-one-on invariant (clicking the sole active chip is a no-op); source chips are absent in CP view.
- **Deep links.** Add/confirm: `?app=…&source=daprd` selects the app in Target and shows only the `daprd` chip pressed; `?cp=…` selects the CP service and hides the source chips.

New behavior is TDD'd: write the failing test for each new interaction (target routing, chip toggle, invariant, CP-view hiding) before implementing.

## Files touched

- `web/src/pages/Logs.tsx` — merge the two selects into the Target `<select>` with optgroups + prefixed values; replace the Source `<select>` with the chip toggle; collapse `onAppChange`/`onCpChange`/`clearCp` into `onTargetChange`; gate source chips to app view; reword the empty state.
- `web/src/styles/theme.css` — add a `.srcchips` wrapper if not reusing `.lvchips` verbatim; no new visual primitives.
- `web/src/pages/Logs.test.tsx` — update selectors and add the new interaction tests above.
- Follow `web/STYLEGUIDE.md` for chip/select styling and link/readability rules.
