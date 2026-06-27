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

# Enable diagnostic logging to stderr (server startup, app discovery, state-store connection, log streams, workflow operations)
dev-dashboard --verbose
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

## Troubleshooting

If the dashboard does not behave as expected, run it with `--verbose` to print diagnostic logs to stderr:

```sh
dev-dashboard --verbose
```

Logs are grouped by `component=` (values: `server`, `discovery`, `statestore`, `workflow`) and use levels INFO (normal milestones), WARN (degraded but still working, e.g. a state store that failed to initialise), and ERROR (an operation failed, e.g. the server could not bind its port). Without `--verbose`, no diagnostic logs are emitted.

## Building from source

**Prerequisites:** Go ≥ 1.26 and Node.js 20 (with `npm`). The binary embeds the React SPA via
`go:embed`, so the web assets (`web/dist`) must be built **before** the Go binary — `make build`
does both in the right order.

**macOS / Linux:**

```sh
make build            # builds web/dist, then the Go binary at bin/dev-dashboard
./bin/dev-dashboard
```

Equivalent manual steps (if you don't have `make`):

```sh
cd web && npm install && npm run build && cd ..
go build -o bin/dev-dashboard .
./bin/dev-dashboard
```

**Windows (PowerShell):** `make` is usually unavailable, so run the steps directly:

```powershell
cd web; npm install; npm run build; cd ..
go build -o bin/dev-dashboard.exe .
.\bin\dev-dashboard.exe
```

To build for a sub-path mount, set `DASH_BASE_PATH` before building (see
[Mounting under a sub-path](#mounting-under-a-sub-path)). On Windows that is
`$env:DASH_BASE_PATH='/dashboard/'` before the `npm run build` step.

Other useful targets: `make test` (Go + web suites), `make test-go`, `make test-web`,
`make tidy`.

### Trying it against a real workflow app

The dashboard is a **passive observer**: it discovers your app the same way `dapr list` does
and reads workflow data directly from your Dapr **state store**. You don't point it at your app —
you just run both on the same machine.

**Prerequisites:**

- `dapr init` has been run. This creates `~/.dapr/components/statestore.yaml` (a Redis store with
  `actorStateStore: "true"`) and starts Redis. That `actorStateStore` store is what Dapr
  Workflows persist to, and what the dashboard reads.
- A Dapr workflow app — e.g. the
  [Dapr Workflow quickstart](https://github.com/dapr/quickstarts/tree/master/workflows), or any
  app using the Workflow API.

**Steps:**

1. Run your workflow app with Dapr (from the app's directory):
   ```sh
   dapr run --app-id order-processor --app-port 6001 -- <your app start command>
   # or, for a multi-app project:
   dapr run -f .
   ```
2. Trigger at least one workflow instance (via the app's endpoint / the quickstart's flow). The
   dashboard only shows state that already exists — an idle store shows an empty list.
3. Start your from-source build:
   ```sh
   ./bin/dev-dashboard            # opens http://localhost:9090
   ```
4. In the UI: the **Apps** table shows your app (health, ports, PIDs); the **Workflows** page
   lists instances read from the state store — open one for its live event history, input/output,
   status, and a ticking wall-clock. You can also terminate / purge an instance (with the
   force-delete fallback).

**If the Workflows page is empty:** the dashboard auto-detects state-store components from
`~/.dapr/components` and from the live `--resources-path` of running apps, then uses the one
marked `actorStateStore: "true"` (falling back to the first detected). Check:

- If detection is ambiguous (several stores), point it explicitly:
  `./bin/dev-dashboard --statestore ~/.dapr/components/statestore.yaml`.
- Workflow keys are namespaced; the dashboard defaults to `default`. For another namespace, pass
  `--namespace <ns>`.
- Only **Redis / PostgreSQL / SQLite** state stores are supported.
- Confirm the app actually persisted a workflow (an empty store → empty list).

## Testing

There are three suites: Go **unit** tests, Go **integration** tests, and the **web**
(frontend) tests. All are self-contained — no Docker or external services required (the
integration tests run an in-process Redis via `miniredis` and a temporary SQLite database).

**Prerequisites:** Go ≥ 1.26 (Go tests) and Node.js 20 with `npm` (web tests).

**Run everything (macOS / Linux):**

```sh
make test          # Go unit tests (with -race) + web tests
```

`make test` runs `make test-go` then `make test-web`. It does **not** run the Go integration
tests — run those separately (see below).

**Go unit tests** — gated by `//go:build unit`:

```sh
make test-go                        # = go test -tags unit -race ./...
# or directly:
go test -tags unit ./...
go test -tags unit -race ./cmd/...  # one package, with the race detector
```

(`make test-go` uses `gotestsum` for nicer output if it's installed, otherwise plain `go test`.)

**Go integration tests** — gated by `//go:build integration`; they exercise the state-store and
workflow read paths against an in-process Redis (`miniredis`) and a temp SQLite DB, so no
external services are needed. They are not part of `make test`:

```sh
go test -tags integration ./...
```

**Web tests** — Vitest:

```sh
make test-web            # = cd web && npm install && npm test  (vitest run)
# or from web/:
cd web
npm install
npm test                 # single run
npm run test:watch       # watch mode
```

**Windows (PowerShell)** — `make` is usually unavailable, so run the commands directly:

```powershell
go test -tags unit -race ./...
go test -tags integration ./...
cd web; npm install; npm test; cd ..
```

> **Tip:** the Go tests are build-tag-gated, so a plain `go test ./...` (without `-tags unit`
> or `-tags integration`) reports "no test files" for most packages. Always pass the tag.

## Releasing

> For maintainers with push access. Releases are built and published by the
> [`release` GitHub Actions workflow](.github/workflows/release.yaml): pushing a `vX.Y.Z` tag
> runs [GoReleaser](https://goreleaser.com), which compiles the cross-platform archives plus
> `checksums.txt` and publishes them to a GitHub Release. The version (`dev-dashboard --version`)
> is injected from the tag via build-time ldflags.

Because `go install` cannot run `npm`, the release tag commit must embed the prebuilt
`web/dist`. `scripts/release.sh` handles this: it builds the SPA, creates a **detached** commit
that force-adds `web/dist` (past `.gitignore`), tags it, and returns you to your branch — so the
tagged commit ships the full UI for `go install` while `main` stays free of built assets.

**Cut a release (macOS / Linux, or Git Bash / WSL on Windows — `release.sh` is a POSIX `sh` script):**

1. Be on an up-to-date `main` with a clean working tree.
2. Build + tag the release:
   ```sh
   scripts/release.sh vX.Y.Z
   ```
   It builds the SPA, creates the tag on a detached commit embedding the UI, and prints the
   push command.
3. Push the tag to trigger the release workflow:
   ```sh
   git push origin vX.Y.Z
   ```
4. Wait for the `release` workflow to finish. It publishes a GitHub Release with one archive per
   platform + `checksums.txt`. After that, the install one-liners and
   `go install github.com/diagridio/dev-dashboard@vX.Y.Z` resolve to the new version.

**Validate locally before tagging (optional, requires GoReleaser v2):**

```sh
make release-check      # validate .goreleaser.yaml
make release-snapshot   # build a local snapshot into dist/ without publishing
```

> The release matrix is **5 archives**: macOS and Linux (amd64 + arm64) and Windows (amd64).
> There is no native Windows/arm64 build — Windows on ARM uses the amd64 build via emulation.

## Architecture

The dashboard is a **single Go binary** that embeds a React SPA and talks to your local Dapr
sidecars and state store.

```
┌───────────────────────────────────────────────────────┐
│  dev-dashboard (single Go binary)                     │
│                                                       │
│  cmd/           cobra root, flags, default `serve`    │
│  pkg/server     chi router + go:embed SPA             │
│  pkg/discovery  standalone.List() + /v1.0/metadata    │
│  pkg/workflow   list / history / purge                │
│  pkg/statestore client (redis / postgres / sqlite)    │
│  pkg/resources  component + configuration YAML loader │
│  pkg/logs       file tail → SSE                       │
│  web/           React + Vite SPA → dist/ (embedded)   │
└───────────────────────────────────────────────────────┘
        │ HTTP /v1.0/metadata, /healthz       │ files / TCP
        ▼                                     ▼
   running daprd sidecars        ~/.dapr, resource paths, state store backend
```

**Components**

- **Backend (Go + `chi`)** — exposes a REST + JSON API (with SSE for log/stream tails) and
  serves the embedded SPA. Each domain lives in an isolated `pkg/*` package (a `service.go`
  plus its response types); the HTTP layer lives in `pkg/server`, one file per domain. No
  domain package depends on `cmd/`.
- **Frontend (React + TypeScript + Vite)** — a single-page app built to static assets and
  embedded into the binary via `go:embed`. Uses **TanStack Query** for polling/caching,
  headless accessible primitives styled in-house, and a custom lightweight read-only YAML
  highlighter (not Monaco). Client-side History-API routing (`react-router-dom`); the Go
  server falls back to `index.html` for unknown paths and is base-path-aware. List
  virtualization is planned, not yet in v1.

**Key dependencies & data sources**

- **App discovery** reuses `github.com/dapr/cli/pkg/standalone` (the same mechanism as
  `dapr list`). `standalone.List()` reads the local process table and is the source of truth
  for existence/ports/PIDs; the **`/v1.0/metadata`** call per sidecar is enrichment (runtime
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
