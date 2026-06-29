import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, setTheme, applyPrefs, getHistoryOrder, setHistoryOrder } from './prefs'

beforeEach(() => {
  localStorage.clear()
})

describe('prefs', () => {
  it('defaults to light theme', () => {
    expect(getTheme()).toBe('light')
  })

  it('persists theme via setTheme', () => {
    setTheme('dark')
    expect(getTheme()).toBe('dark')
  })

  it('applyPrefs is a no-op (does not throw)', () => {
    expect(() => applyPrefs()).not.toThrow()
  })
})

describe('history order pref', () => {
  it("defaults to 'asc' when nothing is stored", () => {
    expect(getHistoryOrder()).toBe('asc')
  })

  it("falls back to 'asc' for an invalid stored value", () => {
    localStorage.setItem('devdash.workflowHistoryOrder', 'sideways')
    expect(getHistoryOrder()).toBe('asc')
  })

  it('persists the order via setHistoryOrder', () => {
    setHistoryOrder('desc')
    expect(getHistoryOrder()).toBe('desc')
  })
})
