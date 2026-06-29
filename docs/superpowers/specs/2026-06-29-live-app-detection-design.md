# Live app detection: keep boot-derived state current

**Date:** 2026-06-29
**Status:** Approved design

## Problem

The dashboard should reflect Dapr applications starting and stopping **while the
dashboard is already running**, not only at dashboard startup.

The Applications table already does this: the frontend polls `GET /api/apps`
every 3s (TanStack Query `refetchInterval`, configurable 1s/3s/5s/10s/Off via
`RefreshControl`), and the backend re-runs the full `StandaloneScanner()`
process-table scan plus per-app enrichment on every poll. Apps that start or
stop appear/disappear in the table within ~3s.

The gap is everything **derived once from the boot-time apps snapshot**. In
`assembleOptions` (`cmd/serve.go:38-79`), `appsSvc.List(ctx)` runs a single time
and from that snapshot it computes state that never refreshes:

| Frozen at boot | Powers | Re-derives per request today? |
|---|---|---|
| `resPaths` → `resources.New(resPaths)` | Resources page (`/api/resources`) | Re-scans *files* each call, but only over the **frozen path list** |
| `scanPaths` → `statestore.Detect()` → `detected` | State stores list (`/api/statestores`) | No — list is static |
| `loaded` set + `registry` active-store election | Which store is "active" | No |
| `backend` (opens a live DB connection, returns closers) | Workflow features | No — connection opened once at boot |

Note: `appIDs` (`cmd/serve.go:81-91`, used by the workflow service) and
`targetResolver` (`cmd/workflow.go`) are already dynamic — they re-list apps.

So if an app starts **later** introducing a new resource path or a new/different
state store, the Resources page, the State stores list, and the workflow backend
connection all stay stale until the dashboard is restarted.

## Goal

Keep the derived state current as apps start/stop while running, **including a
live reconnect of the workflow state-store DB connection** when the elected
active store changes — without adding a second polling loop.

## Approach: piggyback on the existing apps poll + change detection

Reuse the refresh mechanism that already exists. The frontend's `GET /api/apps`
poll already re-scans the process table every 3s. We hook reconciliation onto
that existing scan and gate the expensive work behind a change-detection
fingerprint, so heavy work (directory walk, store re-detect, DB reconnect) fires
**only when the set of apps actually changes**, not on every tick.

Rejected alternatives:

- **Dedicated background reconciler goroutine** — a *second* polling loop on top
  of the frontend's; the "too frequent polling" cost we want to avoid. Works
  with no browser open, which we do not need.
- **Fully lazy per-request re-derivation** — re-opening DB connections on every
  request is wasteful; needs caching anyway, converging back to this approach.

## Architecture

A new **`reconciler`** component is the single owner of all boot-frozen derived
state, guarded by a `sync.RWMutex`:

```
reconciler {
  mu          sync.RWMutex
  fingerprint string            // hash of current apps-derived inputs
  resPaths    []string          // current resource scan paths
  detected    []statestore.Component
  registry    *storeRegistry    // active-store election
  active      *storeEntry       // current open store: svc, remover, targets
  // single-flight guard for in-flight reconciles
}
```

It **implements the three server interfaces** by delegating to current state
under the read lock, so the HTTP handlers need **no changes**:

- `Stores() []StoreInfo` (`server.StoreRegistry`) → from current `registry`
- `ServiceFor(name)` (`server.WorkflowBackend`) → from current `active`, or the
  degraded entry when no store is configured
- a `resources.Service` whose path list reads `resPaths` live (resources already
  re-scans files per request, so this alone makes the Resources page current
  with no extra cost)

### Trigger

Wrap `discovery.Service` in a thin decorator:

```
appsList(ctx):
  apps := inner.List(ctx)        // the scan that already runs every poll
  fp := fingerprint(apps)        // appIDs + resource paths + loaded store names
  if fp != current && not already reconciling:
      go reconciler.Reconcile(ctx, apps, fp)   // async, single-flight
  return apps                    // poll response is NOT blocked on reconnect
```

Because the frontend already polls `GET /api/apps` every 3s, this reuses the
refresh as the trigger. The reconnect runs in a fired-on-change goroutine
(single-flight) so a slow DB connect never stalls the apps poll. This goroutine
is event-driven (fired on change), not a polling loop.

## Change detection (fingerprint)

