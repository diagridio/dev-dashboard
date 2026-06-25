# Dapr Dev Dashboard — Design Specification

**Date:** 2026-06-25
**Status:** Approved (design phase)
**Author:** Marc Duiker

## 1. Purpose & Principles

A local-first, single-binary CLI that gives Dapr developers a live, dense, minimal-chrome
view of everything Dapr running on their machine via `dapr run` / `dapr run -f`.

The dashboard is a **passive observer**: it inspects running apps and reads/purges workflow
state, but it does **not** launch or stop apps in v1.

Distributed as a standalone CLI today, but architected so its functionality can later be
lifted into the Diagrid CLI (Go).

### Principles

- Zero-config for the common case.
- Single self-contained binary; no runtime dependencies (no Node.js at runtime).
- Read-only **except** for workflow purge.
- Degrade gracefully when a sidecar or state store is unavailable.
- Minimal UI, high information density, light + dark themes.
- Local standalone (self-hosted) mode only. No Kubernetes, no docker-compose.

## 2. Decisions (locked)

| Topic | Decision |
|---|---|
| v1 scope | The 6 requested areas **+ Actors + Subscriptions** (free from `/v1.0/metadata`). **No** Control Plane (Kubernetes-only, irrelevant for local dev). |
| Backend | Go + `chi` router. Domain logic in isolated `pkg/*` packages. |
| Frontend | React + TypeScript + Vite SPA, built to static assets and embedded via `go:embed`. No Node at runtime. |
| Workflow purge | **Hybrid**: official Dapr purge API when possible, direct state-store deletion as an explicit "force" fallback. |
| State store discovery | **Auto-detect** from running sidecars' metadata + resource paths; user picks if multiple; `--statestore <path>` override. |
| Distribution | GoReleaser binaries (Win/macOS/Linux × amd64/arm64) on GitHub Releases. First-class v1 install: one-line install script (`curl \| sh` / `iwr \| iex`). `go install` works for free. Homebrew/Scoop/winget deferred. |
| Run model | Passive observer. Does not start/stop apps in v1. |
| Default port | `9090` (configurable via `--port`), auto-opens browser on start (suppressible). |
| Components/Configurations | Read-only viewers in v1 (no YAML editing). |

## 3. Architecture

```
┌─────────────────────────────────────────────────────┐
│  dev-dashboard (single Go binary)                     │
│                                                       │
│  cmd/           cobra root, flags, default `serve`    │
│  pkg/server     chi router + go:embed SPA             │
│  pkg/discovery  standalone.List() + /v1.0/metadata    │
│  pkg/workflow   list / history / purge                │
│  pkg/statestore client (redis / postgres / sqlite)    │
│  pkg/resources  component + configuration YAML loader  │
│  pkg/logs       file tail → SSE                        │
│  web/           React + Vite SPA → dist/ (embedded)    │
└─────────────────────────────────────────────────────┘
        │ HTTP /v1.0/metadata, /healthz       │ files / TCP
        ▼                                      ▼
   running daprd sidecars        ~/.dapr, resource paths, state store backend
```

- **Backend:** Go + `chi`. Each domain is an isolated package with its own `service`
  and `api` (response type) sub-packages, mirroring the Diagrid prototype's structure.
  No domain package depends on `cmd/`.
- **Frontend:** React + TypeScript + Vite, built to static assets, embedded via `go:embed`
  as an `fs.FS` and served by the same binary. TanStack Query for polling/caching.
- **Run model:** the default command starts the HTTP server, serves the SPA at
  `http://localhost:9090`, and opens the browser. Discovery reuses
  `github.com/dapr/cli/pkg/standalone` so behavior matches `dapr list`.

## 4. Detection of Running Dapr Applications & Processes

Detection reuses the same mechanism as `dapr list`
(`github.com/dapr/cli/pkg/standalone.List()`). It is layered: the **process scan is the
source of truth** for existence/ports/PIDs and always works; the **metadata call is
enrichment** and degrades gracefully if a sidecar is down.

### 4.1 Find the sidecar processes

- Enumerate all OS processes with `go-ps` (cross-platform: `/proc` on Linux,
  `sysctl`/`proc_pidpath` on macOS, toolhelp snapshot on Windows).
