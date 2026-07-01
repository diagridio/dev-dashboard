import { describe, it, expect } from 'vitest'
import {
  validateGoDuration,
  validateResourceName,
  validateStatusCodes,
  requiredError,
  integerError,
} from './validation'

describe('validateGoDuration', () => {
  it('accepts ordered unit combinations', () => {
    for (const d of ['30s', '1h', '1h30m', '500ms', '1m30s', '10s', '15m']) {
      expect(validateGoDuration(d).valid, d).toBe(true)
    }
  })
  it('accepts empty string (required-ness gated separately)', () => {
    expect(validateGoDuration('').valid).toBe(true)
  })
  it('rejects out-of-order and repeated units', () => {
    expect(validateGoDuration('1s1h').valid).toBe(false)
    expect(validateGoDuration('1m1m').valid).toBe(false)
  })
  it('rejects arbitrary text', () => {
    const r = validateGoDuration('nope')
    expect(r.valid).toBe(false)
    expect(r.error).toBeTruthy()
  })
})

describe('validateResourceName', () => {
  it('accepts lowercase dns-ish names', () => {
    expect(validateResourceName('order-store')).toBeNull()
  })
  it('rejects empty, spaces, bad chars, and non-letter starts', () => {
    expect(validateResourceName('')).toMatch(/required/i)
    expect(validateResourceName('a b')).toMatch(/space/i)
    expect(validateResourceName('a_b')).toMatch(/alphanumeric/i)
    expect(validateResourceName('1abc')).toMatch(/start/i)
  })
})

describe('validateStatusCodes', () => {
  it('accepts CSV of codes and ranges', () => {
    expect(validateStatusCodes('200,404,500-503')).toBeNull()
    expect(validateStatusCodes('')).toBeNull() // optional
  })
  it('rejects malformed input', () => {
    expect(validateStatusCodes('200,abc')).toBeTruthy()
    expect(validateStatusCodes('200-')).toBeTruthy()
  })
})

describe('requiredError / integerError', () => {
  it('requiredError flags empty', () => {
    expect(requiredError('')).toMatch(/required/i)
    expect(requiredError('x')).toBeNull()
  })
  it('integerError flags non-integers, allows empty', () => {
    expect(integerError('')).toBeNull()
    expect(integerError('3')).toBeNull()
    expect(integerError('-1')).toBeNull()
    expect(integerError('1.5')).toMatch(/integer/i)
    expect(integerError('x')).toMatch(/integer/i)
  })
})