A stable hash over the *current* apps, capturing exactly what the frozen
derivations depend on:

- the set of `appID`s (catches app start/stop),
- the union of `ResourcePaths` + `ConfigPath` dirs (catches new scan locations),
- the set of loaded `state.*` component names (catches a new active-store
  election).

If the hash is unchanged, `Reconcile` returns immediately — no dir walk, no
re-detect, no reconnect.

**Documented limitation:** editing a component YAML's *contents* without
restarting any app won't change the fingerprint, so the workflow connection
won't reconnect for that case. The Resources page still shows fresh content
because it re-reads files per request. This matches how rarely a store's
connection string changes mid-session and keeps the design simple.

## Connection lifecycle

Reconcile steps (on fingerprint change), holding the write lock only for the
swap:

1. Recompute `resPaths` and the `loaded` set from current apps (+ `~/.dapr`
   defaults).
2. `statestore.Detect(scanPaths)` → new `detected`.
3. `newStoreRegistry(detected, loaded)` → new active-store election.
4. **Connection diff:** compare the newly-elected active store's *identity*
   (name + type + connection string via `statestore.ConnInfo`) to the
   currently-open one:
   - **Same identity** → keep the existing connection; just swap
     `registry`/`detected`/`resPaths`.
   - **Changed** (or none→some / some→none) → open the new `statestore.New(...)`
     connection *first* (outside the write lock, since it is slow), build the
     new `storeEntry` (svc/remover/targets), then take the write lock, swap it
     in, and **close the previous connection** after releasing the lock.
5. If the new connection fails to open, log a warning and **retain the old
   entry** — don't tear down a working connection for a broken new one. Same
   spirit as today's boot-time skip.

**Shutdown.** The reconciler exposes `Close() error` that closes whatever
connection is currently open. `assembleOptions` returns this single closer
instead of the per-store closer slice it returns today
(`cmd/serve.go:88-91` defers it).

**Concurrency safety.** A single-flight guard ensures only one reconcile runs at
a time; concurrent `/api/apps` polls that see the same new fingerprint don't
stack up. Reads (`Stores`, `ServiceFor`, resource paths) take the read lock and
never block on a reconnect.

## Wiring changes (`cmd`)

Interfaces are unchanged; only construction changes.

- `assembleOptions` (`cmd/serve.go`) stops computing the frozen
  `detected`/`loaded`/`registry`/`backend`/`resSvc` eagerly. Instead it
  constructs **one `reconciler`**, seeds it with an initial `Reconcile` from the
  boot apps snapshot (so first paint is correct), and wires it into
  `server.Options`:
  - `Apps:` → the **decorated** discovery service (triggers reconcile on every
    `List`)
  - `Stores:` → `reconciler` (implements `StoreRegistry`)
  - `Backend:` → `reconciler` (implements `WorkflowBackend`)
  - `Resources:` → a `resources.Service` whose paths read from the reconciler
    live
- Returns `[]func() error{ reconciler.Close }` as the single closer.
- `newStoreRegistry` / `newStoreBackend` logic in `cmd/workflow.go` largely
  **moves into the reconciler** (the election + connection-open code is reused,
  not rewritten). `targetResolver` is unchanged (already dynamic via
  `apps.Service`).

**`resources.New` change:** accept a path *provider* (`func() []string`) instead
of a static `[]string`, so it always reads current paths. The reconciler
supplies the provider backed by its lock-guarded `resPaths`. Existing
callers/tests pass a closure returning a fixed slice — a small mechanical
update.

## Testing (TDD)

Reconciler unit tests with a fake `discovery.Service` and a fake store opener
(inject `statestore.New` as a func so tests don't need a real DB):

- fingerprint stable → no reconcile / no reconnect
- new app with new resource path → `resPaths` grows, Resources reflects it
- new app elects a different active store → connection swaps, **old connection
  closed exactly once**
- new connection fails to open → old entry retained, warning logged
- app stops → active store removed → degraded mode, old connection closed
- single-flight: concurrent triggers run one reconcile

Decorator test: `List` returns apps unblocked even while a reconcile is in
flight.

Keep `cmd/serve_integration_test.go` and `cmd/workflow_test.go` green (adjust
construction to the reconciler).

## Out of scope (YAGNI)

- No UI toast/event for start/stop (the chosen gap is "startup-only data goes
  stale", not "explicit awareness").
- No second polling loop.
- No per-file-content watching.
