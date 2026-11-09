# Workflow-page store selector (Spec 2c-i)

**Date:** 2026-06-30
**Status:** Approved design
**Scope:** Spec 2c-i of the frontend work. The connection-manager CRUD UI
(add/edit/delete manual connections) is **2c-ii** and follows. Builds on 2b
(registry + lazy pool + `/api/statestores` returning all stores with `id`/`source`)
and the path-aware election fix.

## Problem

After 2b, the backend lists every known state store (`GET /api/statestores`,
each with `id`, `name`, `type`, `source`, `active`, `connection`) and serves any
of them by id (`?store=<id>` → `ServiceFor(id)`). But the workflow page still
renders only the **active** store as a read-only chip — `Workflows.tsx` even
carries a now-stale comment: *"The API returns only this store, so there is no
switching — we render it as a label."* So a user cannot view workflows in a store
whose app isn't the active one (e.g. the PrDigest `localhost:16379` store while a
same-named `~/.dapr` default is active), even though the data is reachable via the
API.

Separately, selecting (or defaulting to) a store whose backend is **down** is
indistinguishable from having **no store at all**: `reconciler.ServiceFor`
returns the degraded (nil-store) entry in both cases, so both surface
`workflow.ErrNoStore` → the handler's "no state store detected" 503 — a
misleading message for an unreachable store.

## Goal

Let the user pick any listed store on the workflow page (defaulting to the
active one), with the selection threaded through the workflow list/stats/detail
and persisted across reloads. And make the page always show an accurate state:
"no state store detected" only when there genuinely is none, and a clear
"could not connect…" when a known store is unreachable.

## Design

### Frontend

**1. Types (`web/src/types/workflow.ts`).** Add `id: string` and
`source: string` (`'auto' | 'manual'`) to the `StateStore` interface — both are
already in the API payload, just untyped.

**2. Store selector (`web/src/pages/Workflows.tsx`).** Replace the read-only
store chip (and the stale comment) with a `<select>` styled like the existing app
dropdown:
- One `<option>` per `/api/statestores` entry, **value = `id`**, label =
  `name — type · connection` (e.g. `statestore — redis · localhost:16379`).
  Including the connection is required: two same-named `statestore` entries are
  otherwise indistinguishable in the dropdown.
- The active store's option is marked with a ` (active)` suffix.
- A small `↗` link beside the selector opens the selected store's component page
  (`/components/<name>`), preserving today's chip-link affordance.

**3. Default + persistence.** `selectedStore` initializes from
`localStorage['devdash.workflowStore']` when that id is still present in the
list; otherwise the **active** store's id. On change: set state, persist to
localStorage, and reset the app filter to "All apps" (a different store has
different apps). The chosen `id` flows through `useWorkflows`/`useWorkflowStats`
via their existing `store` param. A persisted id no longer in the list falls back
to active.

**4. Detail-page threading.** Instance rows link to
`/workflows/:appId/:instanceId`; append `?store=<id>` so `WorkflowDetail` (which
already reads `?store=`) fetches from the same store. The detail page's
"copy link" affordance includes the `store` query param too.

**5. Error/empty states.** The workflow page renders the **server-provided
`error` message** for store-unavailable responses rather than a hard-coded
string, so each backend message (below) displays accurately. The genuinely-empty
"no stores configured" case still shows its guidance (the `--statestore` /
add-a-component hint).

### Backend — distinguish "unreachable" from "no store"

**6. `workflow.ErrStoreUnreachable`** — a new sentinel error (alongside
`ErrNoStore`). A tiny **unreachable service** implements `workflow.Service` and
returns `ErrStoreUnreachable` from `List`/`Stats`/`Get`, carrying the store's
display name + connection for the message.

**7. `reconciler.ServiceFor` branching:**
- `""` → active store, or a specific `id` → its registry entry: if the store is
  **known** but `connpool.openOrGet` **fails**, return the **unreachable service**
  (`ok=true`). This covers both a down *active* store and a down *selected* store.
- genuinely no store elected / none configured → the degraded (`ErrNoStore`)
  entry, as today.
- unknown `id` → `ok=false` → 404 "unknown store" (unchanged).

**8. Handler mapping (`pkg/server` workflows router):** map
`workflow.ErrStoreUnreachable` → **503** with a store-specific message, e.g.
`could not connect to state store "statestore" (localhost:16379)`; keep
`workflow.ErrNoStore` → 503 `no state store detected`. Unknown store stays 404.

## Out of scope

- Connection-manager CRUD UI (add/edit/delete manual connections) → **2c-ii**.
- Per-store "not running" / "unresolved credentials" badges in the selector →
  2c-ii (the selector shows `name`/`type`/`connection`/active for 2c-i).
- The carried `PUT /statestores/{id}` returns-new-id follow-up → 2c-ii (no PUT in
  2c-i).
- Changing election or registry behavior (done in prior specs).

## Testing

**Frontend (vitest + MSW):**
- The selector lists all `/api/statestores` entries with disambiguating
  `name — type · connection` labels and an `(active)` marker on the active one.
- Selecting a store issues `?store=<id>` on the workflow + stats requests and
  renders that store's rows; the app filter resets to "All apps".
- Selection persists to `localStorage` and is restored on reload; a stale
  persisted id falls back to the active store.
- Instance row links carry `?store=<id>`.
- A 503 whose body is the "could not connect…" message renders that text (not
  "no state store detected"); the genuinely-empty case still shows the no-store
  guidance.

**Backend (Go, `//go:build unit` + integration):**
- `reconciler.ServiceFor`: a known store whose open fails (injected failing
  opener) returns a service yielding `ErrStoreUnreachable` — for both the active
  (`""`) and a specific `id`; genuinely-no-store still yields `ErrNoStore`;
  unknown id → `ok=false`.
- Handler: `ErrStoreUnreachable` → 503 with the store-specific message;
  `ErrNoStore` → 503 "no state store detected"; unknown → 404.
