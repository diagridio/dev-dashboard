import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatUptime, useNow } from './uptime'

describe('formatUptime', () => {
  const t0 = Date.parse('2026-07-09T10:00:00Z')
  it('formats seconds, minutes, hours and days', () => {
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 42_000)).toBe('42s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 3 * 60_000 + 7_000)).toBe('3m 07s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 2 * 3_600_000 + 14 * 60_000 + 5_000)).toBe('2h 14m 05s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 26 * 3_600_000)).toBe('1d 2h 0m')
  })
  it('clamps negative durations to 0s and rejects garbage', () => {
    expect(formatUptime('2026-07-09T10:00:00Z', t0 - 5_000)).toBe('0s')
    expect(formatUptime('not-a-date', t0)).toBeNull()
    expect(formatUptime('', t0)).toBeNull()
  })
})

describe('useNow', () => {
  afterEach(() => vi.useRealTimers())
  it('ticks on the interval', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNow(1000))
    const first = result.current
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toBeGreaterThanOrEqual(first + 3000)
  })
})
