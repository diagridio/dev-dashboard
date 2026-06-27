# dev-dashboard

A local-first, single-binary CLI that gives Dapr developers a live, dense, minimal-chrome
view of everything Dapr running on their machine.

## Goal

The Dapr Dev Dashboard is a **passive observer** for local Dapr development. It inspects the
apps you start with `dapr run` / `dapr run -f` and surfaces everything about them — sidecars,
workflows, actors, subscriptions, components, configurations, and logs — in one dense,
minimal UI.

Design goals:

- **Zero-config for the common case** — point it at your machine and it discovers running apps.
- **Single self-contained binary** — no runtime dependencies (the React frontend is embedded
  via `go:embed`; there is no Node.js at runtime).
- **Read-only, except for workflow purge** — it never starts or stops your apps in v1.
- **Degrade gracefully** — keep working when a sidecar or state store is unavailable.
- **Minimal, high-density UI** with light and dark themes, optimized for desktop widths.

It is distributed as a standalone CLI today, but is architected so its functionality can
later be folded into the Diagrid CLI (Go).

## Use cases

Developers use the dashboard to observe and debug Dapr apps while building locally:

- **See what's running** — a live table of all running apps/sidecars: app id, health,
  runtime/language, app/HTTP/gRPC ports, daprd + app PIDs, age, and owning run-template.
- **Inspect an application** — drill into a single app for its ports, PIDs, command,
  resource/config paths, runtime metadata, enabled features, and loaded components.
- **Debug workflows** — browse workflow executions across all apps with status filters and
  search, then open a run to watch its **live event history**, input/output, custom status,
  and a continuously-ticking wall-clock while it runs.
- **Clean up workflows** — terminate and/or purge individual or bulk workflows, with an
  explicit "force delete" fallback for stuck/orphaned state.
- **Review actors & subscriptions** — global pages aggregating active actor types and pub/sub
  subscriptions across all apps, each linkable back to the owning application.
- **Read components & configurations** — read-only YAML viewers, enriched with which apps
  loaded each component.
- **Tail logs** — per-app daprd + app logs streamed live (SSE) with level coloring, keyword
  highlight, and a follow toggle.

The UI is built for fast scanning and debugging: deep-linkable views, a global autorefresh
control, keyboard shortcuts, and cross-navigation between related entities (app → component →
"loaded by" app, etc.).

## User instructions (download, install, run)

The dashboard ships as a standalone binary published on GitHub Releases via GoReleaser.
macOS and Linux ship amd64 + arm64; Windows ships amd64 only (Windows on ARM runs the x64
build via built-in emulation — `install.ps1` handles this automatically).

**Install (one-liner):**

```sh
# macOS / Linux — installs to ~/.local/bin
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | sh

# Windows (PowerShell) — installs to %LOCALAPPDATA%\Programs\dev-dashboard
iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
```

To pin a specific version, set `VERSION` before piping:

```sh
# sh
curl -sSL https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.sh | VERSION=vX.Y.Z sh

# PowerShell
$env:VERSION='vX.Y.Z'; iwr -useb https://raw.githubusercontent.com/diagridio/dev-dashboard/main/scripts/install.ps1 | iex
```

If the install directory is not on your `PATH`, the script prints the export line to add.

**Install with Go (≥ 1.26):**

```sh
go install github.com/diagridio/dev-dashboard@latest
```

> **Note:** tagged versions (`@vX.Y.Z`) embed the prebuilt UI, so `go install` ships the
> full dashboard. `@latest` may resolve to `main`, which carries only a placeholder UI —
> prefer a tagged version for a working install.

**Manual download:**

