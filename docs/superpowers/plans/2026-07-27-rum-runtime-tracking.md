# RUM Runtime (Language) Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach the app's detected language/runtime (`go`/`python`/`node`/`dotnet`/`java`/`rust`) to Datadog RUM events via two new global-context properties — `runtimes` (session-wide set) and `app_runtime` (focused app) — alongside the existing mode properties.

**Architecture:** Increment on the merged mode-tracking work. A pure `runtimeToken()` helper normalizes the app's `runtime` field into the canonical language vocabulary (unknown/empty → omitted). The two existing telemetry hooks are renamed to reflect their broadened purpose and extended: `useModeTelemetry` → `useDiscoveryTelemetry` (also emits `runtimes`, with the `modes` churn-guard extracted into a shared `useDistinctSetContext` helper), and `useAppModeTelemetry` → `useAppTelemetry` (also emits `app_runtime`). No server or config change — `runtime` already flows on every app.

**Tech Stack:** React 18 + TypeScript, `@datadog/browser-rum` ^7.5.0, `@tanstack/react-query`, Vitest + `@testing-library/react`.

## Global Constraints

- **Typecheck every `.ts`/`.tsx` change** — Vitest does not typecheck. Run `cd web && npx tsc -b` after any source or test edit; a green Vitest run alone is not sufficient.
- **Language vocabulary (verbatim, from backend `InferRuntime`):** `go` · `python` · `node` · `dotnet` · `java` · `rust`. `unknown`, `""`, and any unrecognized value → **omitted** (never sent as a value).
- **RUM property names (verbatim, flat, no dots):** `runtimes` (string[]), `app_runtime` (string). Existing `mode_filter`/`modes`/`app_mode` names are unchanged.
- **Renames (verbatim):** hook `useModeTelemetry` → `useDiscoveryTelemetry`; hook `useAppModeTelemetry` → `useAppTelemetry`; files renamed to match; `normalizeModeFilter` stays exported from the discovery hook's module. RUM property names do NOT change — only the hook identifiers.
- **Use `git mv`** for file renames so history is preserved.
- **Follow existing patterns:** `runtimeToken` is a sibling of `web/src/lib/modeToken.ts`; telemetry writes go through the existing buffered `setTelemetryContext`/`removeTelemetryContext` (no-op when telemetry disabled).
- **Preserve the `App.tsx` comment** noting that `['apps']` polling is intentionally kept global.

---

## File Structure

- `web/src/lib/runtimeToken.ts` (create) — pure `runtimeToken(runtime)` → canonical language token | `undefined`.
- `web/src/lib/runtimeToken.test.ts` (create) — unit tests.
- `web/src/hooks/useModeTelemetry.ts` → `web/src/hooks/useDiscoveryTelemetry.ts` (rename + extend) — adds `runtimes`, extracts `useDistinctSetContext`.
- `web/src/hooks/useModeTelemetry.test.tsx` → `web/src/hooks/useDiscoveryTelemetry.test.tsx` (rename + extend).
- `web/src/hooks/useAppModeTelemetry.ts` → `web/src/hooks/useAppTelemetry.ts` (rename + extend) — adds `app_runtime`.
- `web/src/hooks/useAppModeTelemetry.test.tsx` → `web/src/hooks/useAppTelemetry.test.tsx` (rename + extend).
- `web/src/App.tsx` (modify) — import + call rename.
- `web/src/pages/AppDetail.tsx` (modify) — import + call rename.

---

## Task 1: `runtimeToken` helper

**Files:**
- Create: `web/src/lib/runtimeToken.ts`
- Test: `web/src/lib/runtimeToken.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `export function runtimeToken(runtime: string | undefined): string | undefined` — returns one of `'go' | 'python' | 'node' | 'dotnet' | 'java' | 'rust'`, or `undefined` for unknown/empty/unrecognized input.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/runtimeToken.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { runtimeToken } from './runtimeToken'

describe('runtimeToken', () => {
  it('returns the token for each known language', () => {
    for (const lang of ['go', 'python', 'node', 'dotnet', 'java', 'rust']) {
      expect(runtimeToken(lang)).toBe(lang)
    }
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(runtimeToken(' DotNet ')).toBe('dotnet')
    expect(runtimeToken('GO')).toBe('go')
  })

  it('returns undefined for unknown, empty, or absent values', () => {
    expect(runtimeToken('unknown')).toBeUndefined()
    expect(runtimeToken('')).toBeUndefined()
    expect(runtimeToken(undefined)).toBeUndefined()
    expect(runtimeToken('cobol')).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/runtimeToken.test.ts`
