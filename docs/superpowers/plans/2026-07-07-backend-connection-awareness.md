# Backend Connection Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the web UI detect when the Go backend is offline, show a red "Backend offline" indicator on the TopNav refresh control, and pause all data polling until it recovers.

**Architecture:** A new `ConnectionProvider` polls the existing `GET /api/health` endpoint at the global refresh interval (30 s fallback when refresh is paused/Off) and mirrors the result into TanStack Query's built-in `onlineManager`, which pauses every other query while offline and auto-refetches on recovery. `RefreshControl` reads the connection state and repurposes its beat dot as the indicator.

**Tech Stack:** React 19, TanStack Query v5 (`onlineManager`, `networkMode`), Vitest + React Testing Library + MSW, plain CSS theme tokens.

Spec: `docs/superpowers/specs/2026-07-07-backend-connection-awareness-design.md`

## Global Constraints

- All frontend commands run from `web/` (`npm test` = `vitest run`, `npm run build` = `tsc -b && vite build`).
- No hex color literals in `.ts`/`.tsx` — colors come from theme tokens like `var(--fail-fg)` (enforced by `src/test/styleguide.test.ts`). CSS may use `color-mix` with tokens.
- React 19 context style: render context objects directly as providers (`<ConnectionContext value={…}>`), matching `web/src/lib/refresh.tsx`.
- MSW test server (from `src/test/setup.ts`) runs with `onUnhandledRequest: 'error'` — component tests must not mount anything that fires unmocked requests. Stub `ConnectionContext` directly in component tests; only `connection.test.tsx` mounts the real polling provider (with MSW handlers).
- Offline threshold is two consecutive failed health requests (query-client default `retry: 1`); recovery is the first success. Fallback poll cadence when refresh is paused/Off: `30_000` ms.
- Commit after every task.

---

### Task 1: ConnectionProvider (`web/src/lib/connection.tsx`)

**Files:**
- Create: `web/src/lib/connection.tsx`
- Create: `web/src/lib/connection.test.tsx`
- Modify: `web/src/hooks/useMeta.ts` (remove the now-superseded `useHealth` + `HealthInfo`)
- Modify: `web/src/hooks/useMeta.test.tsx` (remove the `useHealth` describe block)

**Interfaces:**
- Consumes: `useRefreshInterval()` / `refetchMs(ctx)` / `RefreshCtx` from `web/src/lib/refresh.tsx`; `fetchJSON` from `web/src/lib/api.ts`; `makeQueryClient`/`QueryProvider` from `web/src/lib/query.tsx`.
- Produces (used by Tasks 2–3):
  - `ConnectionProvider({ children }: { children: ReactNode })` — component
  - `useConnection(): { online: boolean }` — throws outside the provider
  - `ConnectionContext` — exported so tests can stub `{ online }` without polling
  - `healthPollMs(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>): number`
  - `HealthInfo` interface (moves here from `useMeta.ts`)

- [ ] **Step 1: Write the failing tests**

Create `web/src/lib/connection.test.tsx`:

```tsx
import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { onlineManager, type QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from './query'
import { RefreshProvider } from './refresh'
import { ConnectionProvider, useConnection, healthPollMs } from './connection'

function Probe() {
  const { online } = useConnection()
  return <div data-testid="conn-probe">{online ? 'online' : 'offline'}</div>
}

// retryDelay 0 keeps the fail-retry-fail cycle fast; the retry count (1)
// matches the production client, so "two consecutive failures" still holds.
function makeTestClient(): QueryClient {
  const client = makeQueryClient()
  client.setDefaultOptions({ queries: { retry: 1, retryDelay: 0 } })
  return client
}

function renderWithProviders(client: QueryClient) {
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <ConnectionProvider>
          <Probe />
        </ConnectionProvider>
      </RefreshProvider>
    </QueryProvider>,
  )
}

afterEach(() => {
  // ConnectionProvider mirrors state into the module-global onlineManager;
  // reset so a test that ended offline cannot leak into later tests.
  onlineManager.setOnline(true)
})

describe('healthPollMs', () => {
  it('follows the refresh interval when live', () => {
    expect(healthPollMs({ intervalMs: 3000, paused: false })).toBe(3000)
  })

  it('falls back to 30s when paused', () => {
    expect(healthPollMs({ intervalMs: 3000, paused: true })).toBe(30_000)
  })

  it('falls back to 30s when the interval is Off', () => {
    expect(healthPollMs({ intervalMs: 0, paused: false })).toBe(30_000)
  })
})

describe('ConnectionProvider', () => {
  it('is online initially (optimistic) and stays online while /api/health succeeds', async () => {
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok' })))
    const client = makeTestClient()
    renderWithProviders(client)
    // Before the first response settles the state is optimistic, not offline.
    expect(screen.getByTestId('conn-probe')).toHaveTextContent('online')
    await waitFor(() => expect(client.getQueryState(['health'])?.status).toBe('success'))
    expect(screen.getByTestId('conn-probe')).toHaveTextContent('online')
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('flips offline after two consecutive failed checks (initial + retry)', async () => {
    let calls = 0
    server.use(
      http.get('/api/health', () => {
        calls++
        return new HttpResponse(null, { status: 500 })
      }),
    )
    renderWithProviders(makeTestClient())
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('offline'),
    )
    expect(calls).toBe(2)
    expect(onlineManager.isOnline()).toBe(false)
  })

  it('recovers to online on the next successful check', async () => {
    server.use(http.get('/api/health', () => new HttpResponse(null, { status: 500 })))
    const client = makeTestClient()
    renderWithProviders(client)
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('offline'),
    )

    // Later server.use handlers take precedence within a test.
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok' })))
    // Stand in for the next interval tick — force the health refetch now.
    await act(async () => {
      await client.refetchQueries({ queryKey: ['health'] })
    })
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('online'),
    )
    expect(onlineManager.isOnline()).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web && npx vitest run src/lib/connection.test.tsx`
