import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { AppSummary, AppDetail } from '../types/api'

/**
 * Fetches the list of all running Dapr app instances from GET /api/apps.
 * Polls on the global refresh interval configured by the user.
 */
export function useApps() {
  const ctx = useRefreshInterval()
  return useQuery<AppSummary[]>({
    queryKey: ['apps'],
    queryFn: () => fetchJSON<AppSummary[]>('/apps'),
    refetchInterval: refetchMs(ctx),
  })
}

/**
 * Fetches the detail for a single Dapr app instance from GET /api/apps/:appId.
 * Polls on the global refresh interval configured by the user.
 */
export function useApp(appId: string) {
  const ctx = useRefreshInterval()
  return useQuery<AppDetail>({
    queryKey: ['apps', appId],
    queryFn: () => fetchJSON<AppDetail>('/apps/' + appId),
    refetchInterval: refetchMs(ctx),
  })
}
