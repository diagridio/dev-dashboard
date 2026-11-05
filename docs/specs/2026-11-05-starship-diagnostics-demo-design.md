# Starship Diagnostics Demo + Automated Screenshots — Design

Date: 2026-11-05
Status: Draft for review

## Intent

Today, manually testing the dashboard or taking screenshots means hunting through sample repos
for Dapr apps that happen to use the right building blocks, then stitching them together. Each
sample only covers part of the dashboard, and the screenshots in `docs/images` are going stale:
most date from July, several pages have none, and a few exist in light mode only.

This adds two things to the repo:

1. **A demo**: three Dapr apps (Go, .NET, Python), started together with `dapr run -f`, that
   between them put realistic data on every dashboard page. The theme is a starship diagnostics
   system that checks the ship's subsystems.
2. **A screenshot script** that captures every page in light and dark mode into `docs/images`,
   for the README, docs and social posts.

The user is the maintainer, for their own local use: manual testing and producing current images.

## Goals

- One command brings up the demo; one command captures all screenshots.
- Every dashboard page shows meaningful, on-theme data, with no empty states.
- **Repeatable:** the demo seeds a fixed scenario and then goes idle, so every capture shows the
  same rows. A reset command restores that scenario. "Same" means the seeded content (IDs,
  statuses, names, payloads, record keys, messages). Runtime details may vary: PIDs, uptime,
  absolute event times, log lines, container IDs. App/HTTP/gRPC ports are fixed in
  `dapr.yaml` so they don't vary.
- All apps use the latest SDKs targeting **Dapr 1.19**.
- Screenshots in both themes, 1440×900 viewport at device scale factor 2.

## Non-goals

- Compose, Aspire and Testcontainers discovery modes (only `dapr run -f` for now).
- Running in CI, or acting as a test. This is a local maintainer tool.
- Live, continuously changing traffic.
- Pixel-diff / visual regression testing.

## Anti-goals (failure even if it "works")

- Screenshots that differ between runs in anything other than relative timestamps
  ("3 min ago") and durations.
- Copied Star Trek assets in public images (logos, insignia, artwork). The ship is named
  **Enterprise** (maintainer's call: e.g. "Enterprise Diagnostics", app descriptions and log
  lines may mention it). Otherwise use starship vocabulary (warp core, shields, deflector,
  sickbay, bridge, "Starfleet Command" for the HTTPEndpoint).
- Putting the demo or Playwright into the shipped binary or into `make test`.
- Changing dashboard product code to make screenshots work, apart from at most trivial test
  hooks. Discuss with the maintainer first if one seems needed.

## Constraints

