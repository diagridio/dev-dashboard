import type { AppSummary } from '../types/api'

/**
 * Pretty discovery-mode label for an instance. Maps the wire `source` values
 * to the CLI mode names (standalone → "Dapr run", testcontainers →
 * "TestContainers"); host-mode Aspire apps arrive with source 'standalone'
 * and isAspire set, so the flag wins.
 */
export function modeLabel(app: Pick<AppSummary, 'source' | 'isAspire'>): string {
  if (app.isAspire || app.source === 'aspire') return 'Aspire'
  switch (app.source) {
    case 'compose':
      return 'Compose'
    case 'testcontainers':
      return 'TestContainers'
    case 'standalone':
      return 'Dapr run'
    default:
      return '—'
  }
}
