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
