// Go duration: optional units in strict descending order, no repetition.
// Empty string is valid (required-ness is enforced separately by requiredError).
const DURATION_RE = /^(\d+h)?(\d+m)?(\d+s)?(\d+ms)?(\d+[uµ]s)?(\d+ns)?$/
const UNIT_ORDER = ['h', 'm', 's', 'ms', 'us', 'µs', 'ns']

export function validateGoDuration(value: string): { valid: boolean; error?: string } {
  const err = 'Enter a Go duration like 30s, 5m, 1h30m (units in order h→m→s→ms→us→ns, no repeats)'
  const matches = value.match(DURATION_RE)
  if (!matches) return { valid: false, error: err }
  let lastIndex = -1
  for (let i = 1; i < matches.length; i++) {
    const m = matches[i]
    if (!m) continue
    let unit: string
    if (m.endsWith('ms')) unit = 'ms'
    else if (m.endsWith('us')) unit = 'us'
    else if (m.endsWith('µs')) unit = 'µs'
    else if (m.endsWith('ns')) unit = 'ns'
    else unit = UNIT_ORDER.find((u) => m.endsWith(u)) as string
    const idx = UNIT_ORDER.indexOf(unit)
    if (idx <= lastIndex) return { valid: false, error: err }
    lastIndex = idx
  }
  return { valid: true }
}

// Dapr resource-name rules.
export function validateResourceName(value: string): string | null {
  if (!value) return 'Name is required'
  if (value.includes(' ')) return 'Name cannot contain spaces'
  if (/[^a-zA-Z0-9-]/.test(value)) return 'Only alphanumeric characters and hyphens are allowed'
  if (/^[^a-zA-Z]/.test(value)) return 'Name must start with a letter'
  return null
}

// CSV of HTTP/gRPC status codes or ranges, e.g. "200,404,500-503". Optional.
export function validateStatusCodes(value: string): string | null {
  if (value.trim() === '') return null
  const parts = value.split(',').map((p) => p.trim())
  const seg = /^\d{1,3}(-\d{1,3})?$/
  if (!parts.every((p) => seg.test(p))) return 'Use comma-separated codes or ranges, e.g. 200,404,500-503'
  return null
}

export function requiredError(value: string): string | null {
  return value.trim() === '' ? 'This field is required' : null
}

export function integerError(value: string): string | null {
  if (value.trim() === '') return null
  return /^-?\d+$/.test(value.trim()) ? null : 'Must be an integer'
}