- Keep only processes whose executable is **`daprd`** (or `daprd.exe`). Each `daprd`
  process is one Dapr sidecar = one running Dapr app, and is the anchor for everything else.

### 4.2 Read each sidecar's full command line

- For every `daprd` PID, fetch the full argument list via `gopsutil`
  (reads `/proc/<pid>/cmdline`, etc.). Read directly from the PID rather than trusting
  `go-ps`, which truncates long command lines.
- Parse flags (handles both `--flag value` and `--flag=value`):
  - `--app-id` → app id
  - `--dapr-http-port`, `--dapr-grpc-port` → sidecar ports
  - `--app-port` → the application's own port
  - `--resources-path` / `--components-path` (repeatable) → component/config YAML locations
  - `--config` → configuration file path
  - `--unix-domain-socket`, metrics flags, etc.

This step alone yields app id, all ports, the daprd PID, and resource paths **with no
sidecar interaction** — so it works even when the sidecar is unhealthy.

### 4.3 Enrich from `/v1.0/metadata`

- Using the discovered HTTP port, call `GET http://127.0.0.1:{httpPort}/v1.0/metadata`
  (2 s timeout). Returns runtime version, loaded components, actor types/counts,
  subscriptions, and an `extended` map populated by the Dapr CLI at `dapr run` time:
  - `appPID`, `cliPID` → application PID and launching CLI PID
  - `appCommand` → full app command (used to **infer runtime/language**)
  - `appLogPath`, `daprdLogPath` → log file locations (present only for `dapr run -f`)
  - `runTemplatePath`, `runTemplateName` → owning `dapr.yaml` template

### 4.4 Health

- A background poller calls `GET /v1.0/healthz` (~5 s) per sidecar to render the
  healthy / starting / unhealthy badge.

### 4.5 Consequences & edge cases

- **App PID** comes from `appPID` in extended metadata, not from process scanning. If the
  sidecar never received it (very ad-hoc launches), show the daprd PID and mark the app
  PID unknown.
- **Runtime/language detection is heuristic** — string-matching the app command
  (`go run`, `python`, `node`, `dotnet`, `java`, …) with an "unknown" fallback.
- Detection is **poll-based** (re-scan on the autorefresh interval), not event-driven;
  new `dapr run` apps appear within one refresh cycle.

## 5. Data Sources

| Source | How | Used for |
|---|---|---|
| Process scan | `standalone.List()` (`go-ps` + `gopsutil`) | app id, http/grpc/app ports, daprd/app/cli PIDs, age, run-template, log/resource paths |
| `/v1.0/metadata` | HTTP per sidecar | runtime version, loaded components, actor types/counts, subscriptions, extended metadata |
| `/v1.0/healthz` | background poller (~5 s) | health badge |
| Full cmdline via PID | `gopsutil` `/proc/<pid>` | runtime/language inference |
| YAML files | walk `~/.dapr/components`, `~/.dapr/config.yaml`, live `--resources-path` from daprd args | components + configurations |
| State store backend | client built from auto-detected component YAML | workflow list/history/purge |
| Log files | `~/.dapr/logs/*` and metadata `appLogPath`/`daprdLogPath` | log tailing |

## 6. Feature Views (v1)

1. **Overview** — table of running apps/sidecars: app id, health, runtime/language,
   app/http/grpc ports, daprd + app PIDs, age, run-template. Autorefreshes.
2. **App / Sidecar detail** — tabs:
   - Summary (ports, PIDs, command, resource/config paths)
   - Metadata (runtime version, enabled features)
   - **Actors** (types + counts)
   - **Subscriptions** (topic, pubsub component, routes, dead-letter topic)
   - **Logs**
