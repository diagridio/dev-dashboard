# Testcontainers components in the Components view + App detail completeness

Date: 2026-07-12
Status: approved
Builds on: `2026-07-12-testcontainers-discovery-sidecar-workflows-design.md` (PR #60);
branch `feat/testcontainers-components` stacks on `feat/testcontainers-discovery`.

## Goal

1. Components declared in Testcontainers test config (e.g. the `kvstore`
   `state.in-memory` component of the Java quickstart) appear in the
   Components view with their full YAML, even though the file exists only
   inside the daprd container.
2. The Application detail page stops showing empty fields for testcontainers
   apps: Uptime, App PID, App protocol, the daprd PID slot, and the Paths
   section all carry real values — and App protocol is fixed for every
   source, since it was a hardcoded placeholder.

## Background (verified)

- The Components view is backed by `pkg/resources`, which scans YAML files
  on host disk from `reconciler.Paths()`. Testcontainers components are
  written by `testcontainers-dapr` to `--resources-path /dapr-resources`
  inside the daprd container — no host file, so no entry.
- The server already learns each app's component names/types/versions from
  sidecar metadata (the `LoadedBy` index in `pkg/server/resources.go`), so
  badges work once an entry exists.
- `AppDetail.tsx` renders "App protocol" and "Metrics port" as hardcoded
  `—` for every source; PID rows render for testcontainers because only
  `isCompose` swaps in container rows; `AppStartedAt` is never set for
  testcontainers (enrichment probes the app port but never resolves the
  listener's PID).

## Part 1: Component YAML extraction from the daprd container

**Mechanism.** For each testcontainers daprd container, run
`<runtime> cp <containerID>:<resourcesPath> -` through the existing
`containerruntime.Runner` (docker and podman both stream a tar archive to
stdout; no shell needed in the container, so distroless daprd images work).
Parse with `archive/tar`, keeping only regular `.yaml`/`.yml` files, capped
at 32 files and 1 MiB per file.

**Caching.** Extract once per container ID (the files are written at
container creation and never change). Evict cache entries for container IDs
no longer present in the scan. Extraction failure logs once per container
and degrades to no extracted files.

**Store-election isolation (load-bearing).** Extracted YAML feeds ONLY the
resources service (Components/Configurations pages). It is never added to
`reconciler.Paths()`, never passed to `statestore.Detect`, and never
participates in active-store election. Rationale: a testcontainers
component like `kvstore` is `state.in-memory` with `actorStateStore: true`;
the election precedence ranks app-provided actor stores first, so feeding
it in would evict a real (e.g. Redis) store and break other apps' workflow
views. Workflow routing stays exactly as shipped in PR #60.

**Wiring.**
- `TestcontainersSource` exposes the extracted files (container name,
  in-container path, raw content), populated during its cached scan.
- `resources.New` gains an optional extras provider (`func() []Resource`)
  merged after the file scan. Extracted content parses through the same
  multi-doc YAML parser as scanned files, so a `Configuration` document in
  the resources dir lands on the Configurations page for free.
- Extracted entries carry `Raw` (full spec, including fields like
  `actorStateStore: true`) and a container-prefixed display path, e.g.
  `crazy_lamport:/dapr-resources/kvstore.yaml`. IDs derive from the same
  name|type|path hash as file entries; the container name in the path keeps
  concurrent sessions with identical component names distinct.
- `LoadedBy` badges work unchanged (computed from metadata by name).
- Entries are read-only, like any scanned file.

## Part 2: App detail completeness

**App protocol — all sources.** `FetchMetadata` additionally reads
`appConnectionProperties.protocol` from `/v1.0/metadata` (Dapr 1.11+);
`Instance.AppProtocol` carries it; the hardcoded `—` in `AppDetail.tsx`
becomes the real value for standalone, compose, aspire, and testcontainers.
Fallback for container sources when metadata is unavailable:
`--app-protocol` from the parsed daprd argv. Metrics port stays a
placeholder (out of scope).

**App PID and app Uptime (testcontainers).** The `appProcResolver` gains a
PID-returning lookup for the app-port listener (same gopsutil connection
data that already yields the command). The testcontainers enrich branch
sets `AppPID` from it (overriding the container-scoped metadata appPID,
which is meaningless on the host) and `AppStartedAt` via the existing
`procStartTime` — giving the JVM's real PID and a ticking uptime. Daprd
uptime already flows from the container's `StartedAt`.

**Row selection (testcontainers only; aspire untouched).**
- Daprd panel: render the compose-style **Container** row
  (daprd container name) instead of the "daprd PID" row — an in-container
  PID is not a host PID and would mislead (especially on macOS).
- App panel: keep **App PID** (now filled — the app genuinely is a host
  process); replace the **CLI PID** row with a **Session** row showing the
  `org.testcontainers.sessionId` (first 8 characters, full value as the
  element's title attribute). CLI PID remains for
  standalone (it is real and drives orphan detection), compose keeps its
  container rows, and aspire's rendering is explicitly unchanged (its
  dash-only CLI PID row is a pre-existing cosmetic gap, out of scope).

**Paths.** `ResourcePaths` for testcontainers instances gets the
container-prefixed virtual path (e.g. `crazy_lamport:/dapr-resources`),
matching Part 1's display convention; `ConfigPath` likewise when `--config`
is present in the argv. Known caveat: these are display paths — the copy
button yields a string that is not a host path, and the reconciler's path
walkers no-op harmlessly on nonexistent paths (verified; and per the
isolation rule above, extracted YAML never reaches store election anyway).

## Error handling

- `cp` failure / tar parse failure: log once per container, no entries;
  page behaves as today.
- Oversized/odd tar members skipped silently (caps above).
- Missing `appConnectionProperties` in metadata (older daprd): protocol
  falls back to argv for container sources, else stays `—`.
- App-port listener PID lookup failure: PID/uptime stay empty (as today);
  never blocks other enrichment.

## Testing

- Extractor: tar-fixture tests (fixture captured from a real
  `docker cp` of the live quickstart container), including cap and
  malformed-member cases.
- Scanner: fake-runner tests for extract-once caching and eviction of
  departed containers.
- Resources service: merge tests (file + extras, ID stability, kind
  routing of a Configuration doc).
- Guard test: extracted components never appear in store detection paths.
- Metadata: `appConnectionProperties.protocol` parse test; argv fallback
  test.
- Enrich: App PID/StartedAt from listener-PID resolver (faked).
- Web: row-selection tests (Session/Container rows for testcontainers,
  standalone/compose/aspire unchanged), App protocol rendering; `tsc -b`.
- Manual e2e against the child-workflows quickstart: kvstore visible in
  Components with full YAML and LoadedBy badge; AppDetail shows uptime,
  JVM PID, protocol http, container row, session, and paths.

## Out of scope

- Extending extraction to compose containers with unmounted resource dirs
  (documented follow-up).
- Metrics port (placeholder for all sources today).
- Aspire row rendering changes.
- Editing extracted (read-only) component entries.
