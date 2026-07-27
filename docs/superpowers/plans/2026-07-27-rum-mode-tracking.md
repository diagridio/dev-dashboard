# RUM Mode Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attach the dashboard's discovery mode to every Datadog RUM event (especially errors) via global context, so RUM sessions and errors can be segmented by mode — including the mode of the specific app in focus when an error fires.

**Architecture:** Three RUM global-context properties, all in one shared vocabulary (`dapr-run`/`compose`/`test-containers`/`aspire`): `mode_filter` (the CLI `--mode`, set once at startup), `modes` (the distinct set of modes among discovered apps, updated as the apps list changes), and `app_mode` (the mode of the single app whose detail page is in focus, set on mount and removed on unmount). A pure `modeToken()` helper normalizes app `source`/`isAspire` into the vocabulary; two thin telemetry wrappers set/remove global-context properties following the existing buffered-until-init pattern; two hooks wire the data into RUM.

**Tech Stack:** React 18 + TypeScript, `@datadog/browser-rum` ^7.5.0, `@tanstack/react-query`, Vitest + `@testing-library/react` + msw.

## Global Constraints

- **Typecheck every `.ts`/`.tsx` change** — Vitest does not typecheck. Run `cd web && npx tsc -b` after any source or test edit; a green Vitest run alone is not sufficient.
- **Telemetry vocabulary (verbatim):** `dapr-run` · `compose` · `test-containers` · `aspire`. `mode_filter` empty (`''`, complete scan) normalizes to `all`.
- **RUM property names (verbatim, flat, no dots):** `mode_filter` (string), `modes` (string[]), `app_mode` (string).
- **No config/server change.** `env` stays `'prod'`; no new injected globals. All data is already client-side (`window.__DASH_CAPABILITIES__.mode`, `GET /api/apps`).
- **Aspire wins:** `isAspire === true` maps to `aspire` regardless of `source`, matching `web/src/lib/modeLabel.ts`.
- **Follow existing patterns:** telemetry wrappers mirror `trackAction`/`trackError` (buffered via `runOrBuffer`); the new mode helper is a sibling of `modeLabel.ts`.

---

## File Structure

- `web/src/lib/modeToken.ts` (create) — pure `modeToken(app)` → canonical token | `undefined`. Sibling of `modeLabel.ts`.
- `web/src/lib/modeToken.test.ts` (create) — unit tests for the helper.
- `web/src/lib/telemetry.ts` (modify) — add `setTelemetryContext` and `removeTelemetryContext` wrappers.
- `web/src/lib/telemetry.test.tsx` (modify) — extend RUM mock + tests for the two wrappers.
- `web/src/hooks/useModeTelemetry.ts` (create) — sets `mode_filter` once and `modes` as apps change. Exports `normalizeModeFilter`.
- `web/src/hooks/useModeTelemetry.test.tsx` (create) — hook tests.
- `web/src/hooks/useAppModeTelemetry.ts` (create) — sets `app_mode` for the focused app; removes on unmount.
- `web/src/hooks/useAppModeTelemetry.test.tsx` (create) — hook tests.
- `web/src/App.tsx` (modify) — mount `useModeTelemetry()` once.
- `web/src/pages/AppDetail.tsx` (modify) — call `useAppModeTelemetry(app)` in `AppDetailContent`.

---

## Task 1: `modeToken` helper

**Files:**
- Create: `web/src/lib/modeToken.ts`
- Test: `web/src/lib/modeToken.test.ts`

**Interfaces:**
- Consumes: `AppSummary` type from `web/src/types/api.ts` (fields `source?: 'standalone' | 'compose' | 'aspire' | 'testcontainers'`, `isAspire?: boolean`).
- Produces: `export function modeToken(app: Pick<AppSummary, 'source' | 'isAspire'>): string | undefined` — returns one of `'dapr-run' | 'compose' | 'test-containers' | 'aspire'`, or `undefined` for unknown/absent source.

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/modeToken.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { modeToken } from './modeToken'

