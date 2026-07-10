import type { AppSummary } from '../types/api'
import { ledClass } from './runtimeSwatch'

export interface DisplayState {
  label: string
  /** LED modifier class: 'ok' | 'warn' | 'bad' | 'off' */
  led: string
  /** tooltip explaining amber states */
  hint?: string
}

type HealthFields = Pick<AppSummary, 'health' | 'appStatus' | 'daprdStatus' | 'sidecarOrphaned'>

/**
 * Derives the single health state shown for an instance from both halves:
 * stopped (both) > orphaned > app down > plain sidecar health.
 */
export function appDisplayState(app: HealthFields): DisplayState {
  if (app.appStatus === 'stopped' && app.daprdStatus === 'stopped') {
    return { label: 'stopped', led: 'off' }
  }
  if (app.sidecarOrphaned) {
    return { label: 'orphaned', led: 'warn', hint: 'sidecar has no supervising dapr CLI and no app — safe to stop' }
  }
  if (app.health === 'healthy' && app.appStatus === 'stopped') {
    return { label: 'app down', led: 'warn', hint: 'app process is not running' }
  }
  return { label: app.health, led: ledClass(app.health) }
}
