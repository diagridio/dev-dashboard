import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { WorkflowExecution, WorkflowListResult, StateStore } from '../types/workflow'

interface WorkflowsParams {
  appId?: string
  status?: string[]
  search?: string
  page?: string
  limit?: number
}

function queryString(p: WorkflowsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.status && p.status.length) sp.set('status', p.status.join(','))
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
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

export function useWorkflow(appId: string, instanceId: string) {
  const ctx = useRefreshInterval()
  return useQuery<WorkflowExecution>({
    queryKey: ['workflow', appId, instanceId],
    queryFn: () => fetchJSON<WorkflowExecution>(`/workflows/${appId}/${instanceId}`),
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
