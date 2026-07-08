import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'

/** Shape returned by GET /api/version */
export interface VersionInfo {
  version: string
  commit: string
  date: string
}

/** Fetch the server version from /api/version. Refreshes every 60 s. */
export function useVersion() {
  return useQuery<VersionInfo>({
    queryKey: ['version'],
    queryFn: () => fetchJSON<VersionInfo>('/version'),
    refetchInterval: 60_000,
  })
}

/** Shape returned by GET /api/update-check */
export interface UpdateInfo {
  current: string
  latest: string
  updateAvailable: boolean
  releaseUrl: string
}

/** Fetch update availability from /api/update-check. Refreshes every 5 min. */
export function useUpdateCheck() {
  return useQuery<UpdateInfo>({
    queryKey: ['update-check'],
    queryFn: () => fetchJSON<UpdateInfo>('/update-check'),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })
}
