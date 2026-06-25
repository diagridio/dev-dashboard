// Base URL for all API calls: BASE_URL (e.g. "/" or "/dashboard/") + "api"
const base = import.meta.env.BASE_URL.replace(/\/$/, '') + '/api'

/** Build a full URL for an API path, e.g. apiUrl('/version') → '/api/version' */
export function apiUrl(path: string): string {
  return base + path
}

/** Fetch JSON from the API and return the parsed body. Throws on non-2xx responses. */
export async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path))
  if (!res.ok) {
    throw new Error(`API error ${res.status} for ${path}`)
  }
  return res.json() as Promise<T>
}
