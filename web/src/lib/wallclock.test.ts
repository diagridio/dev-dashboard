import { describe, it, expect } from 'vitest'
import { elapsed, elapsedTenths, formatOffset, formatDateTime, formatDuration } from './wallclock'

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

describe('formatOffset', () => {
  const created = '2026-06-28T10:00:00.000Z'

  it('returns +0.00s for a zero offset', () => {
    expect(formatOffset(created, created)).toBe('+0.00s')
  })

  it('formats sub-minute offsets as seconds with hundredths', () => {
    expect(formatOffset(created, '2026-06-28T10:00:05.600Z')).toBe('+5.60s')
  })

  it('adds a minutes prefix once the offset reaches 60s', () => {
    expect(formatOffset(created, '2026-06-28T10:06:09.310Z')).toBe('+6m9.31s')
  })

  it('adds hours and minutes prefixes for long offsets', () => {
    expect(formatOffset(created, '2026-06-28T12:30:10.010Z')).toBe('+2h30m10.01s')
  })

  it('clamps negative offsets to +0.00s', () => {
    expect(formatOffset(created, '2026-06-28T09:59:59.000Z')).toBe('+0.00s')
  })

  it('returns empty string when an input is missing or unparseable', () => {
    expect(formatOffset(undefined, created)).toBe('')
    expect(formatOffset(created, undefined)).toBe('')
    expect(formatOffset(created, 'not-a-date')).toBe('')
  })
})

describe('formatDateTime', () => {
  it('returns undefined for missing or unparseable input', () => {
    expect(formatDateTime(undefined)).toBeUndefined()
    expect(formatDateTime('not-a-date')).toBeUndefined()
  })

  it('joins the localized date and time with " - "', () => {
    const ts = '2026-06-28T10:00:05.600Z'
    const d = new Date(ts)
    expect(formatDateTime(ts)).toBe(`${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`)
  })
})

describe('formatDuration', () => {
  it('renders sub-second durations in ms', () => {
    expect(formatDuration(0)).toBe('0ms')
    expect(formatDuration(340)).toBe('340ms')
    expect(formatDuration(999)).toBe('999ms')
  })
  it('renders seconds with one decimal below 10s and whole seconds below a minute', () => {
    expect(formatDuration(1200)).toBe('1.2s')
    expect(formatDuration(9900)).toBe('9.9s')
    expect(formatDuration(12000)).toBe('12s')
  })
  it('renders minutes and padded seconds at or above a minute', () => {
    expect(formatDuration(65000)).toBe('1m 05s')
    expect(formatDuration(600000)).toBe('10m 00s')
  })
  it('returns empty string for invalid input', () => {
    expect(formatDuration(NaN)).toBe('')
    expect(formatDuration(-5)).toBe('')
  })
})
