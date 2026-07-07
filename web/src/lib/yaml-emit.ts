import { dump } from 'js-yaml'

/** Serialize an object to YAML using js-yaml defaults (no options). */
export function dumpYaml(obj: unknown): string {
  return dump(obj)
}

// Check if the value is an empty array or empty plain object.
function isEmptyContainer(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0
  if (v && typeof v === 'object') return Object.keys(v as Record<string, unknown>).length === 0
  return false
}

/**
 * Deep-clone `input`, then delete keys whose value is null/undefined, an
 * empty/whitespace string, or an empty object/array — recursing into nested
 * objects and pruning branches that become empty. Numbers (incl. 0) and
 * booleans (incl. false) are preserved.
 */
export function recursivelyRemoveEmptyValues<T>(input: T): T {
  const obj = structuredClone(input)
  if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
    const rec = obj as Record<string, unknown>
    for (const key of Object.keys(rec)) {
      const v = rec[key]
      if (
        v === null ||
        v === undefined ||
        (typeof v === 'string' && v.trim() === '') ||
        (typeof v === 'object' && isEmptyContainer(v))
      ) {
        delete rec[key]
      } else if (typeof v === 'object' && !Array.isArray(v)) {
        rec[key] = recursivelyRemoveEmptyValues(v)
        if (isEmptyContainer(rec[key])) delete rec[key]
      }
    }
  }
  return obj
}
