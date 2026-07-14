# Architecture

This document explains how the Diagrid Dev Dashboard is put together: its components,
how they fit, and how the dashboard discovers and reads everything it shows (sidecars,
applications, workflows, control-plane services, resources, logs). It is written for
people **and** agents who want to understand the structure and extend it safely.

For end-user/maintainer docs (install, run, build, release) see [README.md](README.md).
For the agent working agreement (build/test gates, conventions) see [AGENTS.md](AGENTS.md).
For UI styling conventions see [`web/STYLEGUIDE.md`](web/STYLEGUIDE.md).

---

## 1. Mental model

The dashboard is a **single Go binary** that:

1. **Observes** local Dapr development — it discovers your apps; it only starts or stops
   them when you use the explicit lifecycle controls.
2. **Embeds** a React SPA (via `go:embed`) and serves it from the same origin as its API.
3. **Discovers** running apps from three merged sources — the local process table (the same
   scan as `dapr list`), Docker Compose containers, and Dapr Testcontainers sessions — then
   enriches each with a live `GET /v1.0/metadata` call to the sidecar.
4. **Reads workflows** from the Dapr **state store** backend (Redis / PostgreSQL / SQLite)
   when it can open one, and **live from the sidecar's gRPC workflow API** (Dapr ≥ 1.17)
   per app when it can't — Testcontainers apps always, and every reachable sidecar when no
   store is openable. That is what makes `state.in-memory` workflows inspectable.
5. **Degrades gracefully** — a down sidecar, an unreachable store, or a missing runtime
   turns into a partial result or a clear error, never a crash.

The only mutating operations in the entire product are: workflow **terminate/purge**,
managing your own saved **state-store connections** (persisted to
`~/.dapr/dev-dashboard/connections.yaml`, mode `0600`), **app lifecycle** actions
(start/stop/restart of discovered `dapr run` and compose apps — refused for Testcontainers
apps, whose containers belong to ryuk and whose app belongs to the test process), and
**control-plane lifecycle** actions (start/restart/stop of the self-hosted
`dapr_scheduler` / `dapr_placement` containers, allowlisted to those names).

### Top-level data flow

```
                         ┌──────────────────────────────────────────────┐
   Browser (SPA) ──HTTP──▶  dev-dashboard binary (127.0.0.1:9090)        │
        ▲   ▲             │                                              │
        │   │  SSE        │  cmd/         cobra root, flags, serve boot  │
        │   └─────────────┤  pkg/server   chi router + go:embed SPA      │
        │                 │  reconciler   apps → stores → active store   │
        │  static assets  │  pkg/discovery standalone.List + metadata    │
        └─────────────────┤  pkg/workflow list / history / purge         │
                          │  pkg/statestore redis / postgres / sqlite    │
                          │  pkg/controlplane docker/podman inspect+logs │
                          │  pkg/resources / logs / news / metadata      │
                          └───────┬───────────────────────┬──────────────┘
                    HTTP /v1.0/*  │                        │ files / TCP / exec
                                  ▼                        ▼
                       running daprd sidecars   ~/.dapr, resource paths,
                                                state-store backend, container runtime
```

Everything the SPA talks to is its **own origin**. Cross-origin data (the Diagrid product
feed) is proxied through the backend so the browser never leaves `localhost`.

---

## 2. Repository layout

```
main.go                 thin entry point → cmd.Execute()
cmd/                    cobra root + subcommands; process wiring; NO domain logic
  root.go               command tree, global flags, runServe() boot + shutdown
  serve.go              assembleOptions(): builds server.Options + closers
  registry.go           connections.yaml-backed connection registry (ConnRegistry)
  reconciler.go         apps → detected stores → elected active store; implements
                        server.StoreRegistry + server.WorkflowBackend
  derive.go             derivePaths() + appsFingerprint() (reconcile trigger)
  connpool.go           lazy per-store connection pool (identity-keyed)
  update.go             `update` subcommand → pkg/selfupdate
  workflow.go           store-election precedence (newStoreRegistry)
pkg/                    domain packages — each isolated, none import cmd/
  discovery/            standalone.List() + /v1.0/metadata + /v1.0/healthz enrichment;
                        also scans compose containers (scan_compose.go) and Testcontainers
                        daprd containers (scan_testcontainers.go, tar_extract.go)
  statestore/           Store client (redis/postgres/sqlite), Detect, secret resolution
  workflow/             list / stats / history / terminate / purge; store-backed reads
                        (service.go) + sidecar-gRPC reads (sidecar.go) routed per app
                        (composite.go)
  controlplane/         docker/podman detection, inspect, lifecycle actions, log stream
  containerruntime/     docker/podman resolution + exec runner (shared by controlplane & discovery)
  resources/            component + configuration YAML loader
  logs/                 file tail → line channel
  news/                 Diagrid product-feed proxy (cache + singleflight)
  metadata/             embedded component-metadata catalog (drives connection forms)
  server/               chi router + go:embed SPA mount (one file per domain)
  selfupdate/ version/ logging/
internal/golden/        golden-file test helpers
web/                    React + TypeScript + Vite SPA → web/dist (embedded via embed.go)
  src/pages/            one component per route (+ component-builder, resiliency-builder)
  src/components/        reusable UI (wizard/, form/ subdirs)
  src/hooks/            TanStack Query data hooks + useLogStream / useFollowScroll
  src/lib/              api, refresh (polling), connection (backend health), query client, helpers
  src/styles/theme.css  design tokens + component classes
  STYLEGUIDE.md         UI conventions, enforced by src/test/styleguide.test.ts
scripts/                install.sh, install.ps1, release.sh
```

