import { describe, expect, it } from 'vitest'
import { mix, nextRandom, seedFrom } from './rng'

function sequence(seed: number, n: number): number[] {
  const out: number[] = []
  let s = seed
  for (let i = 0; i < n; i++) {
    const r = nextRandom(s)
    s = r.state
    out.push(r.value)
  }
  return out
}

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    expect(sequence(42, 20)).toEqual(sequence(42, 20))
  })

  it('produces values in [0, 1)', () => {
    for (const v of sequence(7, 1000)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('diverges for different seeds', () => {
    expect(sequence(1, 5)).not.toEqual(sequence(2, 5))
  })

  it('returns uint32 states', () => {
    const { state } = nextRandom(0xffffffff)
    expect(Number.isInteger(state)).toBe(true)
    expect(state).toBeGreaterThanOrEqual(0)
    expect(state).toBeLessThanOrEqual(0xffffffff)
  })

  it('mix folds an outside value into the state deterministically', () => {
    expect(mix(123, 0.5)).toBe(mix(123, 0.5))
    expect(mix(123, 0.5)).not.toBe(mix(123, 0.25))
    expect(mix(123, 0.5)).toBeGreaterThanOrEqual(0)
  })

  it('seedFrom derives a different uint32 seed', () => {
    const s = seedFrom(99)
    expect(s).toBe(seedFrom(99))
    expect(s).not.toBe(99)
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true)
  })
})
