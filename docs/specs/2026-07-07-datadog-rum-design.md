# Datadog RUM instrumentation — design

Date: 2026-07-07
Status: approved

## Problem

The dashboard has no visibility into real usage: whether people get past
startup, which nav items and Resources-panel links get used, or whether the
front-end throws errors in the wild. We want Datadog RUM in the front-end to
track exactly four things — application startup, top-menu clicks,
resource-panel clicks, and errors — with a working, restart-based opt-out.

## Decisions (from brainstorming)

- **Front-end only.** No Datadog APM/tracing on the Go backend. The only Go
  change is reading the opt-out env var at process start and passing one
  boolean to the browser — unavoidable, since only the Go process can see its
  own environment.
- **Datadog site:** `datadoghq.com` (US1).
- **No Session Replay.** The dashboard can show local dev data (component
  configs, resource metadata); RUM core events only, `sessionReplaySampleRate: 0`.
- **Route/view tracking:** enabled, but view names are a fixed label per
  route (`handle.rumView`), never the resolved path — local identifiers like
  `:appId` / `:instanceId` must never reach Datadog.
- **Opt-out:** env var `DEVDASHBOARD_TELEMETRY_OPTOUT`. Read once when the Go
  process starts; changing it requires restarting the dashboard. Exact value
  `"true"` (case-insensitive) disables telemetry; anything else (including
  unset) leaves it enabled. When disabled, the RUM SDK must not be loaded at
  all — not just uninitialized.
- **Sample rate:** `sessionSampleRate: 100` — usage volume is low (local dev
  tool), no need to sample down.
- Applications ID and client token are the two IDs given below; both are
  RUM's public browser-side identifiers (not secrets), safe to ship in the
  bundle.

## Design

### 1. Opt-out plumbing (Go — the only backend change)

- `cmd/root.go`, in `runServe`: read the env var once —
  `telemetryEnabled := !strings.EqualFold(os.Getenv("DEVDASHBOARD_TELEMETRY_OPTOUT"), "true")`.
- Print to stdout immediately after the existing
  `fmt.Printf("dev-dashboard %s → %s\n", ...)` line:
  - enabled: `Anonymous usage telemetry is enabled. We use this data improve the dashboard. Set DEVDASHBOARD_TELEMETRY_OPTOUT=true to disable (restart required).`
  - disabled: `Anonymous usage telemetry is disabled (DEVDASHBOARD_TELEMETRY_OPTOUT=true).`
- `pkg/server.Options` gains `TelemetryEnabled bool`. Threaded through
  `NewRouter` → `SPAHandler(fsys, basePath, telemetryEnabled)` → `serveIndex`.
- `serveIndex` injects one inline script into the served `index.html`, right
  before `</head>`:
  `<script>window.__DASH_TELEMETRY_ENABLED__=true;</script>` (or `false`).
  No templating engine needed — a single, controlled string insertion into
  our own build output (not user input, nothing to escape).
- No new API endpoint. `/api/version` is untouched.
- Side effect (not a requirement, just a consequence of the mechanism):
  running the front-end via `vite dev` never goes through `serveIndex`, so
  `window.__DASH_TELEMETRY_ENABLED__` is `undefined` there and telemetry is
  naturally off for this repo's own frontend contributors.

### 2. Front-end telemetry module — `web/src/lib/telemetry.ts`

```ts
export function initTelemetry(): void
export function trackAction(name: string, context?: Record<string, unknown>): void
export function trackError(error: unknown, context?: Record<string, unknown>): void
export function trackView(name: string): void
```

- `initTelemetry()`:
  - If `window.__DASH_TELEMETRY_ENABLED__ !== true`, return immediately.
    Critically, this check happens *before* importing the SDK, via a dynamic
    `import('@datadog/browser-rum')` — so opted-out (or `vite dev`) sessions
    never fetch that JS at all.
  - Otherwise, dynamically import and call:

    ```ts
    datadogRum.init({
      applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a',
      clientToken: 'pub566ae9a25b52873b96a28f4075cf6825',
      site: 'datadoghq.com',
      service: 'dev-dashboard',
      env: 'prod',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask',
      trackViewsManually: true,
    })
    ```
  - Sets an internal module-level `enabled` flag once resolved, so
    `trackAction`/`trackError`/`trackView` don't need to re-check the window
    global on every call.
- `trackAction`/`trackError`/`trackView` no-op silently when `enabled` is
  false or `initTelemetry()` hasn't resolved yet; otherwise delegate to
  `datadogRum.addAction`, `datadogRum.addError`, `datadogRum.startView`
  respectively.

### 3. View tracking with masked IDs

