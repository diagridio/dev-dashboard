# Aspire Container Mode — Design

**Date:** 2026-07-11
**Status:** Approved design, pending implementation plan

## Context

The dashboard today is a host-local developer tool: a single static Go binary
(embedded React SPA) that discovers Dapr apps by scanning the host process
table (`dapr run` via `standalone.List()`) and the container runtime
(`docker`/`podman` shell-outs for compose projects), probes daprd sidecars on
`127.0.0.1:<port>`, tails host log files, and manages host processes by PID.

To integrate with .NET Aspire, the dashboard must run as a **container
resource inside an Aspire AppHost**, where none of that host introspection is
available. Aspire already knows every app and sidecar in its application
model, so discovery inverts: instead of the dashboard scanning, the
orchestrator **tells the dashboard what exists** via environment variables.

A prototype hosting integration exists at
[diagrid-labs/dashboard-aspire](https://github.com/diagrid-labs/dashboard-aspire)
(currently a workflow-only visualizer). It will be rewritten against the
contract defined here; it is **out of scope** for this repo. What this repo
delivers is the contract and the binary/image that honors it.

## Goals

1. **Aspire mode** in the Go binary: config-driven app discovery, container-
   appropriate serving, host-introspection features cleanly disabled.
2. **The contract**: CLI flags and env vars the hosting integration uses to
   start the dashboard and hand it the app inventory. This is the primary
   artifact — the integration is built against it.
3. **Container image**: minimal multi-arch image published to GHCR alongside
   the existing binary release.

## Non-goals

- The .NET hosting integration itself (separate repo).
- Containerized *local* mode (running host-scanning discovery inside a
  container via socket/PID-namespace mounts). Explicitly rejected: it ends up
  granting the container the host anyway.
- Host process/compose discovery, app lifecycle (start/stop/restart),
  control-plane (scheduler/placement) management, and host-file log tailing
  while in aspire mode. Aspire owns resource lifecycle and log streaming.
- Log streaming from daprd/app HTTP endpoints (possible later; new log
  source).

## Feature scope in aspire mode

Read-only observability **plus workflow actions**:

- App inventory with per-app daprd metadata and health.
- Components/resources browsing (from mounted component YAML).
- Workflow instances, history, and **terminate/purge/force-delete** actions.
- Actors, subscriptions, and other pages that derive purely from daprd
  metadata + state store.

## The contract

### Mode switch

| Source | Values | Default |
|---|---|---|
| `--mode` flag / `DEVDASHBOARD_MODE` env | `aspire` (reserved for future work: `dapr`, `compose`) | unset |

The mode takes exactly **one value** — it is a single-source filter, not a
list. Combinations are deliberately unsupported: developers are unlikely to
need a specific mix (e.g. compose+aspire but not `dapr run`), and a
multi-value contract is not worth that cost.

**Mode unset (the default) performs the complete scan across all discovery
sources**: `dapr run` host processes, docker compose containers, and — when
its env contract is present — Aspire-injected apps. Serving posture is
today's host behavior, byte-for-byte (loopback bind, port 9090, browser
open, update check, all features on).

Note that the standalone process scan matches **any** host `daprd` process
by executable name, not just `dapr run` children — so daprd sidecars
launched by an Aspire AppHost as host executables are already discovered
today, and that keeps working unchanged with mode unset. The env-contract
Aspire source is additive on top of (and merged with) that incidental
detection, not a replacement for it.

`--mode=aspire` restricts discovery to the Aspire env contract alone and
switches to container serving posture; every change below is gated on it.

**Future work (reserved, not in this iteration):** `--mode=dapr` and
`--mode=compose` restrict discovery to only `dapr run` processes or only
docker compose containers respectively, keeping host serving posture
unchanged.

Precedence everywhere: **flag > env > mode default**.

The published image sets `ENV DEVDASHBOARD_MODE=aspire`, so the integration never has
to pass it; it is overridable.

### App discovery (indexed env vars)

The integration enumerates Dapr sidecars in the AppHost model and injects:

