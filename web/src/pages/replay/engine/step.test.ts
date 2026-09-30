import { describe, expect, it, vi } from 'vitest'
import { makeLevels } from '../testing'
import { hashState } from './hash'
import { LEVELS, chaosMeanTicks, speedAt } from './levels'
import { BOOST_TICKS, BOSS_TICKS, PLAYER_H, PLAYER_W, SLIDE_H, continueAsNew, initialState, step } from './step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState, type InputKind, type Ports, type StartInput } from './types'

const start: StartInput = { level: 1, seed: 7, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }
const levels = makeLevels()
const ports = (over: Partial<Ports> = {}): Ports => ({ impure: () => 0.25, crateValue: () => 0.5, ...over })

/** A state with one entity that overlaps the player after this tick's scroll (speed 4). */
function withEntity(kind: Entity['kind'], y: number, w: number, h: number): GameState {
  const s = initialState(start)
  return { ...s, entities: [{ id: 99, kind, x: PLAYER_X + 4, y, w, h, taken: false }] }
}

function run(ticks: number, plan: (s: GameState) => InputKind[]): GameState {
  let s = initialState(start)
  for (let i = 0; i < ticks; i++) s = step(s, plan(s), ports(), levels).state
  return s
}

describe('initialState', () => {
  it('starts on the ground at tick 0', () => {
    const s = initialState(start)
    expect(s).toMatchObject({ tick: 0, level: 1, score: 0, status: 'running', bossUntil: 0 })
    expect(s.player).toEqual({ y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 })
  })

  it('starts with the retries and shield charge of its start input, and no grace', () => {
    const s = initialState({ ...start, retries: 3, shield: 7 })
    expect(s).toMatchObject({ retries: 3, shield: 7, graceUntil: 0, failedAt: 0 })
    expect(s.player).toEqual({ y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 })
  })

  it('starts the segment scroll at 0 but carries the distance already travelled', () => {
    const s = initialState({ ...start, distance: 300 })
    expect(s.scroll).toBe(0)
    expect(s.distance).toBe(300)
    expect(hashState(s)).not.toBe(hashState(initialState(start)))
  })

  it('arms the boss timer for a boss segment', () => {
    expect(initialState({ ...start, boss: true, retries: 0, shield: 0 }).bossUntil).toBe(BOSS_TICKS)
  })
})

describe('step', () => {
  it('does not mutate the previous state', () => {
    const prev = withEntity('coin', GROUND_Y - 24, 10, 10)
    const snapshot = JSON.stringify(prev)
    step(prev, ['jump'], ports(), levels)
    expect(JSON.stringify(prev)).toBe(snapshot)
  })

  it('is deterministic for the same inputs', () => {
    const plan = (s: GameState): InputKind[] => (s.tick % 50 === 0 ? ['jump'] : [])
    expect(hashState(run(600, plan))).toBe(hashState(run(600, plan)))
  })

  it('jumps, rises and lands again', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    expect(s.player.y).toBeLessThan(GROUND_Y)
    let air = 1
    while (s.player.y < GROUND_Y) {
      s = step(s, [], ports(), levels).state
      air++
    }
    expect(air).toBeGreaterThanOrEqual(30)
    expect(air).toBeLessThanOrEqual(40)
    expect(s.player.vy).toBe(0)
  })

  it('ignores a jump while airborne', () => {
    const up = step(initialState(start), ['jump'], ports(), levels).state
    const a = step(up, [], ports(), levels).state
    const b = step(up, ['jump'], ports(), levels).state
    expect(b.player).toEqual(a.player)
  })

  it('fails on a high obstacle when standing, passes under it when sliding', () => {
    const high = withEntity('high', GROUND_Y - 42, 22, 30)
    expect(step(high, [], ports(), levels).state.status).toBe('failed')
    expect(step(high, ['slideStart'], ports(), levels).state.status).toBe('running')
  })

  it('has a hat-shaped hitbox', () => {
    expect([PLAYER_W, PLAYER_H, SLIDE_H]).toEqual([30, 16, 9])
  })

  it('collects a low coin while standing but not while sliding', () => {
    const coin = withEntity('coin', GROUND_Y - 24, 10, 10)
    expect(step(coin, [], ports(), levels).state.score).toBe(1)
    const sliding = step(coin, ['slideStart'], ports(), levels).state
    expect(sliding.score).toBe(0)
    expect(sliding.entities[0].taken).toBe(false)
  })

  it('clears a high obstacle by jumping over it', () => {
    let s: GameState = { ...initialState(start), entities: [{ id: 99, kind: 'high', x: 400, y: GROUND_Y - 42, w: 22, h: 30, taken: false }] }
    const obstacle = (st: GameState) => st.entities.find((e) => e.id === 99)
    for (let i = 0; i < 200 && s.status === 'running' && obstacle(s); i++) {
      const gap = obstacle(s)!.x - (PLAYER_X + PLAYER_W)
      s = step(s, s.player.y >= GROUND_Y && gap > 0 && gap <= 24 ? ['jump'] : [], ports(), levels).state
    }
    expect(s.status).toBe('running')
    expect(obstacle(s)).toBeUndefined()
  })

  it('fails on a low obstacle', () => {
    expect(step(withEntity('low', GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('failed')
  })

  it('collects a coin as an ActivityCoinCollected event hashed with the new state', () => {
    const { state, events } = step(withEntity('coin', GROUND_Y - 24, 10, 10), [], ports(), levels)
    expect(state.score).toBe(1)
    expect(state.entities[0].taken).toBe(true)
    expect(events).toEqual([{ type: 'ActivityCoinCollected', tick: 0, id: 99, hash: hashState(state) }])
  })

  it('mixes an unrecorded impure value into the RNG on an orb pickup', () => {
    const impure = vi.fn(() => 0.25)
    const orb = withEntity('orb', GROUND_Y - 24, 12, 12)
    const a = step(orb, [], ports({ impure }), levels)
    const b = step(orb, [], ports({ impure: () => 0.75 }), levels)
    expect(impure).toHaveBeenCalledTimes(1)
    expect(a.events).toEqual([{ type: 'OrbTaken', tick: 0, id: 99, hash: hashState(a.state) }])
    expect(a.state.multiplier).toBe(3)
    expect(a.state.rng).not.toBe(b.state.rng)
  })

  it('takes a crate result from crateValue and records it', () => {
    const impure = vi.fn(() => 0.25)
    const crateValue = vi.fn(() => 0.5)
    const { state, events } = step(withEntity('crate', GROUND_Y - 24, 14, 14), [], ports({ impure, crateValue }), levels)
    expect(crateValue).toHaveBeenCalledWith(99)
    expect(impure).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'ActivityCrateCollected', tick: 0, id: 99, hash: hashState(state), result: 0.5 }])
    expect(state.multiplier).toBe(3)
    expect(state.score).toBe(3)
  })

  it('drops the multiplier after BOOST_TICKS', () => {
    let s = step(withEntity('orb', GROUND_Y - 24, 12, 12), [], ports(), levels).state
    for (let i = 0; i < BOOST_TICKS; i++) s = step(s, [], ports(), levels).state
    expect(s.multiplier).toBe(1)
  })

  it('finishes the level at its length and then stops advancing', () => {
    const short = makeLevels({ length: 40 })
    let s = initialState(start)
    for (let i = 0; i < 10; i++) s = step(s, [], ports(), short).state
    expect(s.status).toBe('levelDone')
    expect(step(s, [], ports(), short).state).toBe(s)
  })

  it('spawns only the kinds the level weights allow', () => {
    const crates = makeLevels({ weights: { crate: 1 } })
    let s = initialState(start)
    for (let i = 0; i < 400; i++) s = step(s, [], ports(), crates).state
    expect(s.entities.length).toBeGreaterThan(0)
    expect(s.entities.every((e) => e.kind === 'crate')).toBe(true)
  })

  it('spawns from bossWeights during a boss segment', () => {
    const table = makeLevels({ weights: { coin: 1 }, bossWeights: { high: 1 } })
    let s = initialState({ ...start, boss: true, retries: 0, shield: 0 })
    for (let i = 0; i < 120; i++) s = step(s, ['slideStart'], ports(), table).state
    expect(s.entities.length).toBeGreaterThan(0)
    expect(s.entities.every((e) => e.kind === 'high')).toBe(true)
  })
})

