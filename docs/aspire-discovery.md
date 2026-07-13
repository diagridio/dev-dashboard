# Aspire Discovery — How It Works Today

Reference documentation for how the Diagrid Dev Dashboard currently discovers
and reads **every resource** when integrating with .NET Aspire. This describes
the implemented behavior as of 2026-07-13; for the original rationale see
[the aspire-container-mode design](superpowers/specs/2026-07-11-aspire-container-mode-design.md),
and for the wider architecture see [ARCHITECTURE.md](../ARCHITECTURE.md).

> **One-line summary:** In Aspire, the dashboard does not scan anything. A .NET
> hosting integration injects a static list of apps + daprd base URLs via
> `DEVDASHBOARD_APP_*` environment variables; the dashboard then live-probes each
> sidecar's HTTP API every poll, and reads workflows from a mounted state-store
> component. All resources are derived from those two sources.

---

## 1. Two ways Aspire apps are discovered

There are two entry paths, both centered on the same env contract:

| Path | Trigger | Discovery sources | Serving posture |
|---|---|---|---|
| **Aspire mode** | `--mode aspire` / `DEVDASHBOARD_MODE=aspire` | **Only** the `DEVDASHBOARD_APP_*` env contract | Container posture (bind `0.0.0.0:8080`, non-loopback Host allowed, host features off) — with the env contract; host posture without it |
| **Mode unset (default)** | no mode flag | Full merge: standalone process scan + compose + testcontainers + Aspire contract (if present) | Host posture (loopback `127.0.0.1:9090`, all features on) |

Mode is resolved once at startup in [`cmd/mode.go`](../cmd/mode.go) (`resolveMode`,
flag > env). The published container image sets `ENV DEVDASHBOARD_MODE=aspire`.

**Note on mode-unset:** the standalone scan matches *any* host `daprd` process by
executable name, so daprd sidecars an AppHost launches as host executables are
discovered incidentally even without the contract. When both the standalone scan
and the Aspire contract surface the same sidecar, the merge dedups by routing key
and **the Aspire entry wins** (it carries the reachable base URL) —
[`pkg/discovery/merge.go`](../pkg/discovery/merge.go) (`dedupAspireWins`).

The rest of this document describes **Aspire mode** specifically.

**Note on `--mode aspire` without the env contract:** `--mode aspire` without the
`DEVDASHBOARD_APP_*` contract runs the dashboard on the host with normal host
defaults and filters the standalone process scan to instances flagged
`IsAspire` (DCP-proxy heuristic); the env-contract container flow described
above is unchanged. Heuristic limitations (apps without an app port are
missed; stopped apps drop out) are listed in
[2026-07-13-mode-filter-design.md](superpowers/specs/2026-07-13-mode-filter-design.md).

---

## 2. The contract — the single source of truth

Parsed once at startup by `NewAspireScanner`
([`pkg/discovery/scan_aspire.go`](../pkg/discovery/scan_aspire.go)):

| Env var | Required | Meaning |
|---|---|---|
| `DEVDASHBOARD_APP_COUNT` | yes | number of apps (`0` valid → empty dashboard) |
| `DEVDASHBOARD_APP_<i>_ID` | yes | Dapr app-id |
| `DEVDASHBOARD_APP_<i>_DAPR_HTTP` | yes | daprd HTTP base URL, **reachable from the dashboard container** (e.g. `http://myapp-dapr:3500`) |
| `DEVDASHBOARD_APP_<i>_NAMESPACE` | no | per-app namespace; defaults to `DEVDASHBOARD_NAMESPACE` |
| `DEVDASHBOARD_APP_<i>_LABEL` | no | display name; defaults to the app-id |

Key properties:

- **Static.** The env is read once and validated **fail-fast** — a missing/
  non-numeric count, a missing per-app ID/URL, or an unparsable URL exits at
  startup naming the exact variable. The returned `Scanner` is a closure over the
  parsed slice; it never re-reads env.
- **`DAPR_HTTP` is an Aspire endpoint reference.** Its value is that Aspire
  resolves it and rewrites container→host so it is reachable *from inside the
  dashboard container*. This is how the sidecar's "service name and port" end up
  in a **container perspective** — the integration/Aspire does the rewrite, not
  the dashboard.
- Each entry becomes a `ScanResult{AppID, DaprHTTPBaseURL, Namespace, Label,
  Source: SourceAspire, SidecarReachable: true}`.

---

## 3. Startup wiring (Aspire branch)

In [`cmd/root.go`](../cmd/root.go) `runServe`, the `ModeAspire` case:

