import { describe, expect, it } from 'vitest'
import { LEVELS, type LevelTable } from '../engine/levels'
import { initialState, step } from '../engine/step'
import { GROUND_Y, type Entity, type EntityKind, type GameState, type Level, type OutcomeEvent, type PlayerInput, type Ports } from '../engine/types'
import { lcg, makeLevels } from '../testing'
import { KioskBot, KioskSource } from './kiosk'

const ports: Ports = { impure: () => 0.5, crateValue: () => 0.5 }

const Y: Partial<Record<EntityKind, number>> = { low: GROUND_Y - 20, high: GROUND_Y - 42, tall: GROUND_Y - 44, pit: GROUND_Y, orb: GROUND_Y - 24 }
const SIZE: Partial<Record<EntityKind, [number, number]>> = { low: [14, 20], high: [22, 30], tall: [16, 44], pit: [50, 0], orb: [12, 12] }

function world(kind: EntityKind, x = 300): GameState {
  const [w, h] = SIZE[kind] ?? [10, 10]
  const e: Entity = { id: 1000, kind, x, y: Y[kind] ?? GROUND_Y - 60, w, h, taken: false }
  const s = initialState({ level: 0, seed: 7, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }, makeLevels())
  return { ...s, entities: [e] }
}

interface Run { state: GameState; events: OutcomeEvent[]; inputs: [number, PlayerInput][] }

function drive(s: GameState, takeOrb = false, ticks = 120, levels: LevelTable = makeLevels()): Run {
  const bot = new KioskBot(levels)
  const events: OutcomeEvent[] = []
  const inputs: [number, PlayerInput][] = []
  for (let t = 0; t < ticks && s.status === 'running'; t++) {
    const ins = bot.inputs(s, takeOrb)
    for (const i of ins) inputs.push([s.tick, i])
    const r = step(s, ins, ports, levels)
    events.push(...r.events)
    s = r.state
  }
  return { state: s, events, inputs }
}

const hit = (r: Run) => r.state.status !== 'running' || r.events.some((e) => e.type === 'CircuitBreakerTripped' || e.type === 'BoostLost')

describe('KioskSource', () => {
  it('is deterministic per seed', () => {
    const a = new KioskSource(42)
    const b = new KioskSource(42)
    const c = new KioskSource(43)
    const draw = (src: KioskSource) => Array.from({ length: 20 }, () => [src.impure(), src.chaos()]).flat()
    const va = draw(a)
    expect(draw(b)).toEqual(va)
    expect(draw(c)).not.toEqual(va)
    for (const v of va) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
    expect(a.exhausted).toBe(false)
  })

  it('keeps the impure and chaos streams independent', () => {
    const a = new KioskSource(9)
    for (let i = 0; i < 5; i++) a.impure()
    expect(a.chaos()).toBe(new KioskSource(9).chaos())
  })
})

describe('KioskBot', () => {
  it('clears a low rack', () => {
    const r = drive(world('low'))
    expect(hit(r)).toBe(false)
    expect(r.state.status).toBe('running')
  })

  it('clears a tall rack with a held jump', () => {
    const r = drive(world('tall'))
    expect(hit(r)).toBe(false)
    const jump = r.inputs.find(([, i]) => i === 'jump')
    expect(jump).toBeDefined()
    const end = r.inputs.find(([t, i]) => i === 'jumpEnd' && t > (jump?.[0] ?? 0))
    expect(end).toBeDefined()
    expect((end?.[0] ?? 0) - (jump?.[0] ?? 0)).toBeGreaterThanOrEqual(20)
  })

  it('slides under a high rack', () => {
    const r = drive(world('high'))
    expect(hit(r)).toBe(false)
    const start = r.inputs.findIndex(([, i]) => i === 'slideStart')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(r.inputs.slice(start).some(([, i]) => i === 'slideEnd')).toBe(true)
  })

  it('jumps a pit', () => {
    const r = drive(world('pit'))
    expect(hit(r)).toBe(false)
    expect(r.state.status).toBe('running')
  })

  it('avoids an orb unless asked to take it', () => {
    const avoid = drive(world('orb'), false)
    expect(avoid.events.some((e) => e.type === 'OrbTaken')).toBe(false)
    const take = drive(world('orb'), true)
    expect(take.events.some((e) => e.type === 'OrbTaken')).toBe(true)
  })

  it('stays idle when the road is clear', () => {
    const levels = makeLevels()
    const bot = new KioskBot(levels)
    let s = initialState({ level: 0, seed: 7, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }, levels)
    for (let t = 0; t < 60; t++) {
      expect(bot.inputs(s, false)).toEqual([])
      s = step(s, [], ports, levels).state
    }
  })

  it('ends a slide left over after reset once no high rack is overhead', () => {
    const bot = new KioskBot(makeLevels())
    const s = world('low', 400)
    s.player = { ...s.player, sliding: true }
    expect(bot.inputs(s, false)).toContain('slideEnd')
    const under = world('high', 90)
    under.player = { ...under.player, sliding: true }
    bot.reset()
    expect(bot.inputs(under, false)).not.toContain('slideEnd')
  })

  it('is a pure function of its plan, the state and takeOrb', () => {
    const run = () => drive(world('tall')).inputs
    expect(run()).toEqual(run())
  })
})

/** Plays real levels with the bot and counts hits (any hit, even one a retry or breaker would absorb). */
function stress(level: Level, seed: number, boss: boolean, ticks: number): { hits: number; ticks: number } {
  const bot = new KioskBot(LEVELS)
  const impure = lcg(seed)
  const p: Ports = { impure, crateValue: () => impure() }
  let s = initialState({ level, seed, score: 0, elapsed: 0, distance: 0, boss, retries: 0, shield: 0 }, LEVELS)
  let hits = 0
  let t = 0
  for (; t < ticks && s.status === 'running'; t++) {
    const r = step(s, bot.inputs(s, false), p, LEVELS)
    if (r.events.some((e) => e.type === 'CircuitBreakerTripped' || e.type === 'BoostLost')) hits++
    s = r.state
  }
  if (s.status === 'failed' || s.status === 'retry') hits++
  return { hits, ticks: t }
}

describe('KioskBot on the real levels', () => {
  const seeds = [1, 2, 3, 0x0da92026]
  for (const level of [0, 1, 2, 3] as const) {
    it(`clears level ${level} without a hit`, () => {
      for (const seed of seeds) {
        const r = stress(level, seed, false, 2400)
        expect({ level, seed, hits: r.hits }).toEqual({ level, seed, hits: 0 })
      }
    })
  }
  for (const level of [1, 2, 3] as const) {
    it(`survives the level ${level} boss phase`, () => {
      for (const seed of seeds) {
        const r = stress(level, seed, true, 900)
        expect({ level, seed, hits: r.hits }).toEqual({ level, seed, hits: 0 })
      }
    })
  }
})
