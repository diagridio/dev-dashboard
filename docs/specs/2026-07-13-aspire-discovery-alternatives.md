# Aspire Discovery Alternatives — Analysis

**Date:** 2026-07-13
**Status:** Analysis / feasibility exploration (pre-design)
**Question:** How can the dashboard discover Aspire apps, Dapr sidecars, and
components **without relying on app-ids passed via environment variables** —
ideally by pointing at a single host+port for the Aspire "DCP" and discovering
resources from there, with sidecar service names/ports resolved from a
**container** perspective rather than a host perspective?

Related prior design: [2026-07-11-aspire-container-mode-design.md](2026-07-11-aspire-container-mode-design.md).

---

## 1. How discovery works today

The Aspire path is entirely a **static env-var contract**, parsed in
[`pkg/discovery/scan_aspire.go`](../../../pkg/discovery/scan_aspire.go)
(`NewAspireScanner`):

| Env var | Meaning |
|---|---|
| `DEVDASHBOARD_APP_COUNT` | number of apps |
| `DEVDASHBOARD_APP_<i>_ID` | Dapr app-id |
| `DEVDASHBOARD_APP_<i>_DAPR_HTTP` | daprd HTTP base URL, reachable **from the dashboard container** |
| `DEVDASHBOARD_APP_<i>_NAMESPACE` | per-app namespace (optional) |
| `DEVDASHBOARD_APP_<i>_LABEL` | display name (optional) |

The vars are read **once at startup** into static `ScanResult`s
(`Source: SourceAspire`). A separate .NET hosting integration enumerates the
AppHost model and injects them. Liveness is only the per-poll health/metadata
probe in [`pkg/discovery/service.go`](../../../pkg/discovery/service.go)
(`enrich`); the *set* of apps is frozen until the dashboard restarts.

**Why it's built this way (load-bearing):** the value of
`DEVDASHBOARD_APP_<i>_DAPR_HTTP` is not that it carries an app-id — it is an
**Aspire endpoint reference**, which Aspire resolves and **container→host
rewrites** so the URL is reachable *from the dashboard container*. The contract
offloads the container-perspective problem onto Aspire. Any alternative must
answer the same reachability question.

---

## 2. The fact that reframes the question

