import type { AppSummary } from '../types/api'

/**
 * Canonical discovery-mode token for an app, in the CLI --mode vocabulary
 * (dapr-run/compose/test-containers/aspire). Returns undefined for an
 * absent or unknown source so callers can omit it. The Aspire flag wins
 * over source, matching modeLabel.ts. Distinct from modeLabel (pretty UI
 * labels) because telemetry needs stable, filterable tokens.
 */
export function modeToken(app: Pick<AppSummary, 'source' | 'isAspire'>): string | undefined {
  if (app.isAspire || app.source === 'aspire') return 'aspire'
  switch (app.source) {
    case 'compose':
      return 'compose'
    case 'testcontainers':
      return 'test-containers'
    case 'standalone':
      return 'dapr-run'
    default:
      return undefined
  }
}
