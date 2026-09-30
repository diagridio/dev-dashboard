import { describe, expect, it } from 'vitest'
import { LEVELS } from './levels'

describe('level tips', () => {
  it('explains determinism and tells the player to avoid the purple orbs in level 2', () => {
    expect(LEVELS[2].tip.body).toBe(
      'Workflow code must be deterministic: on replay it has to make exactly the same decisions. The purple orbs are Math.random(), Date.now() and fetch() called straight from workflow code, so avoid them. They look tempting with a ×3 boost, but replay gets a different answer.',
    )
  })

  it('introduces pits in level 1, falling racks in level 2 and tall racks in level 3', () => {
    expect(LEVELS[0].weights.pit ?? 0).toBe(0)
    expect(LEVELS[1].weights.pit).toBeGreaterThan(0)
    expect(LEVELS[1].weights.falling ?? 0).toBe(0)
    expect(LEVELS[2].weights.falling).toBeGreaterThan(0)
    expect(LEVELS[2].weights.tall ?? 0).toBe(0)
    expect(LEVELS[3].weights.tall).toBeGreaterThan(0)
    for (const k of ['pit', 'falling', 'tall'] as const) expect(LEVELS[5].weights[k]).toBeGreaterThan(0)
  })

  it('adds Fan Out as level 4 and moves the endless Production level to 5', () => {
    expect(LEVELS[4].name).toBe('Fan Out')
    expect(LEVELS[4].fanOut).toEqual({ everyPx: 2500, ticks: 600 })
    expect(LEVELS[4].tip.body).toMatch(/WhenAll/)
    expect(LEVELS[5].name).toBe('Production')
    expect(LEVELS[5].length).toBe(Number.POSITIVE_INFINITY)
    expect(LEVELS[5].fanOut).toEqual({ everyPx: 4000, ticks: 600 })
    for (const l of [0, 1, 2, 3] as const) expect(LEVELS[l].fanOut).toBeUndefined()
  })

  it('only spawns low racks, pits and coins in fan-out lanes', () => {
    for (const l of [4, 5] as const) expect(Object.keys(LEVELS[l].laneWeights).sort()).toEqual(['coin', 'low', 'pit'])
  })

  it('introduces RetryPolicy and the circuit breaker in the level-1 tip', () => {
    expect(LEVELS[1].tip.body).toMatch(/RetryPolicy/)
    expect(LEVELS[1].tip.body).toMatch(/circuit breaker/)
  })
})
