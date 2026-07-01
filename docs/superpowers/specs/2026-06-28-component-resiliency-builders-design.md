# Design: Component Builder & Resiliency Builder

**Date:** 2026-06-28 (reconciled 2026-07-01)
**Status:** Approved design. Backend catalog endpoint already shipped (see "Backend"). Frontend wizards not yet started; implementation plan in progress.

Port cloudgrid's **Component Builder** and **Resiliency Builder** into `dev-dashboard` as two
multi-step wizards that generate Dapr YAML you can copy or download.

- **Source:** `cloudgrid/services/admingrid/web/packages/cloud-ui-shared/components/{component-configurator,resiliency-builder}/` (React 19 + MUI + react-hook-form + Yup + js-yaml + Ace).
- **Target:** `dev-dashboard` (Go backend + **React 19** frontend in `web/`; upgraded from React 18 on 2026-06-30).

## Reconciliation notes (2026-07-01)

Verified against `main` before planning:
- **Frontend is React 19** (not 18 as originally written).
- **Backend catalog endpoint is already implemented and merged** — the "Backend" section below is now a reuse note, not work to do.
- **Reusable frontend pieces already exist** (see "Already in the repo") — the plan reuses `Modal.tsx` rather than creating a new `Dialog.tsx`, and generalizes the existing `useComponentCatalog.ts`.
- The existing `MetadataField.type` union is `'string' | 'number' | 'bool' | 'duration'` (not `boolean|json`), and `ComponentMetadataSchema` currently omits `authenticationProfiles`; the builder must extend these (see "Types").

## Locked decisions

- **Scope:** both builders, one spec.
- **Tech approach:** lightweight — match dev-dashboard conventions. Controlled components, manual
  validation. NO MUI, react-hook-form, Yup, Ace, i18n, notistack.
- **One new dependency approved:** `js-yaml` (emission only, `dump()`).
- **Schema source:** Go backend embeds `component-metadata-bundle.json` (mirrors cloudgrid), served
  at `GET /api/metadata/components`, fetched via TanStack Query.
- **Output:** copy + download YAML. **Editable** YAML finalizer (not read-only).
- Scopes/targets are NOT auto-populated from running apps (free-text in v1).

## Guiding principle

Port cloudgrid's logic, data model, and UX flow; reimplement the UI on dev-dashboard's stack:
vanilla-CSS theme tokens (`web/src/styles/theme.css`), controlled components, TanStack Query,
React Router v6.

## Target repo conventions (must match)

- React 19 + TS + Vite, React Router v6 (routes in `web/src/router.tsx`).
- Styling: vanilla CSS, semantic tokens in `theme.css` (`.card`, `.btn`/`.btn.primary`/`.btn.ghost`/
  `.btn.danger`, `.select`, `.pill`, `.code`, `.md` master-detail, `.kv`, `.ph`). Light/dark via
  `data-theme`.
- Data fetching: TanStack Query v5; `lib/api.ts` `fetchJSON`/`apiUrl` (base = `BASE_URL + /api`);
  hooks in `web/src/hooks/`.
- Forms: controlled components, no form/validation library.
- Reuse existing bits: `lib/yaml-highlight.tsx` (`highlightYaml`), `lib/clipboard.ts` (`copyText`),
  `lib/toast.tsx` (`useToast`), `components/ConfirmRemoveDialog.tsx` (modal pattern: focus trap +
  Escape).
- Tests: Vitest + Testing Library, colocated `*.test.tsx`. Go: golden tests via `internal/golden`.
- Directory layout: `pages/`, `components/`, `hooks/`, `lib/`, `types/`.

## Backend — catalog endpoint (ALREADY SHIPPED — reuse, do NOT re-port)

Verified present on `main` as of 2026-07-01:
- `pkg/metadata/metadata.go` — `go:embed component-metadata-bundle.json`, serves raw JSON with
  ETag/304 + `Cache-Control` via `HandleGetComponents`. `metadata.Init()` is wired in `cmd/root.go`.
- Route registered in `pkg/server/api.go` (chi): `r.Get("/metadata/components", metadata.HandleGetComponents)`,
  reachable at `GET /api/metadata/components`.
- `scripts/update-component-metadata-bundle.sh` present (refreshes bundle from
  `diagridio/dapr-components-contrib` release assets).
- Unit test (`pkg/metadata/metadata_test.go`) + golden (`golden_test.go`, `testdata/`) present.

The frontend builders reuse this endpoint as-is. **No backend work is required** unless the
`authenticationProfiles` gap below needs the bundle re-generated to include that field.

## Already in the repo (reuse, don't rebuild)

