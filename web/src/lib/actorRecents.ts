import { safeGet, safeSet } from './safeStorage'

const MAX = 10

const key = (kind: 'ids' | 'methods', appKey: string, type: string) =>
  `actor-recent-${kind}:${encodeURIComponent(appKey)}:${encodeURIComponent(type)}`

function read(k: string): string[] {
  const raw = safeGet(k)
  if (!raw) return []
  try {
    const v: unknown = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function push(k: string, value: string): void {
  if (!value) return
  const next = [value, ...read(k).filter((v) => v !== value)].slice(0, MAX)
  safeSet(k, JSON.stringify(next))
}

/** Recently invoked or opened actor IDs for an app and type, newest first (max 10). */
export function recentIds(appKey: string, type: string): string[] {
  return read(key('ids', appKey, type))
}

/** Recently invoked methods for an app and type, newest first (max 10). */
export function recentMethods(appKey: string, type: string): string[] {
  return read(key('methods', appKey, type))
}

export function rememberInvoke(appKey: string, type: string, id: string, method: string): void {
  push(key('ids', appKey, type), id)
  push(key('methods', appKey, type), method)
}

/** Records an actor ID the user opened; it joins the recently invoked IDs. */
export function rememberId(appKey: string, type: string, id: string): void {
  push(key('ids', appKey, type), id)
}

/** SPA route for an actor type or instance; each segment is URI-encoded. */
export function actorPath(appKey: string, type: string, id?: string): string {
  const base = `/actors/${encodeURIComponent(appKey)}/${encodeURIComponent(type)}`
  return id === undefined ? base : `${base}/${encodeURIComponent(id)}`
}
