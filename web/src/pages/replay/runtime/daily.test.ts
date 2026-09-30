import { describe, expect, it } from 'vitest'
import { utcDate } from './daily'

describe('utcDate', () => {
  it('uses the UTC calendar day, whatever the local time zone', () => {
    expect(utcDate(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-30')
    expect(utcDate(new Date('2026-10-01T00:00:00+02:00'))).toBe('2026-09-30')
  })
})
