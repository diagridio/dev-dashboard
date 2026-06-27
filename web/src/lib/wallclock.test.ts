import { describe, it, expect } from 'vitest'
import { elapsed } from './wallclock'

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
