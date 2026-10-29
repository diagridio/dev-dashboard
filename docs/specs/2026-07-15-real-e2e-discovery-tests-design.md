# Real end-to-end discovery tests — Compose, TestContainers, Aspire

**Date:** 2026-07-15
**Status:** Design approved, ready for planning

## Problem

The dashboard discovers Dapr apps across four runtimes: `dapr run`, docker
compose, TestContainers, and Aspire. Only `dapr run` has a genuine end-to-end
test (`test/e2e/workflow_e2e_test.go`), which spawns the real runtime and reads
state back through the real packages. The other three are covered only by:

- **Unit tests** — scanners against canned `ps`/`inspect` payloads and fakes.
- **Integration tests** — server wiring against *fakes* (compose fake runner,
  aspire stub daprd) or real containers at the *store-contract* layer
  (`store_integration_test.go`), which is orthogonal to the discovery path.

No test stands up a real compose project, a real TestContainers session, or a
real Aspire AppHost and verifies that the dashboard **discovers** what runs
inside it. This design adds one real e2e test per mode, each asserting the three
discovery dimensions the product surfaces:

| Dimension  | HTTP endpoint        | Source of truth per mode |
|------------|----------------------|--------------------------|
| Apps       | `GET /api/apps/`     | container/env scan       |
| Workflows  | `GET /api/workflows/`| elected state store      |
| Components | `GET /api/resources/`| mounted / extracted / env-pathed resource dir |

## Goals

- One real e2e test per mode (compose, testcontainers, aspire), each asserting
  apps + workflows + components discovery over the real dashboard HTTP API.
- Each test exercises the *distinguishing* discovery path for its mode:
  - **compose** → host→container Redis address translation.
  - **testcontainers** → component YAML tar-extracted from the running container.
  - **aspire** → `DEVDASHBOARD_APP_*` / `DEVDASHBOARD_RESOURCES_PATH` env contract.
- Tests boot the **real built binary** as a subprocess in the correct `--mode`,
  not `assembleOptions` in-process — so mode resolution, env parsing, the
  reconciler loop, and the HTTP server are all exercised for real.
- Runnable manually via a new `workflow_dispatch` GitHub Actions workflow that
  installs the heavy toolchains (Docker, .NET + Aspire workload); skip-if-missing
  when run locally.

## Non-goals

- Running these on every push. They are manual (`workflow_dispatch`) only. The
  existing `unit` + `integration` CI tiers stay as the per-push gate.
- Replacing the existing integration tests. The in-process `assembleOptions`
  pattern (`serve_integration_test.go`) remains the faster tier.
- Testing the planned gRPC `DashboardService` Aspire discovery path
  (`pkg/aspire`), which is not yet implemented. The Aspire fixture is designed to
  be reusable for it later (see Aspire section).

## Decisions (from brainstorming)

- **Run target:** new manually-triggered e2e GitHub Actions workflow; `//go:build
  e2e`; skip-if-missing locally.
- **Assertion altitude:** full dashboard HTTP API.
- **Fixtures:** per-mode, purpose-built.
- **Aspire fixture:** .NET AppHost + a native .NET Dapr workflow app.
- **State store:** Redis (containerized) across all fixtures — idiomatic and it
  exercises the compose/aspire host→container translation path.

## Architecture

### Shared harness — `test/e2e/harness.go`

A single helper file used by all three tests:

```go
// bootDashboard builds/locates the real dashboard binary, starts it in the
// given mode against a live runtime, waits for /api/health, and returns the
// base URL. Registers cleanup that kills the process.
func bootDashboard(t *testing.T, mode string, env []string, args ...string) string

// getJSON hits an /api endpoint and returns the decoded body + HTTP status.
func getJSON[T any](t *testing.T, baseURL, path string) (T, int)

// waitFor polls cond until it returns true or the deadline elapses, failing
// the test on timeout. Used to wait for discovery to converge (apps healthy,
// workflow instance visible).
func waitFor(t *testing.T, d time.Duration, cond func() bool)

// Skip guards.
func requireDocker(t *testing.T)
func requireDotnet(t *testing.T)
func requireDapr(t *testing.T)
```

`bootDashboard` uses the binary at `bin/diagrid-dev-dashboard` (built by the CI
workflow via `make build`; locally the test skips if it is absent, or builds it
once). The binary is the product surface — booting it as a subprocess is what
distinguishes these from the in-process integration tests.

### Fixtures layout

```
test/e2e/
  harness.go
  compose_e2e_test.go
  testcontainers_e2e_test.go
  aspire_e2e_test.go
  wfapp/                      # existing Go Dapr workflow app (reused by compose + tc)
  fixtures/
    compose/
      docker-compose.yaml
      Dockerfile.wfapp
      components/statestore.yaml
    testcontainers/
      main.go                 # testcontainers-go session program
      components/statestore.yaml
    aspire/
      AppHost/                # .NET Aspire AppHost
      OrderService/           # native .NET Dapr workflow app
```

## Mode 1 — Compose (`compose_e2e_test.go`)

**Fixture** (`fixtures/compose/`): a real `docker-compose.yaml` with three
services:

- `redis:7`
- `wfapp` — the existing Go `test/e2e/wfapp` built via `Dockerfile.wfapp`.
- `daprd` sidecar — runs with `-resources-path /components`, bind-mounts
  `./components/`. `components/statestore.yaml` is `state.redis` with
  `redisHost: redis:6379` and `actorStateStore: "true"`.

**Flow:**