Expected: FAIL — cannot resolve `./connection` (module does not exist).

- [ ] **Step 3: Write the implementation**

Create `web/src/lib/connection.tsx`:

```tsx
import { createContext, use, useEffect, type ReactNode } from 'react'
import { onlineManager, useQuery } from '@tanstack/react-query'
import { fetchJSON } from './api'
import { refetchMs, useRefreshInterval, type RefreshCtx } from './refresh'

/** Shape returned by GET /api/health */
export interface HealthInfo {
  status: string
}

/** Health poll cadence while the global refresh is paused or Off. */
const OFFLINE_FALLBACK_MS = 30_000

export interface ConnectionCtx {
  /** False once the backend health check has failed (initial try + retry). */
  online: boolean
}

export const ConnectionContext = createContext<ConnectionCtx | null>(null)

/**
 * Health poll interval: follows the global refresh interval when live, and
 * falls back to a slow fixed cadence when refresh is paused or Off, so the
 * connection indicator never goes stale.
 */
export function healthPollMs(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>): number {
  return refetchMs(ctx) || OFFLINE_FALLBACK_MS
}

/**
 * Polls GET /api/health and drives two things: the ConnectionContext consumed
 * by RefreshControl's indicator, and TanStack Query's onlineManager, which
 * pauses every other query while the backend is unreachable and refetches
 * them on recovery. Setting onlineManager manually makes this health check
 * the sole authority on online state (the browser's window online/offline
 * events are meaningless for a localhost backend). networkMode 'always'
 * keeps this one probe polling while the onlineManager reports offline.
 */
export function ConnectionProvider({ children }: { children: ReactNode }) {
  const refreshCtx = useRefreshInterval()

  const health = useQuery<HealthInfo>({
    queryKey: ['health'],
    queryFn: () => fetchJSON<HealthInfo>('/health'),
    refetchInterval: healthPollMs(refreshCtx),
    networkMode: 'always',
  })

  // Optimistic until the first check settles: isError only turns true after
  // the query client's retry, i.e. two consecutive failed requests.
  const online = !health.isError

  useEffect(() => {
    onlineManager.setOnline(online)
  }, [online])

  return <ConnectionContext value={{ online }}>{children}</ConnectionContext>
}

export function useConnection(): ConnectionCtx {
  const ctx = use(ConnectionContext)
  if (!ctx) throw new Error('useConnection must be used within a ConnectionProvider')
  return ctx
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/lib/connection.test.tsx`
Expected: PASS (6 tests).

- [ ] **Step 5: Remove the superseded `useHealth` hook**

`HealthInfo` now lives in `connection.tsx`; the old fixed-30s hook is unused. First confirm nothing else consumes it:

Run: `cd web && grep -rn "useHealth\|HealthInfo" src --include="*.ts" --include="*.tsx" | grep -v "src/lib/connection"`
Expected: matches only in `src/hooks/useMeta.ts` and `src/hooks/useMeta.test.tsx`.

In `web/src/hooks/useMeta.ts`, delete the `HealthInfo` interface and the `useHealth` function (lines 11–14 and 25–32), leaving only `VersionInfo` and `useVersion`.

In `web/src/hooks/useMeta.test.tsx`, delete the entire `describe('useHealth', …)` block and change the import line to:

```tsx
import { useVersion } from './useMeta'
```

