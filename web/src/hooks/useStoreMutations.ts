import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export interface StorePayload {
  name: string
  type: string
  metadata: Record<string, string>
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // non-JSON body; keep status-only message
    }
    throw new Error(msg)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

export function useStoreMutations() {
  const qc = useQueryClient()
  const invalidate = () => qc.invalidateQueries({ queryKey: ['statestores'] })

  const addStore = useMutation({
    mutationFn: (p: StorePayload) => send<{ name: string }>('/statestores', 'POST', p),
    onSuccess: invalidate,
  })
  const updateStore = useMutation({
    mutationFn: ({ id, ...p }: StorePayload & { id: string }) =>
      send<{ id: string }>(`/statestores/${encodeURIComponent(id)}`, 'PUT', p),
    onSuccess: invalidate,
  })
  const deleteStore = useMutation({
    mutationFn: (id: string) => send<void>(`/statestores/${encodeURIComponent(id)}`, 'DELETE'),
    onSuccess: invalidate,
  })

  return { addStore, updateStore, deleteStore }
}
