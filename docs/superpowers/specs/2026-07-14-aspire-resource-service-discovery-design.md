# Aspire Resource-Service Discovery — Design

**Date:** 2026-07-14
**Status:** Approved design (pre-plan)
**Question:** How can the dashboard discover Aspire-hosted Dapr apps and stream
their logs from a supported contract, instead of reverse-engineering DCP
internals from process command lines?

Related prior analysis:
[2026-07-13-aspire-discovery-alternatives.md](2026-07-13-aspire-discovery-alternatives.md)
(chose the Resource Service gRPC direction) and
[2026-07-11-aspire-container-mode-design.md](2026-07-11-aspire-container-mode-design.md)
(the env-var contract this coexists with).

---

## 1. Goal

Add a **live** Aspire discovery source that consumes Aspire's `DashboardService`
resource-service gRPC (`dashboard_service.proto`). It:

- Replaces reverse-engineering of DCP internals (the brittle
  `isAspireProxy` string match in
  [`pkg/discovery/appproc.go`](../../../pkg/discovery/appproc.go) and the DCP log
  scraping in [`pkg/discovery/logsource.go`](../../../pkg/discovery/logsource.go))
  with a supported-ish contract as the **primary** Aspire path.
- Gives Aspire apps **live add/remove** and **console logs** — both absent today
  (the env contract is frozen at startup and cannot locate logs).
- **Coexists** with the existing `DEVDASHBOARD_APP_*` env contract, which remains
  as a fallback.

### Non-goals (this iteration)

- The .NET hosting integration changes that inject the resource-service env vars
  into the dashboard container (separate repo, `diagrid-labs/dashboard-aspire`).
- `ExecuteResourceCommand` (Aspire-driven lifecycle start/stop).
- Retiring the env contract or the host-process heuristic — **both stay**.
- Client-certificate auth (see §6).

---

## 2. Decisions captured (2026-07-14)

| Decision point | Choice |
|---|---|
| Relationship to env contract | **New source, keep env contract** as fallback |
| Container-reachable base URL | **Derive from resource `urls`**, fall back to injected env-contract value |
| Activation / config surface | **Auto-activate on Aspire's own env vars** (zero-config on the .NET side) |
| Auth / transport | **Unsecured + ApiKey**; system cert pool + opt-in skip-verify; `Certificate` deferred (fail fast) |
| Stream-down behavior | **Serve last-known snapshot**, reconnect with exponential backoff |
| Console logs | **In scope this iteration** (Aspire apps get logs for the first time) |
| Client structure | **Approach A** — one package owns both streams behind narrow interfaces |

---

## 3. Architecture (Approach A)

A new self-contained package `pkg/aspire` owns exactly one gRPC connection and
exposes two narrow interfaces to the rest of the app:

- **`discovery.Scanner`** (`func() ([]ScanResult, error)`) — projects a cached
  resource snapshot to scan results.
- **Channel log provider** (`func(ctx context.Context, resourceName string) (<-chan string, error)`)
  — matches the shape the logs handler already accepts for container logs.

All gRPC/proto knowledge stays inside `pkg/aspire`. Discovery merges the scanner
via the existing `scan` composition in
[`pkg/discovery/service.go`](../../../pkg/discovery/service.go); the logs handler
in [`pkg/server/logs.go`](../../../pkg/server/logs.go) gains a source branch that
calls the provider. Precedent for an in-process gRPC client:
[`pkg/workflow/sidecar.go`](../../../pkg/workflow/sidecar.go).

```
          Aspire AppHost
        ┌────────────────┐
        │ ResourceService│  gRPC (dashboard_service.proto)
        └───────┬────────┘
                │ WatchResources / WatchResourceConsoleLogs
        ┌───────▼────────────────────────────┐
        │ pkg/aspire.Client                   │
        │  • one grpc.ClientConn + auth       │
        │  • background WatchResources → cache│
        │  • reconnect w/ backoff             │
        ├──────────────┬──────────────────────┤
        │ Scanner()    │ Logs(ctx, resource)  │
        └──────┬───────┴──────────┬───────────┘
   discovery.service           server/logs.go
   (merge → enrich)            (SSE stream)
```

---

## 4. Components

- **`pkg/aspire/proto/`** — Go stubs generated from a vendored copy of
  `dashboard_service.proto`, **checked in**, with a documented regen command
  (`buf generate` or `protoc`, invoked via `go generate`).
  `google.golang.org/grpc` is promoted from indirect to a **direct** dependency.
- **`Client`** — holds the connection, auth, and lifecycle. A background
  goroutine consumes the `WatchResources` stream (initial snapshot followed by
  add/modify/delete deltas) into a mutex-guarded `map[resourceName]Resource`.
  Reconnects with capped exponential backoff; serves the last-known snapshot
  while the stream is down.
- **`Config`** — resolved from Aspire's env vars (§6). When absent, the client is
  **not constructed** and the source is **not added** — zero cost outside Aspire.
- **Projection** (`snapshot → []ScanResult`) — pure function over the cached
  snapshot; see §5.
- **Log provider** — opens `WatchResourceConsoleLogs` per resource on demand,
  adapts the stream to `<-chan string`, and tears down on context cancel.

---

## 5. Data flow & mapping

Each `WatchResources` update mutates the cached snapshot under a lock. On
`scan()`, projection walks the snapshot:

1. **Filter to Dapr sidecars.** Keep resources where `resource_type ∈
   {Executable, Container}` whose args/env invoke daprd. Reuse
   **`parseDaprdArgs`** ([`pkg/discovery/compose_args.go`](../../../pkg/discovery/compose_args.go))
   against the resource's `properties` / `environment` to pull `app-id`,
   `dapr-http-port`, `dapr-grpc-port`, `resources-path`.
