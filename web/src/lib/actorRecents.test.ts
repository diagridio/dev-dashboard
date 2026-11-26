import { describe, it, expect, afterEach, vi } from 'vitest'
import { recentIds, recentMethods, rememberInvoke, rememberId, actorPath } from './actorRecents'

afterEach(() => {
  vi.restoreAllMocks()
  localStorage.clear()
})

describe('actorRecents', () => {
  it('keeps the newest 10 entries', () => {
    for (let i = 0; i < 12; i++) rememberInvoke('a', 'T', `id${i}`, `m${i}`)
    expect(recentIds('a', 'T')).toHaveLength(10)
    expect(recentIds('a', 'T')[0]).toBe('id11')
    expect(recentMethods('a', 'T')[9]).toBe('m2')
  })

  it('moves a re-used ID to the front without duplicating', () => {
    rememberInvoke('a', 'T', 'x', 'm1')
    rememberInvoke('a', 'T', 'y', 'm2')
    rememberInvoke('a', 'T', 'x', 'm1')
    expect(recentIds('a', 'T')).toEqual(['x', 'y'])
    expect(recentMethods('a', 'T')).toEqual(['m1', 'm2'])
  })

  it('separates by app and type', () => {
    rememberInvoke('a', 'T', 'x', 'm')
    expect(recentIds('b', 'T')).toEqual([])
    expect(recentIds('a', 'U')).toEqual([])
  })

  it('survives a throwing localStorage', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    const ls = localStorage
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: {
        getItem: () => {
          throw new Error('blocked')
        },
        setItem: () => {
          throw new Error('blocked')
        },
      },
    })
    expect(() => rememberInvoke('a', 'T', 'x', 'm')).not.toThrow()
    expect(recentIds('a', 'T')).toEqual([])
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: ls })
  })

  it('rememberId adds an opened ID to the recent IDs without a method', () => {
    rememberInvoke('a', 'T', 'x', 'm')
    rememberId('a', 'T', 'y')
    expect(recentIds('a', 'T')).toEqual(['y', 'x'])
    expect(recentMethods('a', 'T')).toEqual(['m'])
    rememberId('a', 'T', '')
    expect(recentIds('a', 'T')).toEqual(['y', 'x'])
  })

  it('actorPath encodes each segment', () => {
    expect(actorPath('a', 'T', 'x/y')).toBe('/actors/a/T/x%2Fy')
    expect(actorPath('a b', 'T')).toBe('/actors/a%20b/T')
  })
})
