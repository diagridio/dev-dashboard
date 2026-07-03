import { describe, it, expect } from 'vitest'
import { parseEnum } from './parseEnum'

const SOURCES = ['both', 'daprd', 'app'] as const
type Source = (typeof SOURCES)[number]

describe('parseEnum', () => {
  it('returns the value when it is in the allowed list', () => {
    expect(parseEnum<Source>('daprd', SOURCES, 'both')).toBe('daprd')
  })

  it('falls back for a value outside the allowed list', () => {
    expect(parseEnum<Source>('garbage', SOURCES, 'both')).toBe('both')
  })

  it('falls back for null (missing URL param)', () => {
    expect(parseEnum<Source>(null, SOURCES, 'both')).toBe('both')
  })

  it('falls back for undefined', () => {
    expect(parseEnum<Source>(undefined, SOURCES, 'both')).toBe('both')
  })

  it('falls back for the empty string when not allowed', () => {
    expect(parseEnum<Source>('', SOURCES, 'app')).toBe('app')
  })

  it('is case-sensitive (enum values are exact)', () => {
    expect(parseEnum<Source>('Daprd', SOURCES, 'both')).toBe('both')
  })

  it('supports an empty-string fallback outside the allowed list', () => {
    const STATUSES = ['Running', 'Completed'] as const
    expect(parseEnum<(typeof STATUSES)[number] | ''>('Garbage', STATUSES, '')).toBe('')
    expect(parseEnum<(typeof STATUSES)[number] | ''>('Running', STATUSES, '')).toBe('Running')
  })
})