Expected: FAIL — cannot resolve `./runtimeToken`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/lib/runtimeToken.ts`:

```ts
/**
 * Canonical language/runtime token for an app, from its detected `runtime`
 * value (go/python/node/dotnet/java/rust — the backend InferRuntime
 * vocabulary). Returns undefined for an unknown, empty, or unrecognized value
 * so callers can omit it. Sibling of modeToken; kept separate because the two
 * vocabularies are distinct (discovery mode vs. app language). The `runtime`
 * field is expected already-canonical, but the input is lowercased/trimmed
 * defensively so a stray-cased or padded value can't leak.
 */
const KNOWN = new Set(['go', 'python', 'node', 'dotnet', 'java', 'rust'])

export function runtimeToken(runtime: string | undefined): string | undefined {
  if (!runtime) return undefined
  const r = runtime.trim().toLowerCase()
  return KNOWN.has(r) ? r : undefined
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/runtimeToken.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/runtimeToken.ts web/src/lib/runtimeToken.test.ts
git commit -m "feat(telemetry): add runtimeToken helper for canonical language tokens"
```

---

## Task 2: Rename `useAppModeTelemetry` → `useAppTelemetry` and add `app_runtime`

**Files:**
- Rename: `web/src/hooks/useAppModeTelemetry.ts` → `web/src/hooks/useAppTelemetry.ts`
- Rename: `web/src/hooks/useAppModeTelemetry.test.tsx` → `web/src/hooks/useAppTelemetry.test.tsx`
- Modify: `web/src/pages/AppDetail.tsx` (import line 16, call line 23)

**Interfaces:**
- Consumes: `modeToken` (`web/src/lib/modeToken.ts`), `runtimeToken` (Task 1), `setTelemetryContext`/`removeTelemetryContext` (`web/src/lib/telemetry.ts`), `AppSummary` type.
- Produces: `export function useAppTelemetry(app: Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>): void` — sets `app_mode` (unchanged) and `app_runtime` for the focused app; both removed on unmount / when unknown.

- [ ] **Step 1: Rename the files with git mv**

```bash
git mv web/src/hooks/useAppModeTelemetry.ts web/src/hooks/useAppTelemetry.ts
git mv web/src/hooks/useAppModeTelemetry.test.tsx web/src/hooks/useAppTelemetry.test.tsx
```

- [ ] **Step 2: Rename identifiers in the hook (no new behavior yet)**

Replace the entire contents of `web/src/hooks/useAppTelemetry.ts` with (function renamed, param type widened to include `runtime`, doc updated; still only sets `app_mode`):

```ts
import { useEffect } from 'react'
import type { AppSummary } from '../types/api'
import { modeToken } from '../lib/modeToken'
import { setTelemetryContext, removeTelemetryContext } from '../lib/telemetry'

/**
 * Keeps RUM per-app global-context properties in sync with the app the user
 * is currently focused on (its detail page): `app_mode` (discovery mode) and
 * `app_runtime` (language). Each is set on mount / when its value changes and
 * removed on unmount, so an error on a later, non-app page is never attributed
 * to a previously-viewed app. An unknown/absent value sets nothing.
 */
export function useAppTelemetry(app: Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>): void {
  const mode = modeToken(app)
  useEffect(() => {
    if (mode) setTelemetryContext('app_mode', mode)
    return () => removeTelemetryContext('app_mode')
  }, [mode])
}
```

- [ ] **Step 3: Update the renamed test file: rename identifiers AND add the new `app_runtime` tests**

Replace the entire contents of `web/src/hooks/useAppTelemetry.test.tsx` with:

```ts
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const removeTelemetryContextMock = vi.fn()

vi.mock('../lib/telemetry', () => ({
  setTelemetryContext: setTelemetryContextMock,
  removeTelemetryContext: removeTelemetryContextMock,
}))

type FocusApp = Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  removeTelemetryContextMock.mockClear()
})

