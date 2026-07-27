import { describe, it, expect } from 'vitest'
import { modeToken } from './modeToken'

describe('modeToken', () => {
  it('maps each source to its canonical token', () => {
    expect(modeToken({ source: 'standalone' })).toBe('dapr-run')
    expect(modeToken({ source: 'compose' })).toBe('compose')
    expect(modeToken({ source: 'testcontainers' })).toBe('test-containers')
    expect(modeToken({ source: 'aspire' })).toBe('aspire')
  })

  it('prefers the Aspire flag over the standalone source', () => {
    expect(modeToken({ source: 'standalone', isAspire: true })).toBe('aspire')
  })

  it('returns undefined for an absent or unknown source', () => {
    expect(modeToken({ source: undefined })).toBeUndefined()
    expect(modeToken({})).toBeUndefined()
  })
})
