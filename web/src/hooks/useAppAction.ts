import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export type AppTarget = 'app' | 'daprd' | 'all'
export type AppLifecycleAction = 'start' | 'stop' | 'restart'

// Throws the API's {error} body (or a status-only message) for non-2xx responses.
async function throwIfNotOK(res: Response): Promise<void> {
  if (res.ok) return
  let msg = `request failed: ${res.status}`
  try {
    const data = (await res.json()) as { error?: unknown }
    if (data && typeof data.error === 'string') msg = data.error
  } catch {
    // keep status-only message
  }
  throw new Error(msg)
}

async function sendAppAction(key: string, target: AppTarget, action: AppLifecycleAction): Promise<void> {
  const res = await fetch(
    apiUrl(`/apps/${encodeURIComponent(key)}/${encodeURIComponent(target)}/${encodeURIComponent(action)}`),
    { method: 'POST' },
  )
  await throwIfNotOK(res)
}

async function sendAppForget(key: string): Promise<void> {
  const res = await fetch(apiUrl(`/apps/${encodeURIComponent(key)}`), { method: 'DELETE' })
  await throwIfNotOK(res)
}

/**
 * Start/stop/restart an app instance (or one half of it) via
 * POST /api/apps/:key/:target/:action. Invalidates all app queries on success.
 */
export function useAppAction(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ target, action }: { target: AppTarget; action: AppLifecycleAction }) =>
      sendAppAction(key, target, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apps'] }),
  })
}

/**
 * Drops a remembered stopped instance from the dashboard via
 * DELETE /api/apps/:key. Invalidates all app queries on success.
 */
export function useAppForget(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => sendAppForget(key),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apps'] }),
  })
}
