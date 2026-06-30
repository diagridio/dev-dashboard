# Collapse duplicate state stores in the Workflow-page selector

**Date:** 2026-06-30
**Status:** Approved design

## Problem

The Workflow page (`web/src/pages/Workflows.tsx`) has a state-store selector
dropdown. When several state-store component files share the same metadata
**name**, **type**, and **connection** but live at different file **paths**,
each one currently appears as a separate option.

Because the workflow table is read from the underlying state store, every such
duplicate yields identical table contents. The extra options are therefore
noise: selecting a different path makes no difference to what the user sees.

## Goal

In the Workflow-page store dropdown, collapse stores that share the same
`name + type + connection` into a single option. If one member of the group is
the active store, that member is the one shown.

## Key insight

The backend already defines store sameness exactly this way. In
`cmd/reconciler.go:69`:

```go
func identity(c *statestore.Component) string {
    ...
    return c.Name + "|" + c.Type + "|" + statestore.ConnInfo(*c)
}
```

Path is deliberately excluded from `identity()`. The UI dedup key is the
equivalent `name|type|connection` triple available on the `StateStore` shape
(`web/src/types/workflow.ts`), where `connection` is the secrets-free
host/db summary already computed by the backend.

## Scope decisions (confirmed with user)

- **Tie-break when no active member:** keep the **first** entry in existing list
  (registry) order as the group representative.
- **Scope:** **dropdown only.** The same store list (`useStateStores`) also feeds
  `StateStoreConnectionsPanel`, where each connection/path is managed
  (edited/deleted) individually. That panel must keep showing every individual
  connection, so collapsing is local to the Workflow-page selector — not a change
  to the shared hook or backend.
- **Visual:** collapsed options render **identically** to any single store via the
  existing `storeOptionLabel`. No "(N paths)" indicator — the user need not know
  duplicates were hidden, since they read the same data.

## Architecture

Frontend-only, dropdown-only. Two pieces:

### 1. New pure helper — `web/src/lib/dedupeStores.ts`

Mirrors the existing `web/src/lib/dedupeWorkflows.ts` pattern.

```ts
import type { StateStore } from '../types/workflow'

export function dedupeStores(stores: StateStore[]): StateStore[]
```

Contract:

- Group by the key `name|type|connection`.
- Emit **one** entry per group, in order of first appearance of each group.
- The chosen representative for a group is:
  - the **active** member, if the group contains one; otherwise
  - the **first** member encountered (first-in-list-order tie-break).
- The output entry occupies the position of the group's first appearance, so
  overall ordering is stable; only which object represents the group can change
  (when a later member is the active one).
- Pure function: no mutation of inputs; preserves input order otherwise.

### 2. Wiring in `Workflows.tsx`

- Derive the deduped list:
  ```ts
  const displayStores = useMemo(() => dedupeStores(storeList ?? []), [storeList])
  ```
- Use `displayStores` for:
  - **(a)** rendering the `<option>` elements in the store `<select>`.
  - **(b)** the localStorage-init / validation effect that resolves
    `selectedStore`. Validate the persisted id against `displayStores` (the
    visible representatives) rather than the full `storeList`, so a persisted id
    pointing at a now-hidden duplicate falls back to the active store.
- Keep `selectedStoreObj` lookup against the full `storeList`. The selected id is
  always a representative, which is present in both lists, so the "component"
  link continues to resolve.

### Why the existing fallbacks remain correct

- `activeStore?.id`: the active store is always chosen as its group's
  representative, so it is always present in `displayStores`.
- `storeList[0].id`: the first store is, by definition, the first member of its
  group, hence a representative.
- A stale persisted id that points at a now-hidden duplicate fails the
  "is it in `displayStores`?" check and falls back to the active store —
  the desired behavior.

## No change

- `useStateStores` hook — unchanged (shared with the connections panel).
- Backend `Stores()` / `reconciler` — unchanged.
- `StateStoreConnectionsPanel` — unchanged; keeps every individual connection so
  each component file remains manageable.

## Error handling / edge cases

- Empty list: `dedupeStores([]) === []`. `noStores` logic is unaffected because
  `displayStores.length === 0 ⟺ storeList.length === 0`.
- Single store: passes through unchanged.
- A group with no active member: first member kept.

## Testing

**Unit — `web/src/lib/dedupeStores.test.ts` (TDD, write first):**

- No duplicates → list returned unchanged (same order).
- Duplicate group with an active member → group collapsed to one entry; the
  active member is the representative.
- Duplicate group with no active member → first member kept.
- Multiple independent groups → one entry per group, first-appearance order.
- Input order preserved; input not mutated.

**Component — `web/src/pages/Workflows.test.tsx`:**

- Given a store list containing a duplicated-path store (same
  name/type/connection, different paths), the dropdown renders **one** option for
  that store, and when one duplicate is active it is the one shown.
