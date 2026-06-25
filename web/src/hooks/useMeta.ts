import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'

/** Shape returned by GET /api/version */
export interface VersionInfo {
  version: string
  commit: string
  date: string
}

/** Shape returned by GET /api/health */
export interface HealthInfo {
  status: string
}

/** Fetch the server version from /api/version. Refreshes every 60 s. */
export function useVersion() {
  return useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: () => fetchJSON<VersionInfo>('/version'),
    refetchInterval: 60_000,
  })
}

/** Fetch server health from /api/health. Refreshes every 30 s. */
export function useHealth() {
  return useQuery<HealthInfo>({
    queryKey: ['health'],
    queryFn: () => fetchJSON<HealthInfo>('/health'),
    refetchInterval: 30_000,
  })
}
