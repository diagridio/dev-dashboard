# App Lifecycle Controls & Uptime — Design

**Date:** 2026-07-09
**Status:** Approved

## Goal

Add Start/Stop/Restart controls to the application detail page for both the
application and its Dapr sidecar, covering all discovery sources (`dapr run`,
Aspire, Docker Compose). Add a live uptime field for the application and the
sidecar that resets when the target is stopped.

## Decisions (from brainstorming)

1. **Stopped standalone apps are remembered.** The backend keeps an in-memory
   record of standalone (`dapr run`) apps it stopped — launch command, working
   dir, appId — so the detail page keeps showing them as `stopped` with a
   Start button. The record does not survive a dashboard restart (accepted).
2. **Granularity: per-panel + whole-instance.** Start/Stop buttons inside the
   Application panel and the Dapr sidecar panel for independent control, plus
   whole-instance buttons in the page header acting on both.
3. **Aspire: stop only.** No dashboard Start/Restart for Aspire-managed
   processes; the UI hints that Aspire manages restarts. Avoids fighting the
   orchestrator.
4. **Restart included** wherever both stop and start are possible (compose and
   `dapr run`), matching the control plane UX. Not shown for Aspire.
5. **Architecture: new `pkg/lifecycle` package** (approach 1), mirroring how
   `pkg/controlplane` is separate from discovery. Discovery stays a scanner;
   lifecycle owns mutation and the stopped-app registry. No disk persistence.

## Backend

### New package: `pkg/lifecycle`

```go
type Target string  // "app" | "daprd" | "all"
type Action string  // "start" | "stop" | "restart"

type Manager interface {
    Do(ctx context.Context, key string, target Target, action Action) error
    StoppedInstances() []StoppedInstance // consumed by discovery for merging
}
```

Instance resolution uses the same key semantics as `discovery.Service.Get`:
`InstanceKey` first, `AppID` fallback — so the detail page's URL param works
directly.

**Compose instances** — delegate to the existing `containerruntime.Runner`
(same mechanism as `pkg/controlplane`):

- `target=app` → `docker <action> <AppContainerID>`
- `target=daprd` → `docker <action> <DaprdContainerID>`
- `target=all` → both; stop order app→daprd, start order daprd→app (sidecar up
  before the app connects).

**Standalone `dapr run` instances**:

- **Stop**: snapshot each process's command line and working dir (gopsutil,
  already a dependency) *before* signalling. Then:
  - `target=all` → SIGTERM to the CLI PID (equivalent to `dapr stop`; the CLI
    tears down app + daprd). Fallback: signal app + daprd PIDs directly when
    there is no CLI PID.
  - `target=app` / `target=daprd` → SIGTERM to that PID only. Escalate to
    SIGKILL after a ~5s grace period if the process ignores SIGTERM.
  - The snapshot is stored in the in-memory registry keyed by instanceKey,
    per target — "app stopped, daprd running" is representable.
