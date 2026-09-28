import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '../lib/api'

/** How long a revealed value stays visible. The dashboard is screen-shared. */
export const REVEAL_TTL_MS = 30_000

/**
 * Turns a failed reveal response into a short, per-row reason string (no
 * "Could not reveal:" prefix — the caller adds that). Mirrors lib/api.ts's
 * fetchJSON: a server error body is only trusted when it carries a string
 * `error` field; the raw response text is never surfaced.
 */
async function revealFailureReason(res: Response): Promise<string> {
  if (res.status === 403) return 'unavailable when served off-host'
  if (res.status === 404) return 'no resolved value for this field'
  let detail = ''
  try {
    const body = (await res.json()) as { error?: unknown }
    if (body && typeof body.error === 'string') detail = `: ${body.error}`
  } catch {
    // Non-JSON or empty body: fall back to the status-only message.
  }
  return `status ${res.status}${detail}`
}

export function useSecretReveal(resourceId: string) {
  const [values, setValues] = useState<Record<string, string>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const clearField = useCallback((field: string, next: Record<string, string>) => {
    if (!(field in next)) return next
    const copy = { ...next }
    delete copy[field]
    return copy
  }, [])

  const clearAll = useCallback(() => {
    Object.values(timers.current).forEach(clearTimeout)
    timers.current = {}
    setValues({})
    setErrors({})
  }, [])

  // Never let a revealed value outlive the pane it belongs to.
  useEffect(() => clearAll, [clearAll, resourceId])

  const hide = useCallback((field: string) => {
    clearTimeout(timers.current[field])
    delete timers.current[field]
    setValues((v) => clearField(field, v))
  }, [clearField])

  const reveal = useCallback(
    async (field: string) => {
      // Clear any stale error from a previous attempt before retrying.
      setErrors((e) => clearField(field, e))
      try {
        const res = await fetch(apiUrl(`/resources/component/${encodeURIComponent(resourceId)}/secret-value`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ field }),
        })
        if (!res.ok) {
          const reason = await revealFailureReason(res)
          setErrors((e) => ({ ...e, [field]: reason }))
          return
        }
        const body = (await res.json()) as { value: string }
        setValues((v) => ({ ...v, [field]: body.value }))
        timers.current[field] = setTimeout(() => hide(field), REVEAL_TTL_MS)
      } catch (err) {
        // Network failure, JSON parse failure, etc. — degrade to an inline
        // error rather than an unhandled rejection or a silent no-op.
        const reason = err instanceof Error ? err.message : 'network error'
        setErrors((e) => ({ ...e, [field]: reason }))
      }
    },
    [resourceId, hide, clearField],
  )

  return { values, errors, reveal, hide }
}
