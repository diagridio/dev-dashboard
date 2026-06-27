import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import type { NewsResponse } from '../types/logs'

/**
 * Fetches the latest news items from GET /api/news.
 * Refreshes once per hour.
 */
export function useNews() {
  return useQuery<NewsResponse>({
    queryKey: ['news'],
    queryFn: () => fetchJSON<NewsResponse>('/news'),
    staleTime: 60 * 60 * 1000,
    refetchInterval: 60 * 60 * 1000,
  })
}
