import { useEffect } from 'react'
import type { AppSummary } from '../types/api'
import { modeToken } from '../lib/modeToken'
import { setTelemetryContext, removeTelemetryContext } from '../lib/telemetry'

/**
 * Keeps the RUM `app_mode` global-context property in sync with the app the
 * user is currently focused on (its detail page). Set on mount / when the
 * app's mode changes; removed on unmount so an error on a later, non-app
 * page is never attributed to a previously-viewed app. An unknown/absent
 * source sets nothing.
 */
export function useAppModeTelemetry(app: Pick<AppSummary, 'source' | 'isAspire'>): void {
  const token = modeToken(app)
  useEffect(() => {
    if (token) setTelemetryContext('app_mode', token)
    return () => removeTelemetryContext('app_mode')
  }, [token])
}
