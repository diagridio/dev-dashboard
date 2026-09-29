import { describe, it, expect } from 'vitest'
import { decodeBase64Preview } from './base64'

// A shape like a real durabletask history blob: protobuf framing bytes with
// readable strings embedded between them.
const BLOB = 'CgwI/LyM02FwaXNlcnZpY2UymQFEaWFnbm9zZVN1YnN5c3RlbUFjdGl2aXR5Gh8='

/** The placeholder the decoder substitutes for a run of unprintable bytes. */
const DOT = '·'

describe('decodeBase64Preview', () => {
  it('surfaces the readable fragments of a binary blob', () => {
    const out = decodeBase64Preview(BLOB)
    expect(out).toContain('apiservice')
    expect(out).toContain('DiagnoseSubsystemActivity')
  })

  it('collapses runs of unprintable bytes to a single placeholder', () => {
    const out = decodeBase64Preview(BLOB) ?? ''
    // Never two placeholders in a row — a multi-byte run of framing is one dot.
    expect(out).not.toMatch(new RegExp(DOT + DOT))
    // Framing bytes that are themselves printable ASCII survive, so the two
    // fragments sit at most a byte or two apart plus one placeholder.
    expect(out).toMatch(new RegExp('apiservice.{0,2}' + DOT + 'DiagnoseSubsystemActivity'))
  })

  it('decodes plain text round-trip', () => {
    expect(decodeBase64Preview(btoa('hello world'))).toBe('hello world')
  })

  it('decodes a truncated preview by dropping the partial 4-char group', () => {
    // The list preview cuts base64 mid-stream and appends an ellipsis; the
    // decoded result must still be a correct prefix of the original bytes.
    const full = btoa('the quick brown fox jumps')
    const cut = full.slice(0, 14) + '…'
    const out = decodeBase64Preview(cut)
    expect(out).not.toBeNull()
    expect('the quick brown fox jumps'.startsWith(out as string)).toBe(true)
  })

  it('returns null for input that cannot decode, so callers can fall back', () => {
    expect(decodeBase64Preview('!!!!')).toBeNull()
    expect(decodeBase64Preview('')).toBeNull()
    expect(decodeBase64Preview('…')).toBeNull()
  })

  it('returns null when nothing printable survives', () => {
    expect(decodeBase64Preview(btoa('\x00\x00\x00\x00'))).toBeNull()
  })
})