- [ ] **Step 6: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS — everything green (nothing consumes `ConnectionProvider` yet).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/connection.tsx web/src/lib/connection.test.tsx web/src/hooks/useMeta.ts web/src/hooks/useMeta.test.tsx
git commit -m "feat: add ConnectionProvider polling backend health into onlineManager"
```

---

### Task 2: Offline indicator in RefreshControl

**Files:**
- Modify: `web/src/components/RefreshControl.tsx`
- Modify: `web/src/components/RefreshControl.test.tsx`
- Modify: `web/src/styles/theme.css` (after line 207, the `.beatbtn.off .beat` rule)
- Modify: `web/src/components/TopNav.test.tsx`, `web/src/App.test.tsx`, `web/src/components/RouteError.test.tsx` (these render `RefreshControl` via `TopNav`; their wrappers need the stub context or `useConnection` throws)

**Interfaces:**
- Consumes: `useConnection()` and `ConnectionContext` from Task 1 (`web/src/lib/connection.tsx`).
- Produces: no new exports — visual states on the existing `RefreshControl`. CSS contract: `beatbtn offline` class on the button, `.offline-label` span with text `Backend offline`, offline title `Backend unreachable — retrying…`.

- [ ] **Step 1: Write the failing tests**

In `web/src/components/RefreshControl.test.tsx`, replace the `renderWithProvider` helper (and its imports) so every render supplies a stubbed connection state — the real provider would poll and trip MSW's `onUnhandledRequest: 'error'`:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { RefreshProvider } from '../lib/refresh'
import { ConnectionContext } from '../lib/connection'
import { RefreshControl } from './RefreshControl'

function renderWithProvider(online = true) {
  return render(
    <RefreshProvider>
      <ConnectionContext value={{ online }}>
        <RefreshControl />
      </ConnectionContext>
    </RefreshProvider>,
  )
}
```

The existing tests keep passing unchanged (they render online). Append a new describe block at the end of the file:

```tsx
describe('RefreshControl offline indicator', () => {
  it('shows the offline dot state, label, and title when the backend is offline', () => {
    const { container } = renderWithProvider(false)
    const btn = container.querySelector('button.beatbtn')!
    // classList (not className.includes): 'offline' contains 'off' as a substring.
    expect(btn.classList.contains('offline')).toBe(true)
    expect(btn.classList.contains('off')).toBe(false)
    expect(screen.getByText('Backend offline')).toBeInTheDocument()
    expect(btn).toHaveAttribute('title', 'Backend unreachable — retrying…')
  })

  it('offline styling wins over paused', () => {
    const { container } = renderWithProvider(false)
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    const btn = container.querySelector('button.beatbtn')!
    expect(btn.classList.contains('offline')).toBe(true)
    expect(btn.classList.contains('off')).toBe(false)
    expect(btn).toHaveAttribute('title', 'Backend unreachable — retrying…')
  })

  it('renders no offline label when online', () => {
    renderWithProvider(true)
    expect(screen.queryByText('Backend offline')).not.toBeInTheDocument()
  })

  it('keeps the pause button and interval picker functional while offline', () => {
    renderWithProvider(false)
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    const sel = screen.getByRole('combobox', { name: /refresh interval/i }) as HTMLSelectElement
    fireEvent.change(sel, { target: { value: '5000' } })
    expect(sel.value).toBe('5000')
  })
})
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `cd web && npx vitest run src/components/RefreshControl.test.tsx`
Expected: the 4 new tests FAIL (no `offline` class/label); the 7 existing tests PASS.

- [ ] **Step 3: Implement the indicator**

Replace `web/src/components/RefreshControl.tsx` with:

```tsx
import { useConnection } from '../lib/connection'
import { useRefreshInterval } from '../lib/refresh'

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: 'Off', value: 0 },
]

/**
 * Compact global refresh control for the top navigation bar. Renders a beating
 * dot that doubles as a pause/resume button, plus an interval picker. Reads and
 * writes the global RefreshContext, so it governs polling on every page.
 *
 * The dot is also the backend connection indicator: when the health check
 * reports the backend unreachable it turns red (with a "Backend offline"
 * label) and that state wins over the live/paused looks.
 */
