import type { StateStore } from '../types/workflow'

/**
 * Collapse state stores that share the same metadata name, type, and connection
 * but live at different file paths into a single representative. Several
 * component files pointing at the same store read identical data, so they need
 * not appear as separate dropdown options.
 *
 * Grouping key is `name|type|connection` (path excluded) — matching the
 * backend's identity() notion. One entry is emitted per group in order of the
 * group's first appearance; the representative is the group's active member if
 * one exists, otherwise the first member encountered. Input is not mutated.
 */
export function dedupeStores(stores: StateStore[]): StateStore[] {
  const indexByKey = new Map<string, number>()
  const out: StateStore[] = []
  for (const s of stores) {
    const key = `${s.name}|${s.type}|${s.connection}`
    const existing = indexByKey.get(key)
    if (existing === undefined) {
      indexByKey.set(key, out.length)
      out.push(s)
      continue
    }
    // Group already represented — upgrade to the active member if this one is it.
    if (s.active && !out[existing].active) {
      out[existing] = s
    }
  }
  return out
}
