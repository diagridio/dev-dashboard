/**
 * Canonical language/runtime token for an app, from its detected `runtime`
 * value (go/python/node/dotnet/java/rust — the backend InferRuntime
 * vocabulary). Returns undefined for an unknown, empty, or unrecognized value
 * so callers can omit it. Sibling of modeToken; kept separate because the two
 * vocabularies are distinct (discovery mode vs. app language). The `runtime`
 * field is expected already-canonical, but the input is lowercased/trimmed
 * defensively so a stray-cased or padded value can't leak.
 */
const KNOWN = new Set(['go', 'python', 'node', 'dotnet', 'java', 'rust'])

export function runtimeToken(runtime: string | undefined): string | undefined {
  if (!runtime) return undefined
  const r = runtime.trim().toLowerCase()
  return KNOWN.has(r) ? r : undefined
}
