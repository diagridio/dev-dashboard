import { useEffect, useState } from 'react'

/**
 * Formats the elapsed time since an RFC3339 timestamp: "42s", "3m 07s",
 * "2h 14m 05s", "1d 2h 0m". Returns null when startedAt is unparseable.
 */
export function formatUptime(startedAt: string, nowMs: number): string | null {
  const t = Date.parse(startedAt)
  if (Number.isNaN(t)) return null
  let s = Math.max(0, Math.floor((nowMs - t) / 1000))
  const d = Math.floor(s / 86_400)
  s -= d * 86_400
  const h = Math.floor(s / 3_600)
  s -= h * 3_600
  const m = Math.floor(s / 60)
  s -= m * 60
  const ss = String(s).padStart(2, '0')
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${ss}s`
  if (m > 0) return `${m}m ${ss}s`
  return `${s}s`
}

/** Current time in ms, re-rendering every intervalMs (default 1s). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
