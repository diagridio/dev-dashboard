import { describe, expect, it } from 'vitest'
import { hashState } from './hash'
import { GROUND_Y, type GameState } from './types'

function state(): GameState {
  return {
    level: 1, tick: 10, elapsed: 10, rng: 12345, score: 3, multiplier: 1, multUntil: 0,
    player: { y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 },
    scroll: 40, distance: 0, nextSpawnAt: 240, nextId: 2,
    entities: [{ id: 1, kind: 'coin', x: 300, y: GROUND_Y - 30, w: 10, h: 10, taken: false }],
    bossUntil: 0, status: 'running',
    retries: 3, shield: 0, graceUntil: 0, failedAt: 0,
  }
}

describe('hashState', () => {
  it('is stable for equal states', () => {
    expect(hashState(state())).toBe(hashState(state()))
  })

  it('returns a uint32', () => {
    const h = hashState(state())
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true)
  })

  it.each([
    ['tick', (s: GameState) => { s.tick += 1 }],
    ['retries', (s: GameState) => { s.retries -= 1 }],
    ['shield', (s: GameState) => { s.shield += 1 }],
    ['grace', (s: GameState) => { s.graceUntil = 60 }],
    ['failedAt', (s: GameState) => { s.failedAt = 9 }],
    ['jumpHeld', (s: GameState) => { s.player.jumpHeld = true }],
    ['coyote', (s: GameState) => { s.player.coyoteUntil = 5 }],
    ['jump buffer', (s: GameState) => { s.player.jumpBufferUntil = 5 }],
    ['entity vy', (s: GameState) => { s.entities[0].vy = 1.5 }],
    ['retry status', (s: GameState) => { s.status = 'retry' }],
    ['rng', (s: GameState) => { s.rng += 1 }],
    ['score', (s: GameState) => { s.score += 1 }],
    ['player y', (s: GameState) => { s.player.y -= 0.5 }],
    ['sliding', (s: GameState) => { s.player.sliding = true }],
    ['distance', (s: GameState) => { s.distance += 1 }],
    ['entity x', (s: GameState) => { s.entities[0].x -= 0.25 }],
    ['entity taken', (s: GameState) => { s.entities[0].taken = true }],
    ['boss', (s: GameState) => { s.bossUntil = 900 }],
    ['status', (s: GameState) => { s.status = 'failed' }],
  ])('changes when %s changes', (_name, mutate) => {
    const a = state()
    const b = state()
    mutate(b)
    expect(hashState(b)).not.toBe(hashState(a))
  })
})