- `web/src/types/metadata.ts` — `MetadataField { name; type?: 'string'|'number'|'bool'|'duration';
  description?; required?; sensitive?; default?; example?; allowedValues?; url?: {title,url} }`,
  `ComponentMetadataSchema { type; name; version; title; status; description?; metadata? }`,
  `MetadataBundle { schemaVersion; date; components[] }`. **Gap:** no `authenticationProfiles` field —
  the builder must extend `ComponentMetadataSchema` (and likely the bundle) to carry auth profiles.
- `web/src/hooks/useComponentCatalog.ts` — fetches `/metadata/components` (TanStack Query, 1h
  staleTime). **Currently narrowed** to `type === 'state'` + supported store names, and injects a
  synthetic `connectionString` field for pg/sqlite (because auth profiles are absent). The full
  builder must **generalize** it: expose all component types, drop the state-only filter (or make it
  optional), and replace the synthetic-field hack with real `authenticationProfiles` handling once
  the schema carries them.
- `web/src/components/Modal.tsx` — backdrop + `role="dialog"` + `aria-modal` + Escape-to-close +
  initial focus. **Reuse this** for add/edit forms instead of creating a new `Dialog.tsx`.
  Caveats to address when reused for multi-instance forms: it hardcodes `id="modal-title"` /
  `aria-labelledby="modal-title"` (fine for one-at-a-time), and it focuses the container but is not a
  full focus-trap — add a trap if a builder form needs it.
- `web/src/components/MetadataFieldInput.tsx` — per-field control (reuse for the Configure step's
  metadata editor).

## Routing & entry points (frontend) — decided 2026-07-01

**Placement: contextual button for the Component Builder + a new top-level "Resiliency" nav for the
Resiliency Builder** (chosen over a unified "Create" hub because it mirrors Dapr's per-kind resource
model — Resiliency is a first-class CRD sibling of Component/Configuration — and is forward-compatible
with listing discovered resiliency policies later).

**Component Builder**
- Route in `router.tsx`: `{ path: 'components/new', element: <ComponentBuilder /> }`, added **before**
  the existing `components/:name` route. Static `new` outranks the dynamic `:name` param in React
  Router v6, so `/components/new` resolves to the builder, not the detail view.
- Entry point: a **`+ New component`** button (`.btn.primary`) in the Components `ResourceList`
  `.phead` header, present in all three render states (loading, empty, populated). `.phead` is already
  `display:flex; justify-content:space-between`, so the button sits top-right of the title block.
  Clicking navigates to `/components/new`.

**Resiliency Builder**
- New top-nav item: add `{ label: 'Resiliency', to: '/resiliency' }` to `NAV_ITEMS` in
  `components/TopNav.tsx`, positioned **between `Configurations` and `Logs`**.
- Routes in `router.tsx`:
  - `{ path: 'resiliency', element: <Resiliency /> }` — a new **create-only landing page** that
    reuses the `.page`/`.phead` + `.md` master-detail empty-state pattern from `ResourceList`: shows
    a `+ New resiliency policy` button in the header and a "No resiliency policies" hint in the body.
    (v1 lists nothing; the page exists as the discoverable home and a forward-compatible seam for
    listing discovered policies later.)
  - `{ path: 'resiliency/new', element: <ResiliencyBuilder /> }` — the wizard.
- Entry point: the `Resiliency` nav item → `/resiliency` → `+ New resiliency policy` button →
  `/resiliency/new`.

**On finish/cancel:** both wizards return to their origin list (`/components` and `/resiliency`
respectively).

## Shared frontend infrastructure (built once, used by both)

- `components/wizard/`: `Wizard` + `Stepper` (step labels styled with pill/tab classes) + `StepNav`
  (Back/Continue/Finish). Per-builder typed `useReducer` for wizard state (mirrors cloudgrid reducer
  shape: activeStep, steps, config object, etc.).
- **Wizard button styling — monochrome, NOT green (decided 2026-07-01):** the wizard buttons must not
  use the green brand `.btn.primary` (`background: var(--accent2)`). Do NOT change the global
  `.btn.primary` (used elsewhere, e.g. the state-store dialog). Instead add a **wizard-scoped**
  monochrome treatment: primary action (Continue/Finish) = filled neutral
  (`background: var(--text); color: var(--bg)`, no accent color); secondary (Back/Cancel) = the
  existing `.btn.ghost` (transparent, `--line` border, `--text`). Copy/Download in the finalizer also
  use the neutral/ghost styles — no green. Keep focus-visible outlines as-is. This applies to both
  builders and any dialog buttons inside them.
- `components/form/`: thin controlled wrappers over native elements styled via theme.css — `Field`
  (label + control + inline error), `TextInput`, `NumberInput`, `SelectInput`, `Toggle`. No form
  library.