- Local prerequisites: `dapr init` (Redis + placement + scheduler containers), Dapr CLI and
  runtime **1.19.x**, Go (repo toolchain), .NET SDK (the version the 1.19 `Dapr.*` packages
  target; builder confirms), Python 3.11+ with `uv` or venv (builder's choice), Node 20.
- SDK versions, pinned to the latest release that targets Dapr 1.19 (checked 2026-11-05;
  re-check patch versions when building):
  - Go: `github.com/dapr/go-sdk` `v1.16.x` (the e2e matrix already uses `v1.16.0` for 1.19).
  - .NET: `Dapr.Client`, `Dapr.AspNetCore`, `Dapr.Actors.AspNetCore` at `1.19.0` (GA on
    NuGet).
  - Python: **`dapr[workflow,fastapi]==1.19.0`**. Workflow and FastAPI support now ship as
    extras of the main `dapr` package (released on PyPI with `workflow` and `fastapi` extras;
    see https://github.com/dapr/python-sdk/tree/main/dapr/ext/workflow). Do **not** use the
    old separate `dapr-ext-workflow` / `dapr-ext-fastapi` packages.
- The demo assumes a **clean local environment**: the maintainer stops other Dapr apps and
  flushes the `dapr init` Redis manually before running it. The demo uses the default Redis
  (no dedicated DB index or key prefix) and doesn't try to isolate itself. `demo/README.md`
  lists this cleanup step first. Reset only touches demo IDs/keys.
- Each demo app gets its own module/project (`go.mod`, `.csproj`, `pyproject.toml`) so the
  root `go.mod` gains no dependencies. This follows the e2e fixture pattern (`test/e2e/wfapp`
  has its own `go.mod`).
- Playwright is a **devDependency** in `web/package.json` (or a separate small package under
  `demo/screenshots/`, builder's choice). Either way it must not run in `npm test`.
- Theme switching: the dashboard stores the theme in localStorage key `devdash.theme`
  (`'light' | 'dark'`; `web/src/lib/prefs.ts`). The script sets it with an init script before
  each page load.

## Layout

```
demo/
  README.md              prerequisites, make targets, what each app demonstrates
  dapr.yaml              multi-app run file (all three apps, shared resourcesPath)
  resources/             shared component/config/resiliency/subscription/HTTPEndpoint YAML
  secrets.json           demo "command codes" for the local-file secret store (fake values)
  engineering/           Go app
  bridge/                .NET app
  sickbay/               Python FastAPI app
  screenshots/           Playwright capture script (+ package.json if kept separate)
```

Make targets (root `Makefile`):

- `make demo` runs `dapr run -f demo/dapr.yaml` (foreground; Ctrl-C stops it). Also starts
  the dashboard, either in `dapr.yaml` or as a separate step; builder's choice, documented in
  `demo/README.md`.
- `make demo-reset` purges demo workflows and state records and reseeds, against the running
  demo (e.g. via a `POST /seed?reset=true` endpoint on each app, or a small script).
- `make screenshots` runs `make demo-reset` first, then the capture against the
  already-running demo + dashboard (default `http://localhost:9090`, overridable). It fails
  clearly if the demo isn't up or the seed isn't complete.
- Reset semantics: terminate + purge every demo workflow instance (including the Running
  `sweep-005` and all children), delete the demo state keys, then reseed. Actor reminders are
  re-registered idempotently (same name/period); already-consumed pub/sub messages don't
  matter because nothing on screen shows stream contents. Restarting `make demo` on top of
  existing data is fine (seeding is idempotent by fixed ID), but captures always go through
  reset.

## The apps and what they light up

| App | Lang | Dapr features | Dashboard pages fed |
|---|---|---|---|
| `engineering` | Go | Workflows (parent + child workflows, activities, external event, timer), service-invocation target, binding input (cron), 1.19 data reference (large payload in binarystore) | Workflows, Workflow detail, Apps, App detail, Logs |
| `bridge` | .NET | Actors (one type per subsystem class, timers + reminders), pub/sub publish, service invocation to `engineering`, secret store read | Actors, Apps, App detail, Logs |
| `sickbay` | Python | Pub/sub subscribe (one declarative `Subscription` YAML + one programmatic), state store writes, HTTPEndpoint call | Subscriptions, State, HTTP Endpoints, Apps, Logs |
| shared | — | Redis state store (actor store), Redis pub/sub, cron binding, local-file secret store, `binarystore.in-memory` (1.19), Configuration (tracing + features), Resiliency policy, HTTPEndpoint | Components, Configurations, Resiliency, HTTP Endpoints, Control Plane |

### Seeded scenario (fixed IDs, fixed content)

- **Workflows** (in `engineering`): `DiagnosticSweep` parent with `SubsystemCheck` children
  per subsystem (warp-core, shields, deflector, life-support).
  - `sweep-001`, `sweep-003`, `sweep-004`: **Completed**.
  - `sweep-002`: **Failed**. The deflector check throws "plasma conduit rupture in deck 7"
    with a real application stack trace, which feeds the failure banner and per-event error box.
  - `sweep-005`: **Running**, blocked on external event `ChiefEngineerSignOff`, which is
    never raised.
  - `sweep-006`: **Completed**, with one activity output above the data-reference threshold,
    so the 1.19 `$daprRef` payload view shows (dashboard support merged in PR #149). Also
    captured as `workflow-dataref-<theme>`.
  - Child instances get deterministic IDs (e.g. `sweep-001-shields`).
- **Actors** (in `bridge`): a fixed set of actor IDs per type (e.g. `SubsystemActor`:
  warp-core, shields, deflector, life-support, plus perhaps a second type such as `DeckActor`
  with a few decks), activated once at seed. Reminders are registered with a long period so
  they show without causing churn.
- **Pub/sub**: `bridge` publishes a fixed set of alerts to `red-alert` and results to
  `diagnostics.results` during seeding; `sickbay` consumes them.
- **State** (in `sickbay`): crew-log records with fixed keys (`crewlog-0001`…) written once.
- **Secrets**: `bridge` reads a command code from the local-file secret store at startup, which
  feeds the component secret-reference status.
- **HTTPEndpoint** `starfleet-command`: points at a fixed local URL (e.g. `sickbay` itself or a
  tiny stub route). Include one secret-backed header so the masking and resolve status show.
- **Cron binding**: declared and wired to `engineering`, with a schedule far in the future
  (or `@every 24h`), so it is listed but never fires during a session.

**Seeding** is idempotent: each app checks whether its seed exists (by fixed ID) and skips it
if so. Ordering across apps (e.g. `bridge` publishing only after `sickbay` has subscribed) is
handled with readiness checks or retries, not sleeps. After seeding, nothing runs on a timer.

## Screenshot script

- Playwright (Chromium), viewport 1440×900, `deviceScaleFactor: 2`.
- For each theme in `light`, `dark`: set `devdash.theme` before navigation, visit each target,
  wait for data to settle (no loading indicators, expected seeded content visible; e.g. the
  Workflows page waits for `sweep-002`), then screenshot the viewport and write
  `docs/images/<name>-<theme>.png`.
- **Targets.** Keep the existing names so README links keep working:
  - `applications`, `application-detail` (engineering), `workflow-overview`,
    `workflow-detail` (`sweep-002`, the failed run), `actors`, `components`, `control-plane`,
    `logs`
  - new: `state`, `subscriptions`, `configurations`, `resiliency`, `http-endpoints`,
    `component-detail`, `component-builder`, `resiliency-builder`
  - interaction shots, now captured in both themes: `cli-drawer` (drawer open on a sensible
    page), `publish-message` (dialog open on Subscriptions), `state-records` (a crew-log record
    open). These currently exist without a theme suffix. Rename them to `-light`/`-dark`,
    update the README references, and delete the old unsuffixed files.
- Excluded: Replay game.
- Before capture, the script verifies the seed (e.g. via the dashboard API or the apps' seed
  status) and exits non-zero with a clear message if anything is missing.
- Distracting or non-deterministic UI (news panel, update-check banner, offline toasts,
  RUM) is suppressed through existing flags, env or localStorage where possible.
  Builder: find the existing switches. If something can't be suppressed without product
  changes, flag it instead of patching around it.
- Target list lives in one data structure in the script so adding a page is one line.

## Left to the builder

- Exact SDK patch versions (latest 1.19-aligned at build time).
- Whether the dashboard launch lives in `dapr.yaml` or `make demo`.
- Reset mechanism details.
- Python env tooling (`uv` vs venv), .NET target framework.
- Playwright placement (`web/` devDependency vs `demo/screenshots/package.json`).
- Exact app ports, deck/actor names, log message wording (on theme, generic vocabulary).

## Calls made without explicit sign-off (please check)

- Top-level `demo/` folder; make targets `demo`, `demo-reset`, `screenshots`.
- Screenshot script runs against an already-running demo rather than starting it.
- Light-only interaction shots get theme suffixes, and the README is updated.
- Including the 1.19 data-reference workflow (`sweep-006`) and capturing its detail page.
- "Repeatable" = seeded content; runtime details (PIDs, uptime, absolute times, log lines,
  container IDs) may vary. No masking or clock-freezing.
- `make screenshots` always resets first; reset scope as described above.
