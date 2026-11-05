# Enterprise diagnostics demo

Three small Dapr apps that, run together, put fixed data on every dev-dashboard page. The
theme is a diagnostics system for the starship Enterprise. It's a local tool for manual
testing and for capturing screenshots. It isn't part of the dashboard binary or of `make test`.

The apps seed a fixed scenario on startup and then go idle, so the dashboard shows the same
rows every time. `make demo-reset` puts that scenario back.

## Prerequisites

| Tool | Version |
|---|---|
| Dapr CLI and runtime | 1.19.x, initialised with `dapr init` (Redis, placement, scheduler containers) |
| Docker (or Podman) | any version `dapr init` supports |
| Go | 1.26.10 or later (`engineering`, and building the dashboard) |
| .NET SDK | 10.0 (`bridge` targets `net10.0`) |
| Python + uv | Python 3.11 or later, [`uv`](https://docs.astral.sh/uv/) (`sickbay`) |
| Node.js | 20, only to build the dashboard (`make build`) |

## 1. Clean up first

The demo assumes a clean local Dapr environment. It uses the default `dapr init` Redis with no
key prefix or separate database, so data from other apps also shows up on the dashboard.

1. Stop every other Dapr app (`dapr list` should print `No Dapr instances found.`).
2. Flush the `dapr init` Redis. **This deletes all data in it, not just the demo's:**

   ```sh
   docker exec dapr_redis redis-cli FLUSHALL
   ```

The demo's fixed ports must be free: apps 6001-6003, Dapr HTTP 3501-3503, Dapr gRPC
50001-50003, and the dashboard on 9090.

## 2. Run it (two terminals)

Terminal 1, from the repo root, starts all three apps with `dapr run -f`:

```sh
make demo
```

Wait until each app logs that it's seeded (`demo seeded`, `Bridge demo seeded`, and sickbay's
`starfleet-command fleet-status` line). Ctrl-C stops all three apps. If the terminal is gone,
run `cd demo && dapr stop -f .` instead.

Terminal 2, from the repo root, builds and starts the dashboard:

```sh
make build
DEVDASHBOARD_TELEMETRY_OPTOUT=true ./bin/diagrid-dev-dashboard --mode dapr-run
```

The dashboard opens at <http://localhost:9090>.

## 3. What each app shows

| App | Language | Dapr features | Dashboard pages |
|---|---|---|---|
| `engineering` | Go (go-sdk 1.16) | Workflows: `DiagnosticSweep` parents with `SubsystemCheck` children, activities, an external event, a 1.19 data reference (large payload in `binarystore.in-memory`); service-invocation target; cron input binding | Workflows, Workflow detail, Apps, App detail, Logs |
| `bridge` | .NET (`Dapr.*` 1.19.0) | Actors `SubsystemActor` and `DeckActor` with reminders; pub/sub publish; service invocation to `engineering` and `sickbay`; secret store read | Actors, Apps, App detail, Logs |
| `sickbay` | Python (`dapr[workflow,fastapi]` 1.19.0) | Declarative (`red-alert-sub`) and programmatic (`diagnostics.results`) subscriptions; state store writes; a small `CrewHealthScan` workflow; a call through the `starfleet-command` HTTPEndpoint | Subscriptions, State, HTTP Endpoints, Workflows, Apps, Logs |
| shared (`resources/`) | — | Redis state store (actor store) and pub/sub, cron binding, local-file secret store, `binarystore.in-memory`, Configuration `diagnostics`, Resiliency `ship-systems`, HTTPEndpoint `starfleet-command` with a secret-backed header | Components, Configurations, Resiliency, HTTP Endpoints, Control Plane |

The seeded scenario:

- **Workflows:** `sweep-001`, `-003`, `-004` and `-006` completed; `sweep-002` failed
  ("plasma conduit rupture in deck 7"); `sweep-005` running, waiting for an event that never
  arrives; `sweep-006` has a data-reference payload. Each sweep has four children, such as
  `sweep-001-shields`. In `sickbay`, `medscan-001` completed.
- **Actors:** `SubsystemActor` warp-core, shields, deflector, life-support (each with a 24 h
  `diagnostic-heartbeat` reminder), and `DeckActor` deck-01, deck-07, deck-12.
- **State:** `crewlog-0001` to `crewlog-0006`, `alert-RA-0001` to `alert-RA-0004` (delivered
  through `red-alert`), and `result-DR-0001` (delivered through `diagnostics.results`).

Runtime details such as PIDs, uptime, timestamps and log lines vary between runs. The seeded
content doesn't.

The Components and Configurations pages also list the `dapr init` defaults in
`~/.dapr/components` and `~/.dapr/config.yaml`, next to the demo's own resources.

## 4. Reset

With the demo running:

```sh
make demo-reset
```

This asks each app to delete its demo data and seed it again, then waits (up to 120 s) until
all three report seeded. It exits non-zero and names the app if one doesn't finish in time.
It only touches the demo's own workflow instances, actors and state keys.

Each app has the same control endpoints on its app port, if you want to drive them directly:

- `GET /demo/status` returns `{"seeded": true|false}`, plus `"error"` while a seed is failing.
- `POST /demo/reset` returns `202` and resets in the background. A reset sent while another one
  is running is ignored.
