import { describe, expect, it } from 'vitest'
import { modeLabel } from './modeLabel'

describe('modeLabel', () => {
  it('maps sources to pretty mode names', () => {
    expect(modeLabel({ source: 'standalone' })).toBe('Dapr run')
    expect(modeLabel({ source: 'compose' })).toBe('Compose')
    expect(modeLabel({ source: 'testcontainers' })).toBe('TestContainers')
    expect(modeLabel({ source: 'aspire' })).toBe('Aspire')
  })
  it('prefers the Aspire flag over the standalone source', () => {
    expect(modeLabel({ source: 'standalone', isAspire: true })).toBe('Aspire')
  })
  it('falls back to a dash for unknown sources', () => {
    expect(modeLabel({ source: undefined })).toBe('—')
  })
})
