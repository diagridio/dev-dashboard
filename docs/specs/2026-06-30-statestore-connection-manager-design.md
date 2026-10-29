# State Store Connection Manager (Spec 2c-ii) — Design

**Date:** 2026-06-30
**Status:** Proposed (awaiting user review)
**Depends on:** 2b connection registry (`/api/statestores` CRUD), 2c-i workflow store selector (`StateStore` type with `id`/`source`).

## Goal

Let users add, edit, and delete **manual** state-store connections from the dashboard, so they can register a workflow state store (and browse its data) without the writing app being connected. The add/edit form is a **metadata-driven builder** — its fields come from the Dapr component catalog rather than being hardcoded per store type.

## Background & reuse decision

A manual state store is simply a Dapr `state.*` component, so this feature reuses an existing **component builder** design. The builder has two halves:

- **Backend catalog** — a `pkg/metadata/` package from an earlier prototype: `metadata.go` + a 754 KB `component-metadata-bundle.json` describing every component type and its metadata fields. **Directly portable.**
- **Builder UI** — the original React 19 + MUI + react-hook-form + yup implementation. **Not** portable as-is — its styling *is* MUI, and dev-dashboard is React 18 + vanilla CSS.

**Reuse strategy (decided): port the logic, reimplement the UI natively.** We reuse the backend catalog, the metadata-driven data model, the `field.type → control` rendering rules, and the validation approach; we reimplement the form on dev-dashboard's controlled components + `theme.css`. dev-dashboard stays MUI-free.

**Scope (decided): state-store slice now.** Only the **three backend-connectable** state store types are exposed — `state.redis`, `state.sqlite`, `state.postgresql` (`pkg/statestore/store.go` imports components-contrib clients for exactly these, and the registry allowlist in `validateStoreBody` matches). The metadata-driven win is field *completeness*, not type *breadth*: each supported type's full, correctly-typed, sensitivity-flagged field set (required + optional) comes from the catalog rather than being hardcoded. The form saves to the connection registry (not downloadable YAML), and the full multi-type component builder + resiliency builder (see `2026-06-28-component-resiliency-builders-design.md`) are deferred. Because we save JSON to the registry rather than emit YAML, **this slice adds no new frontend dependency** (`js-yaml` is deferred with the full builder). Exposing store types the backend can't open is out of scope (it would require per-type client wiring in `pkg/statestore`).

## Locked decisions (from brainstorm)

1. **Placement** — a "State store connections" panel pinned to the top of the existing **Components** page. No new nav item.
2. **Add/Edit presentation** — a **modal dialog** (scrollable body), one form for both Add and Edit.
3. **Field model** — metadata-driven from the catalog: required fields prefilled, optional fields added on demand via a searchable picker. Control chosen by field type: `string`→text, `number`→numeric, `bool`→toggle, enum (`allowedValues`)→select, `sensitive`→masked input.
4. **Inline values only** — no `secretKeyRef`. Sensitive fields render masked but are stored inline in the `0600` registry file (consistent with how 2b persists manual entries).
5. **`actorStateStore` defaults on** — this manager registers *workflow* state stores, which require it.
6. **Auto-discovered rows are read-only** — no edit, no delete (they come from YAML on disk and would be re-discovered). Only manual rows get edit/delete.

## Architecture

```
Components page
└── StateStoreConnectionsPanel        (lists /api/statestores; Add button)
     ├── rows: auto (read-only, ACTIVE badge) | manual (✎ edit, 🗑 delete)
     ├── StateStoreConnectionDialog    (modal: add/edit, metadata-driven form)
     │     └── useComponentCatalog()   (GET /api/metadata/components, state.* only)
     └── ConfirmRemoveDialog           (existing; delete confirmation for manual rows)

Save → POST /api/statestores  or  PUT /api/statestores/{id}   ({name, type, metadata})
        → reconciler → ConnRegistry (inline metadata, 0600 file)
```

## Backend changes

