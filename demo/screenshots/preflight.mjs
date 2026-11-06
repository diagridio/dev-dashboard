// Preflight: confirm every demo app is reachable and has seeded its scenario,
// using the control contract (GET /demo/status -> {"seeded": bool, "error"?: string}).

export const DEMO_APPS = [
  { name: 'engineering', url: 'http://localhost:6001' },
  { name: 'bridge', url: 'http://localhost:6002' },
  { name: 'sickbay', url: 'http://localhost:6003' },
]

/**
 * @param {typeof fetch} fetchFn
 * @param {{name: string, url: string}[]} urls
 * @returns {Promise<{ok: boolean, problems: string[]}>}
 */
export async function checkDemo(fetchFn, urls = DEMO_APPS) {
  const problems = []
  await Promise.all(
    urls.map(async ({ name, url }) => {
      let body
      try {
        const res = await fetchFn(`${url}/demo/status`, { signal: AbortSignal.timeout(5000) })
        if (!res.ok) {
          problems.push(`${name} (${url}) returned HTTP ${res.status}`)
          return
        }
        body = await res.json()
      } catch {
        problems.push(`${name} (${url}) unreachable`)
        return
      }
      if (body?.seeded !== true) {
        problems.push(body?.error ? `${name} not seeded: ${body.error}` : `${name} not seeded`)
      }
    }),
  )
  // Keep the report order stable (Promise.all settles in any order).
  const order = (p) => urls.findIndex(({ name }) => p.startsWith(name))
  problems.sort((a, b) => order(a) - order(b))
  return { ok: problems.length === 0, problems }
}
