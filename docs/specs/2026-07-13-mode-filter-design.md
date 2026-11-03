# Exclusive `--mode` discovery filters

**Date:** 2026-07-13
**Status:** Approved

## Goal

Extend `--mode` / `DEVDASHBOARD_MODE` from the single `aspire` value to four
**exclusive** single-source filters. A filter mode shows only resources
discovered through that source — applications, workflows, state stores,
control-plane services, and log sources alike. Filters are never combined.
Mode unset stays the complete scan across all sources (today's behavior).

| CLI value | Discovery source | Pretty UI label |
|---|---|---|
| `dapr-run` | host `dapr run` process scan (`StandaloneScanner`) | Dapr run |
| `compose` | Docker Compose container discovery | Compose |
| `test-containers` | Testcontainers container discovery | TestContainers |
| `aspire` | Aspire-managed resources (see dual posture below) | Aspire |
| *(unset)* | all of the above | — |

CLI values are user-facing names and intentionally differ from the discovery
`Source` wire values (`standalone`, `testcontainers`); the mapping is
deliberate, do not unify them.

## Background

- Mode plumbing: [`cmd/mode.go`](../../../cmd/mode.go) (`resolveMode`,
  `resolveServeSettings`), consumed by [`cmd/root.go`](../../../cmd/root.go)
  `runServe`, which today has two branches: `ModeAspire` (env-contract scanner
  + container posture) and default (merge of standalone + compose +
  testcontainers scanners, plus the aspire env-contract scanner when
  `discovery.AspireContractPresent`).
- All app-derived state (workflows, state-store election, stats, resources)
  flows from the merged `discovery.Service`, so filtering the scanner set
  filters those surfaces automatically.
- The Control Plane view and the Logs view's control-plane targets do **not**
  flow from discovery and need their own filtering (below).

## Design

### 1. Mode values and validation

`cmd/mode.go` gains `ModeDaprRun("dapr-run")`, `ModeCompose("compose")`,
`ModeTestcontainers("test-containers")` alongside the existing `ModeAspire`.
`resolveMode` accepts the four values (flag wins over env, unset =
`ModeDefault`); anything else errors at startup naming the supported values.

### 2. `aspire` gets dual posture

`--mode aspire` currently conflates *which resources* with *where the
dashboard runs*. The split:

- **Env contract present** (`DEVDASHBOARD_APP_COUNT` set →
  `discovery.AspireContractPresent`): today's behavior, unchanged. The
  dashboard is the AppHost-managed container: env-contract scanner, container
  posture (port 8080, bind 0.0.0.0, no home-dir registry, no browser open,
  relaxed Host guard).
- **Contract absent**: new. The dashboard runs standalone on the host with
  normal **host posture** (port 9090, bind 127.0.0.1, browser open, registry
  persisted) and scans Aspire resources locally: the standalone process scan
  runs, and results are filtered post-enrichment to instances flagged
  `IsAspire` (the DCP-proxy heuristic in
  [`pkg/discovery/appproc.go`](../../../pkg/discovery/appproc.go)
  `appRuntime`). `IsAspire` is an enrichment-time signal, so this is a
  `discovery.Service` wrapper (filtered `List`, `Get` returns `ErrNotFound`
  for non-aspire keys) applied outside the lifecycle overlay — every consumer
  sees the filtered view.

Container-posture decisions (`resolveServeSettings` defaults, home dir,
browser open, `AllowNonLoopback`, `QuietRegistry`, the non-loopback bind
warning) key on `containerPosture = mode == ModeAspire && contractPresent`,
not on the mode alone.

### 3. Scanner selection per mode (host posture)

| Mode | Scanners | Companion deps |
|---|---|---|
| unset | standalone + compose + testcontainers (+ env contract if present) | composeEnv, containerLogs, extraRes, all |
| `dapr-run` | standalone | none of the container deps |
| `compose` | compose | composeEnv, containerLogs |
| `test-containers` | testcontainers | extraRes, containerLogs |
| `aspire` (host) | standalone + `IsAspire` post-filter | none of the container deps |

Lifecycle overlay/manager, update check, news, and full host capabilities stay
enabled in every host mode.

**Fail-fast:** `compose` and `test-containers` are exclusively
container-backed; when `containerruntime.Detect()` finds no runtime, startup
**fails** with an error naming the mode and the requirement (docker/podman on
PATH, or `DASH_CONTAINER_RUNTIME`). A silent, permanently empty dashboard is
not acceptable in an exclusive mode. Mode unset keeps today's degrade-to-empty
behavior.

### 4. Control Plane view filtering

[`pkg/controlplane`](../../../pkg/controlplane/service.go) lists two
families: the fixed `dapr init` containers (`LiveServiceNames`:
`dapr_placement`, `dapr_scheduler`) and compose-labeled placement/scheduler
containers (`composeControlPlane`). The manager gains a `Sources` selector
(`Init`, `Compose` booleans) that gates both `List` **and** the
`Do`/`LogStream` action allowlist:

| Mode | Control-plane families |
|---|---|
| unset | Init + Compose (today) |
| `dapr-run` | Init only |
| `compose` | Compose only |
| `test-containers` | none — honest empty state (detection **deferred to next iteration**) |
| `aspire` (host) | Init only (CommunityToolkit sidecars use the `dapr init` containers; verify on a real AppHost) |
| `aspire` (container) | n/a — capabilities already hide the view |

### 5. Logs view filtering

- The app target list comes from `/api/apps` → filtered automatically.
- The control-plane target list merges a static `dapr_*` fallback
  ([`web/src/pages/Logs.tsx`](../../../web/src/pages/Logs.tsx) `CP_SERVICES`)
  with `/api/controlplane`. The fetch is filtered server-side by (4); the
  static fallback must be mode-aware. The server-injected
  `window.__DASH_CAPABILITIES__` blob gains a `mode` field (the CLI value; ""
  = complete scan), and Logs includes the static `dapr_*` fallback only for
  modes `""`, `dapr-run`, `aspire`. This is not a UI filter control — the UI
  merely learns what the server was started with.

### 6. "Run template" → "Mode" relabel

- [`web/src/pages/Applications.tsx`](../../../web/src/pages/Applications.tsx)
  column header **Run template** becomes **Mode**. The cell value becomes a
  pure identity→label mapping (new shared helper `web/src/lib/modeLabel.ts`):
  `isAspire || source === 'aspire'` → **Aspire** (checked first — host-mode
  Aspire apps arrive with `source: 'standalone'`), `compose` → **Compose**,
  `testcontainers` → **TestContainers** (casing change from today's
  "Testcontainers"), `standalone` → **Dapr run**.
- The run-template name (`app.runTemplate`) keeps a tooltip slot on the Mode
  cell instead of the cell text.
- [`web/src/pages/AppDetail.tsx`](../../../web/src/pages/AppDetail.tsx) gains
  an explicit **Mode** row in the application identity card using the same
  helper (today the source shows only implicitly via Compose project /
  Session / CLI PID rows).

## Decisions

| Decision | Choice |
|---|---|
| No container runtime in `compose` / `test-containers` mode | **Fail at startup** with a clear error |
| Testcontainers control-plane detection (`org.testcontainers` labels) | **Deferred to next iteration**; empty state in v1 |
| Aspire host-mode control-plane family | Init containers, same as `dapr-run` |
| UI filter control | None — mode is CLI/env only |
| Pretty labels | `Dapr run`, `Compose`, `TestContainers`, `Aspire` |

## Known limitations (accepted for v1)

- **Aspire host filter rides on a heuristic.** `IsAspire` requires daprd to
  carry no app command and the app-port listener to be the DCP proxy; apps
  with `AppPort == 0` are invisible in aspire host mode. A stopped aspire
  app's ghost loses its DCP proxy, so it disappears from the filtered list
  instead of showing as stopped. The long-term fix is the resource-service
  gRPC scanner from
  [2026-07-13-aspire-discovery-alternatives.md](2026-07-13-aspire-discovery-alternatives.md),
  which would slot into this mode's source slot.
- **Aspire-launched containers** (e.g. Redis) carry no matchable labels and
  are not discovered in aspire host mode — same future fix.
- **`test-containers` Control Plane view is empty** until label-based
  detection lands (deferred).

## Out of scope

- Combining filters (explicitly never supported).
- Any UI control to switch modes at runtime.
- Testcontainers control-plane detection (next iteration).
- Resource-service gRPC aspire scanner (separate spec).