1. `requireDocker`. `docker compose up -d --build`. `t.Cleanup` runs
   `docker compose down -v`.
2. wfapp schedules one workflow instance against the Redis store and completes
   (prints its marker line). The test can `waitFor` the marker in compose logs.
3. `bootDashboard(t, "compose", ...)` on the host; the real compose runner scans
   the running containers.
4. Assert over HTTP:
   - **Apps** — `/api/apps/` contains `"appId":"wfapp"`, `"source":"compose"`,
     `"health":"healthy"`.
   - **Components** — `/api/resources/` contains the `statestore` component read
     from the mounted `/components` dir.
   - **Workflows** — `/api/workflows/` returns the completed instance. This
     proves **host→container Redis address translation** (`redis:6379` →
     `localhost:<publishedPort>`) — the path only real compose exercises.

## Mode 2 — TestContainers (`testcontainers_e2e_test.go`)

**Fixture** (`fixtures/testcontainers/main.go`): a Go program using
`testcontainers-go` that, in one session, starts a `redis:7` container and a
`daprd` container running the wfapp, with `components/statestore.yaml` **copied
into** the daprd container (not bind-mounted) — because tar-extraction is the
code path TestContainers discovery uses (`ExtraResources` → `tcExtraResources`).
The program schedules a workflow, then blocks so the containers stay up for the
dashboard to scan; it terminates its containers on SIGINT/SIGTERM.

**Flow:**

1. `requireDocker`. Launch the fixture session as a subprocess; `t.Cleanup`
   signals it to terminate.
2. `bootDashboard(t, "test-containers", ...)`.
3. Assert over HTTP:
   - **Apps** — `/api/apps/` contains the daprd sidecar with
     `"source":"testcontainers"`, grouped by `TestcontainersSession`.
   - **Components** — `/api/resources/` contains the `statestore` component
     **tar-extracted** from the running container (the distinguishing assertion
     vs compose).
   - **Workflows** — `/api/workflows/` returns the instance via the
     sidecar-gRPC / store read path.

## Mode 3 — Aspire (`aspire_e2e_test.go`)

**Fixture** (`fixtures/aspire/`): a minimal .NET Aspire **AppHost** plus a native
.NET Dapr workflow app (`OrderService`). The AppHost wires:

- a Redis resource,
- `OrderService` with a Dapr sidecar
  (`CommunityToolkit.Aspire.Hosting.Dapr`),
- the dashboard binary as an executable resource started in `--mode aspire`.

Aspire injects the `DEVDASHBOARD_APP_*` env contract and
`DEVDASHBOARD_RESOURCES_PATH` into the dashboard process. `OrderService`
schedules a workflow on startup against the Aspire-managed Redis.

**Flow:**

1. `requireDotnet` + `requireDocker`. `dotnet run --project AppHost`; `t.Cleanup`
   tears it down.
2. `waitFor` the dashboard resource to report healthy. The dashboard listens on
   a port pinned in the AppHost (so the test knows where to connect).
3. Assert over HTTP:
   - **Apps** — `/api/apps/` contains `OrderService`, `"source":"aspire"`,
     enriched from its real daprd metadata; a non-loopback `Host` header is
     accepted (aspire mode relaxes the loopback guard).
   - **Components** — `/api/resources/` contains the store component from
     `DEVDASHBOARD_RESOURCES_PATH`.
   - **Workflows** — `/api/workflows/` returns the instance from the
     Aspire-managed Redis.
   - **Negative** — `/api/controlplane/` and `/api/apps/{id}/logs` return 404
     (gated off in aspire mode).

**Forward compatibility:** this targets the current env-contract discovery path.
When the planned gRPC `DashboardService` discovery (`pkg/aspire`) lands, the same
fixture gains an assertion that apps/logs resolve via the live DashboardService
instead of the env contract — no new fixture needed.

## CI workflow — `.github/workflows/e2e.yaml`

`workflow_dispatch`-triggered, with a `mode` input (`compose` | `testcontainers`
| `aspire` | `all`) driving a matrix. Steps:

1. checkout
2. `setup-go`
3. `setup-dotnet` + `dotnet workload install aspire` (aspire matrix leg only)
4. `make build` (web + binary)
5. `dapr init --slim` (provides daprd images/binaries for compose + tc legs)
6. `go test -tags e2e -run <mode> ./test/e2e/...`

Docker is available on `ubuntu-latest`. Local runs skip legs whose toolchain is
absent via the `require*` guards.

## Coverage matrix

Every mode asserts all three dimensions; each row's **bold** cell is the path
unique to that mode.

| Mode           | Apps                    | Workflows                      | Components                       |
|----------------|-------------------------|--------------------------------|----------------------------------|
| compose        | source=compose          | **host→container translation** | mounted `-resources-path`        |
| testcontainers | source=testcontainers   | sidecar-gRPC / store read      | **tar-extracted from container** |
| aspire         | source=aspire           | Aspire-managed Redis           | **`DEVDASHBOARD_RESOURCES_PATH`**|

## Risks / open questions

- **Flakiness / timing** — discovery is a polling reconciler; assertions must use
  `waitFor` with generous deadlines, not fixed sleeps.
- **Aspire port** — the dashboard's port under Aspire must be pinned in the
  AppHost so the test can connect deterministically.
- **daprd availability** — compose/tc fixtures need daprd images; CI provides
  them via `dapr init --slim`. Locally this is a skip condition.
- **Build cost** — building `wfapp` into an image per run is slow; acceptable for
  a manual workflow, and cacheable in CI.
