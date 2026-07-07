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
