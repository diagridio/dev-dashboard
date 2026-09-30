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
    for (const k of ['pit', 'falling', 'tall'] as const) expect(LEVELS[4].weights[k]).toBeGreaterThan(0)
  })
})
