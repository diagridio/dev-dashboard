import { describe, expect, it, vi } from 'vitest'
import { makeLevels } from '../testing'
import { hashState } from './hash'
import { LEVELS, chaosMeanTicks, speedAt } from './levels'
import { BOOST_TICKS, BOSS_TICKS, COYOTE_TICKS, FALL_LEAD_TICKS, JUMP_BUFFER_TICKS, JUMP_CUT_VY, HAZARDS, HAZARD_INSET_X, PIT_HIT_DEPTH, PLAYER_H, PLAYER_W, RACKS, SLIDE_H, GRACE_BARGE, GRACE_BOOST, GRACE_RESUME, GRACE_RETRY, SHIELD_FULL, FAN_CLEAR_PX, FAN_LANES, LANE_SCALE, LANE_SPAWN_X, MERGE_LANE, continueAsNew, initialState, overPit, step } from './step'
import { GROUND_Y, PLAYER_X, VIEW_W, type Entity, type GameState, type InputKind, type OutcomeEvent, type Ports, type StartInput } from './types'

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
    expect(initialState({ ...start, boss: true }).bossUntil).toBe(BOSS_TICKS)
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
    expect({ y: b.player.y, vy: b.player.vy }).toEqual({ y: a.player.y, vy: a.player.vy })
  })

  it('fails on a high obstacle when standing, passes under it when sliding', () => {
    const high = withEntity('high', GROUND_Y - 42, 22, 30)
    expect(step(high, [], ports(), levels).state.status).toBe('failed')
    expect(step(high, ['slideStart'], ports(), levels).state.status).toBe('running')
  })

  it('has a hat-shaped hitbox', () => {
    expect([PLAYER_W, PLAYER_H, SLIDE_H]).toEqual([30, 16, 9])
  })

  it('forgives racks that only graze the sides of the hat, but not pickups', () => {
    // Entities scroll 4 px this tick before collisions run.
    const at = (kind: Entity['kind'], x: number, y: number, w: number, h: number): GameState =>
      ({ ...initialState(start), entities: [{ id: 99, kind, x: x + 4, y, w, h, taken: false }] })
    const grazeLeft = PLAYER_X - 14 + HAZARD_INSET_X
    const grazeRight = PLAYER_X + PLAYER_W - HAZARD_INSET_X
    expect(step(at('low', grazeLeft, GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('running')
    expect(step(at('low', grazeRight, GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('running')
    expect(step(at('low', grazeLeft + 1, GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('failed')
    expect(step(at('low', grazeRight - 1, GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('failed')
    expect(step(at('coin', PLAYER_X + PLAYER_W - 1, GROUND_Y - 24, 10, 10), [], ports(), levels).state.score).toBe(1)
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

  it('spawns orbs at the same two heights as coins', () => {
    const orbs = makeLevels({ weights: { orb: 1 } })
    let s = initialState(start)
    const heights = new Set<number>()
    for (let i = 0; i < 3000; i++) {
      s = step(s, ['slideStart'], ports(), orbs).state
      for (const e of s.entities) heights.add(e.y)
      if (s.status !== 'running') break
    }
    expect([...heights].sort((a, b) => a - b)).toEqual([GROUND_Y - 70, GROUND_Y - 24])
  })

  it('only the orb itself counts, not the label drawn above it', () => {
    // A low orb whose label (drawn a few px above its top edge) crosses the hat, while the orb stays clear: sliding.
    const low = withEntity('orb', GROUND_Y - 24, 12, 12)
    const slid = step(low, ['slideStart'], ports(), levels)
    expect(slid.events).toEqual([])
    expect(slid.state.entities[0].taken).toBe(false)
    // Standing, the hat runs into the low orb itself.
    expect(step(low, [], ports(), levels).events.map((e) => e.type)).toEqual(['OrbTaken'])
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
    let s = initialState({ ...start, boss: true })
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
    expect(next).toMatchObject({ level: 1, score: 12, elapsed: 500, boss: false })
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
    s = initialState(continueAsNew(s, { boss: true }))
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
    const cfg = LEVELS[5]
    expect(speedAt(cfg, 0)).toBe(5)
    expect(speedAt(cfg, 3600)).toBeCloseTo(5.5)
    expect(speedAt(cfg, 10_000_000)).toBe(9)
  })

  it('shrinks the level-5 chaos mean toward its floor', () => {
    expect(chaosMeanTicks(LEVELS[5], 0)).toBe(1200)
    expect(chaosMeanTicks(LEVELS[5], 100_000)).toBe(480)
    expect(chaosMeanTicks(LEVELS[0], 0)).toBeNull()
  })

  it('only level 0 is non-durable', () => {
    expect(LEVELS[0].durable).toBe(false)
    for (const l of [1, 2, 3, 4, 5] as const) expect(LEVELS[l].durable).toBe(true)
  })
})

/** A pit whose span covers the player's foot centre after this tick's scroll (speed 4). */
function withPit(w = 40): GameState {
  const s = initialState(start)
  const foot = PLAYER_X + PLAYER_W / 2
  return { ...s, entities: [{ id: 50, kind: 'pit', x: foot - 10 + 4, y: GROUND_Y, w, h: 0, taken: false }] }
}

describe('pits', () => {
  it('drops the player when the foot centre is over a pit', () => {
    const s = step(withPit(), [], ports(), levels).state
    expect(s.player.y).toBeGreaterThan(GROUND_Y)
    expect(s.status).toBe('running')
  })

  it('fails once the player has fallen PIT_HIT_DEPTH into the pit', () => {
    let s = withPit(200)
    for (let i = 0; i < 30 && s.status === 'running'; i++) s = step(s, [], ports(), levels).state
    expect(s.status).toBe('failed')
    expect(s.player.y).toBeGreaterThanOrEqual(GROUND_Y + PIT_HIT_DEPTH)
  })

  it('jumps over a pit', () => {
    let s: GameState = { ...initialState(start), entities: [{ id: 50, kind: 'pit' as const, x: 200, y: GROUND_Y, w: 50, h: 0, taken: false }] }
    for (let i = 0; i < 200 && s.status === 'running' && s.entities.length > 0; i++) {
      const gap = s.entities[0].x - (PLAYER_X + PLAYER_W)
      s = step(s, s.player.y === GROUND_Y && gap > 0 && gap <= 12 ? ['jump'] : [], ports(), levels).state
    }
    expect(s.status).toBe('running')
    expect(s.player.y).toBe(GROUND_Y)
  })

  it('finds the pit under the foot centre only', () => {
    const foot = PLAYER_X + PLAYER_W / 2
    const pit = { id: 1, kind: 'pit' as const, x: foot - 5, y: GROUND_Y, w: 10, h: 0, taken: false }
    expect(overPit([pit])?.id).toBe(1)
    expect(overPit([{ ...pit, x: foot + 1 }])).toBeUndefined()
  })
})

describe('tall and falling racks', () => {
  it('classifies racks and hazards', () => {
    expect([...RACKS].sort()).toEqual(['falling', 'high', 'low', 'tall'])
    expect(HAZARDS.has('pit')).toBe(true)
    expect(HAZARDS.has('coin')).toBe(false)
  })

  it('fails on a tall rack when standing', () => {
    expect(step(withEntity('tall', GROUND_Y - 44, 16, 44), [], ports(), levels).state.status).toBe('failed')
  })

  it('keeps a falling rack hanging until it is one second away, then lands it well ahead of the player', () => {
    // speed 4: the drop starts FALL_LEAD_TICKS * 4 = 240 px ahead of PLAYER_X.
    const rack = { id: 7, kind: 'falling' as const, x: PLAYER_X + FALL_LEAD_TICKS * 4 + 40, y: -24, w: 18, h: 24, taken: false, vy: 0 }
    let s: GameState = { ...initialState(start), entities: [rack] }
    s = step(s, [], ports(), levels).state
    expect(s.entities[0].y).toBe(-24)
    for (let i = 0; i < 12; i++) s = step(s, [], ports(), levels).state
    expect(s.entities[0].y).toBeGreaterThan(-24)
    for (let i = 0; i < 30; i++) s = step(s, [], ports(), levels).state
    const landed = s.entities.find((e) => e.id === 7)!
    expect(landed.y + landed.h).toBe(GROUND_Y)
    expect(landed.x - PLAYER_X).toBeGreaterThan(80)
    expect(s.status).toBe('running')
  })

  it('spawns pits 30–60 px wide at ground level', () => {
    const table = makeLevels({ weights: { pit: 1, low: 1 } })
    let s = initialState(start)
    const seen: Entity[] = []
    for (let i = 0; i < 3000; i++) {
      s = step(s, [], ports(), table).state
      for (const e of s.entities) if (!seen.some((x) => x.id === e.id)) seen.push({ ...e })
      if (s.status !== 'running') s = { ...s, status: 'running', player: { ...s.player, y: GROUND_Y, vy: 0 } }
    }
    const pits = seen.filter((e) => e.kind === 'pit')
    expect(pits.length).toBeGreaterThan(3)
    for (const p of pits) {
      expect(p.w).toBeGreaterThanOrEqual(30)
      expect(p.w).toBeLessThanOrEqual(60)
      expect(p.y).toBe(GROUND_Y)
    }
  })
})

/** Highest point (px above the ground) of a jump released after `holdTicks` (Infinity = never). */
function apex(holdTicks: number): number {
  let s = step(initialState(start), ['jump'], ports(), levels).state
  let top = GROUND_Y - s.player.y
  for (let i = 1; i < 60 && s.player.y < GROUND_Y; i++) {
    s = step(s, i === holdTicks ? ['jumpEnd'] : [], ports(), levels).state
    top = Math.max(top, GROUND_Y - s.player.y)
  }
  return top
}

describe('jump feel', () => {
  it('cuts the jump short when the key is released early', () => {
    expect(apex(Infinity)).toBeGreaterThanOrEqual(76)
    expect(apex(1)).toBeLessThan(25)
    const tap = apex(6)
    expect(tap).toBeGreaterThan(40)
    expect(tap).toBeLessThan(56)
  })

  it('caps upward speed at JUMP_CUT_VY on release and leaves a falling hat alone', () => {
    const up = step(initialState(start), ['jump'], ports(), levels).state
    expect(step(up, ['jumpEnd'], ports(), levels).state.player.vy).toBe(JUMP_CUT_VY + 0.5)
    let falling = up
    while (falling.player.vy < 0) falling = step(falling, [], ports(), levels).state
    const vy = falling.player.vy
    expect(step(falling, ['jumpEnd'], ports(), levels).state.player.vy).toBe(vy + 0.5)
  })

  it('allows a jump for COYOTE_TICKS after walking off an edge', () => {
    let s = withPit(200)
    s = step(s, [], ports(), levels).state // walks off: now falling
    expect(s.player.y).toBeGreaterThan(GROUND_Y)
    for (let i = 1; i < COYOTE_TICKS - 1; i++) s = step(s, [], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state
    expect(s.player.vy).toBeLessThan(0)
  })

  it('launches a jump pressed on the very first tick over a pit', () => {
    const s = step(withPit(200), ['jump'], ports(), levels).state
    expect(s.player.vy).toBeLessThan(0)
  })

  it('does not allow a coyote jump after COYOTE_TICKS', () => {
    let s = withPit(200)
    for (let i = 0; i < COYOTE_TICKS; i++) s = step(s, [], ports(), levels).state
    expect(s.status).toBe('running') // still falling, not yet at pit-hit depth
    s = step(s, ['jump'], ports(), levels).state
    expect(s.player.vy).toBeGreaterThan(0)
  })

  it('buffers a jump pressed just before landing and fires it on landing', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    while (s.player.y < GROUND_Y - 6 || s.player.vy < 0) s = step(s, [], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state // still airborne: buffered
    for (let i = 0; i < JUMP_BUFFER_TICKS && s.player.vy >= 0; i++) s = step(s, [], ports(), levels).state
    expect(s.player.vy).toBeLessThan(0)
  })

  it('drops a buffered jump that is older than JUMP_BUFFER_TICKS', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state // far from the ground
    while (s.player.y < GROUND_Y) s = step(s, [], ports(), levels).state
    expect(s.player.vy).toBe(0)
  })
})

const armed = makeLevels({ shieldEnabled: true })
const rack = (): GameState => withEntity('low', GROUND_Y - 20, 14, 20)

describe('hit chain', () => {
  it('ignores racks during grace', () => {
    const r = step({ ...rack(), graceUntil: 10 }, [], ports(), armed)
    expect(r.state.status).toBe('running')
    expect(r.events).toEqual([])
    expect(r.state.entities[0].taken).toBe(false)
  })

  it('spends an armed circuit breaker first and smashes the rack', () => {
    const r = step({ ...rack(), shield: SHIELD_FULL, multiplier: 3, multUntil: 100, retries: 3 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'running', shield: 0, multiplier: 3, retries: 3, graceUntil: GRACE_BARGE })
    expect(r.state.entities[0].taken).toBe(true)
    expect(r.events).toEqual([{ type: 'CircuitBreakerTripped', tick: 0, id: 99, hash: hashState(r.state) }])
  })

  it('has no circuit breaker in a level without one', () => {
    expect(step({ ...rack(), shield: SHIELD_FULL }, [], ports(), levels).state.status).toBe('failed')
  })

  it('loses an active boost next, keeping the rack in place', () => {
    const r = step({ ...rack(), shield: 5, multiplier: 3, multUntil: 100, retries: 3 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'running', shield: 5, multiplier: 1, retries: 3, graceUntil: GRACE_BOOST })
    expect(r.state.entities[0].taken).toBe(false)
    expect(r.events).toEqual([{ type: 'BoostLost', tick: 0, id: 99, hash: hashState(r.state) }])
  })

  it('asks the runtime for a retry next, without spending it', () => {
    const r = step({ ...rack(), retries: 2 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'retry', failedAt: 0, retries: 2 })
    expect(r.events).toEqual([])
  })

  it('fails when no layer is left', () => {
    expect(step({ ...rack(), retries: 0 }, [], ports(), armed).state.status).toBe('failed')
  })

  it('bounces out of a pit when a layer absorbs the fall, recording id 0', () => {
    let s: GameState = { ...withPit(200), shield: SHIELD_FULL }
    let event: OutcomeEvent | undefined
    for (let i = 0; i < 40 && !event; i++) {
      const r = step(s, [], ports(), armed)
      event = r.events.find((e) => e.type === 'CircuitBreakerTripped')
      s = r.state
    }
    expect(event).toMatchObject({ type: 'CircuitBreakerTripped', id: 0 })
    expect(s.player.vy).toBeLessThan(0)
    expect(s.status).toBe('running')
  })

  it('bounces out of a pit during grace without an event', () => {
    let s: GameState = { ...withPit(200), graceUntil: 1000 }
    let events = 0
    for (let i = 0; i < 12; i++) {
      const r = step(s, [], ports(), armed)
      events += r.events.length
      s = r.state
    }
    expect(s.status).toBe('running')
    expect(s.player.vy).toBeLessThan(0)
    expect(events).toBe(0)
  })

  it('resolves only one hit per tick', () => {
    const s = rack()
    const twin = { ...s.entities[0], id: 98 }
    const r = step({ ...s, entities: [s.entities[0], twin], shield: SHIELD_FULL, multiplier: 3, multUntil: 100 }, [], ports(), armed)
    expect(r.events.map((e) => e.type)).toEqual(['CircuitBreakerTripped'])
    expect(r.state.multiplier).toBe(3)
  })

  it('charges the circuit breaker with coins, capped at SHIELD_FULL, only where it is enabled', () => {
    const coin = withEntity('coin', GROUND_Y - 24, 10, 10)
    expect(step({ ...coin, shield: 8 }, [], ports(), armed).state.shield).toBe(9)
    expect(step({ ...coin, shield: SHIELD_FULL }, [], ports(), armed).state.shield).toBe(SHIELD_FULL)
    expect(step({ ...coin, shield: 8 }, [], ports(), levels).state.shield).toBe(8)
  })

  it("grants grace on 'resume' and spends a retry with grace on 'retry'", () => {
    const s = { ...initialState(start), retries: 3 }
    expect(step(s, ['resume'], ports(), armed).state.graceUntil).toBe(GRACE_RESUME)
    expect(step(s, ['retry'], ports(), armed).state).toMatchObject({ retries: 2, graceUntil: GRACE_RETRY })
    expect(step({ ...s, retries: 0 }, ['retry'], ports(), armed).state.retries).toBe(0)
  })
})

// 600 ticks at speed 4 = 2400 px of lanes, long enough for lane spawns before the early stop.
const fanLevels = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, weights: { coin: 1 }, laneWeights: { coin: 1 } })
const world = (s: GameState) => s.distance + s.scroll

/** Steps until an event of `type` is emitted; returns the state before and after that tick. */
function until(s: GameState, type: string, table = fanLevels, max = 3000) {
  for (let i = 0; i < max; i++) {
    const r = step(s, [], ports(), table)
    if (r.events.some((e) => e.type === type)) return { before: s, after: r.state, events: r.events }
    s = r.state
  }
  throw new Error(`no ${type}`)
}

describe('fan-out', () => {
  it('places the first gate at the next multiple of everyPx', () => {
    expect(initialState(start, fanLevels).nextGateAt).toBe(400)
    expect(initialState({ ...start, distance: 900 }, fanLevels).nextGateAt).toBe(1200)
    expect(initialState(start, levels).nextGateAt).toBe(Number.POSITIVE_INFINITY)
  })

  it('spawns nothing else from FAN_CLEAR_PX before the gate until the gate', () => {
    let s = initialState(start, fanLevels)
    let idAtQuiet: number | null = null
    for (let i = 0; i < 400; i++) {
      s = step(s, [], ports(), fanLevels).state
      if (idAtQuiet === null && world(s) >= 400 - FAN_CLEAR_PX) idAtQuiet = s.nextId
      const gate = s.entities.find((e) => e.kind === 'fanout')
      if (gate) {
        expect(gate.id).toBe(idAtQuiet)
        return
      }
    }
    throw new Error('no gate')
  })

  it('fans out into two parallel lanes, spawning lane entities just off the right edge of a lane strip', () => {
    expect(FAN_LANES).toBe(2)
    expect(LANE_SPAWN_X).toBe(VIEW_W / LANE_SCALE + 10)
  })

  it('splits into FAN_LANES lanes when the gate reaches the hat', () => {
    const { after, events } = until(initialState(start, fanLevels), 'FanOut')
    expect(events).toContainEqual({ type: 'FanOut', tick: after.tick - 1, hash: hashState(after) })
    expect(after.fan?.lanes).toHaveLength(FAN_LANES)
    for (const lane of after.fan!.lanes) expect(lane.player).toEqual(after.player)
    expect(after.entities).toEqual([])
    expect(after.fan!.until).toBe(after.tick - 1 + 600)
  })

  it('moves every lane with the same inputs and spawns lane entities at LANE_SPAWN_X', () => {
    let s = until(initialState(start, fanLevels), 'FanOut').after
    s = step(s, ['jump'], ports(), fanLevels).state
    const [a, b] = s.fan!.lanes
    expect(a.player).toEqual(b.player)
    expect(a.player.vy).toBeLessThan(0)
    for (let i = 0; i < 80; i++) s = step(s, [], ports(), fanLevels).state
    const spawned = s.fan!.lanes.flatMap((l) => l.entities)
    expect(spawned.length).toBeGreaterThan(0)
    expect(Math.max(...spawned.map((e) => e.x))).toBeGreaterThan(VIEW_W)
    expect(Math.max(...spawned.map((e) => e.x))).toBeLessThanOrEqual(LANE_SPAWN_X)
  })

  it('merges after `ticks` with coins per lane, clears the lanes and resumes normal spawns after a run-out', () => {
    const out = until(initialState(start, fanLevels), 'FanOut')
    const scoreAtSplit = out.after.score
    const merge = until(out.after, 'FanIn')
    const fanIn = merge.events.find((e) => e.type === 'FanIn')
    if (fanIn?.type !== 'FanIn') throw new Error('no FanIn')
    expect(fanIn.results).toHaveLength(FAN_LANES)
    expect(fanIn.results.reduce((a, b) => a + b, 0)).toBe(merge.after.score - scoreAtSplit)
    expect(merge.after.tick - (out.after.tick - 1)).toBe(600)
    expect(merge.after.fan).toBeNull()
    expect(merge.after.player).toEqual(merge.before.fan!.lanes[MERGE_LANE].player)
    expect(merge.after.nextGateAt).toBe(world(merge.after) + 400)
    expect(merge.after.nextSpawnAt).toBe(merge.after.scroll + FAN_CLEAR_PX)
    // Spawns stopped early enough that every lane entity was already behind the hats.
    for (const lane of merge.before.fan!.lanes) for (const e of lane.entities) expect(e.x + e.w).toBeLessThan(PLAYER_X)
  })

  it('runs the hit chain once for a rack in any lane', () => {
    const armed = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, shieldEnabled: true })
    const s = until(initialState(start, armed), 'FanOut', armed).after
    const rackAt = { id: 77, kind: 'low' as const, x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }
    const lanes = s.fan!.lanes.map((l, i) => ({ ...l, entities: i === 1 ? [rackAt] : [] }))
    const r = step({ ...s, shield: SHIELD_FULL, fan: { ...s.fan!, lanes } }, [], ports(), armed)
    expect(r.events.map((e) => e.type)).toEqual(['CircuitBreakerTripped'])
    expect(r.state.fan!.lanes[1].entities[0].taken).toBe(true)
    expect(r.state.shield).toBe(0)
  })

  it('defers the end of the level until the lanes merge', () => {
    // The gate spawns at world 400 and reaches the hat about 410 px later, before the level's end at 1000.
    const short = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, length: 1000 })
    const out = until(initialState(start, short), 'FanOut', short)
    expect(world(out.after)).toBeLessThan(1000)
    let s = out.after
    for (let i = 0; i < 100; i++) s = step(s, [], ports(), short).state
    expect(world(s)).toBeGreaterThan(1000)
    expect(s.status).toBe('running')
    expect(until(s, 'FanIn', short).after.status).toBe('levelDone')
  })

  it('does not carry the lanes across continue-as-new', () => {
    const s = until(initialState(start, fanLevels), 'FanOut').after
    expect(initialState(continueAsNew(s, { boss: true }), fanLevels).fan).toBeNull()
  })
})
