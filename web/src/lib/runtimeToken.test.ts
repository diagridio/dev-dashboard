import { describe, it, expect } from 'vitest'
import { runtimeToken } from './runtimeToken'

describe('runtimeToken', () => {
  it('returns the token for each known language', () => {
    for (const lang of ['go', 'python', 'node', 'dotnet', 'java', 'rust']) {
      expect(runtimeToken(lang)).toBe(lang)
    }
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(runtimeToken(' DotNet ')).toBe('dotnet')
    expect(runtimeToken('GO')).toBe('go')
  })

  it('returns undefined for unknown, empty, or absent values', () => {
    expect(runtimeToken('unknown')).toBeUndefined()
    expect(runtimeToken('')).toBeUndefined()
    expect(runtimeToken(undefined)).toBeUndefined()
    expect(runtimeToken('cobol')).toBeUndefined()
  })
})