describe('useAppTelemetry — app_mode', () => {
  it('sets app_mode to the focused app token', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'compose' } as FocusApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'compose')
  })

  it('removes app_mode on unmount', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { unmount } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'aspire' } as FocusApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_mode')
  })

  it('sets no app_mode for an unknown/absent source', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: {} as FocusApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('app_mode', expect.anything())
  })

  it('updates app_mode when the focused app changes', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { rerender } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { source: 'compose' } as FocusApp },
    })
    rerender({ app: { source: 'standalone' } as FocusApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'dapr-run')
  })
})

describe('useAppTelemetry — app_runtime', () => {
  it('sets app_runtime to the focused app language token', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'dotnet' } as FocusApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_runtime', 'dotnet')
  })

  it('removes app_runtime on unmount', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { unmount } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'go' } as FocusApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_runtime')
  })

  it('sets no app_runtime for an unknown language', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'unknown' } as FocusApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('app_runtime', expect.anything())
  })

  it('updates app_runtime when the focused app language changes', async () => {
    const { useAppTelemetry } = await import('./useAppTelemetry')
    const { rerender } = renderHook(({ app }: { app: FocusApp }) => useAppTelemetry(app), {
      initialProps: { app: { runtime: 'go' } as FocusApp },
    })
    rerender({ app: { runtime: 'python' } as FocusApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_runtime', 'python')
  })
})
```

- [ ] **Step 4: Update the call site in `AppDetail.tsx`**

In `web/src/pages/AppDetail.tsx`, change the import (line 16) from:

```ts
import { useAppModeTelemetry } from '../hooks/useAppModeTelemetry'
```
to:
```ts
import { useAppTelemetry } from '../hooks/useAppTelemetry'
```

And the call (line 23) from:

```ts
  useAppModeTelemetry(app)
```
to:
```ts
  useAppTelemetry(app)
```

- [ ] **Step 5: Run tests to verify the new app_runtime tests fail (RED)**

Run: `cd web && npx vitest run src/hooks/useAppTelemetry.test.tsx`
Expected: the 4 `app_mode` tests PASS; the three `app_runtime` tests with a positive assertion FAIL (`app_runtime` is never set — no matching `setTelemetryContext` call), and the "sets no app_runtime for an unknown language" test PASSES trivially (its assertion is negative).

- [ ] **Step 6: Implement `app_runtime` in the hook**

Replace the entire contents of `web/src/hooks/useAppTelemetry.ts` with:

```ts
import { useEffect } from 'react'
import type { AppSummary } from '../types/api'
import { modeToken } from '../lib/modeToken'
import { runtimeToken } from '../lib/runtimeToken'
import { setTelemetryContext, removeTelemetryContext } from '../lib/telemetry'

/**
 * Keeps RUM per-app global-context properties in sync with the app the user
 * is currently focused on (its detail page): `app_mode` (discovery mode) and
 * `app_runtime` (language). Each is set on mount / when its value changes and
 * removed on unmount, so an error on a later, non-app page is never attributed
 * to a previously-viewed app. An unknown/absent value sets nothing.
 */