- **Reuse `components/Modal.tsx`** (already exists — backdrop + `role="dialog"` + `aria-modal` +
  Escape + initial focus) for add/edit forms (policies, targets). Do NOT create a new `Dialog.tsx`.
  Add a focus-trap only if a form needs it, and give the title a unique id if two modals can ever
  co-exist.
- `components/YamlPreview.tsx`: editable finalizer. `<textarea>` styled as `.code`, initialized with
  generated YAML; tracks local edits; "Reset to generated" restores; **Back disabled once manually
  edited** (matches cloudgrid); Copy (`copyText` + `useToast`) + Download act on the current buffer.
  (No live syntax highlighting in the editable textarea; `highlightYaml` reserved for read-only
  views.)
- `lib/yaml-emit.ts`: wraps `js-yaml` `dump()`. Includes `recursivelyRemoveEmptyValues` (ported)
  applied before dump for resiliency.
- `lib/download.ts`: blob download helper `downloadText(filename, text)`.
- `lib/validation.ts`: `validateGoDuration` (ported from cloudgrid), `validateDns1123`,
  required/numeric helpers; return error strings shown under fields; gate Continue.

## Types (ported from cloudgrid TS types)

- `types/metadata.ts`: **already exists** — `MetadataField` (name, `type?: 'string'|'number'|'bool'|'duration'`,
  description, required, sensitive, default, example, allowedValues, `url?: {title,url}`),
  `ComponentMetadataSchema`, `MetadataBundle`. **Extend it** to add `authenticationProfiles?:
  AuthenticationProfile[]` on `ComponentMetadataSchema` and an `AuthenticationProfile` type. The
  field controls map off the existing union (`bool` → boolean select, `duration` → text +
  `validateGoDuration`, `allowedValues` → enum select); if the bundle ever emits `json`-typed
  fields, add a JSON/textarea control then (YAGNI until observed).
- `types/component.ts`: `ComponentSpec` (apiVersion `dapr.io/v1alpha1`, kind `Component`,
  metadata{name, namespace}, scopes[], spec{type, version, metadata[]{name, value? |
  secretKeyRef{name, key}}}).
- `types/resiliency.ts`: `DaprResiliency` (kind `Resiliency`, spec{policies{timeouts, retries,
  circuitBreakers}, targets{apps, actors, components}}). RetryPolicy{policy `constant|exponential`,
  duration, maxRetries, maxInterval, matching{httpStatusCodes, grcpStatusCodes}}.
  CircuitBreakerPolicy{maxRequests, timeout, trip (CEL), interval}.
  AppTarget / ActorTarget (+circuitBreakerScope `type|id|both`, circuitBreakerCacheSize) /
  ComponentTarget (inbound/outbound).

## Component Builder flow (4 steps)

1. **Type** — `useComponentCatalog()` (TanStack Query → `/api/metadata/components`).
   Searchable/filterable list by type (state/pubsub/bindings/…), capability, status; pick
   implementation + version.
2. **Auth profile** (conditional) — only if the component has `authenticationProfiles`; pick one or
   skip; selection seeds required metadata fields.
3. **Configure** — name (+ optional namespace); two-panel metadata editor: left = active fields
   (required prefilled + added), right = searchable optional fields to add. Per field: value input
   OR "use secret" toggle → `secretKeyRef{name, key}`. Field type drives the control (text / number /
   boolean select / enum from `allowedValues`). Manual validation gates Continue. `scopes` optional
   free-text (not auto-populated).
4. **Preview** — editable YAML, Copy + Download `<name>.yaml`.

Dropped: cloudgrid's connected-mode "Access & Scopes" step.

## Resiliency Builder flow (4 steps)

1. **General** — policy name (+ optional namespace).
2. **Policies** — three sections (timeouts/retries/circuitBreakers), each a list + "Add" (Dialog
   form). Validation: Go-duration, numeric, non-empty CEL trip. ≥1 policy required to proceed.
3. **Targets** — three sections (apps/actors/components) + optional default-policy overrides. Targets
   reference defined policies via dropdowns; actors add `circuitBreakerScope`; components add
   inbound/outbound directions. Target names free-text in v1 (optional `<datalist>` suggestions =
   future enhancement).
4. **Preview** — empty values recursively stripped, then editable YAML; Copy + Download.

## Tests

Vitest + Testing Library, colocated: YAML emitter (golden), validation helpers, step-gating logic,
end-to-end "fill wizard → expected YAML" per builder. Go: handler test + golden.

## Out of scope (YAGNI)

Connected/cluster mode & live scopes/targets; applying to a running Dapr/cluster; editing/
round-tripping existing resources; i18n; Ace editor.

## Open follow-ups (future, not v1)

- Auto-populate scopes/targets from running apps/actors/components.
- Live syntax highlighting in the editable finalizer.
- Loading existing component/resiliency YAML into the builder for edit.