describe('modeToken', () => {
  it('maps each source to its canonical token', () => {
    expect(modeToken({ source: 'standalone' })).toBe('dapr-run')
    expect(modeToken({ source: 'compose' })).toBe('compose')
    expect(modeToken({ source: 'testcontainers' })).toBe('test-containers')
    expect(modeToken({ source: 'aspire' })).toBe('aspire')
  })

  it('prefers the Aspire flag over the standalone source', () => {
    expect(modeToken({ source: 'standalone', isAspire: true })).toBe('aspire')
  })

  it('returns undefined for an absent or unknown source', () => {
    expect(modeToken({ source: undefined })).toBeUndefined()
    expect(modeToken({})).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/modeToken.test.ts`
Expected: FAIL — cannot resolve `./modeToken` / `modeToken is not a function`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/lib/modeToken.ts`:

```ts
import type { AppSummary } from '../types/api'

/**
 * Canonical discovery-mode token for an app, in the CLI --mode vocabulary
 * (dapr-run/compose/test-containers/aspire). Returns undefined for an
 * absent or unknown source so callers can omit it. The Aspire flag wins
 * over source, matching modeLabel.ts. Distinct from modeLabel (pretty UI
 * labels) because telemetry needs stable, filterable tokens.
 */
export function modeToken(app: Pick<AppSummary, 'source' | 'isAspire'>): string | undefined {
  if (app.isAspire || app.source === 'aspire') return 'aspire'
  switch (app.source) {
    case 'compose':
      return 'compose'
    case 'testcontainers':
      return 'test-containers'
    case 'standalone':
      return 'dapr-run'
    default:
      return undefined
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/modeToken.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc -b`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/modeToken.ts web/src/lib/modeToken.test.ts
git commit -m "feat(telemetry): add modeToken helper for canonical mode tokens"
```

---

## Task 2: telemetry global-context wrappers

**Files:**
- Modify: `web/src/lib/telemetry.ts`
- Test: `web/src/lib/telemetry.test.tsx`

**Interfaces:**
- Consumes: existing `runOrBuffer(fn: (r: Rum) => void)` in `telemetry.ts`; the RUM SDK methods `setGlobalContextProperty(key: string, value: unknown)` and `removeGlobalContextProperty(key: string)`.
- Produces:
  - `export function setTelemetryContext(key: string, value: unknown): void`
  - `export function removeTelemetryContext(key: string): void`

- [ ] **Step 1: Write the failing test**

In `web/src/lib/telemetry.test.tsx`, add the two new mock methods to the existing `vi.mock('@datadog/browser-rum', …)` block. Change the mock object to:

```ts
const initMock = vi.fn()
const addActionMock = vi.fn()
const addErrorMock = vi.fn()
const startViewMock = vi.fn()
const setGlobalContextPropertyMock = vi.fn()
const removeGlobalContextPropertyMock = vi.fn()

vi.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: initMock,
    addAction: addActionMock,
    addError: addErrorMock,
    startView: startViewMock,
    setGlobalContextProperty: setGlobalContextPropertyMock,
    removeGlobalContextProperty: removeGlobalContextPropertyMock,
  },
}))
```

Add `setGlobalContextPropertyMock.mockClear()` and `removeGlobalContextPropertyMock.mockClear()` to the existing `beforeEach`.

Then add this `describe` block to the file:

```ts
describe('setTelemetryContext / removeTelemetryContext', () => {
  it('delegates to the RUM SDK once enabled', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, setTelemetryContext, removeTelemetryContext } = await import('./telemetry')
    await initTelemetry()

    setTelemetryContext('mode_filter', 'compose')
    expect(setGlobalContextPropertyMock).toHaveBeenCalledWith('mode_filter', 'compose')

    removeTelemetryContext('app_mode')
    expect(removeGlobalContextPropertyMock).toHaveBeenCalledWith('app_mode')
  })

  it('buffers a call made before initTelemetry resolves and flushes it', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, setTelemetryContext } = await import('./telemetry')

    const initPromise = initTelemetry()
    setTelemetryContext('modes', ['compose'])
    expect(setGlobalContextPropertyMock).not.toHaveBeenCalled()

    await initPromise
    expect(setGlobalContextPropertyMock).toHaveBeenCalledWith('modes', ['compose'])
  })

  it('does nothing when telemetry is disabled', async () => {
    const { initTelemetry, setTelemetryContext, removeTelemetryContext } = await import('./telemetry')
    await initTelemetry()

    setTelemetryContext('mode_filter', 'all')
    removeTelemetryContext('app_mode')
    expect(setGlobalContextPropertyMock).not.toHaveBeenCalled()
    expect(removeGlobalContextPropertyMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/telemetry.test.tsx`
Expected: FAIL — `setTelemetryContext`/`removeTelemetryContext` are not exported.

- [ ] **Step 3: Write minimal implementation**

In `web/src/lib/telemetry.ts`, add after the existing `trackView` function:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/telemetry.test.tsx`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Typecheck**

Run: `cd web && npx tsc -b`
Expected: exits 0. (If `tsc` flags the RUM method types, confirm `@datadog/browser-rum` ^7.5.0 exposes `setGlobalContextProperty`/`removeGlobalContextProperty` on `datadogRum` — it does; no cast needed.)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/telemetry.ts web/src/lib/telemetry.test.tsx
git commit -m "feat(telemetry): add set/removeTelemetryContext global-context wrappers"
```

---

## Task 3: `useModeTelemetry` hook (mode_filter + modes) and App wiring

**Files:**
- Create: `web/src/hooks/useModeTelemetry.ts`
- Test: `web/src/hooks/useModeTelemetry.test.tsx`
- Modify: `web/src/App.tsx`

**Interfaces:**
- Consumes: `useApps()` from `web/src/hooks/useApps.ts` (returns a react-query result whose `data` is `AppSummary[] | undefined`); `getCapabilities()` from `web/src/lib/capabilities.ts` (returns `{ mode?: string, … }`); `modeToken` (Task 1); `setTelemetryContext` (Task 2).
- Produces:
  - `export function normalizeModeFilter(mode: string | undefined): string` — `''`/`undefined` → `'all'`; otherwise returns `mode` unchanged.
  - `export function useModeTelemetry(): void` — mount once; sets `mode_filter` on mount and `modes` whenever the discovered mode set changes.

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/useModeTelemetry.test.tsx`:

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

function app(source: AppSummary['source'], isAspire = false): AppSummary {
  return {
    appId: 'a', health: 'healthy', runtime: 'dapr', httpPort: 1, grpcPort: 2,
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
    const { normalizeModeFilter } = await import('./useModeTelemetry')
    expect(normalizeModeFilter('')).toBe('all')
    expect(normalizeModeFilter(undefined)).toBe('all')
    expect(normalizeModeFilter('compose')).toBe('compose')
  })
})

describe('useModeTelemetry', () => {
  it("sets mode_filter from capabilities ('' -> 'all')", async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('mode_filter', 'all')
  })

  it('does not set modes before apps have loaded', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'compose' })
    useAppsMock.mockReturnValue({ data: undefined })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).not.toHaveBeenCalledWith('modes', expect.anything())
  })

  it('sets the distinct, sorted set of modes among discovered apps', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: '' })
    useAppsMock.mockReturnValue({
      data: [app('compose'), app('standalone'), app('compose'), app('standalone', true)],
    })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', ['aspire', 'compose', 'dapr-run'])
  })

  it('sets an empty modes array when nothing is discovered', async () => {
    getCapabilitiesMock.mockReturnValue({ mode: 'aspire' })
    useAppsMock.mockReturnValue({ data: [] })
    const { useModeTelemetry } = await import('./useModeTelemetry')

    renderHook(() => useModeTelemetry())

    expect(setTelemetryContextMock).toHaveBeenCalledWith('modes', [])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useModeTelemetry.test.tsx`
Expected: FAIL — cannot resolve `./useModeTelemetry`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/hooks/useModeTelemetry.ts`:

```ts
import { useEffect, useMemo } from 'react'
import { useApps } from './useApps'
import { getCapabilities } from '../lib/capabilities'
import { setTelemetryContext } from '../lib/telemetry'
import { modeToken } from '../lib/modeToken'

/** Normalizes the CLI --mode capability value for telemetry: '' or
 * undefined (complete scan) becomes 'all'; any other value passes through. */
export function normalizeModeFilter(mode: string | undefined): string {
  return mode ? mode : 'all'
}

/**
 * Keeps RUM global context in sync with the dashboard's discovery mode:
 * `mode_filter` (the CLI --mode, set once) and `modes` (the distinct,
 * sorted set of modes among discovered apps, refreshed as the apps list
 * changes). Mount exactly once, near the app root.
 */
export function useModeTelemetry(): void {
  useEffect(() => {
    setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))
  }, [])

  const { data } = useApps()
  const modes = useMemo(() => {
    const tokens = new Set<string>()
    for (const app of data ?? []) {
      const t = modeToken(app)
      if (t) tokens.add(t)
    }
    return [...tokens].sort()
  }, [data])

  // Refire only when the *set* changes (join key), not on every poll that
  // returns an equivalent set, so identical sets don't churn RUM context.
  const modesKey = data === undefined ? null : modes.join(',')
  useEffect(() => {
    if (modesKey === null) return
    setTelemetryContext('modes', modes)
    // modes is derived from the same data as modesKey; keying on modesKey
    // alone is intentional to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modesKey])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/hooks/useModeTelemetry.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire into `App.tsx`**

In `web/src/App.tsx`, add the import alongside the existing telemetry import:

```ts
import { useModeTelemetry } from './hooks/useModeTelemetry'
```

Inside the `App()` component body, before the existing `useEffect(() => { trackAction('app_startup') }, [])`, add:

```ts
  useModeTelemetry()
```

- [ ] **Step 6: Run the App test suite + typecheck**

Run: `cd web && npx vitest run src/App.test.tsx src/hooks/useModeTelemetry.test.tsx && npx tsc -b`
Expected: PASS and `tsc` exits 0. (`App.test.tsx` mounts within a QueryProvider; `useApps` resolves against msw or returns pending — either is fine since `useModeTelemetry` no-ops on `data === undefined`.)

- [ ] **Step 7: Commit**

```bash
git add web/src/hooks/useModeTelemetry.ts web/src/hooks/useModeTelemetry.test.tsx web/src/App.tsx
git commit -m "feat(telemetry): track mode_filter + discovered modes in RUM"
```

---

## Task 4: `useAppModeTelemetry` hook (app_mode) and AppDetail wiring

**Files:**
- Create: `web/src/hooks/useAppModeTelemetry.ts`
- Test: `web/src/hooks/useAppModeTelemetry.test.tsx`
- Modify: `web/src/pages/AppDetail.tsx`

**Interfaces:**
- Consumes: `modeToken` (Task 1); `setTelemetryContext` and `removeTelemetryContext` (Task 2); the loaded `AppDetail` object available in `AppDetailContent` (`web/src/pages/AppDetail.tsx:19`), which extends `AppSummary` and so carries `source`/`isAspire`.
- Produces: `export function useAppModeTelemetry(app: Pick<AppSummary, 'source' | 'isAspire'>): void` — sets `app_mode` to the app's token when known; removes `app_mode` on unmount (and when the token is unknown).

- [ ] **Step 1: Write the failing test**

Create `web/src/hooks/useAppModeTelemetry.test.tsx`:

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

type ModeApp = Pick<AppSummary, 'source' | 'isAspire'>

beforeEach(() => {
  setTelemetryContextMock.mockClear()
  removeTelemetryContextMock.mockClear()
})

describe('useAppModeTelemetry', () => {
  it('sets app_mode to the focused app token', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'compose' } as ModeApp },
    })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'compose')
  })

  it('removes app_mode on unmount', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    const { unmount } = renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'aspire' } as ModeApp },
    })
    unmount()
    expect(removeTelemetryContextMock).toHaveBeenCalledWith('app_mode')
  })

  it('sets nothing for an unknown/absent source', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: {} as ModeApp },
    })
    expect(setTelemetryContextMock).not.toHaveBeenCalled()
  })

  it('updates app_mode when the focused app changes', async () => {
    const { useAppModeTelemetry } = await import('./useAppModeTelemetry')
    const { rerender } = renderHook(({ app }: { app: ModeApp }) => useAppModeTelemetry(app), {
      initialProps: { app: { source: 'compose' } as ModeApp },
    })
    rerender({ app: { source: 'standalone' } as ModeApp })
    expect(setTelemetryContextMock).toHaveBeenCalledWith('app_mode', 'dapr-run')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useAppModeTelemetry.test.tsx`
Expected: FAIL — cannot resolve `./useAppModeTelemetry`.

- [ ] **Step 3: Write minimal implementation**

Create `web/src/hooks/useAppModeTelemetry.ts`:

```ts
import { useEffect } from 'react'
import type { AppSummary } from '../types/api'
import { modeToken } from '../lib/modeToken'
import { setTelemetryContext, removeTelemetryContext } from '../lib/telemetry'

/**
 * Keeps the RUM `app_mode` global-context property in sync with the app the
 * user is currently focused on (its detail page). Set on mount / when the
 * app's mode changes; removed on unmount so an error on a later, non-app
 * page is never attributed to a previously-viewed app. An unknown/absent
 * source sets nothing.
 */
export function useAppModeTelemetry(app: Pick<AppSummary, 'source' | 'isAspire'>): void {
  const token = modeToken(app)
  useEffect(() => {
    if (token) setTelemetryContext('app_mode', token)
    return () => removeTelemetryContext('app_mode')
  }, [token])
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/hooks/useAppModeTelemetry.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Wire into `AppDetail.tsx`**

In `web/src/pages/AppDetail.tsx`, add the import near the other hook imports:

```ts
import { useAppModeTelemetry } from '../hooks/useAppModeTelemetry'
```

Inside `AppDetailContent({ app }: { app: AppDetailType })` (starts at line 19), add as the first hook call in the body, immediately after `const { toast, toastNode } = useToast()`:

```ts
  useAppModeTelemetry(app)
```

- [ ] **Step 6: Run the AppDetail test suite + typecheck**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx src/hooks/useAppModeTelemetry.test.tsx && npx tsc -b`
Expected: PASS and `tsc` exits 0. (`AppDetail.test.tsx` does not assert on telemetry; the hook is a no-op unless RUM is enabled, and telemetry is not mocked there — but `setTelemetryContext`/`removeTelemetryContext` no-op when telemetry is disabled, so no behavior change.)

- [ ] **Step 7: Commit**

```bash
git add web/src/hooks/useAppModeTelemetry.ts web/src/hooks/useAppModeTelemetry.test.tsx web/src/pages/AppDetail.tsx
git commit -m "feat(telemetry): track focused app_mode in RUM"
```

---

## Task 5: Full-suite verification

**Files:** none (verification only).

- [ ] **Step 1: Run the full web test suite**

Run: `cd web && npm test`
Expected: all suites PASS (including the four new/modified files).

- [ ] **Step 2: Typecheck + lint**

Run: `cd web && npx tsc -b && npm run lint`
Expected: `tsc` exits 0; `eslint` reports no errors. (If lint flags the intentional `react-hooks/exhaustive-deps` line in `useModeTelemetry.ts`, confirm the inline `eslint-disable-next-line` is present and correctly placed directly above the `}, [modesKey])` dependency array.)

- [ ] **Step 3: Build**

Run: `cd web && npm run build`
Expected: `tsc -b && vite build` completes with no errors.

- [ ] **Step 4: Commit (only if any lint/format fixups were needed)**

```bash
git add -A
git commit -m "chore(telemetry): lint/format fixups for RUM mode tracking"
```

---

## Self-Review Notes (for the executor)

- **Spec coverage:** `mode_filter` → Task 3; `modes` → Task 3; `app_mode` → Task 4; `modeToken` vocabulary → Task 1; buffered wrappers → Task 2; `App.tsx`/`AppDetail.tsx` wiring → Tasks 3/4; edge cases (empty apps → `[]`, unknown source → omitted, unmount removal, `'' → 'all'`) → covered in Tasks 1/3/4 tests.
- **Out of scope (do not implement):** server-side telemetry, Session Replay/sampling changes, per-view/per-action attributes, and `WorkflowDetail` wiring (the `app_mode` pattern generalizes there, but the spec scopes it to `AppDetail` only).
