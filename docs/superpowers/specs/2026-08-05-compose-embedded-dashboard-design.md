# Compose-embedded dashboard (compose container posture)

## Problem

The dashboard already supports Docker Compose, but only from the *outside*. `--mode
compose` (`cmd/sources.go:24`) runs on the host, shells out to the docker/podman CLI, and
translates container facts into host-reachable ones: bind-mount sources become host paths,
container ports become published host ports, and state-store addresses like `postgres:5432`
are rewritten to `localhost:<published>` (`pkg/statestore/translate.go`). It also scans
*every* compose project on the machine.

Developers whose day-to-day stack is compose want the dashboard **inside** that stack — a
service in the same compose file as their Dapr apps, started by the same `docker compose
up`, with nothing installed on the host. In that position every host-oriented assumption
above is wrong, and the dashboard should show only what its own compose file declares.

The container image exists (`ghcr.io/diagridio/dev-dashboard`) and container posture exists,
but posture is hard-wired to Aspire: `containerPosture()` (`cmd/mode.go:57`) returns true
only for `mode == aspire` with the `DEVDASHBOARD_APP_*` contract present. The image is
`gcr.io/distroless/static:nonroot` with no shell and no `docker` CLI, so today's compose
scanner physically cannot run inside it.

## Goals

1. **A compose container posture**: the dashboard runs as a service in the user's compose
   file and discovers only the apps that file declares. No host scanning, no cross-project
   visibility.
2. **Four features working**: application data, workflow inspection, component review, and
   publishing a test message.
3. **No Docker socket, no elevated privileges.** Discovery is sidecar HTTP/gRPC plus
   optional read-only file mounts.
4. **Zero regression to host posture.** Every existing mode behaves bit-for-bit as today.
5. **Honest capability gating**: features that cannot work in this posture are off at the
   route level, with accurate empty-state copy explaining why.

## Chosen approach: peer-probe with declared apps

The dashboard is a peer service on the compose network. The **set of apps** is declared via
the existing `DEVDASHBOARD_APP_*` env contract in the compose file; **everything else** is
discovered live from the sidecars themselves — metadata, health, components, subscriptions,
actors, and workflows over gRPC.

This works because all four required features are sidecar-protocol or file features, not
container-introspection features:

| Feature | Mechanism | Extra mounts |
|---|---|---|
| Application data | `GET /v1.0/metadata` + `/v1.0/healthz` | none |
| Workflow inspection | daprd gRPC management API (`pkg/workflow/sidecar.go`) | none |
| Component names/types | `/v1.0/metadata` `components[]` | none |
| Full component YAML | file scan | resources dir, read-only |
| Store-backed workflow history | direct DB connection | state-store YAML, read-only |
| Publish test message | `POST /v1.0/publish/{pubsub}/{topic}` (`pkg/server/apps.go:154`) | none |

### Rejected alternatives

