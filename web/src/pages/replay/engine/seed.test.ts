import { describe, expect, it } from 'vitest'
import { seedForDate } from './seed'

describe('seedForDate', () => {
  it('is a stable uint32 per date and differs between dates', () => {
    const a = seedForDate('2026-09-30')
    expect(seedForDate('2026-09-30')).toBe(a)
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true)
    expect(seedForDate('2026-10-01')).not.toBe(a)
  })
})
