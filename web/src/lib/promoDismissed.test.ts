import { describe, it, expect, beforeEach } from 'vitest'
import { isPromoDismissed, dismissPromo } from './promoDismissed'

const KEY = 'devdash.promoDismissed'

describe('promoDismissed', () => {
  beforeEach(() => localStorage.clear())

  it('starts with nothing dismissed', () => {
    expect(isPromoDismissed('a')).toBe(false)
  })

  it('remembers a dismissed id only', () => {
    dismissPromo('a')
    expect(isPromoDismissed('a')).toBe(true)
    expect(isPromoDismissed('b')).toBe(false)
  })

  it('does not store duplicates', () => {
    dismissPromo('a')
    dismissPromo('a')
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(['a'])
  })

  it.each(['oops', '{}', '[1,2]'])('treats corrupt storage %s as nothing dismissed', (raw) => {
    localStorage.setItem(KEY, raw)
    expect(() => isPromoDismissed('a')).not.toThrow()
    expect(isPromoDismissed('a')).toBe(false)
    expect(() => dismissPromo('a')).not.toThrow()
    expect(isPromoDismissed('a')).toBe(true)
  })
})
