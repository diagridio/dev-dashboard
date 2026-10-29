# Contributing to Diagrid Dev Dashboard

Thank you for your interest in contributing! This project is owned and maintained by
[Diagrid](https://diagrid.io) and welcomes external contributions — bug reports, fixes,
docs improvements, and features.

## Reporting issues

Open a [GitHub issue](https://github.com/diagridio/dev-dashboard/issues) with:

- What you did, what you expected, and what happened instead.
- Your OS, dashboard version (`diagrid-dev-dashboard --version`), and Dapr version (`dapr --version`).
- If relevant, diagnostic output from `diagrid-dev-dashboard --verbose` (logs go to stderr).

For feature requests, describe the use case rather than a specific implementation —
it helps us evaluate the best way to fit it into the dashboard.

## Developer Certificate of Origin (DCO)

All commits must be signed off, certifying that you have the right to submit the work
under this project's [Apache 2.0 license](LICENSE) per the
[Developer Certificate of Origin](https://developercertificate.org/):

```sh
git commit -s -m "fix: describe your change"
```

This appends a `Signed-off-by: Your Name <your@email>` trailer to the commit message.
Pull requests with unsigned commits cannot be merged.

## Building from source

**Prerequisites:** Go ≥ 1.26 and Node.js 20 (with `npm`). The binary embeds the React SPA via
`go:embed`, so the web assets (`web/dist`) must be built **before** the Go binary — `make build`
does both in the right order.

```sh
git clone https://github.com/diagridio/dev-dashboard.git
cd dev-dashboard
```

**macOS / Linux:**

```sh
make build            # builds web/dist, then the Go binary at bin/diagrid-dev-dashboard
./bin/diagrid-dev-dashboard
```

Equivalent manual steps (if you don't have `make`):

```sh
cd web && npm install && npm run build && cd ..
go build -o bin/diagrid-dev-dashboard .
./bin/diagrid-dev-dashboard
```

**Windows (PowerShell):** `make` is usually unavailable, so run the steps directly:

```powershell
cd web; npm install; npm run build; cd ..
go build -o bin/diagrid-dev-dashboard.exe .
.\bin\diagrid-dev-dashboard.exe
```

To build for a sub-path mount, set `DASH_BASE_PATH` at build time and pass the matching
`--base-path` flag at runtime (`DASH_BASE_PATH` must end with `/`), e.g.
`DASH_BASE_PATH=/dashboard/ make build` then `./bin/diagrid-dev-dashboard --base-path /dashboard`.
On Windows, set `$env:DASH_BASE_PATH='/dashboard/'` before the `npm run build` step.

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the codebase is organized and how to extend
each part.

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
   ./bin/diagrid-dev-dashboard    # opens http://localhost:9090
   ```
4. In the UI: the **Apps** table shows your app (health, ports, PIDs); the **Workflows** page
   lists instances read from the state store — open one for its live event history, input/output,
   status, and a ticking wall-clock. You can also terminate / purge an instance (with the
   force-delete fallback).

**If the Workflows page is empty:** the dashboard auto-detects state-store components from
`~/.dapr/components` and from the live `--resources-path` of running apps, then uses the one
marked `actorStateStore: "true"` (falling back to the first detected). Check:

- If detection is ambiguous (several stores), either pick one with the store selector on the
  Workflows page, or point it explicitly:
  `./bin/diagrid-dev-dashboard --statestore ~/.dapr/components/statestore.yaml`. You can also add a
  store by hand via the connection manager on the Components page.
- Workflow keys are namespaced; the dashboard defaults to `default`. For another namespace, pass
  `--namespace <ns>`.
- Only **Redis / PostgreSQL / SQLite / MongoDB** state stores can be opened directly. Apps whose store
  the dashboard can't open (e.g. `state.in-memory`, or a Testcontainers app whose store lives
  inside the container) are served **via their sidecar's gRPC workflow API** instead — this
  requires Dapr ≥ 1.17 and only works while the sidecar is running.
- Confirm the app actually persisted a workflow (an empty store → empty list).

**Testcontainers apps** (e.g. the Java quickstarts run with `mvn spring-boot:test-run`) need
none of the store setup above: workflows, components, and app details all come from the
Testcontainers-managed sidecar itself.

## Testing

There are four suites: Go **unit** tests, Go **integration** tests, the **web**
(frontend) tests, and an opt-in Go **e2e** suite. The unit and web suites are self-contained.
The integration suite runs its state-store and workflow tests against a temporary SQLite
database plus real Redis, PostgreSQL, and MongoDB containers (via testcontainers-go), so it
needs Docker or Podman for full coverage; without one, the container-backed tests skip. The
**e2e** suite drives a real `daprd` and is local-only — it skips automatically when Dapr is not
installed (see below).

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
workflow read paths (including a parity test of the workflow list/stats/detail against all four
supported backends), the parsed sidecar `/v1.0/metadata`, and the full assembled HTTP server.
Backends run as containers through testcontainers-go (skipped when no container runtime is
available) alongside a temp SQLite DB. They run in CI but are not part of `make test`:

```sh
make test-integration               # = go test -tags integration -race ./...
# or directly:
go test -tags integration ./...
```

Some integration tests use golden files (`testdata/golden/*`); regenerate them after an
intentional shape change with `-update`, e.g.
`go test -tags integration ./pkg/workflow -run Golden -update`.

**Go e2e tests** — gated by `//go:build e2e`; they run a real Dapr workflow app under
`dapr run` and read its state back through the dashboard's own packages, validating against
state authored by a live runtime. They require a local Dapr install (`dapr init`) — `dapr` on
your `PATH` and `daprd` on `PATH` or in `~/.dapr/bin` — and **skip automatically** when Dapr is
not found. They are local-only and not run in CI:

```sh
make test-e2e                       # = go test -tags e2e ./...
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

> **Tip:** the Go tests are build-tag-gated, so a plain `go test ./...` (without `-tags unit`,
> `-tags integration`, or `-tags e2e`) reports "no test files" for most packages. Always pass
> the tag.

New code should come with tests: Go changes with unit tests (build tag `unit`), frontend
changes with Vitest tests, and state-store/HTTP-path changes with integration coverage
where it applies.

## Linting

```sh
make lint          # lint-go (gofmt + go vet) + lint-web (eslint)
make lint-go       # = gofmt check + go vet -tags unit ./...
make lint-web      # = cd web && npm install && npm run lint  (eslint .)
```

The Go checks (`gofmt`, `go vet`) and the web `eslint` run in CI on every push and pull request.

**Pre-commit hook (optional):** install a hook that lints only your staged files before each
commit:

```sh
make hooks         # symlinks .git/hooks/pre-commit -> scripts/pre-commit
```

It runs `gofmt`/`go vet` on staged Go files and `eslint` on staged `web/` files. Bypass it for a
single commit with `git commit --no-verify`.

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep PRs focused — one logical change per PR.
3. Make sure `make lint` and `make test` (and `make test-integration` if relevant) pass.
4. Run `make tidy` if you touched Go dependencies.
5. Sign off all commits (`git commit -s`).
6. Use clear commit messages; this repo follows the
   [Conventional Commits](https://www.conventionalcommits.org/) style
   (`feat(web): ...`, `fix: ...`, `test(web): ...`).

A maintainer will review your PR. We may ask for changes — see the review comments as a
conversation, not a gate.

## Code style

- **Go:** standard `gofmt` formatting; each domain lives in its own `pkg/*` package with
  no dependency on `cmd/`.
- **Frontend:** React + TypeScript; UI conventions (design tokens, page anatomy,
  component classes) are documented in [`web/STYLEGUIDE.md`](web/STYLEGUIDE.md).

## Releasing

> For maintainers with push access. Releases are built and published by the
> [`release` GitHub Actions workflow](.github/workflows/release.yaml): pushing a `vX.Y.Z` tag
> runs [GoReleaser](https://goreleaser.com), which compiles the cross-platform archives plus
> `checksums.txt` and publishes them to a GitHub Release. The version (`diagrid-dev-dashboard --version`)
> is injected from the tag via build-time ldflags. The same tag-driven run also builds and
> pushes the multi-arch container image to `ghcr.io/diagridio/dev-dashboard` via goreleaser.
> Prerelease tags (any `-suffix`, e.g. `v1.5.0-rc.1`) push their version-tagged image but
> skip the `:latest` manifest, so release candidates never reach `:latest` consumers.

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

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](LICENSE), per section 5 of the license.
