import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { RefreshProvider, useRefreshInterval, refetchMs } from './refresh'

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RefreshProvider>{children}</RefreshProvider>
)

beforeEach(() => {
  localStorage.clear()
})

describe('useRefreshInterval — defaults', () => {
  it('defaults intervalMs to 3000', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(3000)
  })

  it('defaults paused to false', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.paused).toBe(false)
  })
})

describe('useRefreshInterval — setInterval', () => {
  it('updates intervalMs when setInterval is called', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    act(() => {
      result.current.setInterval(5000)
    })
    expect(result.current.intervalMs).toBe(5000)
  })

  it('persists intervalMs to localStorage', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    act(() => {
      result.current.setInterval(5000)
    })
    expect(localStorage.getItem('devdash.refreshMs')).toBe('5000')
  })

  it('reads intervalMs from localStorage on mount', () => {
    localStorage.setItem('devdash.refreshMs', '10000')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(10000)
  })
})

describe('useRefreshInterval — stored value validation', () => {
  it('falls back to default when stored value is not an interval option (too large)', () => {
    localStorage.setItem('devdash.refreshMs', '250000')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(3000)
  })

  it('falls back to default when stored value is negative', () => {
    localStorage.setItem('devdash.refreshMs', '-5')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(3000)
  })

  it('falls back to default when stored value is garbage', () => {
    localStorage.setItem('devdash.refreshMs', 'garbage')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(3000)
  })

  it('honors a stored valid option (1s)', () => {
    localStorage.setItem('devdash.refreshMs', '1000')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(1000)
  })

  it('honors a stored valid option (Off = 0)', () => {
    localStorage.setItem('devdash.refreshMs', '0')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(0)
  })
})

describe('useRefreshInterval — setPaused', () => {
  it('updates paused when setPaused is called', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    act(() => {
      result.current.setPaused(true)
    })
    expect(result.current.paused).toBe(true)
  })

  it('persists paused to localStorage', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    act(() => {
      result.current.setPaused(true)
    })
    expect(localStorage.getItem('devdash.refreshPaused')).toBe('true')
  })

  it('reads paused from localStorage on mount', () => {
    localStorage.setItem('devdash.refreshPaused', 'true')
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.paused).toBe(true)
  })
})

describe('refetchMs', () => {
  it('returns false when paused', () => {
    expect(refetchMs({ intervalMs: 3000, paused: true })).toBe(false)
  })

  it('returns intervalMs when not paused', () => {
    expect(refetchMs({ intervalMs: 3000, paused: false })).toBe(3000)
  })

  it('returns false when intervalMs is 0', () => {
    expect(refetchMs({ intervalMs: 0, paused: false })).toBe(false)
  })
})
