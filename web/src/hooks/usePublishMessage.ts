import { useMutation } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export interface PublishPayload {
  pubsubName: string
  topic: string
  data: string
  contentType: string
  metadata?: Record<string, string>
}

async function publish(key: string, p: PublishPayload): Promise<void> {
  const res = await fetch(apiUrl(`/apps/${encodeURIComponent(key)}/publish`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
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
}

/** Publish a message to a topic via POST /api/apps/:key/publish. */
export function usePublishMessage(key: string) {
  return useMutation({
    mutationFn: (p: PublishPayload) => publish(key, p),
  })
}
