# Compose App Instance Identity (Container Name as Key) — Design

**Date:** 2026-07-09
**Status:** Approved design, pending implementation plan

## Problem

Compose discovery (PR #34) identifies apps solely by the daprd `-app-id`.
`AppID` is simultaneously the list key, the `/apps/:appId` route param, the
`service.Get` lookup key, and the display label. When several compose sidecars
share one app-id — a normal Dapr pattern for scaled instances (reference
workload: `dapr-mq`'s `docker-compose.yml`, four sidecars all running
`-app-id daprmq-service`) — the Applications page shows four identical rows
that all drill into the same first-matching instance. Logs, app detail, and
the Logs-page dropdown collapse the same way.

The data to tell instances apart is already captured per instance
(`appContainerName`, `daprdContainerName`, ports, container IDs); only the
identity is missing.

## Goals

1. Each compose-run app instance is individually addressable: distinct row,
   distinct detail URL, distinct log stream.
2. The container name is the instance identifier for compose apps, with
   fallback to the app-id when absent.
3. Container name is shown alongside the app-id on the App overview and App
   detail pages; the Logs dropdown distinguishes instances.
4. Zero observable change for apps started with `dapr run` or Aspire.

## Chosen approach

Add a new **`InstanceKey`** field alongside `AppID` — routing identity
separate from Dapr identity. Rejected alternatives:

- **Overwrite `AppID` with the container name for compose apps:** smallest
  frontend diff, but breaks every join that needs the real app-id (workflow
  state-store key parsing, actor metadata, `?appId=` filters) and misreports
  the sidecar's actual identity. High regression risk.
- **Query-param disambiguator (`/apps/{appId}?instance=…`):** keeps AppID as
  the route but leaks a two-part identity into every link and still needs a
  unique value for dropdowns — Approach A with worse ergonomics.

## Design

### 1. Identity model (backend)

`ScanResult` (`pkg/discovery/service.go`) and `Instance`
(`pkg/discovery/types.go`) gain `InstanceKey string` (`json:"instanceKey"`),
computed at scan time:

- **Compose scanner** (`pkg/discovery/scan_compose.go`, after app-container
  pairing): `AppContainerName` → fallback `DaprdContainerName` → fallback
  `AppID`. Docker/podman container names are unique per host, so the key is
  unique whenever a container name is available.
- **Standalone scanner** (`dapr run` / Aspire,
  `pkg/discovery/scan_standalone.go`): always `AppID`.

### 2. Lookup resolution

`service.Get(key)` (`pkg/discovery/service.go:94-106`) resolves in two
passes over the scan results:

1. Exact `InstanceKey` match (checked across **all** apps first).
2. First `AppID` match, as fallback.

Consequences:

- `/api/apps/daprmq-host-1` resolves the exact instance.
- Legacy/ambiguous links such as `/api/apps/daprmq-service` (e.g. from a
  workflow page) resolve to the first matching instance instead of 404ing —
  same behavior as today.
- The two-pass order makes a collision (some container named identically to
  another app's app-id) resolve deterministically in favor of the instance
  key.
- All `Get`-based paths — app detail, log streaming
  (`pkg/server/logs.go`), workflow purge/removal target resolution
  (`cmd/workflow.go`) — are fixed through this single chokepoint.

### 3. Per-instance rows on derived endpoints

Actor, Subscription, and Components-"loaded by" rows are built by iterating
the discovered app list (`pkg/server/actors.go`, `pkg/server/subscriptions.go`,
`pkg/server/resources.go`), so each row DTO gains `instanceKey` next to its
existing `appId`. This lets those pages link precisely to one instance.

Workflows are excluded: workflow instances live in the state store keyed by
the daprd app-id, and cannot be attributed to a single compose instance.
Workflow pages keep linking by `appId` (resolved via the `Get` fallback).

### 4. Sorting

The app list sort (`service.List`) becomes `AppID, then InstanceKey` so
same-app-id instances have a stable order.

### 5. Frontend

**Types** (`web/src/types/api.ts`): `instanceKey` on `AppSummary` and
`AppDetail`; also on actor, subscription, and loaded-by row types.

**App overview** (`web/src/pages/Applications.tsx`):

- Rows keyed and linked by `app.instanceKey` (`/apps/${app.instanceKey}`).
- When `instanceKey !== appId` (compose apps): the **container name is the
  primary line**, with the app-id underneath in smaller muted text.
- When `instanceKey === appId` (dapr run / Aspire): single line, unchanged.

**App detail** (`web/src/pages/AppDetail.tsx`): the `:appId` route param is
treated as the instance key — `useApp(key)` fetches `/api/apps/${key}`. The
page title/breadcrumb keeps the **app-id as the primary line** with the
container name underneath. "View logs" links pass `?app=${instanceKey}`.

**Logs page** (`web/src/pages/Logs.tsx`, `web/src/hooks/useLogStream.ts`):
dropdown option *value* is `instanceKey`; label shows `appId (container-name)`
when they differ. Stream URL becomes `/apps/${key}/logs`.

**Links from other pages**: Actors (`Actors.tsx`), Subscriptions
(`Subscriptions.tsx`), and ResourceDetail's "loaded by" use their row's
`instanceKey` for `/apps/…` links. `WorkflowDetail.tsx` keeps linking by
`appId`.

## Edge cases

| Case | Behavior |
| --- | --- |
| No explicit `container_name` in compose | Docker generates `project-service-1`; still unique per host — works unchanged. |
| App-container pairing fails (no service matches `-app-channel-address`) | Falls back to daprd container name, then app-id. |
| Container name collides with another app's app-id | Deterministic: instance-key pass wins over app-id fallback. |
| Container recreated under a new name | URL changes; stale links resolve via the app-id fallback. Acceptable for a live dev tool. |
| Duplicate app-id across compose + `dapr run` | Compose instances get distinct keys; the `dapr run` app keeps its app-id key. App-id fallback resolves to first in scan order — same as today, no regression. |
| Non-compose apps | `instanceKey === appId`; no sub-line rendered, URLs identical to today. |

## Testing

- **Backend unit tests:** `InstanceKey` computation (all three fallback
  tiers); `Get` resolution (exact key hit, app-id fallback, precedence when
  both could match); a duplicate-app-id compose scenario yields four distinct,
  individually retrievable instances.
- **Frontend tests:** overview renders container name as primary line with
  muted app-id for compose rows and links by key; Logs dropdown offers
  distinct options per instance; AppDetail fetches by key.
- **Build:** `tsc -b` / `make build` in addition to vitest (vitest does not
  typecheck).
- **Manual verification** against the live `dapr-mq` stack: drill into all
  four apps, stream logs from each.