export function useAppTelemetry(app: Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>): void {
  const mode = modeToken(app)
  useEffect(() => {
    if (mode) setTelemetryContext('app_mode', mode)
    return () => removeTelemetryContext('app_mode')
  }, [mode])

  const runtime = runtimeToken(app.runtime)
  useEffect(() => {
    if (runtime) setTelemetryContext('app_runtime', runtime)
    return () => removeTelemetryContext('app_runtime')
  }, [runtime])
}
```

- [ ] **Step 7: Run tests + typecheck + lint**

Run: `cd web && npx vitest run src/hooks/useAppTelemetry.test.tsx src/pages/AppDetail.test.tsx && npx tsc -b && npm run lint`
Expected: all 8 hook tests PASS, AppDetail suite PASS, `tsc` exits 0, `eslint` 0 errors. (Pre-existing warnings in untouched files are fine.)

- [ ] **Step 8: Commit**

```bash
git add web/src/hooks/useAppTelemetry.ts web/src/hooks/useAppTelemetry.test.tsx web/src/pages/AppDetail.tsx
git commit -m "feat(telemetry): rename useAppModeTelemetry->useAppTelemetry, add app_runtime"
```

---

## Task 3: Rename `useModeTelemetry` → `useDiscoveryTelemetry`, extract `useDistinctSetContext`, add `runtimes`

**Files:**
- Rename: `web/src/hooks/useModeTelemetry.ts` → `web/src/hooks/useDiscoveryTelemetry.ts`
- Rename: `web/src/hooks/useModeTelemetry.test.tsx` → `web/src/hooks/useDiscoveryTelemetry.test.tsx`
- Modify: `web/src/App.tsx` (import line 10, call line 44)

**Interfaces:**
- Consumes: `useApps()` (`web/src/hooks/useApps.ts`, `data: AppSummary[] | undefined`), `getCapabilities()`, `setTelemetryContext`, `modeToken`, `runtimeToken` (Task 1), `AppSummary` type.
- Produces:
  - `export function normalizeModeFilter(mode: string | undefined): string` (unchanged).
  - `export function useDiscoveryTelemetry(): void` — sets `mode_filter` once, `modes` and `runtimes` as the apps list changes.

- [ ] **Step 1: Rename the files with git mv**

```bash
git mv web/src/hooks/useModeTelemetry.ts web/src/hooks/useDiscoveryTelemetry.ts
git mv web/src/hooks/useModeTelemetry.test.tsx web/src/hooks/useDiscoveryTelemetry.test.tsx
```

- [ ] **Step 2: Rename + refactor the hook (extract helper; modes only, no runtimes yet)**

Replace the entire contents of `web/src/hooks/useDiscoveryTelemetry.ts` with (function renamed, churn-guard extracted into `useDistinctSetContext` + `distinctTokens`, still only `modes`):

```ts
import { useEffect, useMemo } from 'react'
import type { AppSummary } from '../types/api'
import { useApps } from './useApps'
import { getCapabilities } from '../lib/capabilities'
import { setTelemetryContext } from '../lib/telemetry'
import { modeToken } from '../lib/modeToken'

/** Normalizes the CLI --mode capability value for telemetry: '' or
 * undefined (complete scan) becomes 'all'; any other value passes through. */
export function normalizeModeFilter(mode: string | undefined): string {
  return mode ? mode : 'all'
}

/** Distinct, sorted set of tokens produced by `fn` over the apps list. */
function distinctTokens(
  data: AppSummary[] | undefined,
  fn: (app: AppSummary) => string | undefined,
): string[] {
  const tokens = new Set<string>()
  for (const app of data ?? []) {
    const t = fn(app)
    if (t) tokens.add(t)
  }
  return [...tokens].sort()
}

/**
 * Syncs a RUM global-context array property with a distinct token set derived
 * from the apps list. No-op until apps have loaded (data === undefined); then
 * refires only when the set changes (join key), so an equivalent set on a
 * later poll doesn't churn RUM context.
 */
