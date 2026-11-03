# Path-aware active-store election

**Date:** 2026-06-30
**Status:** Approved design

## Problem

The dashboard elects one **active** state store (the default shown on the
workflow page). When an app loads a store whose component **name** collides with
a same-named store elsewhere — most commonly the global `~/.dapr/components`
default created by `dapr init` — the election picks the wrong one.

Observed live: an Aspire app `pr-digest` loads `state.redis` component
`statestore` from `.../PrDigest.AppHost/resources/statestore.yaml`
(redis `localhost:16379`). There is also `~/.dapr/components/statestore.yaml`
(redis `localhost:6379`). Both are detected; both are named `statestore`. The
workflow page shows the **6379** store (old, unrelated data) as active, and the
user's actual **16379** store — though listed in `/api/statestores` and fully
queryable via `?store=<id>` — is `active:false`, with no UI selector (Spec 2c)
to switch to it.

### Root cause

`derivePaths` (`cmd/derive.go`) builds `loaded map[string]bool` keyed by
component **name**. `newStoreRegistry` (`cmd/workflow.go`) decides "app-loaded"
via `isLoaded(c) = loaded[c.Name]`. With two components both named `statestore`,
**both** satisfy `isLoaded`, so election step 1 ("app-loaded AND actorStateStore")
takes the **first detected** component. `scanPaths` lists `~/.dapr/components`
before any app `resourcePaths`, so the global default is detected first and wins.
The app's `/v1.0/metadata` only reports loaded component **names**, not paths or
connections, so name-matching cannot distinguish the two.

## Goal

Elect the store the running app actually loaded — identifiable by **path**: its
component file sits under the app's own `resourcePaths`. Prefer an app-provided
store over a same-named global default, falling back to the global default only
when the app has no store of its own. The `/api/statestores` listing is
unchanged (both stores remain listed; only the `active` flag flips).

## Design

### 1. `derivePaths` returns the app resource paths

Add a fourth return value `appPaths []string` — the union of running apps'
`resourcePaths` (the scan locations that are NOT `~/.dapr/components`):

```
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string)
    (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string)
```

`appPaths` is the concatenation of each app's `ResourcePaths`. (`loaded` is
unchanged — still the set of loaded component names.)

### 2. Path-aware election in `newStoreRegistry`

`newStoreRegistry` takes an added `appPaths []string` parameter:

```
func newStoreRegistry(comps []statestore.Component, loaded map[string]bool, appPaths []string) *storeRegistry
```

Define:
- `isLoaded(c) = loaded != nil && loaded[c.Name]` (unchanged)
- `isActor(c)  = c.Metadata["actorStateStore"] == "true"` (unchanged)
- `isAppProvided(c) = isLoaded(c) && pathUnder(c.Path, appPaths)` (new)

New election precedence (first match wins):

1. app-provided **and** actorStateStore
2. app-provided (any)
3. loaded **and** actorStateStore   — fallback: app genuinely uses the global default
4. loaded (any)
5. actorStateStore
6. first component

For the `pr-digest` case both `statestore` comps are loaded + actorStateStore,
but only the one under `.../PrDigest.AppHost/resources` is app-provided, so it
wins at step 1. The `~/.dapr` 6379 store remains listed with `active:false`.

### 3. `pathUnder` helper

```
func pathUnder(child string, parents []string) bool
```

Normalize `child` and each `parent` via the existing `normPath` (in
`cmd/registry.go`: `filepath.Clean`, case-folded on Windows) and return true when
`normPath(child) == normPath(parent)` or `normPath(child)` is under
`normPath(parent) + string(os.PathSeparator)`. Cross-platform via `path/filepath`.

### 4. Wiring

In `cmd/reconciler.go` `reconcile`, capture the new `appPaths` from `derivePaths`
and pass it to `newStoreRegistry(detected, loaded, appPaths)`. No other reconciler
logic changes.

## Backward compatibility

When `appPaths` is empty or nil, `isAppProvided` is always false and election
falls through to the existing loaded → actor → first precedence (steps 3–6) —
identical to today's behavior. Existing `newStoreRegistry(comps, loaded)` call
sites/tests simply gain a `nil` (or relevant) `appPaths` argument; their outcomes
are unchanged. This is a refinement, not a behavior change, for every case except
the same-name-collision one this fixes.

## Error handling

- A component with an empty `Path` (e.g. a manual registry entry, which is not
  in `comps` here anyway) → `pathUnder` returns false → not app-provided. Safe.
- `appPaths` entries are app resource directories; `pathUnder` tolerates
  non-existent paths (pure string comparison after normalization).

## Testing (TDD)

- `cmd/derive_test.go`: `derivePaths` returns `appPaths` = union of the apps'
  `ResourcePaths`, and does NOT include `~/.dapr/components`.
- `cmd/workflow_test.go` (core): two same-named `state.redis` components, both in
  `loaded` and both `actorStateStore:"true"` — one with `Path` under an app
  resource path, one under `~/.dapr/components`; with `appPaths` set to the app
  dir, election picks the **app-provided** (app-path) component. Fallback case:
  only the `~/.dapr` component present (no app-provided) with its name loaded →
  it is still elected. Update existing `TestStoreRegistry_*` to pass `appPaths`
  (nil where not under test); they keep their current outcomes.
- Integration (`//go:build integration`, no external services): reproduce the
  shape with two same-named SQLite stores — one under a running app's
  `ResourcePaths`, one under a separate (home) dir — and assert `/api/statestores`
  marks the app-provided one `active:true` and the other `active:false`.

## Out of scope

- The Spec 2c store selector UI (this fix corrects the *default*; the selector is
  separate).
- Any change to `/api/statestores` listing, the registry, or the connection pool.
- Disambiguating two *app-provided* stores that share a name across two running
  apps (still resolved by precedence order; the 2c selector covers manual choice).
