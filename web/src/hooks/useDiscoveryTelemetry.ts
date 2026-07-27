import { useEffect, useMemo } from 'react'
import type { AppSummary } from '../types/api'
import { useApps } from './useApps'
import { getCapabilities } from '../lib/capabilities'
import { setTelemetryContext } from '../lib/telemetry'
import { modeToken } from '../lib/modeToken'
import { runtimeToken } from '../lib/runtimeToken'

/** Normalizes the CLI --mode capability value for telemetry: '' or
 * undefined (complete scan) becomes 'all'; any other value passes through. */
export function normalizeModeFilter(mode: string | undefined): string {
  return mode ? mode : 'all'
}

/** Distinct, sorted set of tokens produced by `fn` over the apps list. */
function distinctTokens(
  data: AppSummary[] | undefined,
  fn: (app: AppSummary) => string | undefined,
): string[] {
  const tokens = new Set<string>()
  for (const app of data ?? []) {
    const t = fn(app)
    if (t) tokens.add(t)
  }
  return [...tokens].sort()
}

/**
 * Syncs a RUM global-context array property with a distinct token set derived
 * from the apps list. No-op until apps have loaded (data === undefined); then
 * refires only when the set changes (join key), so an equivalent set on a
 * later poll doesn't churn RUM context.
 */
function useDistinctSetContext(
  property: string,
  data: AppSummary[] | undefined,
  tokens: string[],
): void {
  const key = data === undefined ? null : tokens.join(',')
  useEffect(() => {
    if (key === null) return
    setTelemetryContext(property, tokens)
    // tokens is derived from the same data as key; keying on key alone is
    // intentional to avoid churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
}

/**
 * Keeps RUM global context in sync with what the dashboard has discovered:
 * `mode_filter` (the CLI --mode, set once), `modes` (distinct discovery modes),
 * and `runtimes` (distinct app languages). `modes`/`runtimes` refresh as the
 * apps list changes. Mount exactly once, near the app root.
 */
export function useDiscoveryTelemetry(): void {
  useEffect(() => {
    setTelemetryContext('mode_filter', normalizeModeFilter(getCapabilities().mode))
  }, [])

  const { data } = useApps()
  const modes = useMemo(() => distinctTokens(data, modeToken), [data])
  const runtimes = useMemo(() => distinctTokens(data, (app) => runtimeToken(app.runtime)), [data])

  useDistinctSetContext('modes', data, modes)
  useDistinctSetContext('runtimes', data, runtimes)
}
