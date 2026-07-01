# Design: Component Builder — category filter + highlighted preview

**Date:** 2026-07-02
**Status:** Approved design. Implementation plan not yet started.
**Branch:** `feat/component-resiliency-builders`
**Builds on:** the Component Builder shipped in `docs/superpowers/plans/2026-07-01-builders-02-component.md`.

Two changes to the existing Component Builder wizard:

1. **Category filter on step 1 (Type).** Add single-select category filter buttons (one per Dapr component `type`: bindings, configuration, conversation, crypto, lock, middleware, nameresolution, pubsub, secretstores, state). Selecting a category filters the component list to that category and scopes the search box to it. The selected category + component remain visible across all wizard steps.
2. **Highlighted, read-only Preview.** Replace the editable `<textarea>` preview with the same syntax-highlighted rendering the Components detail view uses (`highlightYaml` in `<pre className="code">`), reusing that proven look. Copy + Download still act on the generated YAML.

## Decisions (from brainstorming, 2026-07-02)

- **Design A** (top category chips + read-only highlighted preview) over the master-detail/editable alternative.
- **Initial state:** before a category is chosen, show only the category chips + a hint ("Choose a category to browse components"); the search box and list appear once a category is selected. (Avoids rendering all 141 components; matches "only show components for the selected type".)
- **Switching category** after a component was chosen **clears** the selected schema and its downstream config (auth profile, field values, secret refs, added-optional) — they no longer apply.
- **Shared preview:** simplify the shared `components/YamlPreview.tsx` to read-only and **update Plan 3's plan doc** (`2026-07-01-builders-03-resiliency.md`) so the Resiliency Builder also uses the read-only preview. One component, consistent everywhere. (Plan 3 is not yet implemented, so this is a doc edit.)

## Current state (what changes)

- `web/src/pages/component-builder/StepType.tsx` — currently a search box over ALL components grouped by type. Becomes category-chip-gated.
- `web/src/pages/component-builder/reducer.ts` — gains a `category` field + `SELECT_CATEGORY` action.
- `web/src/pages/component-builder/ComponentBuilder.tsx` — gains the persistent selection bar; drops the `previewEdited` gate.
- `web/src/components/YamlPreview.tsx` — becomes read-only + highlighted; loses `edited`/`onEditedChange`/Reset and the mount-emit effect.
- Tests for all four, plus `ComponentBuilder.test.tsx` (reads a `<pre>` instead of a textbox; drops the back-then-forward Finish probe which no longer applies).

## Reuse (must match)

- YAML rendering: `lib/yaml-highlight.tsx` `highlightYaml(text)` inside `<pre className="code">…</pre>` (exactly as `ResourceDetail.tsx:87`). Read-only.
- Existing theme.css tokens: category chips use the segmented/chip styles already present (`.segs`/`.segs button[aria-pressed]`, or `.lvchips`/`.lvchip[aria-pressed]`); selection bar uses `.chip`/`.typechip`; list uses `.complist`/`.ci`/`.ci.sel`; search uses `.search`.
- `lib/clipboard.ts` `copyText`, `lib/toast.tsx` `useToast`, `lib/download.ts` `downloadText`.

## Detailed design

### Reducer (`reducer.ts`)

Add to `ComponentBuilderState`:
- `category?: string` — the active category filter on step 1 (persists across step navigation).

Add action:
- `{ type: 'SELECT_CATEGORY'; category: string }` — sets `category`. If `category !== state.schema?.type`, also clears schema-dependent state: `schema = undefined`, `version = ''`, `authProfile = undefined`, `hasAuthProfiles = false`, `values = {}`, `secretRefs = {}`, `useSecret = {}`, `optionalAdded = []`. `activeStep` stays 0.

Update `SELECT_SCHEMA`: also set `category = action.schema.type` (keep the chip in sync with the picked component). All other behavior (advance to step 1) unchanged.

`canContinue`, `assembleComponentSpec`, and every other action are unchanged.

### Step 1 (`StepType.tsx`)

