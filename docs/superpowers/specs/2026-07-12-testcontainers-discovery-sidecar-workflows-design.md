# Testcontainers discovery + sidecar-gRPC workflow source

Date: 2026-07-12
Status: approved

## Goal

Apps launched via Dapr Testcontainers (e.g. a Spring Boot app run with
`mvn spring-boot:test-run` and `dapr-spring-boot-starter-test`) appear in the
dashboard like any other app. Additionally, the Workflows pages work for any
app whose state store the dashboard cannot open — including `state.in-memory`
— by reading workflow data from the sidecar's gRPC API instead of the store.

## Verified environment facts

Captured from a live run of the `child-workflows` Java quickstart
(`mvn spring-boot:test-run`, dapr-spring-bom 1.18.0, Testcontainers 1.20.6):

- The app is a plain **host JVM process** listening on its app port (8080).
  There is no `dapr` CLI and no host `daprd` process.
- `testcontainers-dapr` starts four containers, all labeled
  `org.testcontainers=true` plus a shared `org.testcontainers.sessionId`:
  `daprio/daprd`, `daprio/placement`, `daprio/scheduler`, and
  `testcontainers/ryuk` (the reaper that deletes everything when the JVM
  exits). A `testcontainers/sshd` helper may also be present.
- The daprd container argv is a standard daprd invocation, e.g.
  `./daprd --app-id workflow-patterns-app --dapr-listen-addresses=0.0.0.0
  --placement-host-address placement:50005 --scheduler-host-address
  scheduler:51005 --app-channel-address host.testcontainers.internal
  --app-port 8080 --app-protocol http ... --resources-path /dapr-resources`.
  The existing `parseDaprdArgs` parses it verbatim (verified).
- Container-internal ports 3500 (HTTP) and 50001 (gRPC) are published to
  **random host ports** that change every run.
- Components are declared in Java test config and written to
  `/dapr-resources` inside the daprd container; the quickstart's actor state
  store is `state.in-memory`, which lives inside the daprd process. There is
  no store file or DB on the host.
- **Proven live**: `durabletask-go`'s `workflow.Client` against the published
  gRPC port answered `ListInstanceIDs` (7 instances), `FetchWorkflowMetadata`
  (name/status/created/custom status/failure details), and
  `GetInstanceHistory` (full event lists) — all backed purely by
  `state.in-memory`. These are the same sidecar APIs `dapr workflow
  list/history` uses on runtime >= 1.17 (pre-1.17 returns `Unimplemented`).
- A docker-inspect snapshot of the daprd/scheduler/placement containers was
  captured for test fixtures; it is regenerable by running the quickstart.

## Part 1: Testcontainers discovery scanner

New `pkg/discovery/scan_testcontainers.go`, modeled on the compose scanner,
registered in default mode's `discovery.Merge(...)` in `cmd/root.go`.

- **Filter**: `docker ps -aq --filter label=org.testcontainers=true`, then
  batch `docker inspect`, keeping only containers whose argv invokes daprd
  (reuse `parseDaprdArgs`). This naturally excludes ryuk, sshd, placement,
  and scheduler. Reuse the `containerruntime.Runner` abstraction; nil runner
  means an empty, error-free scan (as compose does).
- **Source**: new `SourceTestcontainers` constant in
  `pkg/discovery/service.go`; `Instance.Source` carries it; the TS union
  `AppSummary.source` in `web/src/types/api.ts` widens with
  `'testcontainers'`.
- **Ports**: map container-internal HTTP/gRPC ports (from `parseDaprdArgs`,
  defaulting 3500/50001) to their published host ports from docker inspect,
  same as compose. `SidecarReachable = published HTTP port != 0`. Record the
  published gRPC port on the instance — the workflow source needs it.
  Discovery re-reads ports every poll, so random per-run ports are fine.
- **App pairing**: the app is a host process, not a container. When
  `--app-channel-address` is `host.testcontainers.internal` (or
  `host.docker.internal`) and `--app-port` is set, resolve the host process
  listening on the app port via the existing `CommandForPort` resolver
  (`pkg/discovery/appproc.go`). That yields app PID, liveness, and runtime
  inference from the command (a JVM command infers "java").
- **Grouping**: store the `org.testcontainers.sessionId` label analogously to
  a compose project so one session's containers group together; populate
  container ID/name fields as compose does.
