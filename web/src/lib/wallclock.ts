export function elapsed(createdAt: string, endedAt?: string | null, now?: number): string {
  const start = Date.parse(createdAt)
  if (isNaN(start)) return ''
  const end = endedAt ? Date.parse(endedAt) : (now ?? Date.now())
  let secs = Math.max(0, Math.floor((end - start) / 1000))
  const h = Math.floor(secs / 3600); secs -= h * 3600
  const m = Math.floor(secs / 60); const s = secs - m * 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}

/** Format elapsed time as M:SS.t (tenths of a second, no zero-padded minutes). */
export function elapsedTenths(createdAt: string, endedAt?: string | null, now?: number): string {
  const start = Date.parse(createdAt)
  if (isNaN(start)) return ''
  const end = endedAt ? Date.parse(endedAt) : (now ?? Date.now())
  const ms = Math.max(0, end - start)
  const totalSecs = ms / 1000
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = Math.floor(totalSecs % 60)
  const t = Math.floor((ms % 1000) / 100)
  const pad = (n: number) => String(n).padStart(2, '0')
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}.${t}`
  return `${m}:${pad(s)}.${t}`
}

/**
 * Format the signed offset between two timestamps as +[Hh][Mm]S.SSs.
 * Minutes appear only at >= 60s, hours only at >= 60m; seconds always carry
 * two decimals. Negative deltas clamp to +0.00s. Returns '' on bad input.
 */
export function formatOffset(fromTs: string | undefined, toTs: string | undefined): string {
  if (!fromTs || !toTs) return ''
  const from = Date.parse(fromTs)
  const to = Date.parse(toTs)
  if (isNaN(from) || isNaN(to)) return ''
  const totalSecs = Math.max(0, to - from) / 1000
  const h = Math.floor(totalSecs / 3600)
  const m = Math.floor((totalSecs % 3600) / 60)
  const s = totalSecs % 60
  let out = '+'
  if (h > 0) out += `${h}h`
  if (h > 0 || m > 0) out += `${m}m`
  out += `${s.toFixed(2)}s`
  return out
}

/** Format a timestamp as localized "date - time", or undefined on bad input. */
export function formatDateTime(ts: string | undefined): string | undefined {
  if (!ts) return undefined
  const d = new Date(ts)
  if (isNaN(d.getTime())) return undefined
  return `${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`
}

/**
 * Format a millisecond duration compactly: "340ms" (<1s), "1.2s" (<10s),
 * "12s" (<1min), "1m 05s" (>=1min). Returns '' for NaN or negative input.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 1000) return `${Math.round(ms)}ms`
  const totalSecs = ms / 1000
  if (totalSecs < 60) {
    return totalSecs < 10 ? `${totalSecs.toFixed(1)}s` : `${Math.round(totalSecs)}s`
  }
  const m = Math.floor(totalSecs / 60)
  const s = Math.round(totalSecs % 60)
  return `${m}m ${String(s).padStart(2, '0')}s`
}
