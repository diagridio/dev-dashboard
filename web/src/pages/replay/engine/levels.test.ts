import { describe, expect, it } from 'vitest'
import { LEVELS } from './levels'

describe('level tips', () => {
  it('explains determinism and tells the player to avoid the purple orbs in level 2', () => {
    expect(LEVELS[2].tip.body).toBe(
      'Workflow code must be deterministic: on replay it has to make exactly the same decisions. The purple orbs are Math.random(), Date.now() and fetch() called straight from workflow code, so avoid them. They look tempting with a ×3 boost, but replay gets a different answer.',
    )
  })
})
