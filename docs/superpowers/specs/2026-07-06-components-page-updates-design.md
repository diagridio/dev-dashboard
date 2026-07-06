# Components Page Updates — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

Four improvements to the Components page:

1. Rename the "State store connections" panel to "Recent workflow state store connections" and order it by recency, with the active store pinned on top.
2. Make the connections list editable: every connection except the active one gets a remove button, and removal is durable (connection details themselves stay read-only).
3. Show the component file path in both the connections list and the components list.
4. Make components with duplicate `metadata.name` values independently selectable by giving each resource a stable unique ID.

## Context

- The connections panel is `web/src/components/StateStoreConnectionsPanel.tsx`, backed by `GET /api/statestores` (`StoreInfo` in `pkg/server/workflows.go`, produced by `Stores()` in `cmd/reconciler.go`). The registry (`cmd/registry.go`, `ConnEntry`) persists no timestamps and returns insertion order.
- `DELETE /api/statestores/{id}` already removes any entry, but the panel only shows Delete for `source === 'manual'` rows. Auto-discovered entries are re-added by the reconciler's next scan (`UpsertAuto`).
- The components list is `web/src/pages/ResourceList.tsx`. It keys and selects rows by `metadata.name` (route `/components/:name`), and the backend `Get()` in `pkg/resources/resources.go` returns the first name match — so duplicate-name components can't all be selected.
- Both `StoreInfo` and `ResourceSummary` already include `path`; showing it is display-only work.
- Existing pattern to reuse: `entryID()` in `cmd/registry.go` derives a stable, URL-safe ID as `sha256(key)` hex-truncated to 12 chars.

## Design

### 1. Recency ordering for state store connections

**Backend**

- `ConnEntry` gains `UpdatedAt time.Time` (`json:"updatedAt"`).
  - Set to now in `Add` and `Update`.
  - In `UpsertAuto`, set only when the entry is new or actually changed — the existing no-op guard (skip disk write when nothing changed) already prevents churn, so timestamps do not shuffle on every reconcile.
  - Registry files written before this change load with a zero `UpdatedAt`; those entries sort last, with name as tiebreaker.
- `StoreInfo` gains `updatedAt string` (RFC 3339).
- `Stores()` returns the list sorted: active store first, then `updatedAt` descending, then name.

**Frontend (`StateStoreConnectionsPanel.tsx`)**

- Panel title becomes **"Recent workflow state store connections"**.
- Rows render in API order (no client-side sort).

### 2. Remove button for all connections (durable tombstone)

Removal is durable: a removed auto-discovered connection stays hidden across reconciles and restarts. It reappears only if it becomes the **active** workflow state store for the running applications. The active store itself cannot be deleted.

**Backend**

- `ConnEntry` gains `Dismissed bool` (`json:"dismissed,omitempty"`), persisted in the registry file. Registry files from before this change load with `Dismissed = false`.
- `ConnRegistry.Delete(id)` semantics change per source:
  - Manual entry: removed outright (as today).
  - Auto entry: kept but marked `Dismissed = true`. Keeping the entry means `UpsertAuto` (keyed by normalized path) keeps updating its name/type on YAML changes without resurrecting it — `UpsertAuto` preserves the `Dismissed` flag.
- `DELETE /api/statestores/{id}` rejects deleting the currently active store with `409 Conflict` and a clear message; the check compares the entry against the elected active store.
- `Stores()` excludes dismissed entries from the list.
- Un-dismissal: at the end of `reconcile()` (`cmd/reconciler.go`), if the newly elected active store corresponds to a dismissed registry entry (matched by normalized path), the flag is cleared and persisted, so the entry reappears in the panel. Reconciles run on boot and whenever the set of running apps changes — exactly the moments a store can become active.

**Frontend (`StateStoreConnectionsPanel.tsx`)**

- The Delete button renders for all rows **except the active one** (hidden on the active row, matching the backend guard).
- The existing confirm dialog is reused. For auto-discovered rows the copy notes the connection stays hidden unless it becomes the active workflow state store again.
- Connection details remain read-only in this panel.

### 3. File path display

- Components list rows (`ResourceList.tsx`): render `resource.path` under the name in small mono muted text, CSS-truncated, full path in a `title` tooltip.
- Connections panel rows: same treatment for `store.path`, rendered only when non-empty (manual connections have no file path).

### 4. Stable unique resource IDs

**Backend (`pkg/resources/resources.go`)**

- Each scanned resource gets `ID` computed at scan time: `sha256(name + "|" + type + "|" + path)` hex-truncated to 12 chars — the `entryID` pattern from `cmd/registry.go`, mirrored in `pkg/resources` (the original is unexported and keyed differently).
- `Resource` gains `id` in its JSON. Uniqueness holds because the scanner dedups files by absolute path, so name+type+path never repeats.
- List sorting becomes name, then path (stable order for duplicate names).
- `Get()` resolves by ID first, then falls back to the first name match, so existing `/components/:name` deep links keep working. The API route shape `/api/resources/{kind}/{idOrName}` is unchanged.

**Frontend**

- `ResourceSummary` (and thus `ResourceDetail`) gains `id: string`.
- Routes stay `/components/:param`; the param is now the resource ID.
- `ResourceList` keys rows by `resource.id`, navigates to `/components/${id}`, and resolves the selected row as `find(r => r.id === param) ?? find(r => r.name === param)`, defaulting to the first item.
- `ResourceDetail` fetches with the same param; the backend fallback handles old name-based links.

## Testing

- **Go**
  - Registry: `UpdatedAt` set on `Add`/`Update`; bumped on a changed `UpsertAuto`; unchanged on a no-op upsert. `Delete` removes manual entries but marks auto entries dismissed; `UpsertAuto` preserves the `Dismissed` flag on update.
  - Reconciler: `Stores()` ordering — active first, then recency, then name; zero timestamps sort last. Dismissed entries excluded from `Stores()`; a dismissed entry elected active gets un-dismissed (and persisted) by `reconcile()`.
  - API: `DELETE /api/statestores/{id}` returns `409 Conflict` for the active store; deletes/dismisses others.
  - Resources: ID is stable and unique across duplicate names; `Get` resolves by ID; `Get` falls back to name; list order is name-then-path.
- **Web (Vitest/RTL)**
  - Panel: new title; Delete button present on non-active rows and absent on the active row; auto-row dialog copy explains the store stays hidden unless it becomes the active workflow state store; path rendered when present.
  - ResourceList: duplicate-name entries independently selectable; row click navigates to ID URL; name-based URL still selects a row; path rendered per row.

## Out of scope

- Capping the "recent" list to N entries.
- A UI to view or restore dismissed connections (a dismissed store only returns by becoming active; manual re-add creates a separate manual entry).
- Editing connection details from the panel.