- **Parse a mounted compose file.** Truly automatic, and it adapts to files we did not
  write. Rejected for v1 because it re-opens what the original compose design deliberately
  closed (`2026-07-04-compose-discovery-design.md`, goal 2: "the runtime, not the compose
  YAML, is the source of truth — it reflects interpolated env vars, actual published ports,
  and actual mount sources"). Parsing YAML means handling `${VAR}` interpolation,
  `env_file`, `extends`, profiles, multi-`-f` merges, and `container_name` vs service name.
  Recorded as the intended follow-up layer (see Future work) — it only changes *how the app
  list is populated*, not what works once populated, so it composes cleanly on top of this
  design.
- **Mount the Docker socket.** Full parity, including logs, lifecycle, and the control
  plane. Rejected because the distroless image has no `docker` CLI, so `pkg/containerruntime`'s
  exec model cannot run — it would need either a Docker Engine API client (rejected in the
  same earlier design for "a very heavy dependency tree, weaker podman story") or a second
  fat image variant. It also asks users for a privilege many will refuse, and every
  host-path translation in `scan_compose.go` would need inverting.

## Design

### 1. Posture switch

Generalize container posture from aspire-only to contract-driven:

```go
// cmd/mode.go
func containerPosture(mode Mode, getenv func(string) string) bool {
    switch mode {
    case ModeAspire, ModeCompose:
        return discovery.ContractPresent(getenv)
    }
    return false
}
```

`discovery.AspireContractPresent` is renamed `discovery.ContractPresent` — the contract is
no longer Aspire-specific. Its anchor variable stays `DEVDASHBOARD_APP_COUNT`.

`DEVDASHBOARD_MODE=compose` **with** the contract → compose container posture.
`--mode compose` **without** the contract → today's host docker-scan, unchanged.

`resolveServeSettings` (`cmd/mode.go:78`) already keys off the posture boolean, so port
`8080`, bind `0.0.0.0`, `AllowNonLoopback`, `QuietRegistry`, and suppressed browser-open all
apply with no new plumbing. The flag > env > posture-default precedence is unchanged.

The image keeps `DEVDASHBOARD_MODE=aspire` baked in — changing the default would break the
existing Aspire hosting integration. Compose users override it in their service definition.

`sourcesFor` (`cmd/sources.go:19`) is not reached in container posture; `runServe`
(`cmd/root.go:139`) branches to the contract scanner first. That branch keeps its
`case containerPosture:` condition and gains a mode-derived source value: `SourceCompose`
for `ModeCompose`, `SourceAspire` for `ModeAspire` (section 2). `cpSourcesFor`
(`cmd/sources.go:38`) is unreachable in this posture because the control-plane route is
never registered, and is left unchanged.

### 2. The contract

Reuse `DEVDASHBOARD_APP_*` with one addition and one behavior change.

| Env var | Required | Meaning in compose posture |
|---|---|---|
| `DEVDASHBOARD_APP_COUNT` | yes | number of apps (`0` valid: empty dashboard) |
| `DEVDASHBOARD_APP_<i>_ID` | yes | Dapr app-id |
| `DEVDASHBOARD_APP_<i>_DAPR_HTTP` | yes | daprd HTTP base URL **reachable on the compose network**, e.g. `http://order-dapr:3500` |
| `DEVDASHBOARD_APP_<i>_DAPR_GRPC` | no | `host:port` of the sidecar's gRPC endpoint; **derived** when absent as the host of `_DAPR_HTTP` plus `:50001` |
| `DEVDASHBOARD_APP_<i>_NAMESPACE` | no | per-app namespace; defaults to `DEVDASHBOARD_NAMESPACE` |
| `DEVDASHBOARD_APP_<i>_LABEL` | no | display name; defaults to the app-id |

`_DAPR_HTTP` needs no code change — `sidecarBaseURL` (`pkg/discovery/health.go:12`) already
accepts an arbitrary base URL. Only the documented value changes, from
`host.docker.internal` to a compose service name.

Deriving `_DAPR_GRPC` from `_DAPR_HTTP` keeps the common case at two variables per app, and
is correct in every network shape (section 3) because it inherits whatever host already
works. `50001` is daprd's default gRPC port. An explicit `_DAPR_GRPC` overrides the
derivation; a malformed one fails at startup like every other contract variable.

**Source value.** `NewAspireScanner` (`pkg/discovery/scan_aspire.go:27`) hardcodes
`Source: SourceAspire`. It becomes `NewContractScanner(getenv, source)`, and the file is
renamed `scan_contract.go`. Compose posture passes `SourceCompose`, so:

- `IsAspire` is not set (`pkg/discovery/service.go:224`), and the UI frames apps as compose.
- `ScanResult.Key()` (`service.go:87`) falls through to `AppID` when no container names are
  present — correct, since scaled-instance disambiguation by container name is unavailable
  and irrelevant here.
- `service.go:237` fills `Runtime` from `r.AppRuntime` for compose results; both are empty
  in this posture, so runtime resolves to `unknown`. Acceptable — language inference needs
  container image or build-context data we do not have.
- `Merge` (`pkg/discovery/merge.go:40`) has aspire-specific precedence rules; container
  posture uses a single scanner and never merges, so those paths are untouched.

Aspire posture passes `SourceAspire` and is unchanged.

### 3. Network shape and sidecar addressing

The dashboard is a service in the **same compose file** as the Dapr apps and joins the
project's network(s). With only the implicit default network this is automatic. **If the
compose file declares custom networks, the dashboard must be attached to every network its
target sidecars are on**, or metadata probes fail with DNS resolution errors. This is the
first item in the troubleshooting docs.

Sidecar addressing follows the **network-namespace owner**, not a naming convention:

| Compose shape | `_DAPR_HTTP` value |
|---|---|
| App and sidecar as separate services | `http://<sidecar-service>:3500` |
| App joins the sidecar (`network_mode: "service:daprd"`) | `http://daprd:3500` — sidecar owns the namespace |
| Sidecar joins the app (`network_mode: "service:app"`) | `http://app:3500` — **app** service name; sidecar not resolvable |

Both `network_mode` directions occur in practice: `test/e2e/fixtures/compose/docker-compose.yaml:64`
uses `network_mode: "service:daprd"`, and `docs/superpowers/plans/2026-07-15-real-e2e-discovery-tests.md:332`
uses `service:wfapp`. This is the same namespace-owner constraint the fixture already
documents for published ports (`docker inspect` reports `NetworkSettings.Ports` only on the
namespace owner) — same root cause, different symptom.

**No `depends_on` on the dashboard service.** Discovery is static env parsing and health is
probed per poll, so the dashboard starting before the sidecars is fine and preferable: apps
appear unreachable and flip healthy as they come up. `depends_on` would only delay the UI.

### 4. Workflows without a state store

`cmd/reconciler.go:468` hardcodes the sidecar gRPC address:

```go
Addr: "127.0.0.1:" + strconv.Itoa(in.GRPCPort),
```

That is a host-posture assumption. Add `Instance.DaprGRPCAddr` (set by the contract
scanner) and a resolver mirroring the existing `BaseURL()` pattern, in
`pkg/discovery/health.go`:

```go
// GRPCAddr resolves the sidecar's gRPC endpoint (contract address wins, else
// the loopback-port form). Empty means no gRPC endpoint is known.
func (in Instance) GRPCAddr() string {
    if in.DaprGRPCAddr != "" {
        return in.DaprGRPCAddr
    }
    if in.GRPCPort == 0 {
        return ""
    }
    return "127.0.0.1:" + strconv.Itoa(in.GRPCPort)
}
```

`sidecarEndpoints` (`cmd/reconciler.go:445`) uses `in.GRPCAddr()` and skips empty results
instead of testing `GRPCPort == 0`. Host behavior is bit-for-bit identical.

**Eligibility** (`reconciler.go:460`) gains one clause: in compose container posture every
declared app is sidecar-eligible unconditionally, for the same reason Testcontainers apps
are — the sidecar is authoritative and there may be no readable store at all. The existing
`includeAll && in.SidecarReachable && in.Source != SourceAspire` clause is unchanged.

Because workflow inspection no longer requires a store, capabilities cannot gate on the
store file:

```go
caps = &server.Capabilities{
    Workflows: settings.StateStore != "" || anyContractGRPCAddr,
    Mode:      string(ModeCompose),
}
```

Because `_DAPR_GRPC` is derived whenever `_DAPR_HTTP` is valid and `_DAPR_HTTP` is required,
`anyContractGRPCAddr` is true whenever at least one app is declared. The store clause
therefore only matters for `DEVDASHBOARD_APP_COUNT=0` with a mounted store — a valid
configuration for browsing workflow history with no live apps.

`NewComposite` (`pkg/workflow/composite.go:31`) already merges store-backed and
sidecar-sourced results with the sidecar winning collisions, so no new merge logic is
needed. The sidecar path requires **Dapr 1.17+**; older runtimes surface the existing
`ErrSidecarUnsupported` (`pkg/workflow/sidecar.go:23`).

### 5. Files and address translation

Both optional, both existing behavior:

- `DEVDASHBOARD_RESOURCES_PATH` → full component YAML on the Resources page. Without it,
  component **names and types** still come from `/v1.0/metadata`.
- `DEVDASHBOARD_STATESTORE_FILE` → store-backed workflow history alongside the sidecar view.

The load-bearing subtlety is what must *not* happen. `rc.translate`
(`cmd/reconciler.go:94`) returns the component untouched when `composeEnv == nil`, and
container posture never constructs a `ComposeSource` — so a component declaring
`postgres:5432` dials `postgres:5432`, which is correct inside the network. The host-mode
rewrite to `localhost:<published>` would be actively wrong here. That correctness rests on a
nil check in another file, so it gets a dedicated regression test rather than a comment.

### 6. Capabilities: what is off, and why

| Capability | State | Reason |
|---|---|---|
| `Workflows` | **on** | sidecar gRPC, or a mounted store |
| `Lifecycle` | off | no container runtime to start/stop containers |
| `ControlPlane` | off | see below |
| `Logs` | off | see below |
| update-check / self-update | off | container images are updated by tag, not in place |
| browser-open | off | no host browser |

Route registration is the boundary, per the rule in `ARCHITECTURE.md`: `pkg/server/api.go`
gates `/workflows` (`:97`) and `/controlplane` (`:102`), and `appsRouter` takes `caps` for
lifecycle and log routes. The JSON flags in `window.__DASH_CAPABILITIES__` are advisory UX;
a disabled feature is unroutable, not merely hidden. `/apps` (including publish),
`/actors`, `/subscriptions`, and `/resources` are mounted unconditionally and need no
change.

**Logs are architecturally impossible in this posture**, not merely unimplemented. Recorded
so the question is not re-opened:

- `docker logs -f` (`Options.ContainerLogs`, wired at `cmd/root.go:185`) requires the socket.
- daprd exposes no log API — only `/v1.0/metadata` and Prometheus metrics. App containers
  expose stdout, which is not network-addressable.
- daprd logs to stdout, not a file, so a shared named volume yields nothing without
  wrapping the user's `command` in a `tee` shim — unacceptable for compose files we did not
  write.
- Host `json-file` logs (`/var/lib/docker/containers/<id>/*-json.log`) would need a
  privileged host mount *and* container IDs, which require the socket anyway. Strictly worse
  than mounting the socket.

**Control Plane is off in v1**, but the highest-value part of it already works for free.
`pkg/discovery/metadata.go:70` parses `actorRuntime.placement`, `service.go:285` maps it to
`Instance.Placement`, and `web/src/pages/AppDetail.tsx:358` and `web/src/pages/Actors.tsx:143`
already render it. That flow is pure sidecar HTTP, so **placement connectivity is visible in
compose container posture with no new code**. What the page itself needs is unobtainable:
of `controlplane.Service` (`pkg/controlplane/types.go:24`), only `Name`, `Ports`, and
`Healthy` are reachable in-network, while `Status`, `MemoryBytes`, `MemoryHuman`, `LogPath`,
and `Actionable` are all container-runtime facts.

`Mode: "compose"` is echoed to the SPA, which needs two copy changes:

- The unreachable-sidecar hint currently advises publishing the port to the host. In-network
  that advice is wrong; it must say the dashboard and the named service have to share a
  network.
- `web/src/pages/ControlPlane.tsx:18` and `web/src/pages/Logs.tsx` already branch on mode
  and need compose-**container** empty-state copy distinct from compose-**host** copy. Both
  routes are unregistered in this posture, so `router.tsx` does not mount them at all (it
  reads `getCapabilities()`); the copy change covers a user navigating directly to the path.

### 7. Reference compose file

```yaml
services:
  order-processor:
    build: ./order-processor

  order-processor-dapr:
    image: daprio/daprd:1.18.1
    command:
      - "./daprd"
      - "-app-id"
      - &order_id order-processor
      - "-app-port"
      - "5001"
      - "-dapr-http-port"
      - "3500"
      - "-resources-path"
      - "/components"
    volumes:
      - "./components:/components:ro"
    network_mode: "service:order-processor"

  dev-dashboard:
    image: ghcr.io/diagridio/dev-dashboard:latest
    ports:
      - "9090:8080"
    environment:
      DEVDASHBOARD_MODE: compose
      DEVDASHBOARD_APP_COUNT: "1"
      DEVDASHBOARD_APP_0_ID: *order_id
      # order-processor owns the network namespace, so the sidecar is
      # addressed by the app's service name.
      DEVDASHBOARD_APP_0_DAPR_HTTP: http://order-processor:3500
      DEVDASHBOARD_RESOURCES_PATH: /components
    volumes:
      - "./components:/components:ro"
```

The YAML anchor (`&order_id` / `*order_id`) is the recommended mitigation for the app-id
being declared twice in one file — the honest cost of a declared contract, and glaring when
both declarations sit twenty lines apart. Compose-file parsing removes it entirely (Future
work).

### 8. Errors

- **Malformed contract fails at startup**, naming the exact variable — existing
  `scan_contract.go` behavior, extended to `_DAPR_GRPC`. `DEVDASHBOARD_APP_COUNT` remains
  bounded by `maxAspireAppCount` (1024).
- **Unreachable sidecar**: the app is listed with `sidecarReachable=false` and
  posture-appropriate hint copy (section 6). It recovers on the next poll with no restart.
- **One bad sidecar never hides the others.** Per-app gRPC budgets already exist
  (`sidecarCallTimeout`, 3s, `pkg/workflow/sidecar.go`), and HTTP metadata probes are
  per-instance.
- **Dapr below 1.17**: workflow routes exist but return `ErrSidecarUnsupported`, with the
  store-backed path still available if a store YAML is mounted.

## Testing

- `cmd/mode_test.go`: posture matrix over mode × contract presence, asserting compose+contract
  → container posture, compose alone → host posture, aspire unchanged.
- `pkg/discovery`: contract-scanner table tests for the `source` parameter, `_DAPR_GRPC`
  derivation from `_DAPR_HTTP` across all three network shapes, explicit-override precedence,
  and malformed-value startup failure naming the variable.
- `pkg/discovery/health_test.go`: `GRPCAddr()` precedence — contract address, loopback
  fallback, empty when neither is available.
- `cmd/reconciler_test.go`: endpoint eligibility per posture, and address resolution proving
  host posture still yields `127.0.0.1:<port>`.
- Translation no-op regression test: a compose-posture component with an in-network address
  survives `rc.translate` unmodified.
- Capabilities golden for compose container posture, plus a route-level assertion that
  `/api/controlplane` and the log routes are **absent** (not merely flagged off).
- Integration test in the spirit of `cmd/compose_discovery_integration_test.go`: a fake
  sidecar serving `/v1.0/metadata`, `/v1.0/healthz`, and publish, driven through the
  contract scanner.
- Web: `capabilities.ts` consumers for `mode: "compose"` with container-posture flags.

## Documentation

- README: rename "Run as a container (.NET Aspire)" — it is no longer Aspire-only — and add
  a compose subsection with the reference file, the namespace-owner addressing table, the
  custom-networks requirement, and an explicit list of what is off and why.
- `ARCHITECTURE.md`: posture table gains compose container posture; the `--mode` row notes
  that `compose` selects posture by contract presence; the capabilities section records the
  logs and control-plane reasoning.

## Future work

- **Compose-file parsing** as an optional auto-populate layer: mount the compose file
  read-only, find services whose command invokes `daprd`, extract `-app-id` and port flags,
  derive in-network URLs from the namespace owner, and fall back to the env contract
  per-service. Removes the double declaration. Cheap to add because the file's path is
  already known to the user, and it changes only how the app list is populated.
- **Health-only Control Plane**: `DEVDASHBOARD_PLACEMENT_ADDR` / `_SCHEDULER_ADDR` plus
  in-network healthz probes. Attractive because healthz ports are reachable in-network even
  when unpublished (the fixture publishes only `50005`). Costs: two new contract variables,
  a new probe source, a page reworked for five empty fields, and verification of Dapr 1.18's
  placement/scheduler healthz ports and paths — unverified as of this design.
- **Scheduler connectivity per app**, if a future daprd metadata payload reports it the way
  `actorRuntime.placement` reports placement.
