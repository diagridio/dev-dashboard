# Docker Compose App Discovery — Design

**Date:** 2026-07-04
**Status:** Approved design, pending implementation plan

## Problem

The dashboard discovers daprd sidecars via the local process table
(`pkg/discovery/scan_standalone.go` wrapping the Dapr CLI's `standalone.List()`).
That covers `dapr run` and .NET Aspire, both of which run daprd as host
processes. Dapr apps started with `docker compose` run daprd *inside
containers* and are invisible to the process table, so the dashboard shows
nothing for them.

Reference workload: a compose file with paired `<app>` + `<app>-dapr` services,
daprd flags in each sidecar's `command` array, sidecar HTTP ports published to
the host, components/config bind-mounted into the sidecar, and compose-run
placement + a 3-node scheduler cluster
(e.g. the `dapr-distributed-saga` sample's `docker-compose.yml`).

## Goals (agreed scope)

1. **Full parity** for compose-run Dapr apps: Applications list, health badge,
   `/v1.0/metadata` enrichment, log streaming, resource listing, state-store
   detection, and workflow browsing.
2. **Zero-config auto-detect**: scan the container runtime; no flag or UI
   registration of compose files. The runtime (not the compose YAML) is the
   source of truth — it reflects interpolated env vars, actual published
   ports, and actual mount sources.
3. **Graceful degradation** when a sidecar's HTTP port is not published to the
   host: show the app from scan data alone, with a UI hint to publish the port.
4. **Auto-translate state-store addresses** from compose-network hostnames to
   `localhost:<published-port>` so workflow browsing works without manual
   connections.
5. **Compose control plane**: placement/scheduler containers appear on the
   Control Plane page with status, logs, and lifecycle actions.

## Chosen approach

Shell out to the docker/podman CLI (`ps` + `inspect`), exactly like
`pkg/controlplane` does today. Rejected alternatives:

- **Docker Engine API (Go SDK):** typed and event-capable, but a very heavy
  dependency tree, weaker podman story, and divergent from the repo's existing
  runtime integration. The fingerprint-gated reconciler doesn't need events.
- **Compose-file parsing:** duplicates what `docker inspect` reports more
  reliably (env interpolation, real ports/mounts) and breaks on
  `include:`/profiles/overrides. Labels are still read opportunistically for
  display, but the file is never parsed.

## Design

### 1. Shared container-runtime package

Extract the runtime resolution (`DASH_CONTAINER_RUNTIME` override → `docker` →
`podman` → none) and the exec `runner` seam (run-returning-stdout +
line-streaming, including the `docker logs` stdout/stderr demux) from
`pkg/controlplane/runtime.go` into a new package, e.g. `pkg/containerruntime`.
Both `controlplane` and `discovery` consume it. The fake-runner test pattern
moves with it.

### 2. Compose scanner (`pkg/discovery/scan_compose.go`)

`ComposeScanner(rt)` returns a `discovery.Scanner`. Each scan is two execs:

1. `docker ps -q --filter label=com.docker.compose.project` → candidate IDs.
2. One batched `docker inspect <ids…>` → JSON for all compose containers.

**Sidecar identification:** a container whose command argv contains a token
ending in `daprd`. (Image name `daprio/daprd` is corroborating but not
required — custom images are common.)

**Flag parsing** from the sidecar's argv: `-app-id`, `-app-port`,
`-dapr-http-port`, `-dapr-grpc-port`, `-app-channel-address`,
`-resources-path`, `-config`. Accept `-flag value`, `--flag value`, and
`=`-joined forms.

**Per-sidecar mapping to `ScanResult`:**

- `HTTPPort` / `GRPCPort`: the *host* port from `NetworkSettings.Ports` for the
  container-internal port daprd was started with. Unpublished → `0` and the
  instance is marked sidecar-unreachable.
- `ResourcePaths`: the host `Source` of the mount whose `Destination` matches
  `-resources-path`. Same mechanism for `-config` → `ConfigPath`.
- **App pairing:** within the same `com.docker.compose.project`, the container
  whose compose service name (`com.docker.compose.service`) equals
  `-app-channel-address` (fallback: the app-id) is the app container. Its
  container ID/name/image are kept for logs and runtime inference.
- `Created`: sidecar container `State.StartedAt`. PID fields stay `0`.

**New fields.** `ScanResult` and `Instance` gain: `Source`
(`standalone` | `compose`), `ComposeProject`, `ComposeService`,
`DaprdContainerID`/`Name`, `AppContainerID`/`Name`, `AppImage`, and
`SidecarReachable bool`. `Instance.IsAspire` remains; the SPA switches on
`Source` the same way it switches on `IsAspire` today.

**Endpoint map (for §5):** per compose project, the scanner also records
`service-name → localhost:<published-host-port>` for **every** service's
published ports (not just sidecars), plus each service's bind-mount table.
Discovery caches the map from the last scan and exposes it to the reconciler.

### 3. Scanner composition & resilience

`cmd/serve.go` wires `discovery.New(discovery.Merge(StandaloneScanner(),
ComposeScanner(rt)), client)`.

- `Merge` concatenates results. If one scanner errors, it logs and continues
  with the others — docker being absent must never break `dapr run` discovery.
  `Merge` returns an error only when *all* scanners fail.
- Compose scans run under a bounded timeout (~3s) and the last good result is
  cached for ~2s, so 1s SPA polling cannot cause exec storms.

### 4. Enrichment & logs

**Enrichment** (`enrich`) is unchanged for the happy path: with a published
HTTP port, `CheckHealth` and `FetchMetadata` hit `localhost:<host-port>` and
actors/subscriptions/components/features populate as today. Compose deltas:

- `SidecarReachable == false` → skip both HTTP calls (no wasted timeouts),
  `MetadataOK=false`, `Health=unknown`. The SPA derives the hint from
  `source == "compose" && !sidecarReachable` — "publish the daprd HTTP port
  (e.g. `3500:3500`) to enable health & metadata" — no extra field needed.
- Skip process-based logic: no `lsof` stdout resolution, no DCP/Aspire probing,
  no `appRuntime` port scan. Runtime inference is best-effort from the app
  container's image name/command; `unknown` is acceptable.
- Metadata `Extended` fields (app PID, log paths) describe the container's own
  view and are ignored for compose instances.

**Logs.** `/api/apps/{appId}/logs?source=app|daprd` gains a third log-source
kind, `container`. For compose instances the handler streams
`docker logs -f --tail 200 <container-id>` (the demuxed stream from
`pkg/containerruntime`) instead of `logs.Tail` on a file. SSE framing is
identical, so `useLogStream`/Logs page work unchanged. Container stops
mid-stream → the stream closes; the SPA's existing `closed` handling applies.

### 5. State-store detection & address translation

**Detection is mostly free.** Compose instances carry host-side
`ResourcePaths`, so `derivePaths()` → `statestore.Detect` finds their component
YAMLs unchanged, `appsFingerprint` picks up compose start/stop, detected stores
are upserted, and the existing 6-level active-store election applies
("app-provided" now includes compose-mounted paths).

**Translation.** Component YAML in a compose project points at compose-network
hostnames (e.g. `postgres-db:5432`) that don't resolve from the host. At
**connect time** (connection pool → `statestore.New`), if the store's YAML came
from a compose project's resource path, a translator derived from that
project's endpoint map rewrites connection metadata in memory:

- `host:port`-style fields (e.g. `redisHost`) and PostgreSQL connection
  strings/URLs.
- Only exact service-name matches from the store's own compose project are
  rewritten — never arbitrary hostnames.
- Service matched but port unpublished → leave as-is; the connection fails
  normally and the store-error UI carries a "publish the port" hint.
- SQLite: container-internal path; translate through the mount table when it's
  a bind mount, otherwise (named volume) unreachable → degrade.
- The registry keeps the original YAML untouched (`auto` entries re-read the
  file); translation never persists.

### 6. Control plane

`pkg/controlplane.List()` additionally scans compose containers whose command
is `./placement` or `./scheduler`. They render on the Control Plane page with
the same status/health/ports/memory/logs cards, grouped under their compose
project. `start`/`stop`/`restart` are allowed on them: the action allowlist
becomes "the fixed `dapr_*` names **plus** container names the compose scan
itself identified as placement/scheduler", so arbitrary container control
remains impossible.

### 7. Frontend

- **Applications table:** a `compose` source badge (same treatment as the
  Aspire badge) with the project name in a tooltip; unreachable sidecars show a
  subdued health state plus the publish-port hint.
- **App detail:** container names + short IDs replace the PID rows for compose
  apps; show compose project/service. Logs tab unchanged.
- **Control Plane page:** a project-labeled compose group alongside the
  `dapr init` section.
- **Types/hooks:** extend the `Instance` TS type; no new pages, routes, or nav
  entries.

## Failure modes

| Condition | Behavior |
|---|---|
| No docker/podman | Compose scanner yields nothing; `dapr run`/Aspire unaffected |
| Docker slow/hung | Bounded scan timeout; last good result cached ~2s |
| Sidecar HTTP port unpublished | App listed from scan data; health unknown; hint |
| Store port unpublished | Component detected; connection fails with hint |
| Store on named volume (SQLite) | Detected; unreachable → degrade |
| Container stops during log stream | SSE stream closes cleanly |
| Podman | Same code path via shared runtime resolution; compose labels per podman-compose |
| Duplicate app-id across sources | Both instances listed (no dedup) |

## Testing

- **unit:** golden tests for the compose scanner on canned `docker inspect`
  JSON (fake-runner pattern; the saga compose file's shapes become fixtures);
  table tests for daprd flag parsing and address translation (redis
  `host:port`, PG connection string/URL, unpublished port, foreign hostname
  untouched, SQLite mount translation).
- **web:** badge/hint rendering, container-ID display.
- **integration:** assembled server with a fake runner serving compose
  fixtures — apps list, container log branch, store election with a translated
  address against miniredis.
- **e2e:** compose-based scenario deferred to a follow-up (needs docker +
  compose locally; skipped when absent).

## Non-goals

- Parsing compose YAML (including `include:`, profiles, overrides).
- Showing declared-but-not-running compose services.
- Docker Engine API / event-driven updates.
- Reaching unpublished ports via helper containers or network tricks.
