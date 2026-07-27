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
errors can be segmented and filtered by mode in Datadog.

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
- **Per-app runtime** is available on each `AppSummary` as `source`
  (`standalone`/`compose`/`testcontainers`/`aspire`/`auto`) plus an `isAspire` flag.
  `web/src/lib/modeLabel.ts` maps these to *pretty UI labels* ("Dapr run",
  "TestContainers", …). The apps list is fetched by `useApps()`
  (`web/src/hooks/useApps.ts`) and polled on the global refresh interval.

No server-side or configuration change is required — all needed data is already
client-side.

## The two notions of "mode"

There are two distinct, complementary signals. We capture **both**:

1. **`mode_filter`** — the CLI `--mode` filter the user chose. Static, known at page
   load, always present. Empty (`''`) means a complete scan; we normalize that to `"all"`.
2. **`runtimes`** — the set of runtimes *actually discovered* among running apps. Dynamic;
   in a complete scan the user may be running a mix. Populates after the first apps poll.

Capturing both means an error carries both what the user asked to scan and what was
really running.

## Design

### RUM global context

Use Datadog RUM **global context**, which attaches attributes to *every* event in the
session (views, actions, resources, long tasks, and errors). Two flat properties:

| Property      | Type       | Example                | Meaning                                    |
| ------------- | ---------- | ---------------------- | ------------------------------------------ |
| `mode_filter` | `string`   | `"compose"` / `"all"`  | CLI `--mode` value (`''` → `"all"`)         |
| `runtimes`    | `string[]` | `["compose","aspire"]` | Distinct runtimes among discovered apps    |

In Datadog these surface as `@context.mode_filter` and `@context.runtimes`, filterable on
any RUM event including Error events. Flat keys (no dots) are used deliberately to avoid
nested-facet ambiguity.

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

1. **`telemetry.ts` — new wrapper.** One thin function matching the existing pattern:

   ```ts
   /** Sets a RUM global-context property, once enabled. Buffered until
    * initTelemetry() has resolved; dropped if telemetry is disabled. */
   export function setTelemetryContext(key: string, value: unknown): void {
     runOrBuffer((r) => r.setGlobalContextProperty(key, value))
   }
   ```

   No change to `initTelemetry()` itself.

2. **`runtimeToken(app)` — new pure helper** in `web/src/lib/runtimeToken.ts`. Maps
   `Pick<AppSummary, 'source' | 'isAspire'>` to a canonical token or `undefined`. Sibling
   to `modeLabel.ts`, which stays for pretty UI labels. Kept separate because the two
   vocabularies differ (canonical telemetry tokens vs. human labels).

3. **`useModeTelemetry()` — new hook** in `web/src/hooks/useModeTelemetry.ts`. One job:
   keep RUM global context in sync with the current mode. Mounted **once** in `App.tsx`.
   - On mount: `setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))`.
   - Subscribes to `useApps()` (shared react-query cache — no extra network request):
     whenever the data changes, compute the sorted, de-duplicated set of `runtimeToken`s
     over the apps and call `setTelemetryContext('runtimes', tokens)`. Sorting keeps the
     array stable so identical sets don't churn RUM context.

4. **`App.tsx`** — call `useModeTelemetry()` once, alongside the existing startup/view
   tracking effects.

### Data flow

```
window.__DASH_CAPABILITIES__.mode ─► getCapabilities().mode ─► normalizeModeFilter ─┐
                                                                                     ├─► setTelemetryContext ─► RUM global context ─► every RUM event
GET /api/apps ─► useApps() ─► apps[] ─► runtimeToken(each) ─► distinct sorted set ──┘
```

## Behavior & edge cases

- **Telemetry disabled:** `setTelemetryContext` no-ops via the existing `runOrBuffer`
  guard; the SDK is never loaded. No behavior change.
- **Ordering:** `mode_filter` is set at mount, which may fire before `initTelemetry()`
  resolves. Buffering guarantees it flushes in order once RUM is ready, so it is present
  on the earliest reported error.
- **`runtimes` timing:** absent until the first successful apps poll. Early errors still
  carry `mode_filter`, so at least one mode dimension is always present.
- **Empty apps / all-unknown sources:** `runtimes` is set to `[]`. This is a meaningful
  signal (dashboard running, nothing discovered) and distinct from "not yet loaded".
- **Mode changes:** `mode_filter` is fixed for a server process lifetime; the hook sets it
  once. `runtimes` updates live as apps start/stop across polls.
- **No config/server change:** `env` stays `'prod'`; no new injected globals.

## Testing

- **`telemetry.test.tsx`:** add `setGlobalContextProperty` to the RUM mock. Assert
  `setTelemetryContext` (a) delegates to `setGlobalContextProperty` once enabled, (b)
  buffers a call made before `initTelemetry()` resolves and flushes it, (c) does nothing
  when telemetry is disabled.
- **`runtimeToken.test.ts`:** every source, the `isAspire` override beating `standalone`,
  and unknown/`auto` → `undefined`.
- **`useModeTelemetry.test.tsx`:** render with a mocked `useApps` result and stubbed
  telemetry; assert the correct `mode_filter` call (including `''` → `"all"`) and the
  distinct, sorted `runtimes` call. Verify duplicate sources collapse to one token.

## Out of scope

- Server-side telemetry / backend tagging (RUM is client-only here).
- Session Replay, sampling changes, or new RUM config.
- Per-view or per-action mode attributes (global context already covers all events).