- **Enrich branch**: a `SourceTestcontainers` case in `enrich()`
  (`pkg/discovery/service.go`): health/metadata via the published HTTP port;
  app-process status from the host-port pairing; sidecar status from docker
  container state. Resource paths inside the container are not host-readable;
  the Components view relies on the metadata endpoint's component list (as it
  already does for unreachable paths).
- **Lifecycle controls stay disabled** for these apps: ryuk owns the
  containers and Maven owns the JVM; the dashboard must not fight either.
- **Merge/dedup**: no `Key()` collision with standalone is expected (there is
  no host daprd), but testcontainers results participate in the existing
  merge so an Aspire contract entry still wins if both describe the same app
  (`dedupAspireWins` semantics extend to cover the new source).

## Part 2: Sidecar-gRPC workflow source (general fallback)

`pkg/workflow` gains a per-app source interface — list instances, get
instance, get history — with two implementations:

- **Store-backed**: the existing service, refactored behind the interface.
  Behavior unchanged: cross-app listing, batched stats, reads state for
  stopped apps, per-app namespace resolution.
- **Sidecar-backed** (new): `durabletask-go` `workflow.Client` over the
  app's daprd gRPC endpoint. `ListInstanceIDs` with continuation-token
  pagination; `FetchWorkflowMetadata` with a bounded fan-out (the CLI uses
  32-way concurrency; adopt a similar cap); `GetInstanceHistory` for the
  detail page. History arrives as `protos.HistoryEvent`, the same shapes the
  store path decodes, so it maps onto the existing event model; the existing
  decode-failure surfacing (failure details, per-event error box) carries
  over. `github.com/dapr/durabletask-go v0.12.1` is already a dependency.

**Per-app selection rule**, applied at query time:

1. A `SourceTestcontainers` app always uses the sidecar source (its store
   lives inside the container and is never host-readable).
2. Otherwise, if a state store is configured *and openable*, use the store
   source (authoritative; existing behavior). A configured store stays
   authoritative even if some app actually writes to a different store —
   querying both per app is out of scope.
3. Otherwise (no `--state-store-file`, or the component is unsupported or
   unopenable — `state.in-memory` is the canonical case), use the sidecar
   source for every app with a reachable gRPC endpoint.

The all-apps Workflows list merges per-app results across sources. Stats for
sidecar-sourced apps are computed from listed metadata. gRPC connections are
cached per app and closed when the app disappears from discovery. A runtime
older than 1.17 returns `Unimplemented`; mark that app's workflows
unavailable with a version message instead of an error page.

**Known limits (documented, not solved here):**

- Sidecar-sourced workflow data is live-only: when the app/sidecar goes
  away, its history is no longer viewable (unlike the store path).
- Aspire container mode keeps its store requirement: the env contract
  carries only an HTTP base URL, no gRPC endpoint. Extending the contract
  with a gRPC address is a future follow-up.

## Capabilities & UX

- `Capabilities.Workflows` becomes true when a store is configured **or** at
  least one discovered app can serve workflows via sidecar.
- The store-error/degradation banner only shows when the store path is
  actually selected and failing; sidecar-sourced apps render normally.
- Optional cosmetic: a small "via sidecar" annotation on workflow views for
  transparency. Cut if it adds friction.

## Error handling

- Scanner: docker unavailable or inspect failures degrade to an empty scan
  (merge already tolerates failing scanners unless all fail).
- Sidecar source: per-app timeouts on gRPC calls; a failing app's workflows
  surface as that app being unavailable, never a whole-page error.
  `Unimplemented`/`Unknown` maps to the version message (mirroring the CLI's
  fallback detection).

## Testing

- Scanner unit tests with docker-inspect fixtures captured from the real
  Testcontainers session (argv parsing, port mapping, label grouping,
  exclusion of non-daprd session containers).
- Sidecar source unit tests against a fake durabletask gRPC server:
  pagination, metadata fan-out, history mapping, `Unimplemented` messaging.
- Selection-rule tests covering the three-way precedence.
- `make build` / `tsc -b` on any TS change (vitest does not typecheck).
- Manual end-to-end: run the child-workflows quickstart, confirm the app
  appears, trigger `POST /start`, confirm instances and history render.

## Out of scope

- Generalizing container discovery beyond Testcontainers labels (the "any
  containerized daprd" scanner) — future refactor.
- Upstream `testcontainers-dapr` integration that launches the dashboard as
  a session container (Aspire-style env contract) — future follow-up.
- Workflow queries against both store and sidecar for the same app.
- Lifecycle controls for testcontainers-managed containers.
