# Control Plane page — design

**Date:** 2026-07-02
**Status:** Draft for review

## Summary

Add a new **Control Plane** page to the dev-dashboard that surfaces the Dapr
control-plane services running locally, and lets the user start / restart / stop
them. This is the first sanctioned **lifecycle mutation** in a product that has
until now been a strictly read-only observer — the exception is deliberate and
scoped (see §5).

The page targets **self-hosted (local) mode**, where the control plane runs as
containers created by `dapr init`. It works with both **Docker and Podman** via
a container-runtime abstraction. Kubernetes-only services (sentry, injector) are
shown as placeholders; real Kubernetes support is deferred to a later spec.

## Goals

- List the local control-plane services with, per service: health indicator,
  container status, ports, memory usage, and log path.
- Provide start / restart / stop actions, scoped safely to the known services.
- Deep-link to the existing Logs page for actual log viewing.
- Work with both Docker and Podman.

## Non-goals (this spec)

- Kubernetes cluster introspection (real sentry / injector data). Placeholder
  only.
- Slim-mode (`dapr init --slim`) process detection, where placement/scheduler run
  as host processes without a container runtime. Deferred.
- Controlling `dapr_redis` / `dapr_zipkin` or any container outside the
  allowlisted control-plane set.
- In-page log streaming — logs remain on the Logs page.

## 1. Scope & platform behavior

| Service          | Self-hosted (this spec)              | Kubernetes        |
| ---------------- | ------------------------------------ | ----------------- |
| `dapr_scheduler` | ✅ container                          | placeholder       |
| `dapr_placement` | ✅ container                          | placeholder       |
| `dapr_sentry`    | k8s-only → disabled placeholder card | (later spec)      |
| `dapr_injector`  | k8s-only → disabled placeholder card | (later spec)      |

In self-hosted mode the page shows scheduler + placement as live cards; sentry +
injector render as **"Kubernetes only"** placeholder cards (greyed, no data, no
actions).

**Unavailable states** (each a distinct, clearly-worded empty state, not an
error):

- No container runtime found on PATH → "No container runtime (Docker/Podman)
  detected."
- Runtime found but not responsive (daemon down) → "Docker/Podman is installed
  but not running."
- Runtime healthy but no `dapr_*` control-plane containers exist → "No Dapr
  control plane found — run `dapr init`."

## 2. Container-runtime abstraction (Docker **and** Podman)

Because the backend **shells out to the runtime CLI** (matching the existing
pattern where the code shells out to `lsof` and the Dapr CLI), Podman support is
nearly free: Podman's CLI is command-compatible with Docker for the verbs we
need (`ps`, `inspect`, `stats`, `start`, `stop`, `restart`), and
`dapr init --container-runtime podman` creates the **same** container names.

> Note: the Docker Go SDK was rejected precisely because it talks to the Docker
> daemon socket; Podman is daemonless and would not work through it without extra
> socket handling. The CLI shell-out keeps both runtimes on one code path.

Runtime resolution (once, lazily, cached):

1. If `DASH_CONTAINER_RUNTIME` is set (`docker` | `podman`), honor it.
2. Otherwise probe PATH: prefer `docker` if present and responsive, else
   `podman`.
3. If neither resolves, the list endpoint returns the "runtime unavailable"
   state.

All subprocess calls go through the resolved runtime name — `docker ps …` simply
becomes `<runtime> ps …`. Output parsers are shared and unchanged across
runtimes.

## 3. Backend — new `pkg/controlplane` domain package

Follows the architectural rule (logic in `pkg/*`, HTTP wiring in `pkg/server`,
no `cmd/` imports).

- **`pkg/controlplane/service.go`** — `List()` returns `[]Service`. Each
  `Service`:
  - `Name` (e.g. `dapr_scheduler`)
  - `Healthy` (bool)
  - `Status` (running / exited / created / …)
  - `Ports` (published port mappings)
  - `MemoryBytes` (uint64) + `MemoryHuman` (string)
  - `LogPath` (string, best-effort — see below)
  - `Platform` marker distinguishing live vs k8s-only placeholder
