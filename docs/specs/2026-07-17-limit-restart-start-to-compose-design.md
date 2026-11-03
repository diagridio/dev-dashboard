# Limit Restart & Start to Compose mode

**Date:** 2026-07-17
**Status:** Approved — ready for implementation plan

## Problem

The Application detail view (`web/src/pages/AppDetail.tsx`) offers Restart, Start,
and Stop lifecycle controls for discovered app instances. In practice, Restart and
Start only work **reliably** for apps started via Docker Compose, where the container
runtime restarts/starts containers cleanly. For Dapr-run (standalone) apps the
start/restart path depends on re-running a process snapshot captured at stop time,
which is unreliable. Offering those buttons sets a false expectation.

## Goal

Limit **Restart** and **Start** to Compose mode only. Keep **Stop** available for
every mode where it works today. Make the reliability boundary explicit in both the
UI and the backend API.

## Behavior

Restart and Start become Compose-only. Stop is unchanged.

| Mode | Before | After |
|------|--------|-------|
| Compose | Restart / Start / Stop | *(unchanged)* Restart / Start / Stop |
| Dapr run (standalone) | Restart / Start / Stop | **Stop only** |
| Aspire | Stop only | *(unchanged)* Stop only |
| Testcontainers | none | *(unchanged)* none |

After stopping a Dapr-run app, it still appears as *stopped* and offers **Remove from
list** via the existing `removable = !isCompose && appStopped && daprdStopped` path,
so the flow does not dead-end.

## Frontend — `web/src/pages/AppDetail.tsx`

- Add an `isCompose` gate to:
  - the header **Restart** button (target `all`),
  - the header **Start** button (target `all`),
  - the per-panel **Restart** and **Start** in `panelActions`.
- Stop buttons (header and panels) are untouched — all current stop conditions remain.
- Simplify now-redundant conditions:
  - the panel Start's `(isCompose || !allStopped)` clause collapses to `isCompose`,
  - the header Start's non-compose reachability collapses to `isCompose && allStopped`.
- Add a hint for a **running standalone** app (source `standalone`, not Aspire, not
  orphaned): *"Started with `dapr run` — restart and start it from your terminal."*
  Styled like the existing Aspire hint (`className="hint"`). It complements, and does
  not replace, the existing Aspire/orphan/unreachable hints.

Aspire (`isCompose` is false) already had Restart/Start hidden, so there is no
regression there.

## Backend — `pkg/lifecycle/manager.go`

- Add a single policy guard at the top of `doStandalone`: any `action` other than
  `ActionStop` returns `ErrUnsupported` with a clear message, e.g.
  *"restart/start is only supported for Docker Compose apps"*. This subsumes the
  existing Aspire and orphaned-sidecar start/restart guards (which can be simplified
  or left in place — the earlier general guard wins first).
- `standaloneStop`, `RecordStop`, `terminateWithEscalation`, and the registry/overlay
  stopped-instance visibility are **unchanged** — stopped Dapr-run apps must still be
  remembered so they render as *stopped* and can be removed from the list.
- `standaloneStart` and the injected `Starter` wiring stay in place as **dormant
  machinery** behind the gate. Nothing is removed, so start can be re-enabled when it
  becomes reliable.

Compose (`doCompose`) and Testcontainers handling in `Do` are unchanged.

## Tests

- `pkg/lifecycle/manager_test.go`: convert the standalone start/restart success cases
  (~lines 260–347) into assertions that start and restart now return `ErrUnsupported`.
  Stop cases stay green. Compose start/restart/stop cases stay green.
- `web/src/pages/AppDetail.test.tsx`:
  - standalone running app: assert Restart and Start are absent, Stop is present,
    and the new `dapr run` hint renders;
  - compose app: assert Restart/Start/Stop all still present;
  - standalone stopped app: assert **Remove from list** still offered.

## Out of scope

- The Control Plane view (`ControlPlane.tsx`) placement/scheduler restart — unrelated.
- Making standalone start/restart reliable — deferred; the machinery is retained for
  that future work.
