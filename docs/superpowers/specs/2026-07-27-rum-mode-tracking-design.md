# RUM Mode Tracking — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation plan

## Problem

Datadog RUM currently tags every event with the build version (`window.__DASH_VERSION__`)
but carries no information about *which application-discovery mode* the dashboard is
running in. When an error is reported, we cannot tell whether the user was running in
`dapr run`, Docker Compose, Testcontainers, or Aspire mode. That dimension is a strong
signal for narrowing down root causes, because discovery, logs, and lifecycle behavior
differ substantially per mode.

## Goal

Attach the discovery mode to every RUM event — especially errors — so RUM sessions and
errors can be segmented and filtered by mode in Datadog. Crucially, this must hold
*regardless of the CLI `--mode`*: even under `--mode all`, when an app the user is running
causes an error, we want to know whether that app runs via `dapr run`, Docker Compose,
Aspire, or Testcontainers.

## What already exists

- **Telemetry wrapper** (`web/src/lib/telemetry.ts`): a thin, buffered wrapper around
  `@datadog/browser-rum`. `initTelemetry()` loads the SDK only when the server-injected
  `window.__DASH_TELEMETRY_ENABLED__` flag is exactly `true`. `trackAction`/`trackError`/
  `trackView` each run against the SDK if ready, otherwise buffer until init resolves, or
  drop permanently when telemetry is disabled (`runOrBuffer`).
- **Mode already flows to the client.** The server injects
  `window.__DASH_CAPABILITIES__` (see `pkg/server/spa.go`), whose `mode` field echoes the
  CLI `--mode` value (`''` = complete scan). The client reads it via
  `getCapabilities().mode` (`web/src/lib/capabilities.ts`).
- **Per-app mode** is available on each `AppSummary` as `source`
  (`standalone`/`compose`/`testcontainers`/`aspire`/`auto`) plus an `isAspire` flag.
  `web/src/lib/modeLabel.ts` maps these to *pretty UI labels* ("Dapr run",
  "TestContainers", …). The apps list is fetched by `useApps()`
  (`web/src/hooks/useApps.ts`) and polled on the global refresh interval.

No server-side or configuration change is required — all needed data is already
client-side.

## The three notions of "mode"

There are three distinct, complementary signals. We capture **all three**:

1. **`mode_filter`** — the CLI `--mode` filter the user chose. Static, known at page
   load, always present. Empty (`''`) means a complete scan; we normalize that to `"all"`.
2. **`modes`** — the set of modes *actually discovered* among running apps. Dynamic;
   in a complete scan the user may be running a mix. Populates after the first apps poll.
3. **`app_mode`** — the discovery mode of the *single app the user is currently focused on*
   (viewing its detail page). Present only while a specific app is in focus.

Why all three, and why `app_mode` matters most for errors: `mode_filter` is what the
user *asked* to scan, and `modes` is the *set* actually running — but when the user is
running a mix (e.g. `--mode all` with both Compose and Aspire apps) and one app breaks,
neither pins down *how the failing app itself runs*. `app_mode` does: RUM auto-captures
most errors (uncaught exceptions, promise rejections, console errors) rather than routing
them through an explicit call site, so the only reliable way to attach the failing app's
mode is to keep it in global context while that app is in focus. Any error that fires
while the user is on that app's page then carries its mode, regardless of `mode_filter`.

## Design

### RUM global context

Use Datadog RUM **global context**, which attaches attributes to *every* event in the
session (views, actions, resources, long tasks, and errors). Three flat properties:

| Property      | Type       | Example                | Meaning                                                  |
| ------------- | ---------- | ---------------------- | -------------------------------------------------------- |
| `mode_filter` | `string`   | `"compose"` / `"all"`  | CLI `--mode` value (`''` → `"all"`)                       |
| `modes`    | `string[]` | `["compose","aspire"]` | Distinct modes among discovered apps                  |
| `app_mode`    | `string`   | `"compose"`            | Discovery mode of the app currently in focus (detail page only) |

In Datadog these surface as `@context.mode_filter`, `@context.modes`, and
`@context.app_mode`, filterable on any RUM event including Error events. Flat keys (no
dots) are used deliberately to avoid nested-facet ambiguity. `app_mode` is *absent*
when no specific app is in focus (e.g. on the apps list) — it is set when an app detail
page mounts and removed when it unmounts, so a later error is never mis-attributed to a
previously-viewed app.

### Shared vocabulary

Both properties are normalized to one canonical vocabulary so they are directly
comparable in facets:

```
dapr-run · compose · test-containers · aspire
```

This matches the CLI `--mode` vocabulary. App `source`/`isAspire` values map onto it:

| App input                              | Canonical token   |
| -------------------------------------- | ----------------- |
| `isAspire === true` (any source)       | `aspire`          |
| `source === 'aspire'`                  | `aspire`          |
| `source === 'compose'`                 | `compose`         |
| `source === 'testcontainers'`          | `test-containers` |
| `source === 'standalone'`              | `dapr-run`        |
| anything else (e.g. `auto`, unknown)   | *(omitted)*       |

`mode_filter` normalization: a non-empty `getCapabilities().mode` is already in this
vocabulary and passes through; `''` → `"all"` (the only value outside the token set, and
intentionally so — it denotes "no filter / scan everything").

### Components

