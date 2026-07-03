import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON, apiUrl } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { ControlPlaneList, ControlPlaneAction } from '../types/controlplane'

export function useControlPlane() {
  const ctx = useRefreshInterval()
  return useQuery<ControlPlaneList>({
    queryKey: ['controlplane'],
    queryFn: () => fetchJSON<ControlPlaneList>('/controlplane'),
    refetchInterval: refetchMs(ctx),
  })
}

async function sendAction(name: string, action: ControlPlaneAction): Promise<void> {
  const res = await fetch(apiUrl(`/controlplane/${encodeURIComponent(name)}/${action}`), { method: 'POST' })
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // keep status-only message
    }
    throw new Error(msg)
  }
}

export function useControlPlaneAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: ControlPlaneAction }) => sendAction(name, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['controlplane'] }),
  })
}
