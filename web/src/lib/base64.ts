/** Placeholder standing in for a run of unprintable bytes. */
const UNPRINTABLE = '·'

/**
 * Decode a base64 state value into printable text.
 *
 * A state value is base64 in the first place precisely because it is *not*
 * valid UTF-8 — a durabletask history blob, a gzip payload — so the decoded
 * bytes are binary with readable fragments embedded in protobuf framing. Runs
 * of unprintable bytes therefore collapse to a single `·`, which is what makes
 * those fragments (an app id, an activity name, an inline JSON input) legible.
 *
 * The list preview is a base64 string already cut to 200 runes with a trailing
 * ellipsis, so the input is first trimmed to a whole number of 4-character
 * base64 groups. Each group is exactly 3 bytes, so the result is a correct
 * prefix of the real value rather than garbage.
 *
 * Returns null when the input will not decode or yields nothing printable, so
 * callers can fall back to the raw base64 instead of rendering an empty cell.
 */
export function decodeBase64Preview(s: string): string | null {
  const cleaned = s.replace(/…+$/, '').replace(/\s+/g, '')
  const whole = cleaned.slice(0, cleaned.length - (cleaned.length % 4))
  if (!whole) return null

  let bytes: string
  try {
    bytes = atob(whole)
  } catch {
    return null
  }

  // Keep printable ASCII; tabs and newlines also become the placeholder so a
  // decoded value always stays on one table row.
  const text = bytes.replace(/[^\x20-\x7E]+/g, UNPRINTABLE)
  const trimmed = text.replace(/^·+/, '').replace(/·+$/, '').trim()
  return trimmed === '' ? null : trimmed
}