function useDistinctSetContext(
  property: string,
  data: AppSummary[] | undefined,
  tokens: string[],
): void {
  const key = data === undefined ? null : tokens.join(',')
  useEffect(() => {
    if (key === null) return
    setTelemetryContext(property, tokens)
    // tokens is derived from the same data as key; keying on key alone is
    // intentional to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/**
 * Keeps RUM global context in sync with what the dashboard has discovered:
 * `mode_filter` (the CLI --mode, set once), `modes` (distinct discovery modes),
 * and `runtimes` (distinct app languages). `modes`/`runtimes` refresh as the
 * apps list changes. Mount exactly once, near the app root.
 */
export function useDiscoveryTelemetry(): void {
  useEffect(() => {
    setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))
  }, [])

  const { data } = useApps()
  const modes = useMemo(() => distinctTokens(data, modeToken), [data])

  useDistinctSetContext('modes', data, modes)
}
```

- [ ] **Step 3: Rename identifiers in the test file AND add the new `runtimes` tests**

Replace the entire contents of `web/src/hooks/useDiscoveryTelemetry.test.tsx` with:

```ts
import { renderHook } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { AppSummary } from '../types/api'

const setTelemetryContextMock = vi.fn()
const useAppsMock = vi.fn()
const getCapabilitiesMock = vi.fn()

vi.mock('../lib/telemetry', () => ({ setTelemetryContext: setTelemetryContextMock }))
vi.mock('./useApps', () => ({ useApps: useAppsMock }))
vi.mock('../lib/capabilities', () => ({ getCapabilities: getCapabilitiesMock }))

function app(source: AppSummary['source'], isAspire = false, runtime = 'dapr'): AppSummary {
  return {
    appId: 'a', health: 'healthy', runtime, httpPort: 1, grpcPort: 2,
    appPort: 3, daprdPid: 4, appPid: 5, cliPid: 6, age: '1m',
    created: '2024-01-01T00:00:00Z', runTemplate: '', source, isAspire,
  }
}

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  useAppsMock.mockReset()
  getCapabilitiesMock.mockReset()
})

describe('normalizeModeFilter', () => {
  it("maps empty/undefined to 'all' and passes other values through", async () => {
    const { normalizeModeFilter } = await import('./useDiscoveryTelemetry')
    expect(normalizeModeFilter('')).toBe('all')
    expect(normalizeModeFilter(undefined)).toBe('all')
    expect(normalizeModeFilter('compose')).toBe('compose')
  })
})

describe('useDiscoveryTelemetry — mode_filter + modes', () => {
  it("sets mode_filter from capabilities ('' -> 'all')", async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('mode_filter', 'all')
  })

  it('does not set modes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'compose' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('modes', expect.anything())
  })

  it('sets the distinct, sorted set of modes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose'), app('standalone'), app('compose'), app('standalone', true)],
    })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', ['aspire', 'compose', 'dapr-run'])
  })

  it('sets an empty modes array when nothing is discovered', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'aspire' })
    useAppsMock.mockReturnValue({ data: [] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', [])
  })

  it('avoids re-sending an equivalent modes set on a new apps array reference, but resends when the set changes', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: [app('compose')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    const { rerender } = renderHook(() => useDiscoveryTelemetry())
    const modesCalls = () => setTelemetryContextMock.mock.calls.filter((c) => c[0] === 'modes')

    expect(modesCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose')] })
    rerender()
    expect(modesCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose'), app('aspire')] })
    rerender()
    expect(modesCalls()).toHaveLength(2)
  })
})

