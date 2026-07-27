import { useEffect } from 'react'
import type { AppSummary } from '../types/api'
import { modeToken } from '../lib/modeToken'
import { runtimeToken } from '../lib/runtimeToken'
import { setTelemetryContext, removeTelemetryContext } from '../lib/telemetry'

/**
 * Keeps RUM per-app global-context properties in sync with the app the user
 * is currently focused on (its detail page): `app_mode` (discovery mode) and
 * `app_runtime` (language). Each is set on mount / when its value changes and
 * removed on unmount, so an error on a later, non-app page is never attributed
 * to a previously-viewed app. An unknown/absent value sets nothing.
 */
export function useAppTelemetry(app: Pick<AppSummary, 'source' | 'isAspire' | 'runtime'>): void {
  const mode = modeToken(app)
  useEffect(() => {
    if (mode) setTelemetryContext('app_mode', mode)
    return () => removeTelemetryContext('app_mode')
  }, [mode])

  const runtime = runtimeToken(app.runtime)
  useEffect(() => {
    if (runtime) setTelemetryContext('app_runtime', runtime)
    return () => removeTelemetryContext('app_runtime')
  }, [runtime])
}