```go
scan, err := discovery.NewAspireScanner(os.Getenv)   // only source
appNS = contractNamespaces(scan)                      // appID → namespace map
appsSvc = discovery.New(scan, client)                 // no standalone/compose/testcontainers
caps = &server.Capabilities{Workflows: settings.StateStore != ""}
```

- No `containerruntime.Detect()`, no compose/testcontainers sources, no lifecycle
  overlay, no control-plane manager, no update checker, no browser open.
- `home = ""` → connection-registry persistence is disabled silently
  (`QuietRegistry`).
- `appNS` (`contractNamespaces`, [`cmd/workflow.go`](../cmd/workflow.go)) is the
  static appID→namespace map used later for app-scoped workflow reads.
- Serving settings (`resolveServeSettings`, [`cmd/mode.go`](../cmd/mode.go)) default
  to port `8080`, bind `0.0.0.0`, and — if `DEVDASHBOARD_STATESTORE_FILE` is set —
  a resources scan path of that file's directory.

---

## 4. The discovery pipeline

`discovery.Service.List` ([`pkg/discovery/service.go`](../pkg/discovery/service.go)):

1. `scan()` returns the static Aspire results (no I/O).
2. Each result is **enriched in parallel** (bounded pool of 8 workers).
3. Results are sorted by app-id and returned.

`enrich` for an Aspire result:

1. Copies contract fields into the `Instance` and sets `IsAspire = true`,
   `Source = "aspire"`.
2. Resolves the daprd endpoint via `sidecarBaseURL(DaprHTTPBaseURL, HTTPPort)`
   ([`pkg/discovery/health.go`](../pkg/discovery/health.go)) — the contract base
   URL **always wins**; the `127.0.0.1:<port>` form is only the host-mode fallback.
3. `CheckHealth` → `GET {base}/v1.0/healthz` (2s timeout) → the health badge.
4. `FetchMetadata` → `GET {base}/v1.0/metadata`
   ([`pkg/discovery/metadata.go`](../pkg/discovery/metadata.go)) → everything else
   (below). On failure, `MetadataOK=false` and the app degrades to scan-only.
5. The Aspire branch **returns early** after metadata — host-only concerns (app
   PID liveness, stdout log files, orphan detection, DCP log-dir resolution) are
   skipped, since the app is an Aspire-managed container/executable, not a
   host-scanned `dapr run` child.

**Liveness model:** the *set* of apps is frozen at startup (static contract), but
health + metadata are re-probed **every poll**, so per-app status, actors,
subscriptions, components, etc. stay live. Adding/removing an app requires a
dashboard restart.

There is **no polling timer** in the backend — the SPA drives everything by
polling the API at its configured interval (1s/3s/5s/10s/Off).

---

## 5. Resource by resource

Every read-only resource below comes from **one `GET /v1.0/metadata` call per
sidecar**, parsed in `FetchMetadata`. The SPA polls the corresponding API route.

### Apps — `GET /api/apps`, `GET /api/apps/{appId}`
The `Instance` list itself: app-id, label, namespace, health, runtime version,
`DaprHTTPBaseURL`, and the derived fields below. `MetadataOK` reflects whether the
sidecar answered.

### Health
`Instance.Health` from `CheckHealth` against the contract base URL, computed on
demand during each `List` (no background poller).

### Actors — `GET /api/actors`
`metadata.actors` (`[]ActorType{Type, Count}`), surfaced per app.

### Subscriptions — `GET /api/subscriptions`
`metadata.subscriptions` (pubsub name, topic, routing rules, dead-letter topic,
declarative/programmatic type).

### Components (loaded, per app)
`metadata.components` (`Name`, `Type`, `Version`) — the components **that
sidecar actually loaded**, shown on the app detail view.

### Resources page — `GET /api/resources`, `GET /api/resources/{kind}/{name}`
Distinct from per-app loaded components: this reads **`Component` /
`Configuration` YAML from disk** via the resources loader over the reconciler's
scan paths. In Aspire mode those paths come from `DEVDASHBOARD_RESOURCES_PATH`
(default: the directory of `DEVDASHBOARD_STATESTORE_FILE`) — i.e. the component
YAML **mounted into the container**. There is no `~/.dapr` in the image, so
without a resources path the page is truthfully empty. See `derivePaths`
([`cmd/derive.go`](../cmd/derive.go)) and the `extraResPaths` plumbing in
[`cmd/reconciler.go`](../cmd/reconciler.go).

