import { safeGet, safeSet } from './safeStorage'

const STORAGE_KEY = 'devdash.promoDismissed'

/** Dismissed promotion ids; corrupt or non-string-array storage reads as empty. */
function getDismissed(): string[] {
  const raw = safeGet(STORAGE_KEY)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // ignore parse errors
  }
  return []
}

/** True when the promotion with this id was closed before. */
export function isPromoDismissed(id: string): boolean {
  return getDismissed().includes(id)
}

/** Remembers that the promotion with this id was closed, so it stays hidden. */
export function dismissPromo(id: string): void {
  const ids = getDismissed()
  if (!ids.includes(id)) ids.push(id)
  safeSet(STORAGE_KEY, JSON.stringify(ids))
}
