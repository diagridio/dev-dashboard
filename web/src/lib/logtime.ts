/**
 * Parse the leading clock token from a log line text.
 * Returns a numeric value suitable for chronological comparison.
 * Falls back to Infinity (treated as "no time") so lines without
 * a parseable timestamp are sorted after lines that have one.
 * When two lines share the same parsed time, caller uses arrival
 * seq to preserve stable order.
 */
export function parseLogTime(text: string): number {
  // Match HH:MM:SS.mmm or HH:MM:SS (standalone at start of string or after ISO prefix)
  // Also handles ISO timestamps like 2006-01-02T15:04:05.000
  const iso = text.match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (iso) {
    const h = parseInt(iso[1], 10)
    const m = parseInt(iso[2], 10)
    const s = parseInt(iso[3], 10)
    const ms = iso[4] ? parseInt(iso[4].slice(0, 3).padEnd(3, '0'), 10) : 0
    return h * 3_600_000 + m * 60_000 + s * 1_000 + ms
  }

  const hms = text.match(/\b(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (hms) {
    const h = parseInt(hms[1], 10)
    const m = parseInt(hms[2], 10)
    const s = parseInt(hms[3], 10)
    const ms = hms[4] ? parseInt(hms[4].slice(0, 3).padEnd(3, '0'), 10) : 0
    return h * 3_600_000 + m * 60_000 + s * 1_000 + ms
  }

  return Infinity
}