### Workflows — `GET /api/workflows*`, `POST /api/workflows/purge`
Workflows are **not** read from the app — they are read from the Dapr **state
store** backend directly, plus a sidecar-gRPC source. In Aspire mode:

- **Store source:** the explicit component YAML at `DEVDASHBOARD_STATESTORE_FILE`
  / `--statestore`. `derivePaths` sets the state-store scan path to exactly that
  file; `statestore.Detect` parses it; `newStoreRegistry`
  ([`cmd/workflow.go`](../cmd/workflow.go)) elects it active (Aspire apps carry no
  resource paths, so the path-aware election steps are inert and it falls to the
  loaded/actor/first precedence). The store is pre-warmed through the lazy
  connection pool ([`cmd/connpool.go`](../cmd/connpool.go)).
  - The component's connection string must be written from the **container's
    perspective** (Docker-network host names) — that is the integration's
    responsibility; a wrong-perspective string surfaces via the store-error
    banner, not a crash.
- **Namespace:** app-scoped reads (one instance's history, an app-filtered
  `List`/`Stats`, force delete) resolve the per-app namespace from the static
  `appNS` map (`DEVDASHBOARD_APP_<i>_NAMESPACE`) via a namespace resolver
  (`buildStoreEntry` in [`cmd/workflow.go`](../cmd/workflow.go)) — never via
  discovery probes. Store-wide scans use the global `DEVDASHBOARD_NAMESPACE`.
- **Terminate / purge (mutating):** go through daprd HTTP. `targetResolver.Resolve`
  carries the app's `DaprHTTPBaseURL` into `RemoveTarget`, and `Remover.post`
  ([`pkg/workflow/remove.go`](../pkg/workflow/remove.go)) POSTs to
  `{DaprHTTPBaseURL}/v1.0-beta1/workflows/dapr/{id}/{action}`. Reachability is
  `Healthy && (HTTPPort>0 || DaprHTTPBaseURL != "")`.
- **Force delete:** deletes state-store keys directly, scoped to the per-app
  namespace (`RemoveTarget.Namespace`); works even when the sidecar is down.
- **Sidecar-gRPC workflow source is excluded for Aspire apps.** The eligibility
  rule in `sidecarEndpoints` ([`cmd/reconciler.go`](../cmd/reconciler.go)) uses
  `in.Source != discovery.SourceAspire`, because that path addresses sidecars at
  `127.0.0.1:<grpcPort>`, which is not container-reachable. Aspire workflows are
  therefore **store-backed only**.

### Logs — disabled
Log streaming routes are **not registered** in Aspire mode (`caps.Logs=false`).
Aspire owns log streaming; HTTP-endpoint log streaming from daprd is a possible
future source. (The DCP session-dir log resolution in `resolveLogSources` applies
only to host-scanned Aspire executables in mode-unset, not to container Aspire
mode.)

### Control plane & lifecycle — disabled
`dapr_scheduler` / `dapr_placement` management and app start/stop/restart require
host container-runtime/process access the dashboard container does not have.
`caps.ControlPlane=false` and `caps.Lifecycle=false`, and the routes are not
mounted.

---

## 6. Serving posture & security

Set in [`cmd/serve.go`](../cmd/serve.go) `assembleOptions` and enforced in
[`pkg/server`](../pkg/server):

- **Bind / port:** `0.0.0.0:8080` by default (the container is addressed by
  Docker-network name / published port).
- **Request guard** (`requestGuard`, [`pkg/server/middleware.go`](../pkg/server/middleware.go)):
  `AllowNonLoopback=true` drops the loopback-Host (anti-DNS-rebinding) check,
  since a non-loopback server makes it meaningless. If `DEVDASHBOARD_ALLOWED_HOSTS`
  is set, the `Host` header is restricted to that allowlist (loopback always
  allowed). Mutating requests keep CSRF protection via a **same-origin** rule
  (Origin host must equal Host).
- **Capability gating** ([`pkg/server/server.go`](../pkg/server/server.go),
  `api.go`, `apps.go`): `Capabilities{Lifecycle:false, ControlPlane:false,
  Logs:false, Workflows: statestore-configured}`. Disabled-capability routes are
  **not registered** (real 404s — the security boundary), and the same flags are
  injected into `index.html` as `window.__DASH_CAPABILITIES__`
  ([`pkg/server/spa.go`](../pkg/server/spa.go)) so the SPA hides the corresponding
  nav entries and controls (advisory UX, no dead buttons).

---

## 7. Reconciler & derived paths in Aspire mode

The reconciler ([`cmd/reconciler.go`](../cmd/reconciler.go)) still runs — it is
fingerprint-gated and single-flight, driven by every `apps.List` poll — but with
Aspire inputs it does much less:

