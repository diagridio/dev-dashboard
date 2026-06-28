import { describe, it, expect } from 'vitest'
import { elapsed, elapsedTenths } from './wallclock'

describe('elapsed', () => {
  it('formats mm:ss between created and now', () => {
    const created = '2026-06-26T10:00:00Z'
    const now = Date.parse('2026-06-26T10:01:30Z')
    expect(elapsed(created, null, now)).toBe('01:30')
  })
  it('freezes at total duration when ended', () => {
    expect(elapsed('2026-06-26T10:00:00Z', '2026-06-26T11:02:05Z')).toBe('1:02:05')
  })
})

describe('elapsedTenths', () => {
  it('formats M:SS.t (no zero-padded minutes, tenths of a second)', () => {
    const created = '2026-06-26T10:00:00.000Z'
    const now = Date.parse('2026-06-26T10:00:00.000Z')
    expect(elapsedTenths(created, null, now)).toBe('0:00.0')
  })
  it('formats 1:23.7 correctly', () => {
    const created = '2026-06-26T10:00:00.000Z'
    // 1 minute, 23 seconds, 700 ms
    const now = Date.parse('2026-06-26T10:00:00.000Z') + (1 * 60 + 23) * 1000 + 700
    expect(elapsedTenths(created, null, now)).toBe('1:23.7')
  })
  it('includes hours when elapsed >= 1 hour', () => {
    const created = '2026-06-26T10:00:00.000Z'
    const ended = '2026-06-26T11:02:05.300Z'
    expect(elapsedTenths(created, ended)).toBe('1:02:05.3')
  })
  it('freezes at total duration when endedAt is provided', () => {
    const created = '2026-06-26T10:00:00.000Z'
    const ended = '2026-06-26T10:00:30.500Z'
    expect(elapsedTenths(created, ended)).toBe('0:30.5')
  })
})
