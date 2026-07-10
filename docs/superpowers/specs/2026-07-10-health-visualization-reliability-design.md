# Health Visualization Reliability — Design

**Date:** 2026-07-10
**Status:** Approved
**Follow-up to:** `2026-07-09-app-lifecycle-controls-design.md` (PR #53, merged)

## Problem

The health LED means only "daprd `/v1.0/healthz` answered" (`pkg/discovery/health.go`),
and all app-process information (`appPID`, command, log paths) comes from
Extended metadata that only the `dapr` CLI injects at launch
(`pkg/discovery/metadata.go`). Two consequences observed in practice:

1. An app whose process died still shows a green "healthy" LED as long as its
   sidecar answers health probes; `appStatus` goes stale or unknown instead
   of `stopped`.
2. Stopping/restarting only the daprd sidecar of a `dapr run` app fights the
   CLI's supervision: the stop cascades to the app, and a dashboard-restarted
   daprd is detached from the CLI (own process group, no Extended metadata) —
   an orphaned sidecar that survives external stops and keeps the instance
   looking healthy forever.

## Decisions (from brainstorming)

1. **App liveness: PID check + port dial.** Verify the metadata-reported
   `AppPID` with gopsutil `PidExists`; when the PID is unknown but `appPort`
   is set, a fast local TCP dial decides. daprd's `appConnectionProperties`
   is NOT consumed — it requires the app to opt into
   `--enable-app-health-check` and is absent for most local apps.
2. **Overview: combined LED + reason text.** One LED derived from both
   halves, with the label naming the state (`healthy`, `app down`,
   `orphaned`, `unhealthy`, `stopped`).
3. **Orphaned sidecars: flag + offer Stop.** Detected orphans render amber
   with an explanation; the existing whole-instance Stop cleans them up.
4. **Guardrail: funnel daprd-only actions to whole-instance** for `dapr run`
   apps. The sidecar panel's Stop/Restart act on the whole instance
   (re-running the original `dapr run` command); the confirm dialog explains
   why. No dashboard path can create an orphan. Compose keeps per-container
   control; Aspire stays stop-only, unchanged.
5. **Registry-snapshot backfill of app info: dropped (YAGNI).** Funneling
   removes the only dashboard flow that produced metadata-less daprd
   restarts.

## Architecture

Liveness probing lives inside discovery `enrich` (Approach A): two new
injectable functions on the `service` struct, following the existing
`procStart` pattern. Everything downstream renders `Instance` fields — the
rule lives in one testable place. A background health poller (Approach B) was
rejected as machinery without payoff: `PidExists` is a syscall and a dial to
a closed loopback port fails immediately.

## Backend

### Truthful `appStatus` (standalone only; compose is container-state-driven)

`pkg/discovery/service.go`:

- `service` gains `pidAlive func(pid int) bool` (default: gopsutil
  `PidExists`) and `portOpen func(port int) bool` (default:
  `net.DialTimeout("tcp", "127.0.0.1:<port>", 200ms)`; never called for
  port 0).
- In `enrich`, after metadata, for `SourceStandalone`:
  - `AppPID != 0`: `pidAlive(AppPID)` decides `AppStatus` =
    `running`/`stopped`. A dead PID also zeroes `AppPID` and `AppStartedAt`
    (no stale PID display).
  - `AppPID == 0 && AppPort != 0`: `portOpen(AppPort)` decides
    `running`/`stopped`.
  - Neither signal: `AppStatus` stays `""` (unknown) — honest, never worse
    than today.
  - Probes run only on the metadata-success path; the metadata-failure and
    sidecar-unreachable early returns are unchanged (the orphan case has
    reachable metadata with empty Extended, so it is covered).

### Orphan detection

New `Instance` field `SidecarOrphaned bool` (`json:"sidecarOrphaned,omitempty"`),
computed in `enrich`, true when ALL of:

- `Source == SourceStandalone`
- `!IsAspire` (Aspire daprd legitimately lacks CLI metadata)
- `CLIPID == 0` (no supervising `dapr` CLI)
- `AppStatus == StatusStopped`

A normal `dapr run` app always reports a CLI PID, so false positives require
losing both the CLI and the app while daprd survives — exactly the orphan
case.

### Funneling (lifecycle manager)

`pkg/lifecycle/manager.go` `doStandalone`: for non-Aspire instances,
`target == TargetDaprd` is remapped to `TargetAll` before dispatch. Stop and
restart therefore act on the whole instance via the existing CLI-PID path;
the existing no-CLI fallback (signal whatever PIDs are alive) covers orphan
cleanup, where only the daprd PID exists. Aspire (stop-only, per-PID) and
compose (per-container) behavior unchanged.

### API

No route changes. Two new omitempty JSON fields (`sidecarOrphaned`, plus the
truthful `appStatus` values) — backward compatible.

## Frontend

### Types

`AppSummary` gains `sidecarOrphaned?: boolean`.

### Derived display state

New pure helper `appDisplayState(app)` in `web/src/lib/` returning
`{ label, led }`, used by both pages so the rule lives once. Precedence:

1. `appStatus === 'stopped' && daprdStatus === 'stopped'` → grey `stopped`
   (existing behavior moves into the helper)
2. `sidecarOrphaned` → amber (`starting` LED style), label `orphaned`
3. sidecar health healthy but `appStatus === 'stopped'` → amber, `app down`
4. otherwise → existing `health` value and LED

### Applications overview

The Health cell renders from `appDisplayState`. Amber states carry a
tooltip: `app down` → "app process is not running"; `orphaned` → "sidecar
has no supervising dapr CLI and no app — safe to stop". The "Apps running"
stat keeps its current rule (excludes only fully-stopped instances).

### AppDetail

- Status rows become truthful automatically via the backend change.
- Orphan banner (hint style, when `sidecarOrphaned`): *"Orphaned sidecar —
  this daprd has no supervising dapr CLI and its app is gone. Stopping it is
  safe."* The header Stop button is the cleanup action (funnel + fallback
  already signal just the daprd PID).
- Sidecar panel buttons for `dapr run` apps send `target: 'all'`; confirm
  copy: *"For dapr run apps the sidecar and app are managed together — this
  will stop/restart the whole instance."* Compose and Aspire button wiring
  unchanged.

## Edge cases

- **Port-dial false positive** (another process reuses the app port):
  accepted dev-machine heuristic; the PID check wins whenever a PID is
  known.
- **App that never listens on its app port** (`appPort` 0 or a non-server
  app): no dial attempted; status stays unknown — same as today.
- **Probe cost:** one syscall or one instant loopback dial per app per poll,
  inside the existing 8-worker enrich parallelism. The 200 ms timeout only
  bites for half-open ports, which do not occur on loopback.
- **Orphan mis-detection:** requires all four conditions; Aspire excluded
  explicitly.

## Testing

- **Go:** enrich tests with fake `pidAlive`/`portOpen` — dead PID → stopped
  + zeroed PID/startedAt; port-open → running; port-closed → stopped; no
  signals → unknown; orphan-flag truth table including the Aspire and
  CLI-PID exclusions. Manager tests pinning daprd→all funneling for
  standalone non-Aspire, and unchanged Aspire/compose dispatch.
- **Frontend:** unit tests for `appDisplayState` (all four branches +
  precedence); Applications rendering of `app down` and `orphaned` rows with
  tooltips; AppDetail orphan banner and the new sidecar-panel confirm copy.
- `make build` (includes `tsc -b`) and full Go (`-tags unit` /
  `-tags integration`) + vitest suites before commit.
