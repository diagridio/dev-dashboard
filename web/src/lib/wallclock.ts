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
