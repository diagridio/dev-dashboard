// The state store types the backend can actually connect to (must match the
// allowlist in pkg/server/api.go validateStoreBody).
export const SUPPORTED_STORE_TYPES = ['state.redis', 'state.sqlite', 'state.postgresql', 'state.mongodb'] as const

const LABELS: Record<string, string> = {
  'state.redis': 'Redis',
  'state.sqlite': 'SQLite',
  'state.postgresql': 'PostgreSQL',
  'state.mongodb': 'MongoDB',
}

export function storeTypeLabel(type: string): string {
  return LABELS[type] ?? type
}

// "state.redis" → "redis" (catalog component name).
export function implFor(type: string): string {
  return type.startsWith('state.') ? type.slice('state.'.length) : type
}