1. **`telemetry.ts` — two new wrappers.** Thin functions matching the existing pattern
   (buffered until init, dropped if telemetry disabled):

   ```ts
   /** Sets a RUM global-context property, once enabled. Buffered until
    * initTelemetry() has resolved; dropped if telemetry is disabled. */
   export function setTelemetryContext(key: string, value: unknown): void {
     runOrBuffer((r) => r.setGlobalContextProperty(key, value))
   }

   /** Removes a RUM global-context property, once enabled. Buffered until
    * initTelemetry() has resolved; dropped if telemetry is disabled. */
   export function removeTelemetryContext(key: string): void {
     runOrBuffer((r) => r.removeGlobalContextProperty(key))
   }
   ```

   `removeTelemetryContext` (via `removeGlobalContextProperty`) is used to clear
   `app_mode` on unmount — cleaner than storing `undefined`. No change to
   `initTelemetry()` itself.

2. **`modeToken(app)` — new pure helper** in `web/src/lib/modeToken.ts`. Maps
   `Pick<AppSummary, 'source' | 'isAspire'>` to a canonical token or `undefined`. Sibling
   to `modeLabel.ts`, which stays for pretty UI labels. Kept separate because the two
   vocabularies differ (canonical telemetry tokens vs. human labels).

3. **`useModeTelemetry()` — new hook** in `web/src/hooks/useModeTelemetry.ts`. One job:
   keep RUM global context in sync with the current mode. Mounted **once** in `App.tsx`.
   - On mount: `setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))`.
   - Subscribes to `useApps()` (shared react-query cache — no extra network request):
     whenever the data changes, compute the sorted, de-duplicated set of `modeToken`s
     over the apps and call `setTelemetryContext('modes', tokens)`. Sorting keeps the
     array stable so identical sets don't churn RUM context.

4. **`useAppModeTelemetry(app)` — new hook** in
   `web/src/hooks/useAppModeTelemetry.ts`. One job: keep `app_mode` in sync with the
   app currently in focus. Called by `AppDetail` once the app has loaded.
   - When the app's mode token changes:
     `setTelemetryContext('app_mode', modeToken(app))` (skipped when the token is
     `undefined`, e.g. an `auto`/unknown source).
   - On unmount (or when the token becomes `undefined`):
     `removeTelemetryContext('app_mode')`, so an error on a later, non-app page is not
     attributed to this app.

5. **`App.tsx`** — call `useModeTelemetry()` once, alongside the existing startup/view
   tracking effects.

6. **`AppDetail.tsx`** — call `useAppModeTelemetry(app)` from `AppDetailContent`, which
   already has the loaded `app` (with `source`/`isAspire`) via `useApp()`. `modeToken`
   is reused here — no new mapping. (The same pattern generalizes to other app-specific
   pages such as `WorkflowDetail`, but only `AppDetail` is in scope now.)

### Data flow

```
window.__DASH_CAPABILITIES__.mode ─► getCapabilities().mode ─► normalizeModeFilter ─► setTelemetryContext('mode_filter', …) ─┐
GET /api/apps ─► useApps() ─► apps[] ─► modeToken(each) ─► distinct sorted set ─► setTelemetryContext('modes', […]) ────┼─► RUM global context ─► every RUM event
AppDetail app ─► modeToken(app) ─► setTelemetryContext('app_mode', …) / removeTelemetryContext on unmount ─────────────┘
```

## Behavior & edge cases

- **Telemetry disabled:** `setTelemetryContext` no-ops via the existing `runOrBuffer`
  guard; the SDK is never loaded. No behavior change.
- **Ordering:** `mode_filter` is set at mount, which may fire before `initTelemetry()`
  resolves. Buffering guarantees it flushes in order once RUM is ready, so it is present
  on the earliest reported error.
- **`modes` timing:** absent until the first successful apps poll. Early errors still
  carry `mode_filter`, so at least one mode dimension is always present.
- **Empty apps / all-unknown sources:** `modes` is set to `[]`. This is a meaningful
  signal (dashboard running, nothing discovered) and distinct from "not yet loaded".
- **Mode changes:** `mode_filter` is fixed for a server process lifetime; the hook sets it
  once. `modes` updates live as apps start/stop across polls.
- **`app_mode` lifetime:** set when an app detail page mounts, removed on unmount.
  Navigating from app A's page to app B's updates it to B; navigating to a non-app page
  removes it. An unknown/`auto` source yields no token, so `app_mode` stays absent
  rather than being set to a placeholder.
- **No config/server change:** `env` stays `'prod'`; no new injected globals.

## Testing

- **`telemetry.test.tsx`:** add `setGlobalContextProperty` and `removeGlobalContextProperty`
  to the RUM mock. Assert `setTelemetryContext`/`removeTelemetryContext` (a) delegate to
  the matching SDK method once enabled, (b) buffer a call made before `initTelemetry()`
  resolves and flush it, (c) do nothing when telemetry is disabled.
- **`modeToken.test.ts`:** every source, the `isAspire` override beating `standalone`,
  and unknown/`auto` → `undefined`.
- **`useModeTelemetry.test.tsx`:** render with a mocked `useApps` result and stubbed
  telemetry; assert the correct `mode_filter` call (including `''` → `"all"`) and the
  distinct, sorted `modes` call. Verify duplicate sources collapse to one token.
- **`useAppModeTelemetry.test.tsx`:** render with an app; assert
  `setTelemetryContext('app_mode', …)` fires with the right token, that unmount calls
  `removeTelemetryContext('app_mode')`, and that an unknown/`auto`-source app sets
  nothing.

## Out of scope

- Server-side telemetry / backend tagging (RUM is client-only here).
- Session Replay, sampling changes, or new RUM config.
- Per-view or per-action mode attributes (global context already covers all events).