- Each route object in `router.tsx` gets a `handle: { rumView: '<Label>' }`,
  e.g. `Applications`, `AppDetail`, `Workflows`, `WorkflowDetail`, `Actors`,
  `Subscriptions`, `ComponentBuilder`, `Components`, `Configurations`,
  `Resiliency`, `ResiliencyBuilder`, `ControlPlane`, `Logs`. These are fixed
  strings — never derived from `:appId`/`:instanceId` param values.
- `App.tsx` adds a small effect that watches `useMatches()` and, whenever the
  deepest match's `handle.rumView` changes, calls
  `trackView(handle.rumView)`. This fires once for the initial route on
  mount, so it also produces the very first "view" — no separate initial-view
  wiring needed.

### 4. Startup, clicks, errors

- **Startup:** `main.tsx` calls `initTelemetry()` as its first statement,
  before `applyPrefs()`. Once the initial route's view fires (§3), `App.tsx`
  additionally calls `trackAction('app_startup')` on first mount, so startup
  is a directly queryable named action rather than something inferred from
  view timing.
- **Top menu clicks:** in `TopNav.tsx`, each `NavLink` in the `NAV_ITEMS` map
  gets `onClick={() => trackAction('nav_click', { label: item.label })}`.
- **Resource panel clicks:** in `ResourcesSidebar.tsx`:
  - Each link inside `SECTIONS` (Community/Read/Learn/Build/Run & Operate)
    gets `onClick={() => trackAction('resource_click', { section: section.heading, label: link.label })}`.
  - Each `NewsSection` item's `onClick` becomes
    `() => { onMarkSeen(); trackAction('resource_click', { section: 'News', label: item.title, kind: key }) }`.
  - Excluded: the footer links ("Powered by Diagrid", "Issues & feedback"),
    the collapse/expand toggle, and the bell buttons — these aren't
    "resource" links.
- **Errors:** RUM's built-in `window.onerror`/unhandled-rejection capture is
  active once `init()` runs — no extra config for that baseline. Additionally,
  `RouteError.tsx` calls `trackError(error)` in its render body, since
  react-router's `errorElement` catches render/loader errors before they'd
  ever surface as an uncaught global exception.

### 5. Package

- Add `@datadog/browser-rum` to `web/package.json` dependencies.
- No `vite.config.ts` changes — no build-time env var, no bundling changes
  beyond the new dependency (dynamic `import()` lets Vite code-split it
  automatically).

## Error handling

- `initTelemetry()` itself does not throw on a slow/failed SDK import or a
  Datadog-side init failure reaching the browser — RUM's `init()` already
  handles its own transport failures internally; nothing in the dashboard's
  own code depends on telemetry succeeding.
- `trackAction`/`trackError`/`trackView` are fire-and-forget: no return value
  callers need to check, no failure path that affects the calling UI code.

## Testing

- New `web/src/lib/telemetry.test.tsx`:
  - `window.__DASH_TELEMETRY_ENABLED__` unset/false → the `@datadog/browser-rum`
    module is never imported (spy on the dynamic import), and
    `trackAction`/`trackError`/`trackView` are silent no-ops.
  - `window.__DASH_TELEMETRY_ENABLED__ = true` → `datadogRum.init()` is
    called with the expected config object; `trackAction`/`trackError`/
    `trackView` delegate to `addAction`/`addError`/`startView` with the given
    args.
- `TopNav.test.tsx`: clicking a nav item calls `trackAction('nav_click', { label })`
  (mock `../lib/telemetry`).
- `ResourcesSidebar.test.tsx`: clicking a section link and a news item each
  call `trackAction('resource_click', ...)` with the right `section`/`label`;
  the news click still calls `onMarkSeen`.
- `RouteError.test.tsx`: rendering with a thrown error calls
  `trackError(error)`.
- `App.test.tsx` (or a new test): mounting fires `trackAction('app_startup')`
  and `trackView('Applications')` for the default route.
- Go: `pkg/server/spa_test.go` — assert the served HTML contains
  `window.__DASH_TELEMETRY_ENABLED__=true` / `=false` per `Options.TelemetryEnabled`.
  `cmd/root_test.go` (or equivalent) — assert `DEVDASHBOARD_TELEMETRY_OPTOUT=true`
  (and case variants) flip `Options.TelemetryEnabled` to `false`, and that
  unset/other values leave it `true`.

## Documentation

- Short section in `README.md`: what's tracked (startup, nav clicks, resource
  clicks, errors), what's explicitly not collected (no session replay, no
  dashboard content/resource names — route views use fixed labels), and how
  to opt out (`DEVDASHBOARD_TELEMETRY_OPTOUT=true`, restart required).
