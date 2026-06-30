// Base URL for all API calls: BASE_URL (e.g. "/" or "/dashboard/") + "api"
const base = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api'

/** Build a full URL for an API path, e.g. apiUrl('/version') → '/api/version' */
export function apiUrl(path: string): string {
  return base + path
}

/** Fetch JSON from the API and return the parsed body. Throws on non-2xx responses.
 *  The thrown Error keeps the `API error <status>` prefix and ` for <path>` suffix
 *  (so callers' `.includes('503')` checks still hold) and, when the response body
 *  carries an `error` field, embeds that server message between them. */
export async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path))
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: unknown }
      if (body && typeof body.error === 'string') {
        detail = `: ${body.error}`
      }
    } catch {
      // Non-JSON or empty body: fall back to the status-only message.
    }
    throw new Error(`API error ${res.status}${detail} for ${path}`)
  }
  return (await res.json()) as T
}