export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()
  const { online } = useConnection()

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === intervalMs)?.label ?? `${intervalMs / 1000}s`

  const off = intervalMs === 0
  const live = !paused && !off
  const offline = !online

  // Precedence: offline > off > paused. `off` (interval 0 → nothing polls) is
  // the more fundamental refresh state, so it wins over `paused` in the title
  // even when both are set.
  const title = offline
    ? 'Backend unreachable — retrying…'
    : off
      ? 'Auto-refresh off'
      : paused
        ? 'Auto-refresh paused — click to resume'
        : `Auto-refresh every ${intervalLabel} — click to pause`

  const dotState = offline ? ' offline' : live ? '' : ' off'

  return (
    <div className="refresh-compact">
      {offline && (
        <span className="offline-label" data-cy="offline-label">
          Backend offline
        </span>
      )}
      <button
        className={`beatbtn${dotState}`}
        data-cy="refresh-pause"
        aria-label="Pause auto-refresh"
        aria-pressed={paused}
        title={title}
        onClick={() => setPaused(!paused)}
      >
        <span className="beat" />
      </button>

      <select
        className="select compact"
        data-cy="refresh-interval"
        aria-label="Refresh interval"
        value={intervalMs}
        onChange={(e) => setInterval(Number(e.target.value))}
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  )
}
```

In `web/src/styles/theme.css`, directly after the `.beatbtn.off .beat` rule (line 207), add:

```css
.beatbtn.offline .beat { background: var(--fail-fg); animation: beat-offline 2.4s ease-out infinite; }
@keyframes beat-offline { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--fail-fg) 50%, transparent); } 70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.offline-label { color: var(--fail-fg); font-size: 12px; white-space: nowrap; }
```

- [ ] **Step 4: Run the RefreshControl tests**

Run: `cd web && npx vitest run src/components/RefreshControl.test.tsx`
Expected: PASS (11 tests).

- [ ] **Step 5: Fix the other tests that render RefreshControl via TopNav**

`RefreshControl` now calls `useConnection()`, so any test rendering `TopNav` without the context throws. In each of the three files below, import the context and nest a stub provider just inside `RefreshProvider` at **every** `render(…)` call site that reaches `TopNav`:

```tsx
import { ConnectionContext } from '../lib/connection'   // '../lib' from components/, './lib' from src/
```

Wrap pattern (children unchanged):

```tsx
<RefreshProvider>
  <ConnectionContext value={{ online: true }}>
    {/* existing children of RefreshProvider */}
  </ConnectionContext>
</RefreshProvider>
```

- `web/src/components/TopNav.test.tsx` — render helper around line 50.
- `web/src/App.test.tsx` — the render calls around lines 46, 100, and 121 (any that mount the router/App).
- `web/src/components/RouteError.test.tsx` — render helper around line 57.

- [ ] **Step 6: Run the full web test suite**

Run: `cd web && npm test`
Expected: PASS — including the styleguide test (no hex literals were added to TS/TSX).

- [ ] **Step 7: Commit**

```bash
git add web/src/components/RefreshControl.tsx web/src/components/RefreshControl.test.tsx web/src/styles/theme.css web/src/components/TopNav.test.tsx web/src/App.test.tsx web/src/components/RouteError.test.tsx
git commit -m "feat: show backend offline indicator on the refresh control"
```

---

### Task 3: Wire ConnectionProvider into the app

**Files:**
- Modify: `web/src/main.tsx`

**Interfaces:**
- Consumes: `ConnectionProvider` from Task 1.
- Produces: the live app renders `QueryProvider → RefreshProvider → ConnectionProvider → RouterProvider`, making `useConnection()` available everywhere (TopNav included) and activating the health poll + onlineManager pausing globally.

- [ ] **Step 1: Mount the provider**

In `web/src/main.tsx`, add the import and wrap `RouterProvider` (ConnectionProvider needs both the query client and the refresh context, so it sits innermost):

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'
import { QueryProvider } from './lib/query'
import { RefreshProvider } from './lib/refresh'
import { ConnectionProvider } from './lib/connection'
import { initTelemetry } from './lib/telemetry'

void initTelemetry()
applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <RefreshProvider>
        <ConnectionProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </ConnectionProvider>
      </RefreshProvider>
    </QueryProvider>
  </StrictMode>,
)
```

- [ ] **Step 2: Run the full test suite and the production build**

Run: `cd web && npm test`
Expected: PASS.

Run: `cd web && npm run build`
Expected: `tsc -b` and `vite build` both succeed with no type errors.

- [ ] **Step 3 (optional manual verification): Kill the backend and watch the dot**

Start the dashboard (Go backend serving the built web UI, or `npm run dev` with the backend running). Open the UI, then stop the backend process. Within ~2 poll cycles the beat dot turns red with a "Backend offline" label, and the Network tab shows only `/api/health` requests continuing. Restart the backend: the label clears and data queries resume automatically.

- [ ] **Step 4: Commit**

```bash
git add web/src/main.tsx
git commit -m "feat: wire ConnectionProvider into the app provider tree"
```