- Render a single-select row of category chips from `Object.keys(byType).sort()`. The active chip = `state.category`. Clicking a chip dispatches `SELECT_CATEGORY`. Chips use `aria-pressed` for the active state and are keyboard-operable (they are `<button>`s).
- If `state.category` is undefined: render only the chips + a `.muted` hint "Choose a category to browse components." No search box, no list.
- If a category is selected: render the scoped search input (`aria-label="Search components"`, placeholder `Search {category} components…`) and the flat list (`.complist`) of `byType[category]` filtered by title/name against the query. Each row (`.ci`, `.ci.sel` when selected) dispatches `SELECT_SCHEMA` on click/Enter/Space (unchanged payload).
- Search state stays local (`useState`); it may reset when the category changes (acceptable).

### Persistent selection bar (`ComponentBuilder.tsx`)

- A bar rendered above the `Wizard` (so it shows on all four steps). When `state.category` is set, show a category chip (`.typechip`); when `state.schema` is set, also show the component: `{schema.title} · {version}` (e.g. `[ state ]  Redis · v1`). When nothing is selected yet, the bar is empty/omitted.
- Purely presentational, derived from `state`.

### Step 4 Preview (`YamlPreview.tsx` → read-only)

New props/behavior:
- `YamlPreview({ yaml, filename })` — no `onEditedChange`.
- Renders `<pre className="code">{highlightYaml(yaml)}</pre>` (read-only, syntax-highlighted).
- Buttons: Copy (`.btn.ghost`/`copybtn`, `copyText(yaml)` + `useToast().toast.show('Copied')`) and Download (`.btn.mono`, `downloadText(filename, yaml)`), acting on the generated `yaml` prop directly.
- Removes: `edited` state, `onEditedChange`, the mount-emit effect, the re-seed effect, "Reset to generated", and the internal buffer.

`ComponentBuilder.tsx`: drop `previewEdited` state and the `!previewEdited` clause; `canContinue` on step 3 is simply `true` (Finish always enabled). `YamlPreview` is passed `yaml` + `filename` only.

### Plan 3 doc update

Edit `docs/superpowers/plans/2026-07-01-builders-03-resiliency.md`: its Task 5 uses `YamlPreview` with `onEditedChange`/preview-edited gating. Update it to the read-only `YamlPreview({ yaml, filename })` API (drop `previewEdited` in `ResiliencyBuilder`, Finish always enabled on the preview step). No Plan 3 code exists yet, so this is a plan-text change only.

## Testing

- `reducer.test.ts`: `SELECT_CATEGORY` sets category; switching category clears schema + config; `SELECT_SCHEMA` sets category = schema.type.
- `StepType.test.tsx`: chips render; no-category shows the hint and no list; selecting a category shows the scoped list + search; search filters within the category; clicking a component dispatches `SELECT_SCHEMA`.
- `YamlPreview.test.tsx`: renders highlighted YAML read-only (a `<pre>`, no textbox); Copy calls copyText with the yaml; Download (`.btn.mono`) triggers a download; no Reset/edited behavior.
- `ComponentBuilder.test.tsx`: full walk Type (pick category → pick component) → Auth → Configure → Preview; assert the Preview `<pre>`/container text contains `type: state.redis` and `name: order-store`; Finish enabled on preview. Remove the back-then-forward Finish probe (no longer applicable).

## Out of scope (YAGNI)

- Inline YAML editing in the builder (removed by this change; Copy/Download + regenerate cover the need).
- Multi-select categories or an "All" category (single-select only).
- Changes to Auth/Configure steps beyond what the category-clear requires.

## Success criteria

1. Step 1 shows category filter buttons; picking one filters the list + scopes search; a hint shows before any pick.
2. The selected category + component stay visible on every wizard step.
3. Preview renders syntax-highlighted, read-only YAML matching the Components detail view; Copy + Download work.
4. Switching category resets the stale component/config.
5. All touched tests pass; `tsc -b` clean; `main` untouched.