### 1. Port the metadata catalog (new `pkg/metadata/`)

- Copy `metadata.go` and `component-metadata-bundle.json` from the prototype's `pkg/metadata/`.
- Adapt the HTTP wiring to dev-dashboard's chi router + `writeJSON`/handler conventions: register `GET /metadata/components` inside `apiRouter` (`pkg/server/api.go`), reachable at `/api/metadata/components`. Preserve the bundle processing (`filterDeprecated` → `deduplicateMetadata` → `sortComponents`), the sha256 **ETag**, `If-None-Match` → 304, and `Cache-Control` headers.
- Call `metadata.Init()` once at startup (where the other services are constructed).
- Port `update-component-metadata-bundle.sh` → `scripts/` to refresh the bundle from upstream releases.
- **Tests:** handler test (200 + ETag, 304 on matching `If-None-Match`) and a golden test of the processed bundle shape, following `internal/golden`.

> The frontend only consumes `state.*` entries, but the endpoint serves the whole catalog (cacheable, and reusable by the deferred full builder).

### 2. Return the post-rename id from `UpdateStore`

Renaming a manual connection changes its stable id (`entryID(SourceManual, name)`). Today `ConnRegistry.Update` recomputes the new id but discards it; `StoreRegistry.UpdateStore` returns only `error`, so the `PUT` handler echoes the **stale** URL id. The frontend needs the new id to keep the row/selection addressed correctly.

- `ConnRegistry.Update` returns `(newID string, err error)`.
- `StoreRegistry.UpdateStore(id, name, typ, metadata)` becomes `(string, error)` (the new id); `reconciler.UpdateStore` returns it (it already evicts the old pooled component, resolved before the update).
- The `PUT /statestores/{id}` handler returns `{ "id": <newID> }`.
- **Tests:** update a manual entry's name → handler returns the recomputed id; entry is addressable by the new id and gone under the old.

### 3. Friendlier duplicate-name error

`AddStore` surfaces `os.ErrExist` verbatim ("file already exists"), which is confusing. Map a duplicate manual name to a clear message, e.g. `a connection named "<name>" already exists`, returned as the 400 `{error}` body. **Test:** adding a duplicate name returns 400 with the friendly message.

## Frontend changes

### Types — `web/src/types/metadata.ts`

```ts
export interface ComponentMetadataSchema {
  type: string            // e.g. "state"
  name: string            // implementation, e.g. "redis"
  version: string         // e.g. "v1"
  title: string
  status: 'stable' | 'beta' | 'alpha' | string
  description?: string
  metadata?: MetadataField[]
  // authenticationProfiles, capabilities, urls… (carried but unused in the slice)
}

export interface MetadataField {
  name: string
  type?: 'string' | 'number' | 'bool' | 'duration'
  description?: string
  required?: boolean
  sensitive?: boolean
  default?: string | number | boolean
  allowedValues?: string[]
  example?: string
  url?: { title: string; url: string }
}
```

### Hook — `web/src/hooks/useComponentCatalog.ts`

TanStack Query (`useQuery`) → `fetchJSON('/metadata/components')`. Long `staleTime` (catalog is static + ETag-cached). Expose a selector that returns only the schemas for the supported types (`state.redis`, `state.sqlite`, `state.postgresql`), and a helper to resolve a chosen type to its `MetadataField[]` (prefer the latest/`stable` version when multiple exist). The supported-type list is a single shared constant (`SUPPORTED_STORE_TYPES`) so it stays in lockstep with the backend allowlist.

### Component — `StateStoreConnectionsPanel.tsx`

- Renders a `.card` panel titled **State store connections** with a **+ Add connection** button.
- Lists rows from the existing `/api/statestores` data (`StoreInfo`): `name · type · connection · source` with an **ACTIVE** badge on the active store.
- **Auto** rows: read-only (no actions). **Manual** rows: ✎ (open dialog in edit mode) and 🗑 (open `ConfirmRemoveDialog`).
- After any successful mutation, invalidate the `statestores` query (and the workflow store list).

