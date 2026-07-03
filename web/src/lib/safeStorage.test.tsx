import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import React from 'react'
import { getTheme, setTheme, getHistoryOrder, setHistoryOrder } from './prefs'
import { RefreshProvider, useRefreshInterval } from './refresh'
import { markSeen, getSeen } from './newsSeen'
import { safeGet, safeSet } from './safeStorage'

/**
 * Simulates a restricted context (private mode / blocked storage) where any
 * localStorage access throws.
 */
function throwingStorage(): Storage {
  const deny = () => {
    throw new Error('storage disabled')
  }
  return {
    get length(): number {
      throw new Error('storage disabled')
    },
    clear: deny,
    getItem: deny,
    setItem: deny,
    removeItem: deny,
    key: deny,
  } as unknown as Storage
}

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <RefreshProvider>{children}</RefreshProvider>
)

describe('storage accessors under a throwing localStorage', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', throwingStorage())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('getTheme returns the default instead of throwing', () => {
    expect(getTheme()).toBe('light')
  })

  it('setTheme does not throw', () => {
    expect(() => setTheme('dark')).not.toThrow()
  })

  it('getHistoryOrder returns the default instead of throwing', () => {
    expect(getHistoryOrder()).toBe('asc')
  })

  it('setHistoryOrder does not throw', () => {
    expect(() => setHistoryOrder('desc')).not.toThrow()
  })

  it('RefreshProvider mounts with defaults (readIntervalMs / readPaused)', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    expect(result.current.intervalMs).toBe(3000)
    expect(result.current.paused).toBe(false)
  })

  it('setInterval / setPaused still update state without throwing', () => {
    const { result } = renderHook(() => useRefreshInterval(), { wrapper })
    act(() => {
      result.current.setInterval(5000)
    })
    expect(result.current.intervalMs).toBe(5000)
    act(() => {
      result.current.setPaused(true)
    })
    expect(result.current.paused).toBe(true)
  })

  it('getSeen returns an empty set instead of throwing', () => {
    expect(getSeen()).toEqual(new Set())
  })

  it('markSeen does not throw', () => {
    expect(() => markSeen(['https://example.com/post'])).not.toThrow()
  })
})

describe('safeStorage helper', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('safeGet/safeSet round-trip through localStorage when it works', () => {
    safeSet('devdash.safeStorageTest', 'v1')
    expect(safeGet('devdash.safeStorageTest')).toBe('v1')
  })

  it('safeGet returns null for a missing key', () => {
    expect(safeGet('devdash.safeStorageTest.missing')).toBeNull()
  })

  it('safeGet returns null when localStorage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(safeGet('devdash.safeStorageTest')).toBeNull()
  })

  it('safeSet swallows errors when localStorage throws', () => {
    vi.stubGlobal('localStorage', throwingStorage())
    expect(() => safeSet('devdash.safeStorageTest', 'v2')).not.toThrow()
  })
})