2. **Pair app ↔ sidecar & name.** Recover the pairing and display name from the
   sidecar's `"Parent"` relationship + `display_name` (replaces `_LABEL`).
3. **Resolve the container-reachable base URL** (the reachability crux):
   - Prefer the sidecar's Aspire-rewritten `urls` entry for the daprd HTTP
     endpoint.
   - If absent, fall back to the injected `DEVDASHBOARD_APP_*` `_DAPR_HTTP` for
     the matching app-id (consult the env-contract map during projection).
   - If neither exists, emit the app with an empty base URL and log it; the
     health/metadata probe marks it unreachable.
4. **Emit** `ScanResult{Source: SourceAspireRS, AppID, DaprHTTPBaseURL,
   Namespace: "default", Label, SidecarReachable: true}`.

**Namespace.** Aspire has no namespace concept locally; default to `"default"`
(consistent with `NewAspireScanner`).

**Merge / precedence.** Introduce a new `SourceAspireRS` constant, distinct from
`SourceAspire`. On `Key()` collision, `SourceAspireRS` **wins** over the env
contract's `SourceAspire` (RS is live and log-capable). In
[`service.go`](../../../pkg/discovery/service.go) `enrich`, `SourceAspireRS`
shares the `SourceAspire` early-return path (no host PIDs, no stdout files, no
orphan semantics) so no host-process assumptions leak in.

---

## 6. Logs

The logs handler ([`pkg/server/logs.go`](../../../pkg/server/logs.go)) branches
on `in.Source`. For `SourceAspireRS` it resolves the daprd (or app) resource name
from the snapshot and calls the client's log provider, streaming over the
existing SSE loop — the same `<-chan string` path already used for container
logs. A new format tag (`logFormatAspireRS`) handles line normalization;
`WatchResourceConsoleLogs` already separates stdout/stderr and carries the line
text, so normalization is light (ANSI strip; drop any leading sequence/timestamp
if present).

---

## 7. Config & auth

Activate when Aspire's standard vars are present on the dashboard container:

| Purpose | Env var(s) |
|---|---|
| Endpoint URL | `DOTNET_RESOURCE_SERVICE_ENDPOINT_URL` and/or `Dashboard__ResourceServiceClient__Url` |
| API key | `Dashboard__ResourceServiceClient__ApiKey` |
| Auth mode | `Dashboard__ResourceServiceClient__AuthMode` (`Unsecured` \| `ApiKey`) |
| Dev-cert escape hatch | `DEVDASHBOARD_RESOURCE_SERVICE_INSECURE_SKIP_VERIFY` (opt-in) |

- API key sent as gRPC metadata header `x-resource-service-api-key`.
- HTTPS validates against the system cert pool; the skip-verify hatch exists only
  for local dev certs and defaults off.
- `AuthMode=Certificate` is unsupported this iteration → **fail fast** at startup
  with an error naming the unsupported mode.
- Depends on the hosting integration injecting these vars (out of scope, §1).

---

## 8. Error handling

| Situation | Behavior |
|---|---|
| Missing / partial config | Source not added; no user-facing error |
| `AuthMode=Certificate` | Fail fast at startup, naming the mode |
| Stream disconnect / pre-first-snapshot | Serve last-known snapshot; reconnect with capped exponential backoff; empty snapshot before first connect (env contract still covers apps if present) |
| Un-parseable resource (no daprd args) | Skipped, debug-logged; never aborts projection |
| Log stream failure | Handler returns the existing "no logs for this app/source" path |

---

## 9. Testing

- **Projection** — table tests over snapshot fixtures: executable sidecar,
  container sidecar, non-dapr resource, missing `urls` (fallback path), missing
  `"Parent"` relationship → expected `ScanResult`s.
- **Client lifecycle** — in-process fake `DashboardService` over `bufconn`
  driving initial snapshot + deltas, disconnect/reconnect, and API-key header
  assertion.
- **Log provider** — fake server streaming console-log updates → asserted channel
  output and context-cancel teardown.
- **Merge / precedence** — `SourceAspireRS` wins over `SourceAspire` on `Key()`
  collision; `enrich` skips host-process logic for `SourceAspireRS`.
- **Config resolution** — env-var matrix including `Certificate` fail-fast and
  the URL/key precedence between the two URL var names.

---

## 10. Validation: the deciding spike

One factual question (from the prior analysis, §8) determines how often the §5.3
fallback is exercised — **not** whether the design is correct:

> Does the CommunityToolkit Dapr sidecar `ExecutableResource` register its daprd
> HTTP port as an Aspire endpoint (so it appears in the resource's `urls` and is
> container→host rewritten)?

- **If yes** → the `urls`-derived base URL suffices; the injected `_DAPR_HTTP`
  fallback is rarely needed.
- **If no** → the fallback carries reachability; the resource service still
  supplies the entire live inventory + state + logs.

Run this against a real AppHost with a `.WithDaprSidecar()` app during
implementation, before deciding whether the env-contract fallback can eventually
be dropped.

---

## 11. Sources

- [dotnet/aspire `dashboard_service.proto`](https://github.com/dotnet/aspire/blob/main/src/Aspire.Hosting/Dashboard/proto/dashboard_service.proto)
- [dotnet/aspire discussion #4440 — standalone dashboard with resources](https://github.com/dotnet/aspire/discussions/4440)
- [Milan Jovanović — Standalone Aspire Dashboard Setup](https://www.milanjovanovic.tech/blog/standalone-aspire-dashboard-setup-for-distributed-dotnet-applications)
- [CommunityToolkit.Aspire.Hosting.Dapr](https://github.com/CommunityToolkit/Aspire/tree/main/src/CommunityToolkit.Aspire.Hosting.Dapr)
