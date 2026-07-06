# Components Page Updates — Design

**Date:** 2026-07-06
**Status:** Approved

## Goal

Four improvements to the Components page:

1. Rename the "State store connections" panel to "Recent workflow state store connections" and order it by recency, with the active store pinned on top.
2. Make the connections list editable: every connection gets a remove button (connection details themselves stay read-only).
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

### 2. Remove button for all connections

- The Delete button renders for **all** rows, not only `source === 'manual'`.
- The existing confirm dialog is reused. For auto-discovered rows the copy additionally notes the connection may reappear when discovery re-detects it. This transient removal is the accepted behavior (decided against a persisted "dismissed" tombstone).
- Reappearance timing: reconciliation is fingerprint-gated (`maybeReconcile` in `cmd/reconciler.go`), so the routine UI refresh poll does **not** re-add deleted entries. A deleted auto entry only returns when a reconcile actually runs and the store is still detected — i.e., on dashboard restart (boot seed reconcile) or when the set of running apps changes.
- No backend changes: `DELETE /api/statestores/{id}` and `ConnRegistry.Delete` already handle any source. Deleting the active store is allowed; the reconciler re-elects on its next cycle.
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
  - Registry: `UpdatedAt` set on `Add`/`Update`; bumped on a changed `UpsertAuto`; unchanged on a no-op upsert.
  - Reconciler: `Stores()` ordering — active first, then recency, then name; zero timestamps sort last.
  - Resources: ID is stable and unique across duplicate names; `Get` resolves by ID; `Get` falls back to name; list order is name-then-path.
- **Web (Vitest/RTL)**
  - Panel: new title; Delete button present on auto rows; auto-row dialog copy mentions possible reappearance; path rendered when present.
  - ResourceList: duplicate-name entries independently selectable; row click navigates to ID URL; name-based URL still selects a row; path rendered per row.

## Out of scope

- Capping the "recent" list to N entries.
- Persisted dismissal (tombstones) for auto-discovered connections.
- Editing connection details from the panel.