| Env var | Required | Meaning |
|---|---|---|
| `DEVDASHBOARD_APP_COUNT` | yes | number of apps (`0` is valid: empty dashboard) |
| `DEVDASHBOARD_APP_<i>_ID` | yes | Dapr app-id (i = 0..count-1) |
| `DEVDASHBOARD_APP_<i>_DAPR_HTTP` | yes | daprd HTTP base URL, reachable **from the dashboard container** (e.g. `http://myapp-dapr:3500`) |
| `DEVDASHBOARD_APP_<i>_NAMESPACE` | no | per-app Dapr namespace; defaults to `DEVDASHBOARD_NAMESPACE`. Accepted and exposed in the API; currently informational — workflow queries use the global `DEVDASHBOARD_NAMESPACE`, not the per-app value |
| `DEVDASHBOARD_APP_<i>_LABEL` | no | display name (Aspire resource name); defaults to the app-id. Accepted and exposed in the API; currently informational — UI display of labels is planned |

Indexed single-value vars (not JSON) because each `DAPR_HTTP` value is one
Aspire endpoint reference — runtime-resolved and container→host rewritten by
Aspire — and must not need string escaping inside a composite value.

Validation is **fail-fast at startup**: `DEVDASHBOARD_MODE=aspire` with a missing or
non-numeric `DEVDASHBOARD_APP_COUNT`, or any missing required per-app var, or an
unparsable `DAPR_HTTP` URL, exits with an error naming the exact variable. A
misconfigured integration should be loud, not quietly empty.

With mode unset the contract is optional: an absent `DEVDASHBOARD_APP_COUNT`
simply disables the Aspire source and the full host scan proceeds; a
present-but-malformed contract still fails fast.

### Serving and features

| Env / flag | Default (aspire) | Default (mode unset) | Meaning |
|---|---|---|---|
| `DEVDASHBOARD_PORT` / `--port` | `8080` | `9090` | listen port |
| `DEVDASHBOARD_BIND` / `--bind` (new flag) | `0.0.0.0` | `127.0.0.1` | bind host |
| `DEVDASHBOARD_STATESTORE_FILE` / `--statestore` | unset | unset | path to a mounted Dapr state-store component YAML; enables workflows |
| `DEVDASHBOARD_NAMESPACE` / `--namespace` | `default` | `default` | default Dapr namespace for workflow actor keys |
| `DEVDASHBOARD_RESOURCES_PATH` (new) | dir of `DEVDASHBOARD_STATESTORE_FILE` | n/a | extra component directories for the Resources page, `os.PathListSeparator`-separated |
| `DEVDASHBOARD_ALLOWED_HOSTS` (new) | unset (any host) | n/a | optional, env-only; comma-separated hostnames the `Host` header is restricted to (loopback always allowed); empty means any host |
| `--base-path` | unset | unset | flag only, unchanged (Aspire proxies to root; no env alias needed) |
| `DEVDASHBOARD_TELEMETRY_OPTOUT` | unchanged | unchanged | existing telemetry opt-out |

Aspire mode behavior changes (no new config needed):

- No browser auto-open, no interactive update prompt, no self-update, no
  GitHub update check.
- Connection-registry persistence disabled silently (no `$HOME` in the
  image; today's "home directory unavailable" warning is suppressed in
  aspire mode).
- Lifecycle, control-plane, and log-tail routes are **not registered**; the
  UI hides those features (capabilities, below).

The prototype integration's `COMPONENT_FILE` and `APP_ID` env vars are
superseded by `DEVDASHBOARD_STATESTORE_FILE` and the discovery list; the integration
migrates when it is rewritten.

## Binary internals

### Mode plumbing

Resolve the mode once at startup in `cmd/root.go` (flag > `DEVDASHBOARD_MODE`).
A small mode value threads through `runServe` and gates behavior at the
existing seams — no parallel code path.

### Discovery: `AspireScanner`

