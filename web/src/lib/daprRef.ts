// Detects the Dapr 1.19 SDK "$daprRef" data-reference envelope that replaces
// large workflow payloads in history. See the design spec, section
// "Workflow data references" -> "Envelope detection".

export interface DaprRefStage {
  n: string
  m?: Record<string, string>
}

export interface DaprRef {
  v: 1
  store: string
  key: string
  size: number
  sha256: string
  stages?: DaprRefStage[]
}

export type ParsedPayload =
  | { kind: 'data' }
  | { kind: 'ref'; ref: DaprRef }
  | { kind: 'invalid'; reason: string }

const invalid = (reason: string): ParsedPayload => ({ kind: 'invalid', reason })
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)
const nonEmpty = (x: unknown): x is string => typeof x === 'string' && x.trim() !== ''

export function parseDaprRef(text: string): ParsedPayload {
  const t = text.trimStart()
  if (!t.startsWith('{')) return { kind: 'data' }

  let parsed: unknown
  try {
    parsed = JSON.parse(t)
  } catch {
    return t.includes('$daprRef') ? invalid('not valid JSON') : { kind: 'data' }
  }

  if (!isObject(parsed)) return { kind: 'data' }
  const keys = Object.keys(parsed)
  if (keys.length !== 1 || keys[0] !== '$daprRef') return { kind: 'data' }

  const r = parsed.$daprRef
  if (!isObject(r)) return invalid('$daprRef must be an object')
  if (r.v !== 1) return invalid('v must be 1')
  if (!nonEmpty(r.store)) return invalid('store must be a non-empty string')
  if (!nonEmpty(r.key)) return invalid('key must be a non-empty string')
  if (typeof r.size !== 'number' || !Number.isSafeInteger(r.size) || r.size < 0) {
    return invalid('size must be a non-negative integer')
  }
  if (typeof r.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(r.sha256)) {
    return invalid('sha256 must be 64 lowercase hex characters')
  }

  let stages: DaprRefStage[] | undefined
  if (r.stages !== undefined) {
    if (!Array.isArray(r.stages)) return invalid('stages must be an array')
    stages = []
    for (const s of r.stages) {
      if (!isObject(s) || typeof s.n !== 'string') return invalid('stages entries must have a string n')
      if (s.m !== undefined) {
        if (!isObject(s.m) || !Object.values(s.m).every((v) => typeof v === 'string')) {
          return invalid('stage m must map strings to strings')
        }
        stages.push({ n: s.n, m: s.m as Record<string, string> })
      } else {
        stages.push({ n: s.n })
      }
    }
  }

  const ref: DaprRef = { v: 1, store: r.store, key: r.key, size: r.size, sha256: r.sha256 }
  if (stages) ref.stages = stages
  return { kind: 'ref', ref }
}
