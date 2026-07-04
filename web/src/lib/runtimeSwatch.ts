import type { HealthStatus } from '../types/api'

// Maps a health status to its LED modifier class.
export function ledClass(health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'ok'
    case 'starting':
      return 'warn'
    case 'unhealthy':
      return 'bad'
    default:
      return 'warn'
  }
}

// Picks a language swatch color from the runtime string (mock A palette).
// Raw hex values are a sanctioned styleguide exception.
export function runtimeSwatch(runtime: string): string {
  const r = runtime.toLowerCase()
  if (r.includes('go')) return '#00ADD8'
  if (r.includes('python') || r.includes('py')) return '#3776AB'
  if (r.includes('node') || r.includes('js')) return '#539E43'
  if (r.includes('.net') || r.includes('dotnet')) return '#8330FF'
  return 'var(--faint)'
}