Download the archive for your platform from the [GitHub Releases](https://github.com/diagridio/dev-dashboard/releases) page, extract it, and place `dev-dashboard` (or `dev-dashboard.exe`) on your `PATH`. Verify with:

```sh
dev-dashboard --version
```

> Homebrew / Scoop / winget packaging is planned but not part of v1.

**Run:**

```sh
# Start on the default port (9090) and open your browser automatically
dev-dashboard

# Start without opening the browser
dev-dashboard --no-open

# Start on a custom port
dev-dashboard --port 8080
```

This starts the HTTP server, serves the dashboard at `http://localhost:9090`, and opens your
browser automatically.

No additional setup is needed: the dashboard discovers running Dapr apps the same way
`dapr list` does, so anything started with `dapr run` / `dapr run -f` shows up within one
refresh cycle.

### Mounting under a sub-path

The SPA bakes its asset base URL at build time from the `DASH_BASE_PATH` environment
variable. Released binaries are built for root-mount (`/`).

To run the dashboard under a sub-path, build from source:

```sh
DASH_BASE_PATH=/dashboard/ make build
./bin/dev-dashboard --base-path /dashboard
```

`DASH_BASE_PATH` (used at Vite build time) must equal the `--base-path` flag value, and
both must end with a trailing slash.

## Architecture

The dashboard is a **single Go binary** that embeds a React SPA and talks to your local Dapr
sidecars and state store.

```
┌─────────────────────────────────────────────────────┐
│  dev-dashboard (single Go binary)                     │
│                                                       │
│  cmd/           cobra root, flags, default `serve`    │
│  pkg/server     chi router + go:embed SPA             │
│  pkg/discovery  standalone.List() + /v1.0/metadata    │
│  pkg/workflow   list / history / purge                │
│  pkg/statestore client (redis / postgres / sqlite)    │
│  pkg/resources  component + configuration YAML loader │
│  pkg/logs       file tail → SSE                        │
│  web/           React + Vite SPA → dist/ (embedded)   │
└─────────────────────────────────────────────────────┘
        │ HTTP /v1.0/metadata, /healthz       │ files / TCP
        ▼                                      ▼
   running daprd sidecars        ~/.dapr, resource paths, state store backend
```

**Components**

- **Backend (Go + `chi`)** — exposes a REST + JSON API (with SSE for log/stream tails) and
  serves the embedded SPA. Each domain lives in an isolated `pkg/*` package with its own
  `service` and `api` (response-type) sub-packages; no domain package depends on `cmd/`.
- **Frontend (React + TypeScript + Vite)** — a single-page app built to static assets and
  embedded into the binary via `go:embed`. Uses **TanStack Query** for polling/caching,
  **TanStack Virtual** for large lists, headless accessible primitives styled in-house, and a
  lightweight read-only syntax highlighter (not Monaco). Client-side History-API routing; the
  Go server falls back to `index.html` for unknown paths and is base-path-aware.

**Key dependencies & data sources**

- **App discovery** reuses `github.com/dapr/cli/pkg/standalone` (the same mechanism as
  `dapr list`). A **process scan** (`go-ps` + `gopsutil`) is the source of truth for
  existence/ports/PIDs; the **`/v1.0/metadata`** call per sidecar is enrichment (runtime
  version, components, actors, subscriptions, extended metadata) and degrades gracefully when
  a sidecar is down. A background **`/v1.0/healthz`** poller drives the health badge.
- **Workflows** are read from the detected **state store backend** (Redis / PostgreSQL /
  SQLite); a client is built from the auto-detected component YAML. Purge uses the official
  Dapr workflow API when reachable, with direct state-store key deletion as an explicit force
  fallback.
- **Resources** (components + configurations) are loaded from `~/.dapr` and live
  `--resources-path` directories read from daprd args.
- **Logs** are tailed from `~/.dapr/logs/*` and the `appLogPath`/`daprdLogPath` reported in
  extended metadata, then streamed to the SPA over SSE.
- **News** (optional) — the Resources sidebar pulls the Diagrid product feed, proxied and
  cached behind the backend's own `GET /api/news` endpoint so the SPA only ever talks to its
  own origin.

**Portability** — all logic lives in `pkg/*` domain packages with no dependency on `cmd/`,
the server mounts as a `chi` sub-router, and the SPA is an embedded `fs.FS`, so the whole
thing can later be re-mounted under a `diagrid dashboard` subcommand.

For the full design, see
[`docs/superpowers/specs/2026-06-25-dev-dashboard-design.md`](docs/superpowers/specs/2026-06-25-dev-dashboard-design.md).
