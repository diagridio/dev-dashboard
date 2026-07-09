import type { AppSummary } from '../types/api'

/**
 * Routing identity for an app instance: instanceKey (container name for
 * compose apps) with appId fallback for older payloads and test fixtures.
 */
export function appKey(app: Pick<AppSummary, 'appId' | 'instanceKey'>): string {
  return app.instanceKey || app.appId
}
