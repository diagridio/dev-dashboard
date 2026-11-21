import { describe, it, expect, beforeEach } from 'vitest'
import { isPromoDismissed, dismissPromo, markPromoShown } from './promoDismissed'

describe('markPromoShown', () => {
  beforeEach(() => sessionStorage.clear())

  it('is true only the first time an id is shown in this tab', () => {
    expect(markPromoShown('a')).toBe(true)
    expect(markPromoShown('a')).toBe(false)
    expect(markPromoShown('b')).toBe(true)
    expect(JSON.parse(sessionStorage.getItem('devdash.promoShown')!)).toEqual(['a', 'b'])
  })

  it('treats corrupt session storage as nothing shown', () => {
    sessionStorage.setItem('devdash.promoShown', 'oops')
    expect(markPromoShown('a')).toBe(true)
  })
})

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