describe('continueAsNew', () => {
  it('carries retries and the shield charge, unless patched', () => {
    const s = { ...initialState(start), retries: 2, shield: 6 }
    expect(continueAsNew(s)).toMatchObject({ retries: 2, shield: 6 })
    expect(continueAsNew(s, { retries: 3 })).toMatchObject({ retries: 3, shield: 6 })
  })

  it('carries level, score and elapsed time with a derived seed', () => {
    const s = { ...initialState(start), score: 12, elapsed: 500 }
    const next = continueAsNew(s)
    expect(next).toMatchObject({ level: 1, score: 12, elapsed: 500, boss: false, retries: 0, shield: 0 })
    expect(next.seed).not.toBe(s.rng)
    expect(continueAsNew(s, { boss: true, level: 2 })).toMatchObject({ boss: true, level: 2 })
  })

  it('carries the distance travelled in the level (earlier segments + this scroll)', () => {
    const s = { ...initialState({ ...start, distance: 100 }), scroll: 250 }
    expect(continueAsNew(s).distance).toBe(350)
    expect(continueAsNew(s, { distance: 0 }).distance).toBe(0)
  })

  it('finishes a level at the same total distance across a continue-as-new boundary', () => {
    const short = makeLevels({ length: 40 })
    let s = initialState(start)
    for (let i = 0; i < 5; i++) s = step(s, [], ports(), short).state
    expect(s.status).toBe('running')
    s = initialState(continueAsNew(s, { boss: true, retries: 0, shield: 0 }))
    for (let i = 0; i < 4; i++) s = step(s, [], ports(), short).state
    expect(s.status).toBe('running')
    s = step(s, [], ports(), short).state
    expect(s.status).toBe('levelDone')
  })

  it('a continued segment starts from a reproducible state', () => {
    const next = continueAsNew({ ...initialState(start), score: 4 })
    expect(hashState(initialState(next))).toBe(hashState(initialState(next)))
  })
})

describe('levels', () => {
  it('ramps speed with elapsed time up to the cap', () => {
    const cfg = LEVELS[4]
    expect(speedAt(cfg, 0)).toBe(5)
    expect(speedAt(cfg, 3600)).toBeCloseTo(5.5)
    expect(speedAt(cfg, 10_000_000)).toBe(9)
  })

  it('shrinks the level-4 chaos mean toward its floor', () => {
    expect(chaosMeanTicks(LEVELS[4], 0)).toBe(1200)
    expect(chaosMeanTicks(LEVELS[4], 100_000)).toBe(480)
    expect(chaosMeanTicks(LEVELS[0], 0)).toBeNull()
  })

  it('only level 0 is non-durable', () => {
    expect(LEVELS[0].durable).toBe(false)
    for (const l of [1, 2, 3, 4] as const) expect(LEVELS[l].durable).toBe(true)
  })
})
