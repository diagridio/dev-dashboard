/**
 * Validate a free-form string (typically a URL search param) against a closed
 * set of allowed values. Returns the value narrowed to T when it matches,
 * otherwise the fallback — so `?status=Garbage` never leaks into state or API
 * requests as a bogus enum member.
 */
export function parseEnum<T extends string>(
  value: string | null | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}