**In local Aspire dev, a Dapr sidecar is an `ExecutableResource` — daprd runs
as a host process, not a container.** Confirmed in the CommunityToolkit
integration's `DaprDistributedApplicationLifecycleHook.cs`
([source](https://github.com/CommunityToolkit/Aspire/tree/main/src/CommunityToolkit.Aspire.Hosting.Dapr)):
`new ExecutableResource(daprCliResourceName, fileName, …)` launches the dapr CLI
with `--app-id`, `--dapr-http-port`, `--dapr-grpc-port`, `--resources-path`, and
attaches a `ResourceRelationshipAnnotation(app, "Parent")`.

Two consequences:

1. Those host daprd processes are **already discovered today** by the standalone
   process scan (any `daprd` matched by executable name). "Discovery without the
   env contract" therefore already partly works *when the dashboard runs on the
   host*.
2. **"Container perspective" only becomes a problem because the dashboard itself
   is containerized inside Aspire.** And the correct container-reachable address
   is **not** the sidecar's internal `--dapr-http-port` (a host executable is not
   on the Docker network). It is:
   - **Executable sidecar** (local dev default) → `host.docker.internal:<host-published-port>`
   - **Container sidecar** → `<aspire-network-service-name>:<internal-port>`

   This rule is independent of which discovery source is chosen — it is the real
   crux.

---

## 3. Can you point at "the DCP" and discover? Two surfaces

### 3a. AppHost Resource Service — `DashboardService` gRPC (recommended)

This is the exact surface the real Aspire dashboard consumes
([standalone dashboard setup](https://www.milanjovanovic.tech/blog/standalone-aspire-dashboard-setup-for-distributed-dotnet-applications),
[dotnet/aspire discussion #4440](https://github.com/dotnet/aspire/discussions/4440)).
Configure one URL (`Dashboard:ResourceServiceClient:Url`, historically
`DOTNET_RESOURCE_SERVICE_ENDPOINT_URL`) plus an API key. Contract:
[`dashboard_service.proto`](https://github.com/dotnet/aspire/blob/main/src/Aspire.Hosting/Dashboard/proto/dashboard_service.proto).

Relevant methods:

```
rpc GetApplicationInformation(...) returns (...)
rpc WatchResources(...) returns (stream WatchResourcesUpdate)          // live add/remove
rpc WatchResourceConsoleLogs(...) returns (stream ...ConsoleLogsUpdate) // log streaming
rpc ExecuteResourceCommand(...) returns (...)
```

The `Resource` message exposes: `name`, `resource_type`
(`"Executable"`/`"Container"`/`"Project"`), `state`, `environment` (daprd's
launch env), `properties` (args, image, ports as `google.protobuf.Value`),
`urls` (`endpoint_name`, `full_url`, `is_internal`), and `relationships` (the
sidecar's `"Parent"` app).

**Catch:** it does *not* model "Dapr sidecar, app-id X, HTTP port Y" as
first-class fields. You reverse-engineer that from `environment` / `properties`
/ relationships — the same daprd-argv parsing already implemented in
[`pkg/discovery/compose_args.go`](../../../pkg/discovery/compose_args.go)
(`parseDaprdArgs`). And `urls.full_url` is the AppHost's perspective (usually
`localhost:<proxyport>`), so it does not by itself solve container reachability.

### 3b. DCP kube-style API server (not recommended)

DCP is a mini-Kubernetes API server
([microsoft/dcp](https://github.com/microsoft/dcp),
[Anthony Simmon: Exploring the Microsoft Developer Control Plane](https://anthonysimmon.com/exploring-microsoft-developer-control-plane-core-dotnet-aspire-dotnet-8/))
you would hit via kubeconfig to list `Executable`/`Container`/`Service`/`Endpoint`
specs. Richest low-level truth (including DCP's own proxy/endpoint mapping), but
it is an **undocumented internal contract**, the kubeconfig is an ephemeral
host-local file a container will not have, and it churns with every Aspire
release. **Avoid as a primary mechanism.**

---

## 4. Alternatives with trade-offs

| Option | What it is | Perspective handling | Verdict |
|---|---|---|---|
| **A. Resource Service gRPC** | `WatchResources` stream; derive Dapr apps from `resource_type` + argv + relationships | `urls` are host-perspective → still needs a rewrite | **Primary candidate.** Live, official-ish, adds logs |
| **B. DCP apiserver** | kube client against DCP | DCP proxy endpoints available but internal | Reject — unstable/internal, no kubeconfig in-container |
| **C. Host standalone scan (status quo, mode-unset)** | Existing `daprd` process scan finds host-executable sidecars | Moot — dashboard on host, uses `127.0.0.1:<port>` | Already works **if the dashboard stays on the host** |
| **D. Container-runtime scan** | Reuse the [compose](../../../pkg/discovery/scan_compose.go) / [testcontainers](../../../pkg/discovery/scan_testcontainers.go) machinery for Aspire-launched *containers* | Container-perspective translation already implemented (argv ports + network names) | Only covers containerized resources; Aspire adds no stable label to match on |
| **E. Thin hybrid contract** | Inject just the resource-service URL+key (or a network name), discover the rest dynamically | Lean on Aspire endpoint-reference rewrite for the reachable base URL | **Pragmatic sweet spot** |

**Solving "container perspective" regardless of source.** Whatever inventory
source is used, the dashboard must emit a base URL its container can reach, and
the rule differs by sidecar type (§2). The current env contract sidesteps this
by making Aspire resolve the endpoint reference. If the contract is dropped
entirely, the dashboard must reconstruct these addresses itself — and the
resource service's `urls` will not reliably be container-reachable. That is why
keeping *one* injected, Aspire-rewritten base URL is the robust fallback.

---

## 5. Recommendation

Go with **E (thin hybrid) built on A**: consume the `DashboardService` resource
stream for the live inventory (which apps/sidecars exist, app-ids via
argv/relationships, state, and — free — console logs). This eliminates the
per-app `_ID` / `_NAMESPACE` / `_LABEL` fan-out and makes discovery live instead
of restart-bound. Keep a single container-reachable daprd base URL per sidecar
as an Aspire endpoint reference (or resolve it from `urls` with a documented
fallback), so Aspire keeps owning the perspective rewrite. Reject the DCP
apiserver as primary.

It slots cleanly into the existing model: a new `discovery.Scanner` merged in
[`pkg/discovery/service.go`](../../../pkg/discovery/service.go), reusing the
`DaprHTTPBaseURL` field already threaded through health/metadata/workflow calls.

---

## 6. Chosen direction (decisions captured 2026-07-13)

| Decision point | Choice |
|---|---|
| Where the dashboard runs | **Container inside the AppHost** — container-perspective resolution is mandatory |
| How thin the contract should get | **Thin hybrid** — inject resource-service URL+key (and, if required, one base URL per sidecar); discover inventory live via gRPC |
| Appetite for Aspire coupling | **Resource Service proto only** — depend on `dashboard_service.proto`; reverse-engineer Dapr semantics from generic `Resource` fields; no DCP apiserver |

---

## 7. Concrete shape for the chosen combination

gRPC is already vendored (`google.golang.org/grpc v1.80.0`) and already used by
the sidecar-gRPC workflow source in
[`pkg/workflow/sidecar.go`](../../../pkg/workflow/sidecar.go), so a
resource-service gRPC client is a precedented, modest addition (promote grpc to
a direct dep + add stubs generated from `dashboard_service.proto`).

**New source — a `discovery.Scanner` backed by `WatchResources`.** A
`scan_aspire_resourceservice.go` that maintains a background gRPC stream to the
AppHost resource service (URL + API key injected — the *entire* remaining
contract), keeps a cached resource snapshot, and on each `scan()` projects it to
`[]ScanResult`:

- Filter resources where `resource_type` ∈ {`Executable`, `Container`} and the
  args/env invoke daprd — reuse `parseDaprdArgs`
  ([`pkg/discovery/compose_args.go`](../../../pkg/discovery/compose_args.go))
  against the resource's `properties` / `environment` to pull `app-id`,
  `dapr-http-port`, `dapr-grpc-port`, `resources-path`.
- Recover the app↔sidecar pairing and display name from the sidecar's `"Parent"`
  relationship + `display_name` (replaces `_LABEL`).
- Merge into the existing pipeline via
  [`pkg/discovery/service.go`](../../../pkg/discovery/service.go); populate the
  already-threaded `DaprHTTPBaseURL` field so health/metadata/workflow calls need
  no further change.
- Free upside: `WatchResourceConsoleLogs` can later re-enable log streaming that
  aspire mode currently disables, and `state` gives live add/remove instead of a
  restart-bound list.

This eliminates `DEVDASHBOARD_APP_COUNT` and all per-app `_ID` / `_NAMESPACE` /
`_LABEL` vars.

---

## 8. The deciding spike

One question decides how thin the contract actually gets — a spike, not a design
choice:

> **Does the CommunityToolkit Dapr sidecar `ExecutableResource` register its
> daprd HTTP port as an Aspire endpoint** (so it appears in the resource's `urls`
> and is container→host rewritable)?

Because the sidecar is a *host executable*, only Aspire can hand a containerized
dashboard a reachable address (`host.docker.internal:<published-port>`); the
internal `--dapr-http-port` from argv is unreachable from inside the container.

- **If yes** → fully dynamic: inject only the resource-service URL + key; derive
  each sidecar's reachable base URL from its rewritten `urls` entry. True "one
  host+port, discover everything."
- **If no** → the irreducible minimum contract is *one* Aspire endpoint reference
  per sidecar (today's `_DAPR_HTTP`), kept purely so Aspire performs the
  perspective rewrite; the resource service still supplies the entire live
  inventory + state + logs. Still a large simplification over today.

Run this spike against a real AppHost with a `.WithDaprSidecar()` app before
committing to the thinner variant. It is the same reachability risk flagged in
[the aspire-container-mode design](2026-07-11-aspire-container-mode-design.md),
now the deciding factor.

---

## 9. Sources

- [dotnet/aspire `dashboard_service.proto`](https://github.com/dotnet/aspire/blob/main/src/Aspire.Hosting/Dashboard/proto/dashboard_service.proto)
- [dotnet/aspire discussion #4440 — standalone dashboard with resources](https://github.com/dotnet/aspire/discussions/4440)
- [Milan Jovanović — Standalone Aspire Dashboard Setup](https://www.milanjovanovic.tech/blog/standalone-aspire-dashboard-setup-for-distributed-dotnet-applications)
- [microsoft/dcp — Developer Control Plane API server and CLI](https://github.com/microsoft/dcp)
- [Anthony Simmon — Exploring the Microsoft Developer Control Plane](https://anthonysimmon.com/exploring-microsoft-developer-control-plane-core-dotnet-aspire-dotnet-8/)
- [Aspire architecture overview](https://learn.microsoft.com/en-us/dotnet/aspire/architecture/overview)
- [CommunityToolkit.Aspire.Hosting.Dapr](https://github.com/CommunityToolkit/Aspire/tree/main/src/CommunityToolkit.Aspire.Hosting.Dapr)