- `homeDir=""` → no `~/.dapr` scanning; registry persistence disabled.
- `derivePaths` ([`cmd/derive.go`](../cmd/derive.go)): state-store scan path = the
  explicit statestore file; resource scan paths = `DEVDASHBOARD_RESOURCES_PATH`
  (Aspire apps contribute no resource paths of their own).
- `loaded` (state-store component names apps report via metadata) still feeds
  store election.
- Compose address translation is a no-op (no compose env).

---

## 8. Data flow

```
 .NET AppHost + hosting integration
        │  injects DEVDASHBOARD_APP_* (static, once)
        ▼
 dev-dashboard (container, mode=aspire)
        │  NewAspireScanner → []ScanResult (Source=aspire, DaprHTTPBaseURL set)
        ▼
 discovery.List  ──(per poll, parallel)──▶  each sidecar:
        │                                     GET {DaprHTTPBaseURL}/v1.0/healthz   → health
        │                                     GET {DaprHTTPBaseURL}/v1.0/metadata  → actors,
        │                                        subscriptions, components, features, version
        ▼
 SPA polls /api/apps, /api/actors, /api/subscriptions, /api/resources
        │
        ├─ /api/resources ─▶ read mounted component/config YAML (DEVDASHBOARD_RESOURCES_PATH)
        │
        └─ /api/workflows ─▶ reconciler → active store (DEVDASHBOARD_STATESTORE_FILE)
                                → read/decode instances from the state store
              terminate/purge ─▶ POST {DaprHTTPBaseURL}/v1.0-beta1/workflows/dapr/{id}/{action}
              force delete    ─▶ delete state-store keys (per-app namespace)
```

---

## 9. Limitations of the current approach

- **Static inventory.** Apps are fixed at startup; add/remove needs a restart.
  Only health/metadata are live.
- **Per-app env fan-out.** Every app needs `_ID` (+ optional `_NAMESPACE`,
  `_LABEL`) and a `_DAPR_HTTP` URL, all produced by the external integration.
- **Reachability is the integration's job.** The dashboard trusts each
  `_DAPR_HTTP` to be container-reachable; if it is not, that app shows
  unreachable/unhealthy.
- **No logs, no lifecycle, no control plane** in Aspire mode.
- **Workflows are store-only** (no sidecar-gRPC fallback for Aspire apps), and the
  store connection string must already be container-perspective.

Alternatives that reduce the per-app env contract (e.g. querying the Aspire
resource service) are analyzed in
[2026-07-13-aspire-discovery-alternatives.md](superpowers/specs/2026-07-13-aspire-discovery-alternatives.md).

---

## 10. Code reference

| Concern | File |
|---|---|
| Contract parsing | [`pkg/discovery/scan_aspire.go`](../pkg/discovery/scan_aspire.go) |
| Mode & serve settings | [`cmd/mode.go`](../cmd/mode.go) |
| Startup wiring (aspire branch) | [`cmd/root.go`](../cmd/root.go) |
| Enrichment / base-URL selection | [`pkg/discovery/service.go`](../pkg/discovery/service.go), [`health.go`](../pkg/discovery/health.go) |
| Metadata parsing (actors/subs/components) | [`pkg/discovery/metadata.go`](../pkg/discovery/metadata.go) |
| Instance/scan types | [`pkg/discovery/types.go`](../pkg/discovery/types.go) |
| Merge / aspire-wins dedup (mode unset) | [`pkg/discovery/merge.go`](../pkg/discovery/merge.go) |
| Derived paths & fingerprint | [`cmd/derive.go`](../cmd/derive.go) |
| Reconciler / store election / sidecar exclusion | [`cmd/reconciler.go`](../cmd/reconciler.go), [`cmd/workflow.go`](../cmd/workflow.go) |
| Connection pool / namespace map | [`cmd/connpool.go`](../cmd/connpool.go) |
| Workflow terminate/purge/force (base-URL) | [`pkg/workflow/remove.go`](../pkg/workflow/remove.go) |
| Server assembly & capabilities | [`cmd/serve.go`](../cmd/serve.go), [`pkg/server/server.go`](../pkg/server/server.go) |
| Route gating | [`pkg/server/api.go`](../pkg/server/api.go), [`apps.go`](../pkg/server/apps.go) |
| Host guard / CSRF | [`pkg/server/middleware.go`](../pkg/server/middleware.go) |
| SPA capability injection | [`pkg/server/spa.go`](../pkg/server/spa.go) |