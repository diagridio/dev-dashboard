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

const SHOWN_KEY = 'devdash.promoShown'
// Fallback when sessionStorage is unavailable: dedupe for this page load only.
const shownThisLoad = new Set<string>()

/**
 * Records that the promotion was shown in this tab. Returns true only the
 * first time per tab, so `promo_shown` isn't re-tracked on every remount.
 */
export function markPromoShown(id: string): boolean {
  let raw: string | null
  try {
    raw = sessionStorage.getItem(SHOWN_KEY)
  } catch {
    // sessionStorage unavailable (restricted context)
    if (shownThisLoad.has(id)) return false
    shownThisLoad.add(id)
    return true
  }
  let ids: string[] = []
  try {
    const parsed: unknown = JSON.parse(raw ?? '[]')
    if (Array.isArray(parsed)) ids = parsed.filter((v): v is string => typeof v === 'string')
  } catch {
    // corrupt storage reads as nothing shown
  }
  if (ids.includes(id)) return false
  try {
    sessionStorage.setItem(SHOWN_KEY, JSON.stringify([...ids, id]))
  } catch {
    // ignore persistence failures
  }
  return true
}

/** Remembers that the promotion with this id was closed, so it stays hidden. */
export function dismissPromo(id: string): void {
  const ids = getDismissed()
  if (!ids.includes(id)) ids.push(id)
  safeSet(STORAGE_KEY, JSON.stringify(ids))
}