- **`pkg/controlplane/runtime.go`** — runtime resolution (§2) + thin wrappers
  around the subprocess calls and their output parsing. Runtime-neutral naming
  (`Runtime`, not `Docker`), since it serves both Docker and Podman. Parsers are
  isolated so they unit-test against captured fixture output (like the existing
  `parseLsofStdout` tests).
- **`pkg/controlplane/lifecycle.go`** — `Start(name)`, `Stop(name)`,
  `Restart(name)` → `<runtime> start|stop|restart <name>`, restricted to a
  hardcoded **allowlist** of the known `dapr_*` control-plane container names so
  the endpoint can never control arbitrary containers.
- **`pkg/server/controlplane.go`** — routes:
  - `GET /api/controlplane` → list
  - `POST /api/controlplane/{name}/{action}`, `action ∈ {start, stop, restart}`,
    both `name` and `action` validated against the allowlist before execution.

**Health:** container running AND, where cheaply available, the runtime's
healthcheck status (`inspect` `.State.Health.Status`); otherwise the
running-state is the health signal.

**Data collection:**

- `<runtime> ps` (filtered to the control-plane names) for existence + status +
  ports.
- `<runtime> inspect` for detailed status, health, ports, and `LogPath`.
- `<runtime> stats --no-stream` for current memory usage.

**Log path (best-effort):** `<runtime> inspect --format '{{.LogPath}}'` returns a
real file path under Docker. **Podman's `LogPath` can be empty** (e.g. with the
`journald` driver). So `LogPath` is best-effort: surface it when present;
otherwise show a "logs via journald / not a file" note rather than a broken
link.

## 4. Lifecycle operations & the read-only exception

This is the deliberate departure from the read-only contract. Containment:

- Actions are **allowlisted** to the four known control-plane container names —
  no arbitrary container control.
- Each action button shows the resolved runtime command and requires
  **confirmation** before executing.
- After an action, the card **refetches** status so the UI reflects reality, not
  an optimistic guess.
- The spec documents this as the first sanctioned lifecycle mutation, and
  **AGENTS.md's read-only note is updated** to carve out this exception (control
  plane start/stop/restart) alongside the existing carve-outs (workflow
  terminate/purge, connection registry).

**Button logic per service:**

- **Start** — shown only when the service is stopped/exited.
- **Restart** and **Stop** — shown only when the service is running.
- Placeholder (k8s-only) cards show no action buttons.

## 5. Frontend — `web/src/pages/ControlPlane.tsx`

- New route `control-plane` in `router.tsx` + a nav entry alongside the existing
  pages.
- One **card per service**, composing the existing class vocabulary and design
  tokens (per `web/STYLEGUIDE.md` — no hardcoded colors, reuse primitives). Each
  live card shows:
  - service name
  - health indicator (reuse the existing healthy/unhealthy dot pattern from the
    apps pages)
  - status badge
  - ports
  - memory usage
  - **"View logs"** link deep-linking to the Logs page for that service
  - action buttons per the button logic above
- Placeholder cards render greyed with a "Kubernetes only" label and no actions.
- The page **polls** `GET /api/controlplane` on an interval (matching how other
  live pages refresh) so status and memory stay current.

## 6. Testing

- **Go unit** (`-tags unit`):
  - runtime output parsers (`ps` / `inspect` / `stats`) against captured fixture
    strings, golden-style.
  - runtime resolution: env override, PATH preference (docker before podman),
    neither-present fallback.
  - lifecycle allowlist rejects unknown names; action-name validation rejects
    unknown actions.
  - best-effort `LogPath` (present vs empty/Podman-journald).
- **Server**: route tests (`GET` list, `POST` action) with a faked service
  layer — no real runtime.
- **Web** (vitest): card rendering for running / stopped / k8s-placeholder /
  unavailable states; action buttons appear per state; confirmation flow;
  refetch-after-action.
- No real Docker/Podman in unit tests — the subprocess boundary is
  injected/mocked.

## Open questions / future work

- **Kubernetes support** (real sentry / injector, plus scheduler/placement as
  pods) — separate spec; needs a cluster client and auth handling.
- **Slim mode** — placement/scheduler as host processes; needs process detection
  and a different (or absent) stop/restart story.
- **`dapr_redis` / `dapr_zipkin`** — could later be surfaced read-only, but are
  out of scope here.