**Architectural rule (load-bearing):** all logic lives in `pkg/*` domain packages, and
**nothing in `pkg/*` imports `cmd/`**. The server mounts as a `chi` sub-router and the SPA
is an `fs.FS`, so the whole dashboard can later fold into a `diagrid dashboard` subcommand
without untangling dependencies. Preserve this when extending.

---

## 3. Process lifecycle (`cmd/`)

`main.go` → `cmd.Execute()` builds a cobra root whose **default** action is `serve`
(`cmd/root.go`). `Execute()` installs a signal-cancelled context (Ctrl-C / SIGTERM) that
threads through everything.

### Global flags (`cmd/root.go`)

| Flag | Default | Controls |
|------|---------|----------|
| `--port` | `9090` | HTTP listen port (`8080` default in aspire container posture) |
| `--bind` | `127.0.0.1` | Listen address (`0.0.0.0` default in aspire container posture) |
| `--mode` | unset | Exclusive discovery filter: `dapr-run`, `compose`, `test-containers`, `aspire`; unset = complete scan (env: `DEVDASHBOARD_MODE`, flag wins) |
| `--base-path` | `""` | Sub-path mount, e.g. `/dashboard` (must match the SPA's `DASH_BASE_PATH` build var) |
| `--no-open` | `false` | Skip auto-opening the browser |
| `--statestore` | `""` | Explicit state-store component YAML; disables auto-detection |
| `--namespace` | `default` | Dapr namespace for workflow state keys |
| `--verbose` | `false` | Emit diagnostic slog output to stderr |

Subcommands: `serve` (default) and `update [version]` (self-update). (`cmd/workflow.go` is
not a subcommand — it holds the store-election and target-resolution helpers used by the
reconciler.)

### `serve` boot sequence (`cmd/root.go` `runServe` → `cmd/serve.go` `assembleOptions`)

1. Resolve the mode and posture (`cmd/mode.go`): `resolveMode` validates
   `--mode`/`DEVDASHBOARD_MODE`; **container posture** = aspire mode *with* the
   `DEVDASHBOARD_APP_*` env contract present, and drives the port/bind defaults
   (`resolveServeSettings`, flag > env > posture default), Host-guard relaxation,
   registry persistence, and browser auto-open. Aspire *without* the contract is a
   host-posture run filtered to Aspire-managed apps.
2. `logging.New(verbose)` → set as the default `slog.Logger`.
3. Load the embedded SPA (`web.DistFS()`) and the component catalog (`metadata.Init()`).
4. Resolve the bind address and the browser URL (base-path aware).
5. Select discovery sources by mode (`cmd/sources.go` `sourcesFor`): mode-unset runs
   every scanner; a filter mode runs exactly one (aspire host mode additionally wraps
   the service in `discovery.FilterAspire`). `compose` and `test-containers` **fail
   startup here** when no container runtime is found. The control-plane manager gets
   the matching family filter (`cpSourcesFor` → `controlplane.Sources`), and the mode
   is echoed to the SPA via the capabilities flags.
6. Resolve `~` (`os.UserHomeDir()`); if unavailable, warn and run with registry
   persistence disabled (features degrade to in-memory no-ops rather than writing a
   CWD-relative `.dapr/`).
7. `assembleOptions`: load the connection registry (`LoadRegistry`), build the lazy
   connection pool (`newConnPool`), build the reconciler, and **synchronously seed** it
   with one reconcile against the boot apps snapshot (so the active store is elected and
   pre-warmed before the first request). The discovery service is wrapped in a
   `reconcilingApps` decorator (see §4).
8. `server.New(addr, opts)` builds the chi router; start it in a goroutine.
9. Open the browser (unless `--no-open` or container posture), then block on `select`:
   server error → log + exit non-zero; signal → 5-second graceful `Shutdown`.

---

## 4. The reconciler — the heart of the backend

The reconciler (`cmd/reconciler.go`) is what turns "which apps are running" into "which
state store do we read workflows from." It implements the two interfaces the HTTP layer
depends on: `server.StoreRegistry` (list/add/edit/delete connections) and
`server.WorkflowBackend` (resolve a store id → a workflow service).

### Trigger: fingerprint-gated, single-flight

There is **no polling timer**. Every call to `apps.List()` — which the SPA drives by
polling `/api/apps`, `/api/actors`, `/api/subscriptions`, `/api/resources` — passes
through the `reconcilingApps` decorator (`cmd/reconciler.go`), which computes an
`appsFingerprint` (`cmd/derive.go`: an order-independent hash of app ids, resource paths,
and loaded state-store names, with sentinel bytes so group boundaries can't collide). If
the fingerprint changed since the last reconcile, a background reconcile is spawned under a
CAS single-flight guard (`maybeReconcile`); concurrent polls skip and let the next one
catch up. Identical fingerprint → no work.

### What a reconcile does (`reconcile`)

1. `derivePaths()` computes: **resource scan paths** (`~/.dapr/components`, `~/.dapr`, each
   app's resource paths, config-file dirs), **state-store scan paths** (the explicit
   `--statestore` if set, else `~/.dapr/components` + app paths), the set of store-component
   **names loaded** by running apps, and the running apps' resource paths.
2. `statestore.Detect` + `DetectSecretStores` scan those paths for `Component` YAML of
   `state.*` type (multi-document YAML supported).
3. `secretKeyRef` metadata is resolved through local secret stores
   (`secretstores.local.file` / `secretstores.local.env`); resolved values are used to
   connect but are **never written to disk**.
4. Each detected store is auto-persisted to the registry via `UpsertAuto` (skipped if
   unchanged, so no needless disk churn).
5. `newStoreRegistry` (`cmd/workflow.go`) elects the **active** store by a 6-level
   precedence: app-provided + `actorStateStore="true"` → app-provided → loaded +
   `actorStateStore` → loaded → `actorStateStore` → first detected. ("App-provided" means
   the store's YAML lives under a running app's resource path.)
6. The active store is **pre-warmed** through the connection pool (context derived from the
   process context so shutdown aborts an in-flight dial).

### Connection registry (`cmd/registry.go`)

`ConnRegistry` owns `~/.dapr/dev-dashboard/connections.yaml` (`0600`, parent `0700`). Each
`ConnEntry` has a stable 12-char hex `ID` (hashed from the normalized path for `auto`
entries, from `"manual:"+name` for `manual` entries — so the two sources never collide and
ids survive restarts). Auto entries carry a `Path` (YAML re-read on connect); manual
entries carry inline `Metadata`. All writes go through an **atomic temp-file + rename**
`save()`; `Add`/`Update` reject duplicate manual names.

Every write stamps the entry's `UpdatedAt`. Removing an **auto** entry does not delete it —
it sets a durable `Dismissed` **tombstone**, so `UpsertAuto` never resurrects a connection
the user removed, across restarts included. The only thing that clears a tombstone is
`Undismiss`, called by the reconciler when the dismissed store is elected **active** again
(a store apps are actively using should reappear). The panel listing hides dismissed
entries and sorts active-first, then by recency (`sortStores` in `cmd/reconciler.go`).
Deleting the elected active store is refused outright with `server.ErrActiveStore`.

### Connection pool (`cmd/connpool.go`)

A lazy, identity-keyed cache of open state-store clients. `openOrGet` single-flights per
identity (a `done` channel per slot); a store opened while its slot was evicted or the pool
was closed is closed immediately rather than leaked; `evict` (on manual edit/delete) waits
for any in-flight open before closing. `Close` waits for all in-flight opens and
`errors.Join`s the results. The pool intentionally **retains** connections across active-
store changes — switching stores doesn't churn connections.

---

## 5. HTTP server + SPA (`pkg/server`, `web/embed.go`)

`server.NewRouter(opts)` (`pkg/server/server.go`) builds a `chi` router with two
middlewares — `middleware.Recoverer` and the custom `localhostGuard` — then mounts the API
and the SPA. If `opts.BasePath` is set, everything mounts under a `chi` sub-router at that
prefix (the portability rule in action).

### Dependency injection

All domain services are passed in via `server.Options` (`BasePath`, `DistFS`, `Version`,
`Apps`, `Backend`, `Stores`, `Resources`, `News`, `ControlPlane`), assembled once in
`cmd/serve.go`. Handlers never construct services; they receive interfaces.

### Route table (`pkg/server/api.go` + per-domain files)

| Method | Path | Domain | Handler file |
|--------|------|--------|--------------|
| GET | `/api/health` | — | api.go |
| GET | `/api/version` | version | api.go |
| GET | `/api/metadata/components` | metadata | api.go (`HandleGetComponents`, ETag) |
| GET | `/api/statestores` | reconciler (StoreRegistry) | api.go |
| POST | `/api/statestores` | reconciler | api.go |
| PUT | `/api/statestores/{id}` | reconciler | api.go |
| DELETE | `/api/statestores/{id}` | reconciler | api.go |
| GET | `/api/apps` | discovery | apps.go |
| GET | `/api/apps/{appId}` | discovery | apps.go |
| GET | `/api/apps/{appId}/logs` | discovery + logs (SSE) | logs.go |
| GET | `/api/actors` | discovery | actors.go |
| GET | `/api/subscriptions` | discovery | subscriptions.go |
| GET | `/api/workflows` | reconciler (WorkflowBackend) | workflows.go |
| GET | `/api/workflows/stats` | workflow | workflows.go |
| GET | `/api/workflows/appids` | workflow | workflows.go |
| GET | `/api/workflows/{appId}/{instanceId}` | workflow | workflows.go |
| POST | `/api/workflows/purge` | workflow (remover) | workflows.go |
| GET | `/api/resources` | resources | resources.go |
| GET | `/api/resources/{kind}/{name}` | resources | resources.go |
| GET | `/api/news` | news | news.go |
| GET | `/api/controlplane` | controlplane | controlplane.go |
| POST | `/api/controlplane/{name}/{action}` | controlplane | controlplane.go |
| GET | `/api/controlplane/{name}/logs` | controlplane (SSE) | controlplane.go |
| * | `/*` | SPA fallback | spa.go |

Errors use a shared `writeJSON(w, status, {"error": ...})` helper. Status mapping is
sentinel-based (`errors.Is`): e.g. store CRUD maps duplicate → 409, deleting the active
workflow store (`ErrActiveStore`) → 409, missing → 404, I/O → 500; control-plane maps
invalid action → 400, runtime unavailable → 503, exec failure → 502.

### Capabilities — per-posture feature gating (`pkg/server/server.go` `Capabilities`)

Not every route in the table above always exists. One binary serves two very different
postures, and a `Capabilities` struct (`Lifecycle`, `ControlPlane`, `Logs`, `Workflows`,
plus a `Mode` echo of the `--mode` value) decides which feature surfaces are on. The
layer has three tiers:

1. **Decided at boot** (`cmd/root.go` `runServe`): host modes get `FullCapabilities()`
   with `Mode` set to the CLI value; aspire **container posture** gets only `Workflows`
   (and that only when a state store is configured) — inside the AppHost container there
   is no host process table for lifecycle, no docker socket for the control plane, and
   no `~/.dapr` log files to tail. A nil `Options.Capabilities` defaults to full host
   capabilities.
2. **Enforced server-side** (`pkg/server/api.go`): route *registration* is conditional —
   `caps.Workflows` gates the workflow routes, `caps.ControlPlane` gates
   `/api/controlplane`. This is the design rule to keep: **the JSON flags are advisory
   UX; absent routes are the real boundary.** A disabled feature is unroutable, not
   merely hidden.
3. **Advertised to the SPA** (`pkg/server/spa.go` `serveIndex`): the struct is marshaled
   into the served `index.html` as `window.__DASH_CAPABILITIES__` (alongside the
   telemetry flag and version). The frontend reads it via `getCapabilities()`
   (`web/src/lib/capabilities.ts`, falling back to everything-on for the Vite dev server
   and tests); consumers include `router.tsx` (routes mount only for enabled features),
   `TopNav` (nav entries), `AppDetail` (lifecycle actions), and the mode-adaptive pages
   (`Logs` gates its static `dapr_*` fallback on `mode`; `ControlPlane` picks
   mode-specific empty-state copy).

**To add a feature route:** decide whether it works in container posture; if not, add a
flag to `Capabilities`, gate the route registration in `api.go`, and gate the SPA
surface via `getCapabilities()`.

### SPA embedding & fallback (`web/embed.go`, `pkg/server/spa.go`)

`//go:embed all:dist` bakes the built SPA into the binary; `DistFS()` returns it rooted at
`dist/`. `SPAHandler` strips the base path, serves a real file when one exists (regular
files only — directory auto-indexing is suppressed), returns 404 for missing paths that
have a file extension, and otherwise serves `index.html` (`Cache-Control: no-store`) so the
client router handles the route.

### Security: `localhostGuard` (`pkg/server/middleware.go`)

Because the API can terminate workflows and stop containers, it is hardened against
DNS-rebinding / CSRF even though it binds to loopback: every request's `Host` must be
`localhost` / `127.0.0.1` / `::1` (any port); state-changing methods (POST/PUT/DELETE/PATCH)
additionally require any present `Origin` to be loopback (any port, so the Vite dev server
works; absent `Origin`, as from curl/CLI, is allowed). Non-conforming requests get `403`.

### SSE streaming

Log endpoints (`logs.go`, `controlplane.go`) set `text/event-stream`, verify the
`http.Flusher`, and copy a line channel to the response as `data: <line>\n\n`, flushing
each and returning when the request context is cancelled.

---

## 6. Domain packages

### Discovery (`pkg/discovery`)

`Service.List(ctx)` returns `[]Instance`, one per running app/sidecar. The source of truth
is `StandaloneScanner`, wrapping `github.com/dapr/cli/pkg/standalone.List()` (the same
process-table scan as `dapr list`) — that supplies app id, ports (app/HTTP/gRPC), daprd &
CLI PIDs, created time, run-template, resource paths, and command. Each result is then
**enriched in parallel** (bounded worker pool) by:

- `GET /v1.0/metadata` (2s timeout) → runtime version, components, actors, subscriptions,
  enabled features, placement address, and `Extended` fields (app PID, command, log paths,
  run-template). Failure sets `MetadataOK=false` and degrades to scan-only data.
- `GET /v1.0/healthz` via `CheckHealth` → the health badge. **Computed on demand during
  each `List`, not by a background poller** — the badge's refresh cadence is whatever the
  SPA's polling interval is.
- Log-source resolution (`logsource.go`): for `dapr run`, `lsof` the process's stdout fd
  to find the backing file; for Aspire/DCP apps, parse the DCP session directory to locate
  the per-resource log files.

A second scanner, `ComposeSource` (`scan_compose.go`), discovers Dapr apps running under **docker compose**: it lists compose-labelled containers (`ps -q --filter label=com.docker.compose.project`), batch-inspects them, and treats any container whose argv invokes `daprd` as a sidecar — app id and ports come from the daprd flags, host-reachable ports from the published port bindings, and resource/config paths from the bind-mount table (host side). The paired app container is matched by compose service name (`-app-channel-address`, falling back to the app id). Sidecars without a published HTTP port are listed but marked `sidecarReachable=false` and skip health/metadata probes (the UI shows a publish-port hint). The compose scan is cached for ~2s behind a ~3s exec timeout. The scanner also exposes a per-project **endpoint map** (`ComposeEnv`) — compose service → published host ports, plus mount tables — which the reconciler uses to **translate** detected state-store addresses (e.g. `postgres-db:5432` → `localhost:5432`) at connect time via `statestore.Translate`; translation is in-memory only, never persisted. Compose app logs stream from `docker logs -f` (`Options.ContainerLogs`) instead of file tailing.

A third scanner, `TestcontainersSource` (`scan_testcontainers.go`), discovers **Dapr Testcontainers** sessions (e.g. Spring Boot apps run with `mvn spring-boot:test-run` and `dapr-spring-boot-starter-test`): it lists `org.testcontainers=true`-labelled containers and keeps those whose argv invokes `daprd` (which naturally excludes ryuk/placement/scheduler helpers). The daprd container publishes its HTTP/gRPC ports to **random host ports on every run**, so port mappings are re-read each poll. Unlike compose, the paired app is a **host process** (reached via `host.testcontainers.internal`): enrichment probes the app port for liveness and resolves the listener's command and PID (`appproc.go`) for runtime inference, App PID, and uptime. The scanner also extracts the container's `--resources-path` YAML as a tar stream (`cp <id>:<dir> -`, `tar_extract.go` — no shell needed, distroless-safe; cached per container ID, evicted on departure, transient failures retried) and exposes it via `Files()` for the resources extras provider (see Resources below). Lifecycle actions are refused for these apps — ryuk owns the containers, the test process owns the app. All scanners are combined with `Merge` (one failing source never hides the others).

Which scanners run is decided by `--mode` (`cmd/sources.go` `sourcesFor`): unset merges all of the above (plus the Aspire env-contract scanner when `DEVDASHBOARD_APP_COUNT` is set); `dapr-run`, `compose`, and `test-containers` run exactly one scanner each. `--mode aspire` without the env contract runs the standalone scan and wraps the **outermost** service (after the lifecycle overlay) in `FilterAspire` (`filter.go`), which keeps only instances flagged `IsAspire` by enrichment — the flag comes from the DCP-proxy heuristic (`appproc.go`), so it cannot be filtered at scan time.

Derived fields include a human-friendly `Age` and an inferred runtime language.
**To add a per-app field:** add it to `Instance` (`types.go`), populate it in `enrich`
(`service.go`) from either the scan result or the parsed metadata, and it serializes
automatically.

### State store + workflows (`pkg/statestore`, `pkg/workflow`)

`statestore.Detect` parses `state.*` `Component` YAML; `statestore.New` builds a `Store`
(the `Keys` / `Get` / `BulkGet` / `Delete` / `Set` / `Close` interface) backed by
components-contrib for **Redis, PostgreSQL, or SQLite** (anything else → `ErrUnsupported`).
Workflow keys are actor-state keys shaped
`<appId>||dapr.internal.<ns>.<appId>.workflow||<instanceID>||<suffix>` (`keys.go`).

`workflow.Service` reads instances by enumerating metadata keys (`Keys` with a pattern),
loading each (`BulkGet`), and decoding the durabletask protobuf history (`decode.go`) into
an `Execution` (status, name, input/output, timestamps, parent instance, replay count,
history events). `List` supports status/search/child filters with **loop-fill pagination**
(keep fetching key-pages until a full page of matches, keys are exhausted, or a bounded
scan cap is hit — so a filter that matches nothing can't scan unbounded). `Stats` and
`AppIDs` aggregate across all instances. `Remove` (`remove.go`) picks a mechanism by state:
terminate-then-purge or purge via the sidecar's Dapr workflow API when healthy, or a direct
state-store key-deletion **force** fallback when the sidecar is unreachable or `force` is
requested.

A second data source, `SidecarService` (`sidecar.go`), reads workflows **live from daprd's
gRPC workflow management API** (`ListInstanceIDs` / `FetchWorkflowMetadata` /
`GetInstanceHistory` via the durabletask-go client, Dapr ≥ 1.17; pre-1.17 sidecars map to a
version message). It works with any backing store — `state.in-memory` included — because
the sidecar itself answers; per-app gRPC calls are timeout-bounded, and a failing app is
skipped, never failing the page. `NewComposite` (`composite.go`) routes per app: apps the
sidecar source **owns** (Testcontainers apps always; every reachable non-aspire sidecar
with a gRPC port when no store is openable) read via gRPC, everything else via the store;
all-apps queries merge both (sidecar wins collisions, first page only), and the no-store /
unreachable-store banners still fire when nothing is sidecar-eligible. The reconciler's
`ServiceFor` builds this composite (`cmd/reconciler.go`); sidecar gRPC connections are
cached per address in a `SidecarPool` closed on shutdown.

**To add a workflow field:** add it to the types (`types.go`) and extract it in
`decode.go`. **To add a store backend:** add a case in `statestore.New` and satisfy the
components-contrib `state.Store` (+ `KeysLiker`) interface.

### Control plane (`pkg/controlplane`)

`New(src Sources)` resolves a container runtime — `DASH_CONTAINER_RUNTIME` override, else
`docker`, else `podman`, else none. The `Sources` selector (`Init`, `Compose` — derived
from `--mode` via `cpSourcesFor`) gates both which families `List` reports and which
names `Do`/`LogStream` accept: `dapr-run`/`aspire` show only the `dapr init` containers,
`compose` only the compose-run ones, `test-containers` the zero value (no control-plane
detection yet — honest empty list), and mode-unset both. `List()` probes reachability,
then `docker inspect` + `docker stats` each enabled container (the stats sampling is
skipped entirely when no names are enabled — a bare `docker stats` would sample every
container on the host): `dapr_scheduler` and `dapr_placement` are the **actionable**
self-hosted containers (`LiveServiceNames`). It returns status, health, port bindings,
memory, and log path per service. `List()` additionally detects compose containers whose
command is `placement`/`scheduler`, surfaces them with a `composeProject`, and
`Do`/`LogStream` accept the compose names discovered by the most recent `List` (still
never arbitrary names). `Do(name, action)` runs a
lifecycle verb **allowlisted** to `start`/`stop`/`restart` on the actionable names only
(`ValidAction` + `IsLiveName`). `LogStream` runs `docker logs -f --tail 200` and demuxes
stdout+stderr onto one channel for the SSE handler. **To add an action:** extend
`ValidAction`; to manage a new container, extend `LiveServiceNames`.

### Resources (`pkg/resources`)

Loads `Component` and `Configuration` YAML (multi-doc) from the reconciler's scan paths,
deduped by absolute path, merged with an **extras provider** — entries that exist outside
the host filesystem, today the YAML extracted from Testcontainers daprd containers. Extras
carry their raw YAML inline and a container-prefixed display path
(`crazy_lamport:/dapr-resources/kvstore.yaml`), so `Get` never reads a display path from
disk. **Load-bearing isolation rule:** extracted YAML feeds ONLY this resources service —
never `statestore.Detect`, the reconciler's paths, or store election. An extracted
`state.in-memory` component with `actorStateStore: true` would otherwise win the election
and break other apps' workflow views; a guard test
(`TestVirtualPathsDoNotFeedStoreDetection`) pins this. The HTTP layer enriches each
component with `LoadedBy` — which running apps loaded it — by cross-referencing discovery.
`Get` returns the raw YAML for the detail view. **To add a resource kind:** extend the
`Kind` type + `kindFromString` and the API validation in `pkg/server/resources.go`.

### Logs (`pkg/logs`)

`Tail(ctx, path, backfillLines, pollInterval)` returns a buffered line channel: it
backfills the last N lines, then polls, tracking a byte offset and carrying partial final
lines between ticks. It recovers from in-place truncation/rotation (offset reset + carry
discard when the file shrinks) and closes the channel on context cancel.

### News (`pkg/news`)

Proxies `https://www.diagrid.io/api/product-feed` behind `GET /api/news` so the SPA stays
same-origin. The cache is **stale-while-revalidate with singleflight and a negative TTL**:
fresh cache is served directly; a stale cache serves last-good immediately while one
background refresh runs; a failed fetch is remembered for a short negative TTL and never
evicts the last-good response. The response exposes one latest blog/report and the next
upcoming webinar/event, with UTM params appended to diagrid.io links.

### Update check (`pkg/updatecheck`)

Resolves the latest GitHub release (reusing `pkg/selfupdate`'s resolver), compares it to
the running version with semver, and caches the result. Consumed by the CLI startup notice
and by `GET /api/update-check` for the web indicator. Fails silent; skipped for `dev`/source
builds.

### Metadata (`pkg/metadata`)

An embedded component-metadata catalog (`//go:embed component-metadata-bundle.json`)
processed once at `Init()` (filter deprecated, dedupe, sort) and served from
`GET /api/metadata/components` with an `ETag` and `If-None-Match` handling (weak validators
and comma lists supported). It drives the connection add/edit forms: pick a component type
→ pick an authentication profile → render its metadata fields. The bundle is the
`component-metadata-bundle.json` asset published on [dapr/components-contrib](https://github.com/dapr/components-contrib/releases)
releases; refresh it with `scripts/update-component-metadata-bundle.sh <tag>`. **To add a
catalog entry:** edit/regenerate the bundle JSON; no code change needed.

### Self-update / version / logging

`pkg/selfupdate` resolves the target release (latest via GitHub API or an explicit
version), downloads the platform archive (size-capped), verifies its SHA256 against the
release `checksums.txt`, extracts the binary, and atomically replaces the running
executable (rename on Unix; move-aside-and-swap on Windows). `pkg/version` holds the
build-time `Version`/`Commit`/`Date` (ldflags-injected) surfaced by `--version` and
`GET /api/version`. `pkg/logging` maps `--verbose` to an stderr slog text handler (a
discard handler otherwise); logs are grouped by `component=`
(`server`/`discovery`/`workflow`/`registry`/`reconciler`).

---

## 7. Frontend (`web/`)

React 19 + TypeScript + Vite, built to `web/dist` and embedded in the binary. `main.tsx`
mounts the provider stack: `QueryProvider` (TanStack Query) → `RefreshProvider` (global
polling) → `ConnectionProvider` (backend health) → `RouterProvider`. `App.tsx` is the shell (TopNav + collapsible ResourcesSidebar
+ routed `Outlet`), wrapped by a `SmallScreenGuard` (desktop-width UI) and route-level
error boundaries.

### Routing (`router.tsx`)

Client-side History-API routing; the router `basename` and all API URLs derive from
`import.meta.env.BASE_URL` (the `DASH_BASE_PATH` build var), and the Go server falls back to
`index.html` for unknown paths. Pages: **Applications** (`/`), **AppDetail**
(`/apps/:id`), **Workflows** + **WorkflowDetail**, **Actors**, **Subscriptions**,
**ResourceList/Detail** (`/components`, `/configurations`), **ComponentBuilder**
(`/components/new`), **Resiliency** + **ResiliencyBuilder** (`/resiliency/new`),
**ControlPlane**, and **Logs**. Feature-gated pages (Logs, ControlPlane, lifecycle
surfaces) mount only when their server-injected capability flag is on — see
*Capabilities* in §5.

### Data fetching & live data

Every polling query is a TanStack Query hook (`src/hooks/`) that calls `fetchJSON`
(`lib/api.ts`) and takes its `refetchInterval` from the global `RefreshControl`
(`lib/refresh.tsx`: 1s/3s/5s/10s/Off, persisted). Query keys are conventional
(`['apps']`, `['apps', id]`, `['workflows']`, `['workflow-stats']`, …); mutations
invalidate the relevant keys. `ConnectionProvider` (`lib/connection.tsx`) polls
`GET /api/health` at that same interval (fixed 30s fallback while refresh is paused/Off)
and mirrors the result into TanStack's `onlineManager`: two consecutive failures flip the
app offline — pausing every polling query until the next successful probe — and
`RefreshControl`'s beat dot turns red with a "Backend offline" label. Mutations default to
`networkMode: 'always'` so an action clicked while the backend is down fails fast through
its normal error path instead of queueing and firing on recovery. Pages gate on query errors rather than rendering stale
cache: when the workflow list fails, the Workflows page shows an error banner and clears
rows, selection, and pagination while the page chrome stays usable. Live logs use SSE via `useLogStream` (a monotonic `revision`
counter distinct from buffer length, and a `closed`-vs-`error` status) with
`useFollowScroll` for pin-to-bottom that survives the line-buffer cap.

### Reusable machinery

The two YAML builders share `components/wizard/` (Wizard/Stepper/StepNav),
`components/form/` (DialogShell + typed inputs), `YamlPreview`, and reducer-based form
state. Cross-cutting primitives: `useModalFocus` (focus trap + restore) behind `Modal` and
`ConfirmRemoveDialog`, `useToast`, `useComponentCatalog` (the metadata-driven schema),
and `lib/` helpers (`parseEnum`, `safeStorage`, `runtimeSwatch`, `download`, YAML
emit/highlight). UI conventions and their enforcement live in
[`web/STYLEGUIDE.md`](web/STYLEGUIDE.md) and `src/test/styleguide.test.ts` (component-table
freshness, hex-literal allowlist, className-prefix rules).

**To add a page:** add the page component under `src/pages/`, a data hook under
`src/hooks/` (mirror `useApps`), a `types/` entry, a route in `router.tsx`, and a nav entry
in `TopNav.tsx`. Style with `theme.css` tokens; document any new reusable component in the
styleguide.

---

## 8. End-to-end flows

- **An app appears:** SPA polls `/api/apps` → discovery merges the three scanners (process
  table via `standalone.List`, compose containers, Testcontainers containers) → enriches
  each with `/v1.0/metadata` + `/v1.0/healthz` in parallel → the `reconcilingApps`
  decorator fingerprints the app set and, if changed, kicks a background reconcile → the
  table renders.
- **Workflows load:** SPA polls `/api/workflows?store=<id>` → reconciler resolves the id to
  a workflow service (elected active store if empty) via the connection pool, composed with
  the sidecar-gRPC source (`NewComposite`) → store-backed apps enumerate + decode instances
  from the state store, sidecar-owned apps (Testcontainers; all reachable sidecars when no
  store is openable) read live over gRPC → merged, paginated JSON.
- **A store is elected:** reconcile detects `state.*` components across scan paths, resolves
  secrets, upserts them into the registry, and elects the active one by the 6-level
  precedence, then pre-warms it.
- **Logs stream:** SPA opens an `EventSource` on `/api/apps/{id}/logs?source=…` → discovery
  resolves the log file path → `logs.Tail` backfills + polls the file → SSE lines →
  `useLogStream` buffers and `useFollowScroll` pins to bottom.

---

## 9. Extension quick reference

| Goal | Touch |
|------|-------|
| New API endpoint + domain | `pkg/<domain>/` (service + types), a router file in `pkg/server/`, a field in `server.Options`, wire it in `cmd/serve.go` `assembleOptions` |
| New per-app field | `pkg/discovery/types.go` + populate in `service.go` `enrich` |
| New state-store backend | case in `statestore.New` + satisfy components-contrib `state.Store`/`KeysLiker` |
| New workflow field | `pkg/workflow/types.go` + extract in `decode.go` |
| New control-plane action | extend `ValidAction` (+ `LiveServiceNames` for a new container) |
| New resource kind | `Kind` + `kindFromString` in `pkg/resources`, validation in `pkg/server/resources.go` |
| New CLI flag | declare + register in `cmd/root.go`, thread through `runServe` → `assembleOptions` |
| New CLI subcommand | add `cmd/<name>.go`, register in `NewRootCmd` |
| New SPA page | page + hook + type + route + nav entry (see §7) |
| Support a new discovery source | implement a discovery.Scanner + add it to Merge in cmd/root.go |

---

## 10. Testing map

Four suites (see [README.md](README.md#testing) and [AGENTS.md](AGENTS.md#test) for
commands):

- **unit** (`//go:build unit`) + **web** (Vitest) — self-contained, the everyday gate.
- **integration** (`//go:build integration`) — state-store/workflow read paths and the
  assembled HTTP server against in-process Redis (`miniredis`) + temp SQLite. CI-only.
- **e2e** (`//go:build e2e`) — drives a real `daprd`; local-only, skips when Dapr is absent.

Go tests are build-tag-gated: a bare `go test ./...` runs nothing. Always pass `-tags`.

---

For the original design rationale, see
[`docs/superpowers/specs/2026-06-25-dev-dashboard-design.md`](docs/superpowers/specs/2026-06-25-dev-dashboard-design.md).
