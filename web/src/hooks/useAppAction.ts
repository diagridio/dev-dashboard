import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export type AppTarget = 'app' | 'daprd' | 'all'
export type AppLifecycleAction = 'start' | 'stop' | 'restart'

async function sendAppAction(key: string, target: AppTarget, action: AppLifecycleAction): Promise<void> {
  const res = await fetch(
    apiUrl(`/apps/${encodeURIComponent(key)}/${encodeURIComponent(target)}/${encodeURIComponent(action)}`),
    { method: 'POST' },
  )
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
