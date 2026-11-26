import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl, fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { Actor } from '../types/resources'
import type { ActorDetail, ActorTypeDetail, InvokeRequest, InvokeResult } from '../types/actors'

const enc = encodeURIComponent
const actorsBase = (appKey: string, type: string) => `/actors/${enc(appKey)}/${enc(type)}`

async function errorMessage(res: Response): Promise<string> {
  let msg = `request failed: ${res.status}`
  try {
    const data = (await res.json()) as { error?: unknown }
    if (data && typeof data.error === 'string') msg = data.error
  } catch {
    // non-JSON body; keep status-only message
  }
  return msg
}

export function useActors(appId?: string) {
  const ctx = useRefreshInterval()
  const qs = appId ? `?appId=${enc(appId)}` : ''
  return useQuery<Actor[]>({
    queryKey: ['actors', appId],
    queryFn: () => fetchJSON<Actor[]>(`/actors${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useActorType(appKey: string, type: string) {
  const ctx = useRefreshInterval()
  return useQuery<ActorTypeDetail>({
    queryKey: ['actorType', appKey, type],
    queryFn: ({ signal }) => fetchJSON<ActorTypeDetail>(actorsBase(appKey, type), { signal }),
    refetchInterval: refetchMs(ctx),
    enabled: !!appKey && !!type,
  })
}

export function useActorDetail(appKey: string, type: string, id: string) {
  const ctx = useRefreshInterval()
  return useQuery<ActorDetail>({
    queryKey: ['actor', appKey, type, id],
    queryFn: ({ signal }) => fetchJSON<ActorDetail>(`${actorsBase(appKey, type)}/${enc(id)}`, { signal }),
    refetchInterval: refetchMs(ctx),
    enabled: !!appKey && !!type && !!id,
  })
}

/** Invoke an actor method via POST /api/actors/:app/:type/:id/invoke. */
export function useInvokeActor(appKey: string, type: string) {
  const qc = useQueryClient()
  return useMutation<InvokeResult, Error, InvokeRequest & { id: string }>({
    mutationFn: async ({ id, method, verb, body }) => {
      const res = await fetch(apiUrl(`${actorsBase(appKey, type)}/${enc(id)}/invoke`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method, verb, body }),
      })
      if (!res.ok) throw new Error(await errorMessage(res))
      return (await res.json()) as InvokeResult
    },
    onSuccess: (_r, { id }) => {
      void qc.invalidateQueries({ queryKey: ['actor', appKey, type, id] })
      void qc.invalidateQueries({ queryKey: ['actorType', appKey, type] })
    },
  })
}

/** Delete a reminder via DELETE /api/actors/:app/:type/:id/reminders/:name. */
export function useDeleteReminder(appKey: string, type: string, id: string) {
  const qc = useQueryClient()
  return useMutation<void, Error, string>({
    mutationFn: async (name) => {
      const res = await fetch(apiUrl(`${actorsBase(appKey, type)}/${enc(id)}/reminders/${enc(name)}`), {
        method: 'DELETE',
      })
      if (!res.ok) throw new Error(await errorMessage(res))
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['actor', appKey, type, id] })
      void qc.invalidateQueries({ queryKey: ['actorType', appKey, type] })
    },
  })
}
