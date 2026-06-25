import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, setTheme, getDensity, setDensity, applyPrefs } from './prefs'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
})

describe('prefs', () => {
  it('defaults to light + compact', () => {
    expect(getTheme()).toBe('light')
    expect(getDensity()).toBe('compact')
  })

  it('persists and applies theme', () => {
    setTheme('dark')
    expect(getTheme()).toBe('dark')
    applyPrefs()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists and applies density', () => {
    setDensity('comfortable')
    applyPrefs()
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable')
  })
})
