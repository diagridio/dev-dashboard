import { describe, expect, it } from 'vitest'
import { initialState } from '../engine/step'
import type { Entity, GameState } from '../engine/types'
import { blend } from './interpolate'

const ent = (id: number, x: number): Entity => ({ id, kind: 'coin', x, y: 100, w: 10, h: 10, taken: false })

function states() {
  const base = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false })
  const prev: GameState = { ...base, scroll: 100, player: { ...base.player, y: 200 }, entities: [ent(1, 300)] }
  const curr: GameState = {
    ...base, tick: 1, scroll: 104, player: { ...base.player, y: 190 },
    entities: [{ ...ent(1, 296), taken: true }, ent(2, 400)],
  }
  return { prev, curr }
}

describe('blend', () => {
  it('returns the current state itself with no previous state or alpha 0', () => {
    const { prev, curr } = states()
    expect(blend(null, curr, 0.5)).toBe(curr)
    expect(blend(prev, curr, 0)).toBe(curr)
  })

  it('interpolates scroll, player y and the x of shared entities', () => {
    const { prev, curr } = states()
    const out = blend(prev, curr, 0.5)
    expect(out.scroll).toBe(102)
    expect(out.player.y).toBe(195)
    expect(out.entities[0].x).toBe(298)
    expect(out.entities[0].taken).toBe(true)
    expect(out.tick).toBe(curr.tick)
  })

  it('leaves entities new this tick where they are', () => {
    const { prev, curr } = states()
    expect(blend(prev, curr, 0.5).entities[1].x).toBe(400)
  })

  it('does not mutate its inputs', () => {
    const { prev, curr } = states()
    const before = JSON.stringify([prev, curr])
    blend(prev, curr, 0.5)
    expect(JSON.stringify([prev, curr])).toBe(before)
  })
})