### Component — `StateStoreConnectionDialog.tsx`

Modal (generalize the focus-trap + Escape pattern from `ConfirmRemoveDialog`). Form state via controlled components (no form library):

- **Type** — select of the three supported types (`state.redis`, `state.sqlite`, `state.postgresql`) sourced from the catalog (disabled in edit mode; type is immutable once created).
- **Name** — required text.
- **Required fields** — rendered from the chosen type's catalog `metadata` where `required`, prefilled with `default`. Control by `type`; `sensitive` → masked.
- **Optional fields** — a "+ add optional field" searchable picker listing the type's non-required fields; added fields are removable.
- **actorStateStore** — checkbox, default checked → contributes `metadata["actorStateStore"] = "true"`.
- **Edit mode** — prefilled from the row's `StoreInfo` (type locked); on rename, use the `{id}` returned by `PUT` for subsequent addressing.
- **Save** — build `{ name, type: "state.<impl>", metadata }` and `POST` (add) or `PUT /{id}` (edit). On success: toast (`lib/toast`), close, invalidate queries. On error: show the server `{error}` message inline.

### Validation (`lib/`, manual)

Gate Save on: non-empty Name; all required catalog fields non-empty; numeric fields parse as numbers. Duplicate-name is enforced server-side and surfaced as an inline error. Keep helpers small and colocated; no validation library.

### Placement on the Components page

`ResourceList` is shared between `component` and `configuration`. Render `<StateStoreConnectionsPanel />` **only when `kind === 'component'`**, positioned above the `.md` master-detail block, and in **all** render states (loading/empty/normal) — the panel owns its own queries and must not depend on the components list loading. (Refactor `ResourceList` so the `phead` + panel render once, above the state-specific body.)

## Data flow

1. Dialog opens → `useComponentCatalog()` provides `state.*` schemas.
2. User picks a type → required fields render from `metadata`; user fills values, adds optional fields, toggles `actorStateStore`.
3. Save → `{name, type, metadata}` → `POST`/`PUT /api/statestores` → reconciler → `ConnRegistry` writes inline metadata (`0600`).
4. Query invalidation refreshes the panel (and the workflow store selector). The store is now selectable/browsable even with no app connected.

## Error handling

- Catalog fetch failure → panel still lists existing connections; the **Add** flow shows a "couldn't load component catalog" message and disables the type picker.
- Duplicate name → inline 400 message (backend change #3).
- Save failure (`POST`/`PUT` 4xx/5xx) → inline server `{error}` (via `fetchJSON`'s body-error surfacing from 2c-i).
- Delete → `ConfirmRemoveDialog`; 204 → invalidate.

## Testing

**Go**
- Metadata handler: 200 + body shape + ETag; 304 on matching `If-None-Match`; golden of processed bundle.
- `UpdateStore` returns the recomputed id; addressable by new id, absent under old.
- Duplicate-name → 400 with friendly message.

**Web (Vitest + Testing Library + MSW)**
- `useComponentCatalog` filters to `state.*` and resolves fields for a type.
- Panel: auto rows read-only (no ✎/🗑); manual rows show actions; ACTIVE badge on active store.
- Dialog: required fields render from catalog; control type matches field type; sensitive field masked; optional-field picker adds/removes; `actorStateStore` default-checked.
- Save: `POST` for add and `PUT /{id}` for edit send the expected `{name,type,metadata}`; success toasts + invalidates; rename uses returned id.
- Validation gating: Save disabled until required fields filled; numeric fields validated.
- Delete confirmation invalidates on 204.

## Out of scope (YAGNI)

- `secretKeyRef` / secret-store references (inline values only).
- Downloadable / editable YAML output.
- The full multi-type component builder and the resiliency builder (`2026-06-28-component-resiliency-builders-design.md`).
- Editing auto-discovered connections.
- Auto-populating scopes/targets from running apps.
```