3. **Workflows** — list of executions across all apps with status filter
   (Pending / Running / Completed / Failed / Terminated / Suspended), app/name/instance-id
   search, and pagination. **Autorefreshes** (default 3 s, pausable, interval selector).
   Detail drill-in: header (status, instance id, app, created/ended, duration, replay
   count), **input**, **output**, **custom status**, and the full history timeline (events
   with per-event input/output, timestamps, elapsed, replay count) + derived status. Purge
   actions (see §7).
   - **Autorefresh on the detail page too:** the detail view autorefreshes with the same
     controls as the list — pause/resume and a selectable interval that **includes 1 s**
     (1 s / 3 s / 5 s / 10 s / Off; default 1 s for the detail page so an in-progress run
     updates promptly).
   - **Live event history:** while a workflow is running, the history timeline is appended
     to on each refresh as new events are read — the list grows live rather than only on
     reload. Status, event count, replay count, last-event, output, and custom status
     update with it; on a terminal state the output and final custom status appear.
   - **Wall-clock:** a running elapsed timer starts as soon as the workflow is scheduled and
     counts continuously (independent of the refresh interval), so the user sees the
     workflow is doing something even when events are still in-flight between refreshes. It
     freezes and switches to total duration once the workflow reaches a terminal state.
   - **Custom status:** shown only when the workflow has set it via `ctx.SetCustomStatus()`;
     it updates live as the value changes during the run.
   - **Copyable fields:** input, output, and custom status (and each event's input/output)
     each have a one-click copy-to-clipboard control, plus the raw instance id. Copy yields
     the exact serialized JSON/text. The web UI uses the async Clipboard API with a
     `execCommand` fallback for restricted contexts.
4. **Components & Configurations** — list + read-only YAML viewer, enriched with `LoadedBy`
   (which app ids loaded each component, from metadata). Syntax-highlighted viewer.
5. **Logs** — per-app daprd + app logs, live tail via SSE, log-level parsing/coloring,
   keyword filter, follow toggle.

## 7. Workflow Purge (Hybrid)

- **Single instance**, terminal state, healthy sidecar with the workflow component present
  → `POST /v1.0-beta1/workflows/{component}/{instanceId}/purge` (official Dapr API).
- **Force / fallback** (running, stuck/orphaned, or no sidecar available) → direct
  state-store key deletion: scan keys via the `KeysLike` pattern
  (`<appId>||dapr.internal.<namespace>.<appId>.workflow||<instanceId>||...`) and delete
  them. Clearly labeled "Force delete", separate confirmation.
- **Bulk**: purge selected rows, and purge-all-matching-the-current-filter (e.g. all
  Completed). Bulk applies the same per-item hybrid logic and returns a summary
  (succeeded / failed counts).
- Every destructive action requires explicit confirmation, and the UI states which
  mechanism (API vs force delete) will be used before the user confirms.

## 8. HTTP API (Backend → SPA)

REST + JSON, with SSE for streams. Indicative surface:

```
GET  /api/apps                                  list sidecars/apps
GET  /api/apps/{appId}                           detail incl. metadata
GET  /api/apps/{appId}/logs?source=daprd|app     (SSE)
GET  /api/workflows                              list (filter/search/paginate)
GET  /api/workflows/{appId}/{instanceId}         detail + history
POST /api/workflows/{appId}/{instanceId}/purge   body: { force?: bool }
POST /api/workflows/purge                        bulk: { ids[], force?: bool }
GET  /api/resources?kind=component|configuration list
GET  /api/resources/{kind}/{name}                full YAML
GET  /api/statestores                            detected stores (+ which is active)
GET  /api/health                                 dashboard liveness
GET  /api/version                                dashboard + detected runtime versions
```

## 9. Frontend / UX

- **Minimal chrome:** left nav (Overview · Workflows · Components · Configurations),
  top bar with theme toggle + global autorefresh control. Dense tables; monospace for
  ids/ports/PIDs.
- **Theming:** **defaults to the light theme**, with a manual toggle persisted to
  `localStorage` (may optionally follow `prefers-color-scheme` when the user hasn't chosen).
  CSS variables drive both themes. **All brand-green accents** (text labels, stat numbers,
  status dots, focus rings, selection highlights, primary-button fills) use a single
  contrast-adjusted accent token — a deeper teal-green on light, a brighter mint on dark —
  rather than the raw mint, which is too light on white. The raw mint remains the brand color
  in the palette/logo, but on-screen accents resolve through the adjusted token.
- **Autorefresh:** a central setting. Workflows + Overview poll on the interval
  (default 3 s, pausable). Logs stream over SSE.
- **Tech:** React + Vite with a small dependency footprint; TanStack Query for
  polling/caching; a lightweight component layer (no heavy design system) to keep bundles
  small. Syntax-highlighted YAML viewer (e.g. a lightweight highlighter or Monaco if the
  bundle cost is acceptable).
- **Cross-navigation (deep links):** related entities link to each other so the user can
  follow a debugging trail. From an application's detail page, each loaded component links
  to that component's detail; on a component's detail, each app in its "loaded by" list
  links back to that application's detail. The same app-id ↔ app-detail linking applies on
  the Subscriptions and Actors pages (host/app columns are links). Each view is
  addressable by a stable route so links are shareable.
- **Collapsible left "Resources" menu:** a left sidebar that follows the dashboard theme
  (`--surface` background, `--border`, themed text — light/dark), with uppercase section
  headers, rounded hover rows, ~240px wide, collapsible (state remembered). Text-only menu
  items (no icons). Kept minimal and dense to match the rest of the dashboard. All links
  open in a new tab. Sections and links:
  - **News** (dynamic — see below): the latest blog post, the latest report/ebook, the first
    upcoming webinar, and the first upcoming event (each slot shows a muted empty state when
    the feed has no item for it — e.g. no upcoming events)
  - **Build**: Dapr Workflow Skills (<https://docs.diagrid.io/develop/workflows/dapr-skills/>) ·
    Dapr Composer (<https://workflows.diagrid.io/>)
  - **Learn**: Dapr University (<https://www.diagrid.io/university>) ·
    Diagrid Webinars (<https://www.diagrid.io/webinars>)
  - **Read**: Dapr Docs (<https://docs.dapr.io>) · Diagrid Docs (<https://docs.diagrid.io>)
  - **Run & Operate**: Diagrid Catalyst (<https://www.diagrid.io/catalyst>)
- **News feed (dynamic):** the News section is populated by periodically fetching the
  Diagrid website's existing product feed —
  **`GET https://www.diagrid.io/api/product-feed`** (JSON, CORS-enabled `*`, server-cached
  ~1 h). It returns `latestBlogPosts`, `upcomingWebinars`, `upcomingEvents`, and
  `latestReports`, each item with `title`, `url`, `excerpt`, `publishedAt`, and (for
  webinars/events) `eventStartDate` / `eventLocation`; upcoming-vs-past is derived from
  `eventStartDate`. The dashboard polls roughly hourly (no benefit to more frequent polling),
  caches the last good result, and degrades to the static Build/Learn/Read/Run links if the
  feed is unreachable (e.g. offline). No RSS/Atom feed exists today; the JSON feed is the
  recommended source. The fetch can run from the Go backend (avoids any browser CORS concerns
  and lets results be cached server-side) or directly from the SPA since CORS is open.

### 9.1 Visual Identity & Theming

The dashboard carries **Diagrid's brand identity as primary** (it will fold into the
Diagrid CLI), and uses **Dapr's indigo only as a semantic accent** to tag Dapr-runtime
elements. Brand values are taken from the live `dapr.io` stylesheet and the Diagrid
frontend theme tokens (`…/diagrid-dashboard/src/styles/theme/palette.ts`).

**Brand colors**

- Primary (Diagrid mint): `#0BDDA3` — used for the logo, active nav indicator, focus
  rings, badges, and primary-button *fills* with dark `#121C29` text on the mint (the
  contrast of mint-on-white is too low for text, so mint is never used for text/links).
- Secondary (Diagrid blue): `#129AF3` — interactive text/links and secondary actions.
  Use the dark blue `#007AD3` on light backgrounds (≈4.5:1) and the light blue `#63B8F6`
  on dark backgrounds.
- Dapr accent (semantic only): indigo `#0D2192` on light / `#3EA9F5` on dark — used
  sparingly to distinguish Dapr-runtime things (e.g. the `daprd` sidecar chip vs. the
  application chip). Kept rare so the UI stays Diagrid-branded.

**Theme tokens (CSS variables)**

| Token | Light | Dark |
|---|---|---|
| `--bg` / `--surface` | `#FFFFFF` / `#F9FAFB` | `#161C24` / `#212B36` |
| `--text` / `--text-muted` | `#212B36` / `#637381` | `#F9FAFB` / `#919EAB` |
| `--border` | `#DFE3E8` | `#454F5B` |
| `--primary` | `#0BDDA3` | `#0BDDA3` |
| `--link` / `--secondary` | `#007AD3` | `#63B8F6` |
| `--dapr-accent` | `#0D2192` | `#3EA9F5` |

**Workflow status colors** (state encoded as color *and* a pill, for at-a-glance scanning)

| Status | Color |
|---|---|
| Running | blue `#129AF3` |
| Completed | green `#0BDD39` |
| Failed | red `#DD0B46` |
| Terminated | grey `#637381` |
| Suspended | purple `#8330FF` |
| Pending | amber `#B1AC00` (Diagrid's `#F6F100` yellow is too low-contrast as text) |

Semantic status hues are kept distinct from the mint accent so "needs attention" reads on
its own. Neutrals use the Diagrid grey scale: `#161C24 · #212B36 · #454F5B · #637381 ·
#919EAB · #C4CDD5 · #DFE3E8 · #F4F6F8 · #F9FAFB · #FFFFFF`.

**Logo assets** (copied into `web/src/assets/brand/`, bundled into the SPA, embedded in the
binary — no runtime fetch, works offline):

- Header logo — the **full Diagrid wordmark** (the complete "diagrid" logo, not just the
  "D" mark). The wordmark SVG is made theme-aware by setting its text fills to
  `currentColor` and driving the color from a per-theme `--logo-ink` token (dark ink on
  light, white on dark); the brand accent stroke keeps its green. One asset themes
  automatically.
- Favicon / collapsed-rail mark — the Diagrid "D" icon. Source: `d.svg`.

## 10. Portability to the Diagrid Go CLI

- All logic lives in `pkg/*` domain packages with no dependency on `cmd/`.
- The server mounts as a `chi` sub-router; the SPA is an embedded `fs.FS`. Both can be
  re-mounted under a `diagrid dashboard` subcommand.
- Discovery already depends on `dapr/cli/pkg/standalone`, the same dependency the Diagrid
  CLI can use.
- Configuration is via flags/env with sane defaults; no global mutable state.

## 11. Error Handling & Edge Cases

- **No apps running** → friendly empty state, not an error.
- **Sidecar down / metadata timeout (2 s)** → show process-scan data, mark metadata
  "unavailable", keep going.
- **State store not detected / unreachable** → Workflows view shows an actionable message
  and the `--statestore` hint; the rest of the dashboard still works.
- **Multiple state stores** → user picks the active store in the UI.
- **Ad-hoc `dapr run` (no `-f`)** has no log files → Logs tab explains logs are only
  available for file-logged runs.
- **Purge of a non-terminal workflow via the official API** fails → UI offers the force path.

## 12. Testing

- **Go:** unit tests per service package (cmdline parsing, workflow state decoding,
  purge-mechanism selection, YAML loading) with fakes for sidecar HTTP + state store;
  table-driven. `httptest` for handlers.
- **Frontend:** component tests (Vitest + Testing Library) for tables, filters, and the
  purge-confirm flows; MSW to mock the API.
- **E2E smoke:** one happy-path run against a real `dapr run -f` sample app (borrow example
  apps from the Diagrid prototype).

## 13. Out of Scope for v1

Control plane status (Kubernetes-only), topology graph, metrics/sparklines, data browser,
jobs/scheduler, agents, YAML editing, launching/stopping apps, and Kubernetes &
docker-compose modes. Local standalone (self-hosted) mode only.

## 14. References

- Deprecated Dapr Dashboard — `/Users/marcduiker/dev/dapr/dashboard/`
  (feature-parity baseline; Angular + Go, 10 s polling, K8s log streaming).
- Dapr CLI — `/Users/marcduiker/dev/dapr/cli/`
  (`pkg/standalone/list.go` discovery, `pkg/metadata/metadata.go`, `~/.dapr` layout,
  `pkg/runfileconfig/` run templates).
- Diagrid Dev Dashboard prototype —
  `/Users/marcduiker/dev/diagrid/cloudgrid/tools/diagrid-dashboard`
  (Go + chi + React; workflow list/history via state store `KeysLike`, SSE logs,
  sidecar discovery, resource loading; read-only, no purge, no workflow autorefresh).
