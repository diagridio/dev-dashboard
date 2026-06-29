# Design: Make the dashboard fully reflect externally-launched (incl. Aspire) Dapr apps

Date: 2026-06-29
Status: Approved (design); pending implementation plan

## Problem

When Dapr applications are started via .NET Aspire (`CommunityToolkit.Aspire.Hosting.Dapr`),
users report that the dashboard does not pick up the **state store** or the **runtime**.

Investigation against a live Aspire app (`EnterpriseDiagnostics`, app id `wf-app`) showed the
reported symptom is narrower than "discovery fails". Aspire launches the sidecar by running
`dapr run ...` **without an app command** (Aspire manages the .NET app process itself); that
`dapr run` spawns a normal child `daprd` process with `--app-id`, explicitly allocated
`--dapr-http-port` / `--dapr-grpc-port`, and `--resources-path <app>/Resources`. Because the
process is a real `daprd`, the dashboard's existing process-table discovery
(`dapr/cli/pkg/standalone.List`) already finds it.

Verified live (`/api/apps`, `/api/resources`, `/api/workflows`, daprd `/v1.0/metadata`):

- App discovery, health, runtime version, actors, subscriptions, enabled features, placement,
  and the loaded components (incl. the app's `workflow-store` state component with
  `loadedBy: ["wf-app"]`) **all already work**.
- Workflow listing works mechanically, but reads from the **wrong** state store.

So there are exactly two real defects, and **both are general** (any externally-managed
`dapr run` app hits them) rather than Aspire-specific:

1. **Wrong active state store.** The dashboard elects a single global "active" state store as
   the first detected component with `actorStateStore == "true"`. Scan order puts
   `~/.dapr/components` first, so the `dapr init` default store (which is also
   `actorStateStore: true`) shadows the store the app actually loaded. Only the active store is
   ever connected, so workflow state is read from the wrong Redis.
2. **Runtime shows `unknown`.** Runtime is inferred from the daprd-reported app command, which
   is empty under Aspire's commandless `dapr run`.

## Scope decisions (confirmed with user)

- Fix the two bugs **generally**. No Aspire-specific code branches.
- State-store strategy: **prefer app-loaded stores** in the active-store election. Keep the
  single-active-store model.

## Fix 1 — Prefer app-loaded state stores in the active-store election

### Current behaviour

- `cmd/serve.go:assembleOptions` builds `scanPaths = [~/.dapr/components, ...app ResourcePaths]`,
  calls `statestore.Detect(scanPaths)` (returns components in scan order), then
  `newStoreRegistry(detected)` (for the `/api/statestores` view) and
  `newStoreBackend(ctx, detected, ...)` (for workflow reads). `newStoreBackend` internally calls
  `newStoreRegistry(comps)` again.
- `newStoreRegistry` (`cmd/workflow.go:31`) elects the first component with
  `actorStateStore == "true"`, else the first component, else none.
- `newStoreBackend` (`cmd/workflow.go:151`) connects **only** the elected active component.

### Change

Thread the set of component **names actually loaded by running apps** into the election. The
loaded names come from the apps list already fetched in `serve.go` — each
`discovery.Instance.Components[].Name` (e.g. `wf-app` reports `workflow-store`). A detected
state-store component is "app-loaded" when its `Name` is in that set (same name-matching the
resources `loadedBy` index already uses).

New election precedence:

1. app-loaded **and** `actorStateStore == "true"`
2. app-loaded (any)
3. `actorStateStore == "true"` (current fallback)
4. first component
5. none (empty slice)

`newStoreRegistry` gains the loaded set as input: `newStoreRegistry(comps, loaded)`. `serve.go`
computes `loaded` once (from the same `appsSvc.List` it already calls) and passes it to **both**
`newStoreRegistry` and `newStoreBackend`, so the `/api/statestores` display and the connected
workflow store always agree.

### Why this is safe / general

- Aspire app: `~/.dapr` default `statestore` is not loaded by any running app; `workflow-store`
  is loaded by `wf-app` → `workflow-store` is elected. Correct.
- Plain `dapr run` loading the `~/.dapr` default: that default *is* in the app's loaded set →
  still elected. No regression.
- Dashboard started with no apps running: no loaded names → falls back to today's behaviour.

### Out of scope (explicitly not done)

- Per-app store resolution (reading each app's workflows from the specific store that app
  loaded). The single-active-store model is retained.
- Connecting/aggregating across all detected stores.

## Fix 2 — Infer runtime from the app process when the daprd app-command is empty

### Current behaviour

`pkg/discovery/service.go:enrich` sets `Runtime: InferRuntime(r.Command)`. `r.Command` is the
daprd-reported `appCommand` (truncated by the Dapr CLI). Under Aspire it is empty, so
`InferRuntime("")` returns `"unknown"`.

### Change

In `enrich`, when `InferRuntime` returns `"unknown"` **and** `AppPort != 0`, resolve the process
listening on `AppPort` and run `InferRuntime` on that process's full command line. Keep
`"unknown"` as the fallback when the listener cannot be resolved.

Introduce a small **injectable** app-process resolver so the logic is unit-testable and the OS
dependency is isolated, e.g.:

```go
// resolves the command line of the process listening on a local TCP port.
type appProcResolver interface {
    CommandForPort(port int) (string, bool)
}
```

- Default implementation uses an existing process/port facility (gopsutil is already a transitive
  dependency via `dapr/cli`; `lsof` is the macOS fallback if needed).
- The discovery service holds the resolver; tests inject a fake.

This is a general improvement: it benefits any externally-managed app whose daprd has no app
command, not only Aspire.

### Implementation risk to verify during build

Resolving a listener-by-port on macOS may require elevated privileges depending on the facility
used. Confirm the chosen approach works for same-user processes without elevation during
implementation; if it does not, fall back gracefully to `"unknown"` (no worse than today).

## Testing (TDD)

- **Election** (`cmd/` table tests):
  - default + `workflow-store` both `actorStateStore: true`, only `workflow-store` app-loaded →
    `workflow-store` elected.
  - no apps loaded → current fallback (`actorStateStore` first, else first).
  - plain dapr-run loading the `~/.dapr` default → default still elected.
  - `/api/statestores` registry and the connected workflow backend elect the same store.
- **Runtime** (`pkg/discovery/` unit tests with a fake resolver):
  - empty daprd command + app port whose listener command contains `dotnet` → `"dotnet"`;
    `go`/`python`/`node` similarly.
  - listener not resolvable → `"unknown"`.
- Existing `cmd/serve_integration_test.go`, `cmd/workflow_test.go`, and discovery tests remain
  green.

## Non-goals

- Per-app multi-store resolution or cross-store aggregation.
- Explicit "Aspire" awareness/badging or AppHost detection in the UI.
- Fixing the sample app's own Valkey port miswiring (`redisHost: localhost:16379` vs. the
  container mapped to `:59957`) — that is the demo app, not the dashboard.

## Affected files (anticipated)

- `cmd/workflow.go` — election signature + precedence; pass loaded set to backend.
- `cmd/serve.go` — compute loaded component-name set; pass to registry and backend.
- `pkg/discovery/service.go` — runtime fallback in `enrich`; hold resolver.
- `pkg/discovery/infer.go` (or a new `appproc.go`) — resolver interface + default impl.
- Corresponding `_test.go` files.
