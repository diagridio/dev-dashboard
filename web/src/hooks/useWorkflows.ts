import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { WorkflowExecution, WorkflowListResult, WorkflowStats, StateStore, WorkflowStatus } from '../types/workflow'

interface WorkflowsParams {
  appId?: string
  status?: WorkflowStatus[]
  search?: string
  page?: string
  limit?: number
  store?: string
}

function queryString(p: WorkflowsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.status && p.status.length) sp.set('status', p.status.join(','))
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  if (p.store) sp.set('store', p.store)
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function useWorkflows(params: WorkflowsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  return useQuery<WorkflowListResult>({
    queryKey: ['workflows', qs],
    queryFn: () => fetchJSON<WorkflowListResult>(`/workflows${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useWorkflowStats(params: { appId?: string; search?: string; store?: string }) {
  const ctx = useRefreshInterval()
  const sp = new URLSearchParams()
  if (params.appId) sp.set('appId', params.appId)
  if (params.search) sp.set('search', params.search)
  if (params.store) sp.set('store', params.store)
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  return useQuery<WorkflowStats>({
    queryKey: ['workflow-stats', qs],
    queryFn: () => fetchJSON<WorkflowStats>(`/workflows/stats${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useWorkflow(appId: string, instanceId: string, store?: string) {
  const ctx = useRefreshInterval()
  const qs = store ? `?store=${encodeURIComponent(store)}` : ''
  return useQuery<WorkflowExecution>({
    queryKey: ['workflow', appId, instanceId, store],
    queryFn: () => fetchJSON<WorkflowExecution>(`/workflows/${appId}/${instanceId}${qs}`),
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
