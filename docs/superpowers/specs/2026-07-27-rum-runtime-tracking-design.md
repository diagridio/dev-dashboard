# RUM Runtime (Language) Tracking — Design

**Date:** 2026-07-27
**Status:** Approved, ready for implementation plan
**Builds on:** `2026-07-27-rum-mode-tracking-design.md` (same branch `feat/rum-mode-tracking`, PR #78)

## Problem

The RUM mode-tracking work (PR #78) tags every event with the discovery *mode*
(`dapr-run`/`compose`/`test-containers`/`aspire`). It does not capture the app's
*language/runtime* — whether the failing app is written in .NET, Python, Go, Node, Java,
or Rust. Language is a strong, complementary root-cause signal: SDK behavior, sidecar
integration, and failure modes differ by language, and "all the errors are from the Java
apps" is exactly the kind of segmentation RUM should support.

## Goal

Attach the app's language/runtime to RUM events — especially errors — alongside the
existing mode dimensions, so errors can be segmented by language, including the language
of the specific app in focus when an error fires.

## What already exists

- **The language is already detected.** Each app carries a `runtime: string` field
  (`web/src/types/api.ts`), populated server-side by `InferRuntime` /
  `InferRuntimeFromImage` / `InferRuntimeFromEnv` (`pkg/discovery/infer.go`) from the
  launch command, container image, or inherited env vars. `runtimeSwatch`
  (`web/src/lib/runtimeSwatch.ts`) already color-codes these languages in the UI.
- **The vocabulary is fixed and canonical** (from `InferRuntime`):
  `go` · `python` · `node` · `dotnet` · `java` · `rust`, plus `unknown` (and, defensively,
  possibly empty) for apps whose language could not be inferred.
- **The RUM plumbing is in place** from the mode work: `setTelemetryContext` /
  `removeTelemetryContext` global-context wrappers (`web/src/lib/telemetry.ts`), a
  session-wide hook mounted once in `App.tsx`, and a focused-app hook mounted in
  `AppDetail`. This design extends those two hooks rather than adding parallel ones.

No server or configuration change is required — `runtime` already flows on every app.

## The two new signals

Two RUM global-context properties, joining the existing `mode_filter`/`modes`/`app_mode`:

1. **`runtimes`** — the distinct, sorted set of app languages actually discovered among
   running apps. Dynamic; updates as the apps list changes. The session-wide counterpart
   of `modes`.
2. **`app_runtime`** — the language of the *single app the user is currently focused on*
   (its detail page). Present only while a specific app is in focus. The counterpart of
   `app_mode`, and the property that pins the failing app's language when an error fires.

## Design

### RUM global context

| Property      | Type       | Example             | Meaning                                             |
| ------------- | ---------- | ------------------- | --------------------------------------------------- |
| `runtimes`    | `string[]` | `["dotnet","go"]`   | Distinct languages among discovered apps            |
| `app_runtime` | `string`   | `"dotnet"`          | Language of the app currently in focus (detail page)|

In Datadog these surface as `@context.runtimes` and `@context.app_runtime`, filterable on
any RUM event including Error events. Flat keys (no dots), consistent with the mode
properties. `app_runtime` is *absent* when no specific app is in focus (e.g. the apps
list); it is set when an app detail page mounts and removed when it unmounts, so a later
error is never attributed to a previously-viewed app.

### Vocabulary

Values come straight from the backend's `InferRuntime` vocabulary:

```
go · python · node · dotnet · java · rust
```

`unknown` and empty are treated as "no language" and **omitted** — never sent as a value.
This mirrors how an unknown discovery mode yields no token.

### Components

1. **`runtimeToken(runtime)` — new pure helper** in `web/src/lib/runtimeToken.ts`. Sibling
   of `modeToken.ts`.

   ```ts
   export function runtimeToken(runtime: string | undefined): string | undefined
   ```

   Lowercases/trims the input and returns it if it is one of the six known tokens
   (`go`/`python`/`node`/`dotnet`/`java`/`rust`), else `undefined` (covers `"unknown"`,
   `""`, and any bespoke string). Defensive normalization keeps a stray-cased or padded
   value from leaking, though `runtime` is expected already-canonical.

2. **`useDistinctSetContext(property, data, tokens)` — extracted internal helper** in the
   session hook's module. Encapsulates the churn-guarded "set a global-context array when
   the distinct set changes, not before data loads" logic that `modes` already uses, so
   `modes` and `runtimes` share one implementation instead of duplicating the join-key
   effect. Signature:

   ```ts
   // property: the RUM global-context key; data: the raw useApps() data (undefined until
   // loaded); tokens: the already-computed distinct, sorted token array.
   function useDistinctSetContext(property: string, data: unknown, tokens: string[]): void
   ```

   Behavior: no-op while `data === undefined`; otherwise calls
   `setTelemetryContext(property, tokens)` only when the joined token string changes.

3. **`useDiscoveryTelemetry()` — renamed from `useModeTelemetry`.** Sets `mode_filter`
   once (unchanged), then computes two distinct-sorted token arrays over a single
   `useApps()` subscription — `modes` (via `modeToken`) and `runtimes` (via
   `runtimeToken(app.runtime)`) — and syncs each via `useDistinctSetContext`. Still mounted
   once in `App.tsx`. `normalizeModeFilter` stays exported from this module unchanged.

4. **`useAppTelemetry(app)` — renamed from `useAppModeTelemetry`.** Sets `app_mode`
   (unchanged) and `app_runtime` (via `runtimeToken(app.runtime)`) for the focused app;
   both are removed on unmount and when their token is unknown. Called from
   `AppDetailContent` in `web/src/pages/AppDetail.tsx`.

### Rename scope

The two hooks and their files/tests are renamed to reflect their broadened purpose:

| Before                          | After                          |
| ------------------------------- | ------------------------------ |
| `useModeTelemetry.ts`           | `useDiscoveryTelemetry.ts`     |
| `useModeTelemetry.test.tsx`     | `useDiscoveryTelemetry.test.tsx`|
| `useAppModeTelemetry.ts`        | `useAppTelemetry.ts`           |
| `useAppModeTelemetry.test.tsx`  | `useAppTelemetry.test.tsx`     |

Call sites: `App.tsx` (`useModeTelemetry()` → `useDiscoveryTelemetry()`) and
`AppDetail.tsx` (`useAppModeTelemetry(app)` → `useAppTelemetry(app)`). The `App.tsx`
comment about intentionally keeping `['apps']` polling global is preserved. The RUM
*property* names `mode_filter`/`modes`/`app_mode` are unchanged — only the hook identifiers
change.

### Data flow

```
GET /api/apps ─► useApps() ─► apps[] ─┬─ modeToken(each) ───► distinct sorted ─► setTelemetryContext('modes', …) ───────┐
                                       └─ runtimeToken(each.runtime) ─► distinct sorted ─► setTelemetryContext('runtimes', …) ┼─► RUM global context ─► every event
window.__DASH_CAPABILITIES__.mode ─► normalizeModeFilter ─► setTelemetryContext('mode_filter', …) ────────────────────────────┤
AppDetail app ─► modeToken(app) ─► setTelemetryContext('app_mode', …) ────────────────────────────────────────────────────────┤
              └─ runtimeToken(app.runtime) ─► setTelemetryContext('app_runtime', …) / removeTelemetryContext on unmount ───────┘
```

## Behavior & edge cases

- **Telemetry disabled:** every `setTelemetryContext`/`removeTelemetryContext` call
  no-ops via the existing `runOrBuffer` guard; the SDK is never loaded.
- **`runtimes` timing:** absent until the first successful apps poll (`data === undefined`
  → no call). Set to `[]` when every discovered app has an unknown/empty language — a
  meaningful "apps running, none identifiable" signal, distinct from "not yet loaded".
- **`runtimes` churn:** the shared `useDistinctSetContext` refires only when the joined
  token string changes, so an equivalent set on a later poll does not re-send context.
- **`app_runtime` lifetime:** set when an app detail page mounts, removed on unmount.
  Navigating from app A to app B updates it; navigating to a non-app page removes it. An
  unknown/empty language yields no token, so `app_runtime` stays absent rather than being
  set to a placeholder.
- **Mixed session:** with a Python and a .NET app both running, `runtimes` is
  `["dotnet","python"]`; if the user is on the .NET app's page when an error fires,
  `app_runtime` is `"dotnet"` — pinning the failing app's language even though two
  languages are present.
- **No config/server change:** `env` stays `'prod'`; no new injected globals.

## Testing

- **`runtimeToken.test.ts`:** each of the six known languages → its token; `"unknown"`,
  `""`, `undefined`, and a bespoke string → `undefined`; a mixed-case/padded value (e.g.
  `" DotNet "`) normalizes to `"dotnet"`.
- **`useDiscoveryTelemetry.test.tsx`** (renamed): existing `mode_filter`/`modes` cases
  preserved, plus `runtimes` — distinct + sorted across apps, `[]` when all unknown, no
  call before load, and the churn guard (equivalent set on a new array reference → single
  `runtimes` call; changed set → a second call).
- **`useAppTelemetry.test.tsx`** (renamed): existing `app_mode` cases preserved, plus
  `app_runtime` — set on mount with the correct token, removed on unmount, sets nothing
  for an unknown language, and updates when the focused app changes.
- If `useDistinctSetContext` is unit-tested directly, cover the not-loaded, empty-set, and
  change-vs-no-change paths; otherwise its behavior is covered through the two set cases
  (`modes`, `runtimes`) in the discovery hook test.

## Out of scope

- Server-side telemetry / backend tagging (RUM is client-only here).
- Changing the language-inference logic itself (`InferRuntime` and friends stay as-is);
  this design only surfaces the already-detected `runtime` value.
- The Dapr sidecar runtime/version (`runtimeVersion`) — this design is about the app's
  programming language, not the Dapr build.
- Session Replay, sampling, or new RUM config.
