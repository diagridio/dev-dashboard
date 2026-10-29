# Show all workflows in the connected store (any app-id)

**Date:** 2026-06-29
**Status:** Approved design
**Scope:** Spec 1 of 2. (Spec 2 — "remember stores + connect on demand" — is a separate, later cycle; see *Out of scope*.)

## Problem

The workflow page only shows workflow instances for **currently-running** app-ids. `workflow.Service.List`/`Stats` iterate the app-ids returned by discovery (running apps) and scan the store for each. The dropdown of app-ids is then derived from the returned rows.

Consequence: workflow data written under an app-id that isn't currently running is invisible, even though it lives in the connected store. Observed live with the `EnterpriseDiagnostics` Aspire app:

- Running app's Dapr app-id: **`wf-app`** (correct per `daprd --app-id`).
- All 26 workflow instances in the connected redis store are keyed under app-id **`pr-digest`** (a previous run of the same project).
- `/api/workflows` returns `{"items":null}`; the dropdown is empty.
- `curl /api/workflows?appId=pr-digest` returns all 26 instances — proving the store connection, namespace, key patterns, and query path all work. The only gap is the **app-id scoping**.

## Goal

List workflow instances for **every app-id that has workflow data in the currently-connected (active) store**, within the configured namespace — not only running apps. Visually mark app-ids that are not currently running.

## Decisions (from brainstorming)

- **App-id source:** enumerate distinct app-ids directly from the connected store's workflow keys. The store is the source of truth for what workflows exist.
- **Namespace:** keep the single configured namespace (`--namespace`, default `default`). Only the app-id becomes dynamic; namespace stays fixed in list/get/remove. This solves the `pr-digest` case (it is in `default`).
- **Running cue:** add a small "not running" badge to rows (and a text suffix in the dropdown) for app-ids not currently running, cross-referenced against the running apps the UI already fetches.
- **Default dropdown selection:** on initial load, default the dropdown to the **active app-id** when it has workflow data; otherwise fall back to "All apps". This surfaces the most relevant workflows first without ever showing an empty list by default.

## Background: workflow key layout

Workflow instance keys are `||`-joined:

```
<appID>||dapr.internal.<namespace>.<appID>.workflow||<instanceID>||<suffix>
```

where `<suffix>` is `metadata`, `customStatus`, or `history-NNNNNN`. The `metadata` suffix marks an instance. Existing helpers (`pkg/statestore/keys.go`):

- `InstanceMetaPattern(namespace, appID)` → `appID||dapr.internal.<ns>.<appID>.workflow||%||metadata`
- `InstancePrefix` / `InstanceKeyPattern` / `ParseInstanceID` (segment[2] = instanceID)

The store query layer (`statestore.Store.Keys`) takes a SQL-`LIKE` pattern via `state.KeysLiker`, supported by all three backends (redis, sqlite, postgresql). Leading-wildcard patterns are allowed (redis translates `LIKE` to `SCAN MATCH`).

## Design

### Backend — enumerate app-ids from the store

**New key helpers (`pkg/statestore/keys.go`):**

- `AllInstanceMetaPattern(namespace string) string` →
  `"%" + KeyDelimiter + "dapr.internal." + namespace + "." + "%" + ".workflow" + KeyDelimiter + "%" + KeyDelimiter + SuffixMetadata`
  i.e. `%||dapr.internal.<namespace>.%.workflow||%||metadata`. Matches every instance's metadata key across all app-ids in the namespace. (The `%` covers both the leading app-id segment and the app-id inside the actor type.)
- `ParseAppID(key string) (string, bool)` → returns segment[0] (the app-id) of a `||`-joined key; `ok=false` for a malformed key (fewer than the expected segments or empty app-id segment).

**Workflow service (`pkg/workflow/service.go`):** `List` and `Stats` change from "iterate running app-ids" to a **single store scan** when no specific app is selected:

- When `q.AppID == ""`:
  - One `s.store.Keys(ctx, statestore.AllInstanceMetaPattern(s.namespace), token, pageSize)` returns every instance's metadata key.
  - For each key: `appID, ok := statestore.ParseAppID(k)` and `id, ok := statestore.ParseInstanceID(k)`; skip on `!ok`; dedup by `appID+"/"+id`; `s.load(ctx, appID, id)`; apply `matches(q)`; collect.
  - Paging/continuation-token semantics come straight from the single `Keys` call (store-driven), replacing the previous per-app aggregation.
- When `q.AppID != ""`: unchanged — use the scoped `InstanceMetaPattern(s.namespace, q.AppID)`.
- `load()` and `Get()` are unchanged (they already take an explicit appID).

**Remove the discovery coupling.** With the store scan, `List`/`Stats` no longer call the injected `appIDs func(context.Context) ([]string, error)`. Remove it:

