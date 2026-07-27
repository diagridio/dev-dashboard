# Clear Inactive Applications — Design

Date: 2026-07-27
Status: Approved design, pending implementation plan

## Problem

The dashboard shows entities discovered by **scanning** the local machine (Dapr
apps + sidecars, and — derived from them — components, subscriptions, actors,
resources). Some of these entities go **inactive** (the process stops, the
container exits) but continue to appear in the dashboard. Today the only way to
remove a stale entry is a single "Remove from list" button buried on the
**App detail** page, gated to fully-stopped **non-compose** apps. There is no
coherent, global way to clear inactive data — the user has to visit each app's
detail page, and compose apps cannot be removed at all.

We want an **easy, global, coherent** way to remove data related to inactive
applications — one action that clears everything, rather than per-page,
per-entity cleanup.

## Findings: where retained "inactive" state actually lives

Investigation of the codebase established that there is far less retained state
than the UI suggests, and it comes from exactly two backend sources:

1. **The discovery/scanning layer is stateless.** `pkg/discovery/service.go`
   re-scans on every `/api/apps` request. Nothing accumulates there, nothing is
   persisted to disk. Components, subscriptions, actors, and resources are all
   **derived** from the live app scan (`pkg/server/subscriptions.go`,
   `actors.go`, `resources.go` re-derive from `apps.List`), so they are not
   independently retained — their retention is a side effect of app retention.

2. **The frontend retains nothing.** React Query is in-memory only
   (`web/src/lib/query.tsx` has no persister); `localStorage` holds only prefs
   (refresh interval, news-seen), never entities. On reload the UI shows exactly
   what the backend returns.

The only genuinely retained inactive state is therefore backend-side:

| Source | Retains | Keyed by | Removed today |
|---|---|---|---|
| `lifecycle.Registry` (`pkg/lifecycle/registry.go`) | Standalone/Aspire instances **the dashboard itself stopped** (synthesized "ghost" rows). Lost on dashboard restart. | `InstanceKey` | `DELETE /api/apps/{appId}` → `Manager.Forget` → `reg.Drop`. |
| Docker/Podman itself | Stopped compose containers — the compose scanner runs `ps -aq` (`scan_compose.go`), so it reflects stopped containers until `docker rm`. | container name | **No path exists** — `Forget` cannot touch these (not registry-backed). |

Externally-stopped standalone apps already vanish from the scan, so there is
nothing to remove for those.

## Decisions (from brainstorming)

1. **Dashboard-state only, non-destructive.** Never run `docker rm`. Removing a
   stopped compose container means **suppressing it from the dashboard's view**,
   not deleting it from Docker.
2. **Fully-stopped only.** Eligible = `AppStatus == stopped && DaprdStatus ==
   stopped` (the existing `isStopped` predicate). Half-running / orphaned states
   stay visible.
3. **Global button in the Applications page header + per-row remove** on the
   Applications list. One global "clear all" plus granular control.
4. **Backend, in-memory, until restart.** Suppression lives in the lifecycle
   manager (keyed by `InstanceKey`), shared by all dashboard tabs, resets on
   dashboard process restart — the same ephemeral lifetime as the existing
   registry. Auto-un-hides if the instance becomes active again.

## Design

### 1. Core mechanism — unified "dismiss" in the lifecycle layer

All retained inactive state flows through the lifecycle overlay
(`pkg/lifecycle/overlay.go`), which decorates the discovery service. That is the
single chokepoint. The lifecycle manager gains an in-memory **suppression set**
alongside the existing registry.

- **`Manager.Dismiss(key string)`**:
  - `registry.Drop(key)` — frees any synthesized ghost, and
  - adds `key` to `suppressed map[string]struct{}` (guarded by the existing
    mutex).

  One code path handles both standalone/Aspire ghosts and
  compose/testcontainers stopped containers. Dropping the registry entry is
  redundant-but-harmless for compose (they are never registry-backed);
  suppressing is redundant-but-harmless for a ghost (it will no longer be
  synthesized). Keeping both keeps a single, uniform call site.

- **`overlay.List` final filter pass** (after live scan + synthesized ghosts are
  merged): for each instance, if `suppressed[key]`:
  - if the instance is **fully stopped**, drop it from the returned list;
  - if the instance is **active** (not fully stopped), keep it **and** remove
    `key` from the suppression set (auto-un-hide). This makes a restarted app
    reappear on its own.

- **"Fully stopped" predicate (backend)**: `AppStatus == StatusStopped &&
  DaprdStatus == StatusStopped`. This matches the frontend `isStopped` and the
  current `removable` gate, minus the `!isCompose` exclusion — compose is now
  included.

Because components/subscriptions/actors/resources re-derive from `apps.List`,
suppressing an app removes it from every page automatically. That is what makes
the feature coherent and global with no per-page code.

### 2. Backend API

