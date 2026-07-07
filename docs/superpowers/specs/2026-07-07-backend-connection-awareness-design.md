# Backend connection awareness (online/offline indicator) — design

Date: 2026-07-07
Status: approved

## Problem

The frontend has no awareness of whether the Go backend process is still
running. When the backend dies, every polling query silently fails: pages
keep showing stale data, nothing updates, and the user gets no explanation —
a confusing, disconnected experience. The backend already exposes
`GET /api/health` (`pkg/server/api.go`) and the frontend has an unused
`useHealth()` hook (`web/src/hooks/useMeta.ts`), but neither is wired into
the UI.

## Decisions (from brainstorming)

- **Detection:** poll `/api/health` at the global refresh interval — the
  health check is the single source of truth for online/offline. Offline is
  not derived from failures of other data queries.
- **When refresh is paused or "Off":** the health check keeps running at a
  slow fixed fallback of **30 seconds**, so the indicator stays truthful at
  negligible cost.
- **While offline:** all other data polling is suspended (no storm of
  failing requests or per-page errors) and resumes automatically on
  recovery. Pages keep showing their last-fetched data.
- **Indicator:** repurpose the existing beat dot in `RefreshControl`
  (TopNav) rather than adding a new UI element. Offline = red dot plus a
  "Backend offline" text label.
- **Pause mechanism:** TanStack Query's built-in `onlineManager` — flipping
  it pauses/resumes every existing query with zero changes to the ~10
  existing data hooks.
- **Mutations fail fast, not queue:** mutations (workflow purge, control-plane
  start/stop, store add/update/delete) use `networkMode: 'always'` via the
  global default in `makeQueryClient()`. This ensures they run immediately and
  surface an error rather than silently queuing while offline and firing
  unexpectedly on recovery.

## Design

### 1. ConnectionProvider (`web/src/lib/connection.tsx`, new)

A React context provider mounted in `App.tsx` inside the existing
`QueryClientProvider` and `RefreshProvider`. It owns the health poll and
exposes connection state:

- Runs one query against `/health` via the existing `fetchJSON` helper.
  Query options:
  - `refetchInterval`: the global refresh interval (`refetchMs(ctx)`) when
    refresh is live; when refresh is paused or the interval is 0 ("Off"),
    fall back to a fixed `30_000` ms instead of stopping.
  - `networkMode: 'always'` — the health query must keep polling while
    `onlineManager` reports offline (everything else pauses; this query is
    the recovery probe).
  - `retry`: keep the query client's existing default (1 retry), so
    flipping to offline requires **two consecutive failed requests** —
    protects against a single blip, e.g. during a backend restart.
- `online` is derived from the query: `true` until the query first enters
  the error state (optimistic initial load — no red flash on startup), then
  tracks error/success. Any failure counts: network-level errors and
  non-2xx responses (both throw from `fetchJSON`).
- Recovery: the first successful response flips back online immediately.
- An effect mirrors the state into TanStack:
  `onlineManager.setOnline(online)`. Calling `setOnline` makes the health
  check the sole authority on online state, replacing the browser's
  `window` online/offline events (which are meaningless for a localhost
  backend). All existing polling queries (default `networkMode: 'online'`)
  pause while offline and refetch automatically when connectivity returns
  (`refetchOnReconnect`).
- Exposes `useConnection(): { online: boolean }`.
- The now-superseded `useHealth()` hook in `useMeta.ts` (unused, fixed 30 s
  interval) is removed; its `HealthInfo` type moves to or is redefined in
  `connection.tsx`.

### 2. Indicator in RefreshControl (`web/src/components/RefreshControl.tsx`)

`RefreshControl` reads `useConnection()` and renders three visual states
for the beat dot:

- **Live + online:** green beating dot (unchanged).
- **Paused/off + online:** muted gray dot (unchanged).
- **Offline (regardless of refresh setting):** the dot turns red
  (`--fail-fg`) and keeps the beat animation — it is still actively
  probing. A small red "Backend offline" text label renders next to the
  control. Offline takes visual precedence over the paused look.
- The button's `title` tooltip explains the state when offline
  ("Backend unreachable — retrying…"); pause/resume and the interval
  dropdown remain functional throughout.
- Styling: new `.beatbtn.offline` variant and an offline label style in
  `web/src/styles/theme.css`, using the existing `--fail-fg` token.

### 3. App wiring (`web/src/main.tsx`)

Mount `ConnectionProvider` around the routed content so both
`RefreshControl` (in TopNav) and any future consumers can call
`useConnection()`. The providers live in `web/src/main.tsx` (not
`App.tsx`). Order: `QueryClientProvider` → `RefreshProvider` →
`ConnectionProvider`.

## Edge cases

- **Initial load:** state starts online until the first check completes;
  a dead backend shows the offline state within roughly one interval plus
  the retry.
- **Backend restart:** a blip shorter than one failed request + retry does
  not flip the indicator.
- **Dev server:** with the Vite proxy in front, a dead Go backend surfaces
  as a 5xx or network error — both already count as failures.
- **Per-page error banners** (e.g. the Workflows store-unavailable banner)
  are unrelated to backend liveness and unaffected: they concern a healthy
  backend reporting a bad state store.
- **"Off" refresh setting:** data queries do not poll (as today), but the
  health probe still runs every 30 s, so the indicator cannot go stale.

## Testing

Vitest + React Testing Library, following existing test patterns:

- `connection.test.tsx` (new): provider reports `online: true` initially;
  flips to offline after the health query errors (retry exhausted); flips
  back on the next success; mirrors state into `onlineManager`; health
  poll uses the refresh interval when live and 30 s when paused/off.
- `RefreshControl.test.tsx`: offline renders the red dot class and the
  "Backend offline" label; offline styling wins over paused; label absent
  when online; pause button and dropdown still operate while offline.