- `workflow.New(store, namespace)` (drop the `appIDs` parameter).
- `cmd`/reconciler: `newStoreBackend` and the reconciler stop building and passing `appIDs`; the degraded entry constructor is updated too.
- The store becomes the single source of truth for "what workflows exist"; the workflow service no longer depends on discovery.

This is a net simplification, not a regression: a running app that has never run a workflow has no store keys and therefore did not appear before either (the dropdown was already results-derived).

### Frontend — dropdown + "not running" badge (`web/src/pages/Workflows.tsx`)

- The dropdown's app-id list (`appIds`, derived from returned rows at `Workflows.tsx:132-134`) **auto-populates** with stored app-ids once the backend returns them — no change needed for population.
- Import the existing `useApps()` hook; build a `Set` of running app-ids.
- **Table** (the app-id cell, `<td>{wf.appId}</td>`, ~line 465): when `wf.appId` is not in the running set, append a small muted badge reusing the existing `.typechip` style (`web/src/styles/theme.css:186`) reading `not running`. So a `pr-digest` row reads `pr-digest [not running]`.
- **Dropdown** (`<option>`, ~lines 323-326): an `<option>` cannot hold a chip, so append a ` (not running)` text suffix to the label for non-running app-ids.
- Flicker guard: only show the badge once `useApps()` has returned data; while it is loading, show no badge.

**Default dropdown selection.** Determine the **active app-id** entirely client-side — no backend change:

- Active store: from `useStateStores()`, the entry with `active: true` (its `name`).
- Active app-id: the running app from `useApps()` whose loaded `components` include a component matching the active store's `name`. If more than one running app loaded it, pick the lexicographically-first deterministically (a dev edge case). If none, there is no active app-id.

On initial load, set the dropdown's default `selectedApp` **once**:

- If an app is specified in the URL (`?app=`), it wins — keep current behavior.
- Else, once both the active-app determination and the initial "All apps" result are available: if the active app-id exists **and** appears among the stored app-ids (`appIds` derived from the returned rows), preselect it; otherwise default to "All apps".
- Apply this default exactly once (guard with a ref/flag) so it never overrides a later manual dropdown change or re-applies on a background refetch.

In the `pr-digest` case the active app-id is `wf-app` (loaded the active `workflow-store`) but it has no stored workflows, so the default falls back to "All apps" and the `pr-digest` instances are shown. When a running app does have workflows, its app-id is preselected so the user lands on the most relevant data.

## Error handling & performance

- A single wildcard scan replaces the per-running-app loop. Leading-wildcard `LIKE` / `SCAN MATCH` works on all three KeysLiker backends; it is a full scan, but the previous per-app path was also a non-indexed match, so cost is net-neutral.
- Empty store → empty list (correctly empty rather than scoped-empty).
- A store that does not implement `KeysLiker` → existing `"store %q does not support key listing"` error, unchanged.

## Testing

- `pkg/statestore/keys_test.go`: `AllInstanceMetaPattern` produces the exact expected pattern; `ParseAppID` returns segment[0] for a well-formed key and `ok=false` for malformed keys.
- `pkg/workflow/service_test.go`: seed a fake `statestore.Store` with instances under **two** app-ids (e.g. `app-a`, `app-b`); `List` and `Stats` with `AppID==""` return both apps' instances; with `AppID=="app-a"` scope to one. Confirms enumeration and the discovery-coupling removal.
- Constructor ripple: update every `workflow.New(...)` call site for the dropped `appIDs` parameter — `newStoreBackend`, the reconciler, the degraded entry, and `cmd`/integration tests. The existing integration test (`cmd/serve_integration_test.go`, `TestAssembleServerServesSeededWorkflow`) still passes: its single seeded instance is now found via store enumeration rather than the running-apps list.
- `web/src/pages/Workflows.test.tsx`:
  - Badge: with a mocked `useApps` that omits a row's app-id, that row renders the `not running` badge; a running app-id's row does not.
  - Default selection: (a) active app-id has workflow data → dropdown defaults to it; (b) active app-id has no data (the `pr-digest` shape: running `wf-app`, data under `pr-digest`) → dropdown defaults to "All apps"; (c) a `?app=` URL param overrides the computed default.
  - Build tags / test conventions follow the repo norm (Go: `//go:build unit`, `go test -tags unit`; web: vitest).

## Out of scope (→ Spec 2: "remember stores + connect on demand")

- Connecting to non-active or disconnected stores.
- A known-store registry that persists detected stores across app disconnects.
- A lazy connection cache and a store selector in the workflow UI.
- Cross-backend history (e.g. viewing redis workflows after an app switched to postgresql).

These require connection-lifecycle management beyond the single active store and are deferred to Spec 2. Spec 1 lists all app-ids within whichever store is currently connected; Spec 2 will let the user reach other known stores.