describe('useDiscoveryTelemetry — runtimes', () => {
  it('does not set runtimes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('runtimes', expect.anything())
  })

  it('sets the distinct, sorted set of runtimes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose', false, 'dotnet'), app('standalone', false, 'go'), app('compose', false, 'dotnet')],
    })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('runtimes', ['dotnet', 'go'])
  })

  it('sets an empty runtimes array when no app language is known', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    // default factory runtime 'dapr' is not a known language -> omitted
    useAppsMock.mockReturnValue({ data: [app('compose'), app('standalone')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    renderHook(() => useDiscoveryTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('runtimes', [])
  })

  it('avoids re-sending an equivalent runtimes set on a new apps array reference, but resends when the set changes', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go')] })
    const { useDiscoveryTelemetry } = await import('./useDiscoveryTelemetry')

    const { rerender } = renderHook(() => useDiscoveryTelemetry())
    const runtimeCalls = () => setTelemetryContextMock.mock.calls.filter((c) => c[0] === 'runtimes')

    expect(runtimeCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go')] })
    rerender()
    expect(runtimeCalls()).toHaveLength(1)

    useAppsMock.mockReturnValue({ data: [app('compose', false, 'go'), app('standalone', false, 'python')] })
    rerender()
    expect(runtimeCalls()).toHaveLength(2)
  })
})
```

- [ ] **Step 4: Update the call site in `App.tsx`**

In `web/src/App.tsx`, change the import (line 10) from:

```ts
import { useModeTelemetry } from './hooks/useModeTelemetry'
```
to:
```ts
import { useDiscoveryTelemetry } from './hooks/useDiscoveryTelemetry'
```

And the call (line 44) from:

```ts
  useModeTelemetry()
```
to:
```ts
  useDiscoveryTelemetry()
```

Leave the existing explanatory comment above the call unchanged.

- [ ] **Step 5: Run tests to verify the new runtimes tests fail (RED)**

Run: `cd web && npx vitest run src/hooks/useDiscoveryTelemetry.test.tsx`
Expected: the `normalizeModeFilter` and `mode_filter + modes` tests PASS; the three `runtimes` tests that assert a `runtimes` call FAIL (`runtimes` is never set), and the "does not set runtimes before load" test PASSES trivially.

- [ ] **Step 6: Implement `runtimes` in the hook**

In `web/src/hooks/useDiscoveryTelemetry.ts`, add the `runtimeToken` import after the `modeToken` import:

```ts
import { runtimeToken } from '../lib/runtimeToken'
```

Then, inside `useDiscoveryTelemetry`, after the `modes` memo + its `useDistinctSetContext('modes', …)` call, add:

```ts
  const runtimes = useMemo(() => distinctTokens(data, (app) => runtimeToken(app.runtime)), [data])

  useDistinctSetContext('runtimes', data, runtimes)
```

So the body ends:

```ts
  const { data } = useApps()
  const modes = useMemo(() => distinctTokens(data, modeToken), [data])
  const runtimes = useMemo(() => distinctTokens(data, (app) => runtimeToken(app.runtime)), [data])

  useDistinctSetContext('modes', data, modes)
  useDistinctSetContext('runtimes', data, runtimes)
```

- [ ] **Step 7: Run tests + typecheck + lint**

Run: `cd web && npx vitest run src/hooks/useDiscoveryTelemetry.test.tsx src/App.test.tsx && npx tsc -b && npm run lint`
Expected: all `useDiscoveryTelemetry` tests PASS, App suite PASS, `tsc` exits 0, `eslint` 0 errors (pre-existing warnings only).

- [ ] **Step 8: Commit**

```bash
git add web/src/hooks/useDiscoveryTelemetry.ts web/src/hooks/useDiscoveryTelemetry.test.tsx web/src/App.tsx
git commit -m "feat(telemetry): rename useModeTelemetry->useDiscoveryTelemetry, add runtimes"
```

---

## Task 4: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Confirm no dangling references to the old hook names**

Run: `cd web && grep -rn "useModeTelemetry\|useAppModeTelemetry" src`
Expected: NO output (all references renamed). If any appear, fix them before proceeding.

- [ ] **Step 2: Run the full web test suite**

Run: `cd web && npm test`
Expected: all suites PASS (including `runtimeToken`, `useDiscoveryTelemetry`, `useAppTelemetry`).

- [ ] **Step 3: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: `tsc` exits 0; `eslint` 0 errors. The two intentional `eslint-disable-next-line react-hooks/exhaustive-deps` lines live inside `useDistinctSetContext` in `useDiscoveryTelemetry.ts` — confirm the disable is present directly above the `}, [key])` dependency array.

- [ ] **Step 4: Build**

Run: `cd web && npm run build`
Expected: `tsc -b && vite build` completes with no errors.

- [ ] **Step 5: Commit (only if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore(telemetry): lint/format fixups for RUM runtime tracking"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** `runtimeToken` + vocabulary → Task 1; `runtimes` (session set, churn-guarded, empty-when-all-unknown) → Task 3; `app_runtime` (focused, remove-on-unmount, unknown→omitted, update-on-change) → Task 2; `useDistinctSetContext` extraction → Task 3; hook renames + call sites → Tasks 2 & 3; no-dangling-references + build → Task 4.
- **Vocabulary consistency:** `runtimeToken` returns the same tokens for `runtimes` (via the apps list) and `app_runtime` (via the focused app), so they are comparable in Datadog facets.
- **Out of scope (do not implement):** server-side telemetry, changes to `InferRuntime`, the Dapr `runtimeVersion`, Session Replay/sampling changes, and any change to the `mode_filter`/`modes`/`app_mode` property names.
