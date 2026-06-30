# Applications page: components-loaded count + Aspire run-template label

## Problem

The Applications page (`web/src/pages/Applications.tsx`) has two summary stat cards
that always render a dash `—`:

- **Components loaded** — hardcoded to `—` (line 66) with a stale comment claiming the
  data is "only available per-app". The data is in fact present on every list item
  (`AppSummary.components`).
- **Run template** — shows the first app's `runTemplate`, else `—`. Apps launched by
  .NET Aspire are started via individual `dapr run` invocations (no `-f` run template),
  so `runTemplate` is empty and the card shows `—` even though the apps *are* managed by
  Aspire.

## Goal

1. **Components loaded** shows the total number of components loaded across all running
   apps (sum of each app's component count).
2. **Run template** shows `Aspire` when an app is Aspire-managed, instead of `—`.
   This applies to both the summary stat card and the per-row Run template column.

## Design

### Detection — reuse existing Aspire awareness

The backend already detects Aspire apps. In `pkg/discovery/appproc.go`, `isAspireProxy()`
recognizes the .NET Aspire Developer Control Plane (DCP) proxy that fronts each app's
port; `appRuntime()` uses it to resolve Aspire apps to the `dotnet` runtime. We surface
that same determination as a new boolean rather than inventing a new heuristic.

Confirmed against the live dashboard: the Aspire app `pr-digest` reports
`runTemplate: ""`, `command: ""`, app-port listener = the Aspire DCP proxy, and 3
components — so it already flows through the `isAspireProxy` branch.

Rejected alternatives:
- **Frontend `.AppHost` path heuristic** — fragile, and `resourcePaths` is not part of the
  list response (`AppSummary`).
- **Process-tree ancestry walking** — more code, redundant with `isAspireProxy`.

### Backend changes (`pkg/discovery`)

- `types.go`: add `IsAspire bool` to `Instance`, serialized as `json:"isAspire,omitempty"`.
- `appproc.go`: change `appRuntime(command, appPort, r) string` to
  `appRuntime(command, appPort, r) (runtime string, isAspire bool)`. `isAspire` is true
  only in the existing `isAspireProxy(cmd)` branch. The existing ordering is preserved
  (a real runtime detected directly on the app port still wins before the Aspire branch,
  per `TestAppRuntime_GenericFallbackStillWinsBeforeAspire`).
- `service.go`: `enrich()` sets `in.Runtime, in.IsAspire = appRuntime(...)` from one call.

### Frontend changes (`web/src`)

- `types/api.ts`: add `isAspire?: boolean` to `AppSummary`.
- `pages/Applications.tsx`:
  - **Components loaded** = `apps.reduce((n, a) => n + (a.components?.length ?? 0), 0)`,
    rendered as the number; falls back to `—` only when the total is 0.
  - **Run template stat card** precedence: a real run-template name if any app has one,
    else `'Aspire'` if any app `isAspire`, else `'—'`.
  - **Per-row Run template column**: `app.runTemplate || (app.isAspire ? 'Aspire' : '—')`.

## Testing

- **Go (unit, `-tags unit`)**: extend `appproc_test.go` to assert the new `isAspire`
  return value — `true` for the DCP-proxy case, `false` for the generic/known-runtime
  cases. Update existing `appRuntime` call sites to the two-value signature.
- **Frontend**: render mapping only; verify against the live dashboard on `:9090`
  (Components loaded → `3`, Run template → `Aspire`).

## Out of scope

- Per-row component count column (not requested; only the stat card gains the count).
- Distinct-vs-total component counting (decided: total instances).
