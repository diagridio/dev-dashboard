import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { Actor, Subscription, ResourceKind, ResourceSummary, ResourceDetail } from '../types/resources'

export function useActors(appId?: string) {
  const ctx = useRefreshInterval()
  const qs = appId ? `?appId=${encodeURIComponent(appId)}` : ''
  return useQuery<Actor[]>({
    queryKey: ['actors', appId],
    queryFn: () => fetchJSON<Actor[]>(`/actors${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useSubscriptions(appId?: string) {
  const ctx = useRefreshInterval()
  const qs = appId ? `?appId=${encodeURIComponent(appId)}` : ''
  return useQuery<Subscription[]>({
    queryKey: ['subscriptions', appId],
    queryFn: () => fetchJSON<Subscription[]>(`/subscriptions${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useResources(kind: ResourceKind) {
  return useQuery<ResourceSummary[]>({
    queryKey: ['resources', kind],
    queryFn: () => fetchJSON<ResourceSummary[]>(`/resources?kind=${encodeURIComponent(kind)}`),
    staleTime: 60_000,
  })
}

export function useResource(kind: ResourceKind, name: string) {
  return useQuery<ResourceDetail>({
    queryKey: ['resources', kind, name],
    queryFn: () => fetchJSON<ResourceDetail>(`/resources/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`),
    staleTime: 60_000,
    enabled: !!kind && !!name,
  })
}