New `discovery.AspireScanner(getenv)` produces `[]ScanResult` from the
`DEVDASHBOARD_APP_*` contract, with `Source: SourceAspire` (new constant). In aspire
mode `runServe` builds the discovery service from **only** this scanner — no
`StandaloneScanner`, no compose source, no `containerruntime.Detect()`.
With mode unset, the scanner joins the existing standalone+compose merge
when the contract is present, and is skipped when it is absent. On a key
collision (an Aspire-launched daprd also found by the standalone host scan),
the merge dedups by `Key()` and the aspire entry wins, since it carries
`DaprHTTPBaseURL`.

The scanner itself is static (env read once, validated at startup); the
existing discovery poll loop still re-probes health and metadata every cycle,
so app status stays live.

### Base-URL threading (three call sites)

`ScanResult`/`Instance` gain one field: `DaprHTTPBaseURL string`. When set it
replaces the hardcoded `http://127.0.0.1:<port>` in:

1. `discovery.CheckHealth` (`pkg/discovery/health.go`)
2. `discovery.FetchMetadata` (`pkg/discovery/metadata.go`)
3. `workflow.Remover.post` (`pkg/workflow/remove.go`) — terminate/purge go
   through daprd HTTP; `RemoveTarget` gains the same field, populated from
   the app inventory. (`forceDelete` already uses the state store; no change.)

Empty field ⇒ existing `127.0.0.1:<port>` behavior, so host-scanned apps
are untouched.

### Middleware: Host guard and CSRF

`localhostGuard` (`pkg/server/middleware.go`) currently enforces (a) loopback
`Host` header (anti-DNS-rebinding) and (b) loopback `Origin` on mutating
requests (anti-CSRF). In aspire mode the browser reaches the dashboard
through Aspire's proxy on an arbitrary host, so:

- The loopback **Host** check is bypassed (the container is addressed by
  Docker-network name / published port; rebinding protection is meaningless
  for a non-loopback server).
- The mutating-request rule becomes **same-origin**: when an `Origin` header
  is present, its host must equal the request `Host`. CSRF protection stays;
  the loopback assumption goes.

When `DEVDASHBOARD_ALLOWED_HOSTS` is set, the dropped loopback `Host` check is
replaced by an allowlist — the `Host` header must be a loopback name or one of
the listed hostnames (case-insensitive, port ignored), closing the DNS-rebinding
hole a published localhost port would otherwise leave open. The same-origin rule
is normalized: hostnames compare case-insensitively and ports compare by
effective value (explicit port, else 443 for https / 80 for http on the Origin,
else the listen port for a portless `Host`).

All non-aspire modes keep both checks exactly as today.

### UI capability gating

`serveIndex` (`pkg/server/spa.go`) already injects
`window.__DASH_TELEMETRY_ENABLED__` into `index.html`. Extend the same
injection with:

```js
window.__DASH_CAPABILITIES__ = {lifecycle: bool, controlPlane: bool, logs: bool, workflows: bool}
```

Mode unset: all true (workflows true as today — the page handles a missing
store gracefully). Aspire mode: `lifecycle`, `controlPlane`, `logs` false;
`workflows` true iff `DEVDASHBOARD_STATESTORE_FILE` is set. The React app reads the
flags through a small typed accessor (like the telemetry flag today) and
hides navigation entries and controls for disabled capabilities — no dead
buttons. Server-side, the corresponding routes are not registered, so the
capability flags are advisory UX, not the security boundary.

### Resources page

`cmd/derivePaths` builds scan roots from `$HOME/.dapr` and per-app
`ResourcePaths` (from daprd argv) — both empty in a container. In aspire mode
seed the resource scan paths with `DEVDASHBOARD_RESOURCES_PATH` (default: the
directory containing `DEVDASHBOARD_STATESTORE_FILE`), so the page truthfully shows
the mounted component YAMLs.

### Workflow store

Reuses the existing `--statestore` explicit-component path end to end
(YAML parsing, store clients, graceful-degradation banner). The component's
connection string must be written from the container's perspective (Docker
network host names) — that is the integration's responsibility and is
documented in the contract.

## Container image and publishing

Multi-stage `Dockerfile` at the repo root:

1. `node` stage: `npm ci && npm run build` in `web/` → `web/dist`.
2. `golang` stage: `CGO_ENABLED=0 go build` with the same ldflags as
   goreleaser (version/commit/date build args).
3. Final stage: `gcr.io/distroless/static` with just the binary.
   `ENTRYPOINT ["/dev-dashboard"]`, `ENV DEVDASHBOARD_MODE=aspire`, `EXPOSE 8080`.

Distroless works because aspire mode never shells out (no docker/podman, no
browser opener) and the binary is pure-Go static (modernc sqlite, CGO off).

Publishing: goreleaser `dockers` + `docker_manifests` blocks build
linux/amd64 + linux/arm64 images on the existing tag-driven release, pushed
to **`ghcr.io/diagridio/dev-dashboard`** with `:X.Y.Z` (goreleaser strips the
tag's `v` prefix) and `:latest` tags — image and binary versions stay in
lockstep. (The prototype integration's
`ghcr.io/diagridio/diagrid-dashboard` name is superseded; it repoints when
rewritten.)

CI: build the Dockerfile (without pushing) in the PR workflow so image
breakage is caught before release.

## Error handling summary

| Condition | Behavior |
|---|---|
| aspire mode, contract env missing/malformed | exit non-zero at startup, error names the variable |
| mode unset, contract env absent | Aspire source skipped; full host scan proceeds |
| mode unset, contract env present but malformed | exit non-zero at startup, error names the variable |
| unknown `--mode` / `DEVDASHBOARD_MODE` value | exit non-zero at startup listing supported values |
| `DEVDASHBOARD_APP_COUNT=0` | valid; dashboard serves with an empty app list |
| daprd endpoint unreachable at runtime | app shown unhealthy/unreachable (existing `SidecarReachable`/health semantics); retried each poll |
| `DEVDASHBOARD_STATESTORE_FILE` unset | workflows capability off; UI hides workflow pages |
| state-store file unreadable / store unreachable | existing graceful-degradation banner (PR #39 behavior) |
| workflow terminate/purge fails | existing per-instance error results, unchanged |

## Testing

Unit (table-driven, `-tags unit`, matching repo conventions):

- `AspireScanner` env parsing: happy path, count `0`, missing/non-numeric
  count, missing per-app ID/URL, bad URL, namespace/label defaulting.
- Mode resolution: unset ⇒ full scan (all sources, aspire source iff
  contract present), `aspire` ⇒ aspire-only, unknown value ⇒ startup error.
- Base-URL selection in `CheckHealth`, `FetchMetadata`, and
  `workflow.Remover` (base URL set vs. empty fallback) against `httptest`
  servers.
- Middleware: aspire mode admits non-loopback `Host`; same-origin rule
  accepts matching, rejects mismatched `Origin`; unset mode unchanged.
- Capability JSON injection per mode.

Integration (`-tags integration`):

- `runServe` in aspire mode with stub daprd endpoints: binds `0.0.0.0:8080`,
  apps listed from env, lifecycle/control-plane/logs routes absent (404),
  workflow routes present iff store configured.

Manual/e2e (post-implementation): `docker build` + `docker run` with
hand-written contract env against a locally running daprd, then a real
AppHost run via the rewritten integration.

## Risks and assumptions

- **Sidecar reachability is the integration's job.** The contract only
  requires that each `DEVDASHBOARD_APP_<i>_DAPR_HTTP` URL be reachable from the
  dashboard container. Whether Aspire's Dapr integration exposes sidecar
  endpoints as referenceable resources (and how container→host rewriting
  behaves for executable-hosted sidecars) must be validated by an early
  end-to-end spike on the integration side. If a sidecar is genuinely
  unreachable from containers, that app degrades to "unreachable" — the
  dashboard stays honest.
- **State-store connection perspective**: the mounted component YAML must
  use container-perspective host names; wrong-perspective strings surface
  via the existing store-error banner, not a crash.
- **Contract stability**: the env contract is versioned implicitly by image
  tag; the integration pins a minimum dashboard version. Breaking contract
  changes require a coordinated release. Keep the contract additive where
  possible.
