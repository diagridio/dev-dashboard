import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs, refetchMsAtLeast } from '../lib/refresh'
import type { WorkflowExecution, WorkflowListResult, WorkflowStats, StateStore, WorkflowStatus } from '../types/workflow'

interface WorkflowsParams {
  appId?: string
  status?: WorkflowStatus[]
  search?: string
  page?: string
  limit?: number
  store?: string
  includeChildren?: boolean
  enabled?: boolean
}

function queryString(p: WorkflowsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.status && p.status.length) sp.set('status', p.status.join(','))
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  if (p.store) sp.set('store', p.store)
  if (p.includeChildren === false) sp.set('includeChildren', 'false')
  const s = sp.toString()
  return s ? `?${s}` : ''
}

// Stats is the page's only store-wide read; its tab badges don't need the
// list's cadence.
export const STATS_MIN_REFETCH_MS = 10_000

// keepPreviousWithinStore keeps the previous result on screen while a new
// filter/search/page loads, but never across a store switch: another store's
// rows must not stand in for this store's (row links and removal target the
// selected store). queryKey[1] is the store id.
function keepPreviousWithinStore<T>(store: string) {
  return (prev: T | undefined, prevQuery: { queryKey: readonly unknown[] } | undefined) =>
    prevQuery?.queryKey[1] === store ? prev : undefined
}

export function useWorkflows(params: WorkflowsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  const store = params.store ?? ''
  return useQuery<WorkflowListResult>({
    queryKey: ['workflows', store, qs],
    queryFn: ({ signal }) => fetchJSON<WorkflowListResult>(`/workflows${qs}`, { signal }),
    refetchInterval: refetchMs(ctx),
    placeholderData: keepPreviousWithinStore<WorkflowListResult>(store),
    enabled: params.enabled !== false,
  })
}

export function useWorkflowStats(params: { appId?: string; search?: string; store?: string; includeChildren?: boolean; enabled?: boolean }) {
  const ctx = useRefreshInterval()
  const sp = new URLSearchParams()
  if (params.appId) sp.set('appId', params.appId)
  if (params.search) sp.set('search', params.search)
  if (params.store) sp.set('store', params.store)
  if (params.includeChildren === false) sp.set('includeChildren', 'false')
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  const store = params.store ?? ''
  return useQuery<WorkflowStats>({
    queryKey: ['workflow-stats', store, qs],
    queryFn: ({ signal }) => fetchJSON<WorkflowStats>(`/workflows/stats${qs}`, { signal }),
    refetchInterval: refetchMsAtLeast(ctx, STATS_MIN_REFETCH_MS),
    placeholderData: keepPreviousWithinStore<WorkflowStats>(store),
    enabled: params.enabled !== false,
  })
}

// All app-ids that have workflow data in the store — the filter-independent
// source for the app dropdown (so a selection never collapses the options).
export function useWorkflowAppIds(params: { store?: string; enabled?: boolean }) {
  const ctx = useRefreshInterval()
  const qs = params.store ? `?store=${encodeURIComponent(params.store)}` : ''
  return useQuery<string[]>({
    queryKey: ['workflow-appids', qs],
    queryFn: ({ signal }) => fetchJSON<string[]>(`/workflows/appids${qs}`, { signal }),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}

export function useWorkflow(appId: string, instanceId: string, store?: string) {
  const ctx = useRefreshInterval()
  const qs = store ? `?store=${encodeURIComponent(store)}` : ''
  return useQuery<WorkflowExecution>({
    queryKey: ['workflow', appId, instanceId, store],
    queryFn: ({ signal }) => fetchJSON<WorkflowExecution>(`/workflows/${appId}/${instanceId}${qs}`, { signal }),
    refetchInterval: refetchMs(ctx),
    enabled: !!appId && !!instanceId,
  })
}

export function useStateStores() {
  return useQuery<StateStore[]>({
    queryKey: ['statestores'],
    queryFn: () => fetchJSON<StateStore[]>('/statestores'),
    staleTime: 60_000,
  })
}
