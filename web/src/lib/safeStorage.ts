/**
 * Guarded localStorage access.
 *
 * In restricted contexts (private browsing, blocked third-party storage,
 * sandboxed iframes) any access to `localStorage` can throw. These helpers
 * swallow those errors so reading/writing preferences never crashes the app.
 */

export function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // localStorage may be unavailable (private mode / restricted context)
    return null
  }
}

export function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    // ignore persistence failures
  }
}
