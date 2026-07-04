# AGENT.md

Guidance for AI agents working in this repository. For end-user/maintainer docs, see [README.md](README.md).
For how the system fits together and where to extend it, see [ARCHITECTURE.md](ARCHITECTURE.md).

## What this is

`dev-dashboard` is a **single Go binary** that embeds a React + Vite SPA (via `go:embed`) and
acts as a passive, read-only observer for local Dapr development. There is **no Node.js at
runtime** — the frontend is compiled to `web/dist` and baked into the binary at build time.

- **Module:** `github.com/diagridio/dev-dashboard`
- **Toolchain:** Go ≥ 1.26 (`go.mod` pins 1.26.4), Node.js 20 + `npm` (build/test only).
- **Entry point:** `main.go` → `cmd/` (cobra root, default subcommand is `serve`).

## Repository layout

```
main.go            thin entry point
cmd/               cobra root + subcommands (serve, update, workflow); no domain logic.
                   Also hosts the connection registry / store-election layer (registry.go,
                   reconciler.go, derive.go, connpool.go): the connections.yaml-backed store
                   list, lazy per-store connection pool, and secretKeyRef resolution.
pkg/               domain packages — each is isolated, none import cmd/
  discovery/       standalone.List() + /v1.0/metadata + /v1.0/healthz enrichment
  workflow/        list / stats / history / terminate / purge (reads the state store)
  statestore/      redis / postgres / sqlite client + Detect + secret resolution
  controlplane/    docker/podman detection, inspect, lifecycle actions, log stream
  metadata/        embedded component-metadata catalog (drives the add/edit connection forms)
  resources/       component + configuration YAML loader
  logs/            file tail → SSE
  server/          chi router + go:embed SPA mount (one file per domain)
  news/ logging/ selfupdate/ version/
internal/golden/   golden-file test helpers
web/               React + TypeScript + Vite SPA → web/dist (embedded via web/embed.go)
                   see web/STYLEGUIDE.md for UI styling conventions
scripts/           install.sh, install.ps1, release.sh
test/              test fixtures
```

**Architectural rule:** all logic lives in `pkg/*` domain packages; nothing in `pkg/*` may
depend on `cmd/`. The server mounts as a `chi` sub-router and the SPA is an `fs.FS`, so the
whole thing can later be folded into a `diagrid dashboard` subcommand. Preserve this.

## Build

The SPA must be built **before** the Go binary (the binary embeds `web/dist`). `make build`
does both in order.

```sh
make build                    # builds web/dist, then bin/dev-dashboard
make web                      # build the SPA only (cd web && npm install && npm run build)
./bin/dev-dashboard           # run it (serves http://localhost:9090, opens browser)
./bin/dev-dashboard --no-open --verbose   # no browser, diagnostic logs to stderr
```

Manual equivalent (no `make`):

```sh
cd web && npm install && npm run build && cd ..
go build -o bin/dev-dashboard .
```

Sub-path mount: `DASH_BASE_PATH=/dashboard/ make build` then run with `--base-path /dashboard`
(the env var, used at Vite build time, must equal the flag and both must end with `/`).

## Test

Go tests are **build-tag-gated** — a plain `go test ./...` reports "no test files". You MUST
pass `-tags`.

```sh
make test                # unit (Go, -race) + web — the default gate. Does NOT run integration.
make test-go             # = go test -tags unit -race ./...   (uses gotestsum if installed)
make test-web            # = cd web && npm install && npm test   (vitest run)
make test-integration    # = go test -tags integration -race ./...   (CI runs this; make test does not)
make test-e2e            # = go test -tags e2e ./...   (needs local Dapr; skips if absent)
```

Single package / direct invocation:

```sh
go test -tags unit ./cmd/...
go test -tags integration ./pkg/workflow
cd web && npx vitest run src/path/to/file.test.tsx
```

- **unit** (`//go:build unit`) and **web** (Vitest) — self-contained, the everyday gate.
- **integration** (`//go:build integration`) — exercises state-store/workflow read paths and the
  assembled HTTP server against in-process Redis (`miniredis`) + temp SQLite; no external
  services. Runs in CI but not in `make test`.
- **e2e** (`//go:build e2e`) — drives a real `daprd`; local-only, skips when Dapr isn't installed.
- **Golden files** (`testdata/golden/*`): regenerate after an intentional shape change with
  `-update`, e.g. `go test -tags integration ./pkg/workflow -run Golden -update`.

```sh
make tidy                # go mod tidy
```

## Release

> Maintainers only. Releasing is a tagged-commit + GitHub Actions (GoReleaser) flow.

Because `go install` can't run `npm`, the tagged commit must embed a prebuilt `web/dist`.
`scripts/release.sh` builds the SPA, makes a **detached** commit force-adding `web/dist` past
`.gitignore`, tags it, and returns you to your branch — so `main` stays free of built assets.

```sh
# From a clean, up-to-date main:
scripts/release.sh vX.Y.Z     # builds SPA, tags a detached commit embedding the UI
git push origin vX.Y.Z        # triggers .github/workflows/release.yaml → GoReleaser
```

Validate locally before tagging (needs GoReleaser v2):

```sh
make release-check            # = goreleaser check  (validate .goreleaser.yaml)
make release-snapshot         # = goreleaser release --snapshot --clean --skip=publish
```

Release matrix is **5 archives**: macOS + Linux (amd64 + arm64) and Windows (amd64). No native
Windows/arm64 — it runs the amd64 build via emulation. Version string is injected from the tag
via ldflags (`dev-dashboard --version`).

## Conventions for agents

- **Always run the matching gate before claiming done:** `make test` for Go-unit/web changes,
  `make test-integration` if you touched state-store/workflow/server wiring. Don't assert a fix
  works without showing the test output.
- **Build tags are mandatory** — bare `go test ./...` silently passes by running nothing.
- **Don't commit `web/dist`** to `main`; it's gitignored and only embedded on release tags.
- **Keep `pkg/*` free of `cmd/` imports.** New domain logic goes in a `pkg/<domain>` package
  with its `service.go` + response types; HTTP wiring goes in `pkg/server` (one file per domain).
- **Follow the UI style guide for frontend work.** New pages/components compose the existing
  class vocabulary and design tokens in `web/src/styles/theme.css` — don't hardcode colors or
  reinvent primitives. See [`web/STYLEGUIDE.md`](web/STYLEGUIDE.md).
- **Read-only product surface:** the dashboard never starts/stops apps and never edits app or
  component state. The mutating operations are limited to workflow terminate/purge, managing the
  user's own saved state-store connections (the `connections.yaml` registry under
  `~/.dapr/dev-dashboard/`, written `0600`), and control-plane lifecycle actions
  (start/restart/stop of the known `dapr_*` control-plane containers via the resolved
  container runtime, allowlisted to those container names). Don't add other side-effecting
  behavior without an explicit ask.
- Commit/push only when asked; the project uses Conventional Commit prefixes (`feat:`, `refactor:`,
  `docs:`) — match the existing `git log` style.

For how the system fits together and where each extension point lives, see
[ARCHITECTURE.md](ARCHITECTURE.md). For the original design rationale, see
[`docs/superpowers/specs/2026-06-25-dev-dashboard-design.md`](docs/superpowers/specs/2026-06-25-dev-dashboard-design.md).
