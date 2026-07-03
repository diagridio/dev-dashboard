import type { NewsResponse } from '../types/logs'
import { safeGet, safeSet } from './safeStorage'

const STORAGE_KEY = 'devdash.newsSeen'

/**
 * Returns the URLs of all non-null news slots in order: blog, report, webinar, event.
 */
export function newsUrls(n: NewsResponse): string[] {
  return [n.blog, n.report, n.webinar, n.event]
    .filter((item): item is NonNullable<typeof item> => item !== null)
    .map((item) => item.url)
}

/**
 * Returns the set of URLs that have been marked as seen (from localStorage).
 */
export function getSeen(): Set<string> {
  const raw = safeGet(STORAGE_KEY)
  if (!raw) return new Set()
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed)) return new Set<string>(parsed)
  } catch {
    // ignore parse errors
  }
  return new Set()
}

/**
 * Marks the given URLs as seen by persisting them to localStorage.
 * Merges with any previously seen URLs.
 */
export function markSeen(urls: string[]): void {
  const existing = getSeen()
  for (const url of urls) {
    existing.add(url)
  }
  safeSet(STORAGE_KEY, JSON.stringify([...existing]))
}

/**
 * Returns true if any news slot URL has not yet been seen.
 */
export function hasUnseen(n: NewsResponse): boolean {
  const seen = getSeen()
  return newsUrls(n).some((url) => !seen.has(url))
}
