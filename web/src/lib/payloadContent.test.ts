import { describe, it, expect, vi, afterEach } from 'vitest'
import { analyzePayload } from './payloadContent'

async function sha(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}
const enc = (s: string) => new TextEncoder().encode(s)

describe('analyzePayload', () => {
  it('classifies verified JSON', async () => {
    const b = enc('{"a":1}')
    expect(await analyzePayload(b, await sha(b))).toEqual({
      content: { kind: 'json', text: '{"a":1}' },
      integrity: 'verified',
    })
  })
  it('classifies plain text', async () => {
    const b = enc('hello')
    const r = await analyzePayload(b, await sha(b))
    expect(r.content).toEqual({ kind: 'text', text: 'hello' })
    expect(r.integrity).toBe('verified')
  })
  it('classifies invalid UTF-8 as binary', async () => {
    const b = new Uint8Array([0xff, 0xfe])
    const r = await analyzePayload(b, await sha(b))
    expect(r.content).toEqual({ kind: 'binary', size: 2 })
  })
  it('flags a hash mismatch but still returns content', async () => {
    const r = await analyzePayload(enc('hello'), 'a'.repeat(64))
    expect(r.integrity).toBe('mismatch')
    expect(r.content).toEqual({ kind: 'text', text: 'hello' })
  })

  describe('without SubtleCrypto', () => {
    afterEach(() => vi.unstubAllGlobals())
    it('returns content as unverified instead of throwing', async () => {
      vi.stubGlobal('crypto', {})
      const r = await analyzePayload(enc('{"a":1}'), 'a'.repeat(64))
      expect(r).toEqual({ content: { kind: 'json', text: '{"a":1}' }, integrity: 'unverified' })
    })
  })
})