- **Start**: re-run the captured command (`exec.Command` with captured argv
  and dir, detached from the dashboard's process group, output to the
  instance's known log files where available). The registry entry is removed
  once discovery sees the process again.
- **Restart**: stop + wait for exit + start in one call.

**Aspire instances**: `stop` allowed (signal PID); `start`/`restart` rejected
with a sentinel error. The registry records the stop with an `aspire: true`
marker so the UI can show a "restart from Aspire" hint.

### API

`POST /api/apps/{key}/{target}/{action}` in `pkg/server/apps.go`, mirroring
the control-plane router's error mapping:

| Condition | Status |
|---|---|
| invalid target/action, or action unsupported for app type (e.g. Aspire start) | 400 |
| unknown key | 404 |
| execution failure (signal/exec/docker error) | 502 |

### Discovery changes

1. **Raw start times exposed**: add `AppStartedAt` / `DaprdStartedAt`
   (RFC3339 strings) to `Instance`. Sources exist already: per-PID create time
   (gopsutil) for standalone, per-container `State.StartedAt` for compose. The
   existing `age`/`created` strings are untouched.
2. **Per-target status**: add `AppStatus` / `DaprdStatus`
   (`running` | `stopped`) to `Instance`, making half-stopped states explicit.
3. **Compose sees stopped containers**: `scan_compose.go` switches to
   `docker ps -a` (still filtered to dapr-labelled compose projects) so
   stopped compose apps/sidecars remain visible natively with `stopped`
   status — no registry involvement for compose.
4. **Registry merge**: `List`/`Get` overlay lifecycle-registry entries for
   standalone instances absent from the process scan (fully stopped),
   rendered with `stopped` status, no PIDs, no uptime. When the scan finds
   the instance again, live data wins and the registry entry is dropped.
5. **Health semantics**: a stopped target reads as `unknown`/absent rather
   than `unhealthy` — stopped is deliberate, not a failure.

## Frontend

### Types & hooks

- `web/src/types/api.ts`: add `appStartedAt?`, `daprdStartedAt?`, and
  `appStatus?` / `daprdStatus?` (`'running' | 'stopped'`) to
  `AppSummary`/`AppDetail`. The Aspire hint keys off the existing `isAspire`
  plus the new status fields — no extra flag needed.
- New hook `useAppAction()` mirroring `useControlPlaneAction`: raw `fetch`
  POST to the new endpoint; on success invalidate `['apps']` and
  `['apps', key]`. Errors surface via the existing `useToast`.
- Small `useNow(intervalMs)` hook for the ticking uptime display.

### AppDetail page

- **Header row** (next to `← Back` / `View logs`): whole-instance buttons with
  the control-plane classes — `Start` (`btn ghost`) when everything is
  stopped; `Restart` (`btn ghost`) + `Stop` (`btn danger`) when running. Same
  `window.confirm` guard as the control plane page.
- **Application panel** and **Dapr sidecar panel** each get:
  - a status line (`running` / `stopped`, reusing LED styling);
  - an **Uptime** row computed client-side from `appStartedAt` /
    `daprdStartedAt`, ticking every second, formatted like `2h 14m 05s`;
    shows `—` when the target is stopped (this is the reset behavior — a
    later Start yields a fresh `startedAt`, so uptime restarts from zero);
  - per-target Start/Stop/Restart buttons in the panel header, with the same
    status-conditional rendering as the control plane's `ServiceCard`.
- **Aspire**: panels show Stop only; once stopped, a hint replaces Start:
  *"Managed by Aspire — restart it from the Aspire dashboard."*
- Buttons are disabled while a mutation is in flight (`mutation.isPending`).

### Applications list page

Stopped instances now appear (compose natively, standalone via registry),
rendered with the `unknown`/stopped LED style. No lifecycle buttons on the
list page — control lives on the detail page.

## Error handling & edge cases

- **Start fails** (port taken, stale command): POST returns 502 with the exec
  error; toast shows it; instance stays `stopped`.
- **Stopping the app also kills the CLI** (dapr CLI exits when a child dies):
  both commands were snapshotted before signalling, so everything remains
  restartable.
- **User restarts the app from their own terminal** while the dashboard shows
  it stopped: the next scan finds the live process under the same
  instanceKey → live data wins, registry entry dropped.
- **Sidecar-only stopped (compose)**: detail page stays reachable via the app
  container; the daprd panel shows stopped + Start. The `sidecarReachable`
  hint banner is suppressed when `daprdStatus === 'stopped'` (expected, not
  an error).
- **Dashboard restart**: registry is gone; fully-stopped standalone apps
  disappear from the list (accepted trade-off).

## Testing

- **Go**: unit tests for `pkg/lifecycle` with a fake container runner and a
  fake process signaller — action routing per source/target, Aspire
  rejection, registry snapshot and expiry. Handler tests for the new route's
  status-code mapping. Discovery tests for registry merge and `docker ps -a`
  stopped-container parsing.
- **Frontend**: `AppDetail.test.tsx` — buttons render per status/source/
  Aspire, confirm-then-mutate flow, uptime ticks and shows `—` when stopped
  (fake timers). `useAppAction` invalidation test.
- `make build` (includes `tsc -b`) and full test suites before commit — vitest
  alone does not typecheck.