- **Generalize `DELETE /api/apps/{appId}`** (`pkg/server/apps.go`) from "Forget
  registry entry" to "Dismiss". It resolves the `InstanceKey` (existing
  resolution logic) and calls `Manager.Dismiss`. This now succeeds for compose
  stopped containers (currently returns 404). Powers per-row remove and the
  existing AppDetail button. Returns `204`. For an app that is not
  fully stopped and has no registry entry, return `404`/`409` (see edge cases).

- **New `POST /api/apps/clear-inactive`**: the handler does a fresh `svc.List`,
  filters to fully-stopped instances, calls `Manager.Dismiss(key)` for each
  distinct `InstanceKey`, and returns `{ "cleared": N }`. A distinct path
  (`clear-inactive`) avoids collision with the `{appId}` route.

### 3. Frontend

- **Global button — Applications page header.** In `web/src/pages/Applications.tsx`,
  the `.phead` header gains a right-aligned action `Clear inactive · N`,
  rendered only when `N > 0`. `N` is the count of `isStopped(app)` over the
  existing `['apps']` query — no new query, no cross-page polling (this is why
  the header, not the topbar, is the home). Clicking opens a `ConfirmDialog`
  ("Remove N stopped application(s) from the dashboard? They'll reappear if
  restarted."), then calls `POST /api/apps/clear-inactive` and invalidates
  `['apps']`.

- **Per-row remove.** Each fully-stopped row on the Applications list gets a
  remove control (in the existing trailing `<td>`), reusing the generalized
  `DELETE /api/apps/{appId}` via the existing hook
  (`web/src/hooks/useAppAction.ts`, `useAppForget` / `sendAppForget`). The row
  action stops event propagation so it does not trigger row navigation, and
  confirms before removing.

- **AppDetail consistency.** In `web/src/pages/AppDetail.tsx`, drop the
  `!isCompose` part of the `removable` gate (line 84) so the existing
  "Remove from list" button also works for fully-stopped compose apps, matching
  the new list behavior.

- **Copy.** Because nothing is deleted from Docker, wording is "Remove from
  dashboard" / "hidden until it runs again or the dashboard restarts" — never
  "delete" or "remove container".

- **Telemetry.** Reuse `trackAction` for `clear_inactive` (with count) and the
  per-row/detail remove, consistent with existing action tracking.

### 4. Edge cases

- **Auto-un-hide**: a dismissed instance that reappears active is shown and
  pruned from the suppression set (covered by the overlay filter).
- **Dismiss a key not currently scanned**: no-op on the list, but the
  suppression is still recorded (harmless; pruned when seen active, otherwise
  lives until restart).
- **`clear-inactive` with zero inactive**: returns `{ "cleared": 0 }`; the
  button is hidden client-side anyway.
- **Concurrency**: suppression set shares the manager mutex; `Dismiss` and the
  overlay read are serialized.
- **Not-fully-stopped single delete**: `DELETE /api/apps/{appId}` for an app
  that is neither fully stopped nor a registry ghost returns an error
  (`404`, preserving current `ErrNotFound` behavior) — you cannot dismiss a
  live app.

### 5. Testing (TDD)

Backend (Go):
- `overlay_test.go`: suppressed + fully-stopped instance is filtered out;
  suppressed + active instance is returned and un-suppressed; unsuppressed
  instances pass through unchanged.
- `manager` test: `Dismiss` drops registry entry and records suppression;
  idempotent.
- `apps` handler tests: generalized `DELETE /api/apps/{appId}` dismisses a
  compose stopped container (was 404); `POST /api/apps/clear-inactive` returns
  the correct `cleared` count and dismisses every fully-stopped instance;
  zero-inactive returns `0`.

Frontend (Vitest + tsc):
- Applications: `Clear inactive · N` shows only when N>0 with correct count;
  clicking confirms then calls the endpoint and invalidates `['apps']`; per-row
  remove appears only on fully-stopped rows, stops propagation, confirms, and
  removes.
- AppDetail: remove button now shows for a fully-stopped compose app.
- Run `make build` (tsc) after any `.ts(x)` change — vitest alone does not
  typecheck.

## Non-goals

- No `docker rm` / destruction of real Docker or container state.
- No disk persistence of suppression (resets on dashboard restart, by design).
- No change to the stateless discovery/scanning layer.
- No removal semantics for half-running / orphaned instances.
- No bulk-select UI (a single global clear + per-row remove is sufficient).

## Files likely touched

- `pkg/lifecycle/manager.go`, `pkg/lifecycle/overlay.go`,
  `pkg/lifecycle/registry.go` (suppression set + `Dismiss` + filter)
- `pkg/server/apps.go` (generalized DELETE, new clear-inactive route)
- `web/src/pages/Applications.tsx` (global button + per-row remove)
- `web/src/pages/AppDetail.tsx` (drop `!isCompose` gate)
- `web/src/hooks/useAppAction.ts` (dismiss hook, if adjustments needed)
- Tests alongside each.
