import { useRefreshInterval } from '../lib/refresh'

/**
 * Display-only refresh indicator for list-page headers (mock A `.live`).
 * Reads the global refresh context; does NOT mutate it.
 */
export function LiveIndicator() {
  const { intervalMs, paused } = useRefreshInterval()
  const active = !paused && intervalMs > 0
  if (!active) {
    return <span className="live">auto-refresh off</span>
  }
  const seconds = Math.round(intervalMs / 1000)
  return (
    <span className="live">
      <span className="beat" /> refreshing every {seconds}s
    </span>
  )
}
