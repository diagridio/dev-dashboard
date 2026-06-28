import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, setTheme, applyPrefs } from './prefs'

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
