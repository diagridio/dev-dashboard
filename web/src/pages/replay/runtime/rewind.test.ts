import { describe, expect, it } from 'vitest'
import { initialState } from '../engine/step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState } from '../engine/types'
import { REWIND_BUFFER_TICKS, RewindBuffer, isSafe, sample } from './rewind'

const base = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 3, shield: 0 })
const at = (tick: number, over: Partial<GameState> = {}): GameState => ({ ...base, tick, ...over })
const rack = (x: number): Entity => ({ id: 1, kind: 'low', x, y: GROUND_Y - 20, w: 14, h: 20, taken: false })

describe('isSafe', () => {
  it('needs the hat standing with no hazard close by', () => {
    expect(isSafe(at(1))).toBe(true)
    expect(isSafe(at(1, { player: { ...base.player, y: GROUND_Y - 5 } }))).toBe(false)
    expect(isSafe(at(1, { entities: [rack(PLAYER_X + 100)] }))).toBe(false)
    expect(isSafe(at(1, { entities: [rack(PLAYER_X + 200)] }))).toBe(true)
    expect(isSafe(at(1, { entities: [{ ...rack(PLAYER_X + 100), taken: true }] }))).toBe(true)
    expect(isSafe(at(1, { entities: [{ ...rack(PLAYER_X + 100), kind: 'coin' }] }))).toBe(true)
  })
})

describe('RewindBuffer', () => {
  function filled(n: number, unsafe: (t: number) => boolean = () => false): RewindBuffer {
    const b = new RewindBuffer()
    b.reset(at(0))
    for (let t = 1; t <= n; t++) b.push(at(t, unsafe(t) ? { entities: [rack(PLAYER_X + 50)] } : {}))
    return b
  }

  it('picks the latest safe state at least minBack ticks before the hit', () => {
    expect(filled(150).pick(150, 60, 0).tick).toBe(90)
    expect(filled(150, (t) => t > 80).pick(150, 60, 0).tick).toBe(80)
  })

  it('falls back to the oldest candidate when nothing is safe', () => {
    expect(filled(150, (t) => t > 0).pick(150, 60, 1).tick).toBe(1)
  })

  it('rewinds to the segment start when hit in the first ticks', () => {
    expect(filled(5).pick(6, 60, 0).tick).toBe(0)
  })

  it('never picks a state before the floor, so a retry cannot be refunded', () => {
    const b = filled(150)
    expect(b.pick(150, 60, 120).tick).toBe(120)
    expect(b.pick(150, 60, 95).tick).toBe(95)
  })

  it('forgets the anchor once the ring has wrapped', () => {
    const b = filled(REWIND_BUFFER_TICKS + 20, () => true)
    expect(b.pick(REWIND_BUFFER_TICKS + 20, 60, 0).tick).toBe(21)
  })

  it('returns the states between two ticks and drops newer ones', () => {
    const b = filled(20)
    expect(b.between(5, 8).map((s) => s.tick)).toEqual([5, 6, 7, 8])
    b.dropAfter(10)
    const ticks = b.between(0, 20).map((s) => s.tick)
    expect(ticks[ticks.length - 1]).toBe(10)
  })
})

describe('sample', () => {
  it('spreads n picks evenly, keeping the first and last', () => {
    expect(sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9])
    expect(sample([1, 2], 4)).toEqual([1, 2])
  })
})
