import { useEffect, useMemo } from 'react'
import { useApps } from './useApps'
import { getCapabilities } from '../lib/capabilities'
import { setTelemetryContext } from '../lib/telemetry'
import { modeToken } from '../lib/modeToken'

/** Normalizes the CLI --mode capability value for telemetry: '' or
 * undefined (complete scan) becomes 'all'; any other value passes through. */
export function normalizeModeFilter(mode: string | undefined): string {
  return mode ? mode : 'all'
}

/**
 * Keeps RUM global context in sync with the dashboard's discovery mode:
 * `mode_filter` (the CLI --mode, set once) and `modes` (the distinct,
 * sorted set of modes among discovered apps, refreshed as the apps list
 * changes). Mount exactly once, near the app root.
 */
export function useModeTelemetry(): void {
  useEffect(() => {
    setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))
  }, [])

  const { data } = useApps()
  const modes = useMemo(() => {
    const tokens = new Set<string>()
    for (const app of data ?? []) {
      const t = modeToken(app)
      if (t) tokens.add(t)
    }
    return [...tokens].sort()
  }, [data])

  // Refire only when the *set* changes (join key), not on every poll that
  // returns an equivalent set, so identical sets don't churn RUM context.
  const modesKey = data === undefined ? null : modes.join(',')
  useEffect(() => {
    if (modesKey === null) return
    setTelemetryContext('modes', modes)
    // modes is derived from the same data as modesKey; keying on modesKey
    // alone is intentional to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modesKey])
}
