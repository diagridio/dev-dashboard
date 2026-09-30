import { describe, expect, it } from 'vitest'
import { hashState } from '../engine/hash'
import { chaosMeanTicks, type LevelConfig, type LevelTable } from '../engine/levels'
import { replay } from '../engine/replay'
import { seedFrom } from '../engine/rng'
import { seedForDate } from '../engine/seed'
import { BOSS_TICKS, GRACE_RESUME } from '../engine/step'
import { GROUND_Y, PLAYER_X, type EntityKind } from '../engine/types'
import type { Palette } from '../render/palette'
import { render } from '../render/canvas'
import { autopilot, counter, lcg, makeLevels } from '../testing'
import { CRASH_FRAMES, Game, REPLAY_MAX_FRAMES, type GameDeps } from './game'
import type { SaveStore } from './persistence'
import { MONTAGE_FRAMES } from './montage'
import { REWIND_FRAMES } from './rewind'
import { emptyTape, type Tape } from './tape'
import type { Save } from './types'

type MemoryStore = SaveStore & { saved: Save | null; best: number; daily: { date: string; best: number } | null }

function memoryStore(): MemoryStore {
  const s: MemoryStore = {
    saved: null,
    best: 0,
    daily: null,
    load: () => (s.saved ? (JSON.parse(JSON.stringify(s.saved)) as Save) : null),
    save: (x) => { s.saved = JSON.parse(JSON.stringify(x)) as Save },
    clear: () => { s.saved = null },
    loadBest: () => s.best,
    saveBest: (n) => { s.best = n },
    loadDailyBest: (date) => (s.daily && s.daily.date === date ? s.daily.best : 0),
    saveDailyBest: (date, best) => { s.daily = { date, best } },
  }
  return s
}

function deps(overrides: Partial<GameDeps> = {}): GameDeps {
  return { impure: counter(), chaosRand: () => 0.5, today: () => '2026-09-30', store: memoryStore(), levels: makeLevels(), ...overrides }
}

/** title → tip(0) → playing */
function play(game: Game): void {
  game.command('confirm')
  game.command('confirm')
}

/** Advances one tick per frame, steering toward `want` pickups outside the boss phase. */
function runUntil(game: Game, done: (g: Game) => boolean, want: readonly EntityKind[] = [], max = 20_000): number {
  for (let frames = 0; frames < max; frames++) {
    if (done(game)) return frames
    if (game.phase.kind === 'playing' && game.state.bossUntil === 0) {
      for (const input of autopilot(game.state, want)) game.command(input)
    }
    game.frame(1)
  }
  throw new Error('condition not reached')
}

const is = (kind: string) => (g: Game) => g.phase.kind === kind

describe('Game', () => {
  it("seeds every run from today's UTC date", () => {
    const game = new Game(deps({ today: () => '2026-12-24' }))
    play(game)
    expect(game.start.seed).toBe(seedForDate('2026-12-24'))
    expect(game.runDate).toBe('2026-12-24')
  })

  it('derives the level-1 seed after "Progress lost" from the run seed', () => {
    const game = new Game(deps({ levels: makeLevels({}, { 0: { durable: false, scriptedCrashAt: 120 } }) }))
    play(game)
    runUntil(game, is('lost'))
    game.command('confirm')
    expect(game.start.seed).toBe(seedFrom(seedForDate('2026-09-30')))
  })

  it("records today's best next to the all-time best", () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    // Direct poke: a score of 5 and a rack on the hat (makeLevels has no retries).
    game.state = { ...game.state, score: 5, entities: [{ id: 999, kind: 'low', x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase.kind).toBe('over')
    expect(store.daily).toEqual({ date: '2026-09-30', best: 5 })
    expect(store.best).toBe(5)
    expect(game.dailyBest).toBe(5)
  })

  it('goes from the title screen to the level-0 tip to playing', () => {
    const game = new Game(deps())
    expect(game.phase.kind).toBe('title')
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 0 })
    game.command('confirm')
    expect(game.phase.kind).toBe('playing')
  })

  it('records a jump release as an Input event', () => {
    const game = new Game(deps())
    play(game)
    game.command('jump')
    game.frame(1)
    game.command('jumpEnd')
    game.frame(1)
    expect(game.history.slice(0, 2)).toEqual([
      { type: 'Input', tick: 0, kind: 'jump' },
      { type: 'Input', tick: 1, kind: 'jumpEnd' },
    ])
  })

  it('records inputs in the history at the tick they are applied', () => {
    const game = new Game(deps())
    play(game)
    game.frame(3)
    game.command('jump')
    game.frame(1)
    expect(game.history[0]).toEqual({ type: 'Input', tick: 3, kind: 'jump' })
  })

  it('crashes, replays the history and resumes on the exact same tick and state', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [300, 300] }) }))
    play(game)
    runUntil(game, is('crashing'), ['coin'])
    const tick = game.state.tick
    const hash = hashState(game.state)
    expect(tick).toBe(300)
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.tick).toBe(tick)
    expect(hashState(game.state)).toBe(hash)
    const activities = game.history.filter((e) => e.type === 'ActivityCoinCollected').length
    expect(activities).toBeGreaterThan(0)
    expect(game.stats).toMatchObject({ replays: 1, fromHistory: activities, executed: activities, incidents: 0 })
    expect(game.view().notice).toMatch(/resumed at tick 300/)
  })

  it('keeps any replay under REPLAY_MAX_FRAMES frames, however long the history', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [6000, 6000] }) }))
    play(game)
    runUntil(game, is('crashing'), ['coin'])
    const frames = runUntil(game, is('playing'))
    expect(frames).toBeLessThanOrEqual(CRASH_FRAMES + REPLAY_MAX_FRAMES + 1)
    expect(game.state.tick).toBe(6000)
  })

  it('ignores input while crashing or replaying', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [100, 100] }) }))
    play(game)
    runUntil(game, is('crashing'))
    const before = game.history.length
    game.command('jump')
    runUntil(game, is('playing'))
    game.frame(1)
    // Only the resume's OrchestratorStarted was added; the ignored jump was not recorded.
    expect(game.history.length).toBe(before + 1)
    expect(game.history.some((e) => e.type === 'Input')).toBe(false)
  })

  it('loses all progress on a crash in a non-durable level, then enables durability on level 1', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: makeLevels({}, { 0: { durable: false, scriptedCrashAt: 120 } }) }))
    play(game)
    runUntil(game, is('lost'), ['coin'])
    expect(store.saved).toBeNull()
    expect(game.stats.replays).toBe(0)
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
    expect(game.state.score).toBe(0)
    expect(game.history).toEqual([])
    expect(game.view().notice).toBe('Dapr Workflow enabled')
  })

  it('moves to the next level via continue-as-new, carrying the score', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 1200 }) }))
    play(game)
    runUntil(game, (g) => g.phase.kind === 'tip' && g.phase.level === 1, ['coin'])
    expect(game.start.level).toBe(1)
    expect(game.start.score).toBeGreaterThan(0)
    expect(game.state.score).toBe(game.start.score)
    expect(game.history).toEqual([])
    expect(game.state.tick).toBe(0)
  })

  it('carries the score across levels 1 to 3, except the deliberate level-0 reset', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 1200 }, { 0: { durable: false, scriptedCrashAt: 120 } }) }))
    const pal = { bg: 'white', text: 'black', muted: 'gray' } as Palette
    const hud = (): string => {
      const texts: string[] = []
      const props: Record<string, unknown> = {}
      const ctx = new Proxy(props, {
        get: (t, prop: string) => (prop in t ? t[prop] : (...args: unknown[]) => { if (prop === 'fillText') texts.push(String(args[0])) }),
        set: (t, prop: string, v) => { t[prop] = v; return true },
      }) as unknown as CanvasRenderingContext2D
      render(ctx, { state: game.state, phase: game.phase, notice: null, reducedMotion: false, frame: 0 }, pal)
      return texts.find((x) => x.startsWith('SCORE ')) ?? ''
    }
    play(game)
    runUntil(game, is('lost'), ['coin'])
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
    // Level 0 is non-durable: its progress is lost, so level 1 starts from zero.
    expect(game.start.score).toBe(0)
    expect(game.state.score).toBe(0)
    game.command('confirm')
    expect(game.phase.kind).toBe('playing')
    let previous = 0
    for (const level of [2, 3] as const) {
      runUntil(game, (g) => g.phase.kind === 'tip' && g.phase.level === level, ['coin'])
      const finalScore = game.state.score
      expect(finalScore).toBeGreaterThan(previous)
      expect(game.start.level).toBe(level)
      expect(game.start.score).toBe(finalScore)
      game.command('confirm')
      expect(game.phase.kind).toBe('playing')
      expect(game.state.score).toBe(finalScore)
      expect(hud().startsWith(`SCORE ${finalScore}`)).toBe(true)
      previous = finalScore
    }
  })

  it('detects non-determinism after an orb pickup and enters the boss phase', () => {
    const game = new Game(deps({ levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    const orbIndex = game.history.findIndex((e) => e.type === 'OrbTaken')
    expect(orbIndex).toBeGreaterThanOrEqual(0)
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.bossUntil).toBe(BOSS_TICKS)
    expect(game.start.boss).toBe(true)
    expect(game.divergedAt).toBe(orbIndex)
    expect(game.history).toEqual([{ type: 'OrchestratorStarted', tick: 0 }])
    expect(game.stats.incidents).toBe(1)
    expect(game.view().notice).toBe(`NonDeterministicError at event #${orbIndex + 1}`)
  })

  it('records OrchestratorStarted when a replay resumes, and grants grace', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [120, 120] }) }))
    play(game)
    runUntil(game, is('crashing'))
    runUntil(game, is('playing'))
    expect(game.history[game.history.length - 1]).toEqual({ type: 'OrchestratorStarted', tick: 120 })
    game.frame(1)
    expect(game.state.graceUntil).toBe(120 + GRACE_RESUME)
  })

  it('starts a boss segment with OrchestratorStarted at tick 0', () => {
    const game = new Game(deps({ impure: counter(), levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, (g) => g.state.bossUntil > 0 && g.phase.kind === 'playing', ['orb'])
    expect(game.history[0]).toEqual({ type: 'OrchestratorStarted', tick: 0 })
  })

  it('gives each level its own retries', () => {
    const levels = makeLevels({ length: 400 }, { 0: { retries: 0 }, 1: { retries: 3 } })
    const game = new Game(deps({ levels }))
    play(game)
    expect(game.start.retries).toBe(0)
    runUntil(game, (g) => g.phase.kind === 'tip' && g.start.level === 1)
    expect(game.start.retries).toBe(3)
  })

  it('counts circuit trips in the run stats, and only activities as executed', () => {
    const levels = makeLevels({ weights: { low: 1, coin: 1 }, shieldEnabled: true })
    const game = new Game(deps({ levels }))
    play(game)
    game.state = { ...game.state, shield: 10 }
    runUntil(game, (g) => g.stats.circuitTrips === 1)
    expect(game.stats).toMatchObject({ circuitTrips: 1, boostsLost: 0, retriesUsed: 0 })
    expect(game.stats.executed).toBe(game.history.filter((e) => e.type === 'ActivityCoinCollected').length)
  })

  it('replays crate pickups without divergence', () => {
    const game = new Game(deps({ levels: makeLevels({ weights: { crate: 1 }, crashAfterPickup: ['crate'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['crate'])
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.bossUntil).toBe(0)
    expect(game.divergedAt).toBeNull()
    expect(game.stats).toMatchObject({ replays: 1, incidents: 0 })
  })

  function bossGame(): { game: Game; orbIndex: number } {
    const game = new Game(deps({ levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    const orbIndex = game.history.findIndex((e) => e.type === 'OrbTaken')
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
    return { game, orbIndex }
  }

  it('hotfixes after surviving the boss: fresh history, divergence cleared', () => {
    const { game } = bossGame()
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    expect(game.divergedAt).toBeNull()
    expect(game.start.boss).toBe(false)
    expect(game.state.tick).toBeLessThan(5)
    expect(game.view().notice).toBe('Hotfix deployed · continue-as-new')
  })

  it('records no montage segments in an endless level', () => {
    const levels = makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'], length: Number.POSITIVE_INFINITY })
    const game = new Game(deps({ levels }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    expect(game.view().notice).toBe('Hotfix deployed · continue-as-new')
    expect((game as unknown as { segments: unknown[] }).segments).toHaveLength(0)
  })

  it('keeps the level distance across the boss and hotfix segments', () => {
    const { game } = bossGame()
    const before = game.start.distance
    expect(before).toBeGreaterThan(0)
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    expect(game.start.distance).toBeGreaterThan(before)
  })

  it('clears the divergence when the level ends during the boss phase', () => {
    const levels = makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }, { 0: { length: 1_000_000 } })
    const game = new Game(deps({ levels }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
    expect(game.divergedAt).not.toBeNull()
    // Direct poke: put the player at the end of the level mid-boss.
    game.state = { ...game.state, scroll: 1_000_000 - game.state.distance }
    game.frame(1)
    expect(game.phase.kind).toBe('montage')
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
    expect(game.start.distance).toBe(0)
    expect(game.divergedAt).toBeNull()
  })

  it('schedules chaos after a hotfix from the elapsed time the segment carries', () => {
    const levels = makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'], chaosMeanTicks: 1000, chaosFloorTicks: 100 })
    const game = new Game(deps({ levels }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    const expected = Math.round(chaosMeanTicks(levels[0], game.start.elapsed) ?? 0)
    expect(expected).toBeLessThan(1000)
    // Slide under the low orbs (high ones pass overhead): an orb pickup would force an earlier crash.
    game.command('slideStart')
    runUntil(game, is('crashing'))
    expect(game.state.tick).toBe(expected)
  })

  it('fails with the non-determinism reason when the player dies during the boss', () => {
    const { game, orbIndex } = bossGame()
    for (let i = 0; i < GRACE_RESUME; i++) game.frame(1)
    // Direct poke: drop an obstacle on the player (the boss segment never replays here).
    game.state = { ...game.state, entities: [{ id: 999, kind: 'low', x: PLAYER_X, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase).toEqual({ kind: 'over', reason: `non-determinism detected at event #${orbIndex + 1}` })
  })

  it('ends the run on an obstacle, clears the save and records the best score', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: makeLevels({ weights: { low: 1 } }) }))
    play(game)
    game.state = { ...game.state, score: 7 }
    runUntil(game, is('over'))
    expect(game.phase).toEqual({ kind: 'over', reason: 'hit an obstacle' })
    expect(store.saved).toBeNull()
    expect(store.best).toBe(7)
    expect(game.best).toBe(7)
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 0 })
    expect(game.state.score).toBe(0)
  })

  it('pauses and continues; paused frames do not advance the game', () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    game.frame(10)
    game.command('cancel')
    expect(game.phase.kind).toBe('paused')
    expect(store.saved?.tick).toBe(10)
    game.frame(10)
    expect(game.state.tick).toBe(10)
    game.command('confirm')
    game.frame(1)
    expect(game.state.tick).toBe(11)
  })

  it('announces fan-out and fan-in', () => {
    const game = new Game(deps({ levels: makeLevels({ fanOut: { everyPx: 400, ticks: 120 } }) }))
    play(game)
    runUntil(game, (g) => g.state.fan !== null)
    expect(game.view().notice).toBe('fan-out · 2 activities in parallel')
    runUntil(game, (g) => g.state.fan === null)
    expect(game.view().notice).toMatch(/^WhenAll · fan-in \d+ \+ \d+ coins$/)
  })

  it('keeps a held slide consistent across a pause during fan-out', () => {
    const game = new Game(deps({ levels: makeLevels({ fanOut: { everyPx: 400, ticks: 600 } }) }))
    play(game)
    runUntil(game, (g) => g.state.fan !== null)
    game.command('slideStart')
    game.frame(2)
    expect(game.state.fan?.lanes.every((l) => l.player.sliding)).toBe(true)
    const before = game.history.length
    game.command('pause')
    game.command('pause')
    game.frame(2)
    expect(game.history.slice(before).filter((e) => e.type === 'Input')).toEqual([])
    expect(game.state.fan?.lanes.every((l) => l.player.sliding)).toBe(true)
  })

  it('ends a slide released while paused once play continues, and records it', () => {
    const game = new Game(deps())
    play(game)
    game.frame(5)
    game.command('slideStart')
    game.frame(1)
    expect(game.state.player.sliding).toBe(true)
    game.command('pause')
    game.command('slideEnd')
    game.command('pause')
    game.frame(1)
    expect(game.state.player.sliding).toBe(false)
    expect(game.history[game.history.length - 1]).toEqual({ type: 'Input', tick: 6, kind: 'slideEnd' })
  })

  it('ends a slide released during a crash once the replay resumes play', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [100, 100] }) }))
    play(game)
    game.frame(50)
    game.command('slideStart')
    runUntil(game, is('crashing'))
    game.command('slideEnd')
    runUntil(game, is('playing'))
    expect(game.state.player.sliding).toBe(true)
    game.frame(1)
    expect(game.state.player.sliding).toBe(false)
    expect(game.history[game.history.length - 1]).toEqual({ type: 'Input', tick: 100, kind: 'slideEnd' })
  })

  it('starts a slide held through a segment change', () => {
    const { game } = bossGame()
    game.command('slideStart')
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    game.frame(1)
    expect(game.state.player.sliding).toBe(true)
    expect(game.history[0]).toEqual({ type: 'Input', tick: 0, kind: 'slideStart' })
  })

  it('never saves a run in a non-durable level', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: makeLevels({}, { 0: { durable: false } }) }))
    play(game)
    game.frame(10)
    game.command('pause')
    game.suspend()
    game.save()
    expect(store.saved).toBeNull()
  })

  it('suspend() pauses a running game and saves it', () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    game.frame(5)
    store.saved = null
    game.suspend()
    expect(game.phase.kind).toBe('paused')
    expect(store.saved).not.toBeNull()
  })

  it('stays on the endless level 5 once reached', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 300 }, { 5: { length: Number.POSITIVE_INFINITY } }) }))
    play(game)
    for (let f = 0; f < 20_000 && game.start.level < 5; f++) {
      if (game.phase.kind === 'tip') game.command('confirm')
      game.frame(1)
    }
    expect(game.start.level).toBe(5)
    if (game.phase.kind === 'tip') game.command('confirm')
    for (let i = 0; i < 400; i++) game.frame(1)
    expect(game.state.level).toBe(5)
  })

  describe('view().prev', () => {
    it('is the state one tick back after a live tick', () => {
      const game = new Game(deps())
      play(game)
      expect(game.view().prev).toBeNull()
      game.frame(1)
      const v = game.view()
      expect(v.prev?.tick).toBe(v.state.tick - 1)
      game.frame(3)
      expect(game.view().prev?.tick).toBe(game.view().state.tick - 1)
    })

    it('is null while paused', () => {
      const game = new Game(deps())
      play(game)
      game.frame(2)
      game.command('pause')
      expect(game.view().prev).toBeNull()
    })

    it('is null while crashing and replaying, and after the replay resumes play', () => {
      const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [300, 300] }) }))
      play(game)
      runUntil(game, is('crashing'), ['coin'])
      expect(game.view().prev).toBeNull()
      runUntil(game, is('replaying'))
      expect(game.view().prev).toBeNull()
      runUntil(game, is('playing'))
      expect(game.view().prev).toBeNull()
      game.frame(1)
      expect(game.view().prev?.tick).toBe(game.state.tick - 1)
    })

    it('is null right after a level transition and a boss start', () => {
      const lv = new Game(deps({ levels: makeLevels({ length: 1200 }) }))
      play(lv)
      runUntil(lv, (g) => g.phase.kind === 'tip' && g.phase.level === 1, ['coin'])
      lv.command('confirm')
      expect(lv.view().prev).toBeNull()
      const boss = new Game(deps({ levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
      play(boss)
      runUntil(boss, is('crashing'), ['orb'])
      runUntil(boss, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
      expect(boss.view().prev).toBeNull()
    })

    it('is null right after resuming a saved run', () => {
      const store = memoryStore()
      const first = new Game(deps({ store }))
      play(first)
      first.frame(20)
      first.save()
      const second = new Game(deps({ store }))
      second.command('confirm')
      runUntil(second, is('playing'))
      expect(second.view().prev).toBeNull()
    })
  })

  it('offers to resume a saved run and replays it to the same state', () => {
    const store = memoryStore()
    const first = new Game(deps({ store }))
    play(first)
    runUntil(first, (g) => g.state.tick >= 250, ['coin'])
    first.save()
    const second = new Game(deps({ store }))
    expect(second.phase).toEqual({ kind: 'resume', tick: 250 })
    second.command('confirm')
    expect(second.phase.kind).toBe('replaying')
    runUntil(second, is('playing'))
    expect(second.state.tick).toBe(250)
    expect(hashState(second.state)).toBe(hashState(first.state))
    expect(second.stats.replays).toBe(1)
  })

  it('discards the saved run on cancel', () => {
    const store = memoryStore()
    const first = new Game(deps({ store }))
    play(first)
    first.frame(20)
    first.save()
    const second = new Game(deps({ store }))
    second.command('cancel')
    expect(second.phase.kind).toBe('title')
    expect(store.saved).toBeNull()
  })

  it('notifies subscribers and bumps the version on phase changes', () => {
    const game = new Game(deps())
    let calls = 0
    const unsubscribe = game.subscribe(() => { calls++ })
    const v = game.getVersion()
    game.command('confirm')
    expect(calls).toBeGreaterThan(0)
    expect(game.getVersion()).toBeGreaterThan(v)
    unsubscribe()
  })
})

const retryLevels = (over: Partial<LevelConfig> = {}) => makeLevels({ weights: { low: 1 }, retries: 3, ...over })

describe('RetryPolicy rewind', () => {
  it('rewinds at least half a screen on a hit, truncates the history and records the retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    const R = game.state.tick
    const retry = game.history[game.history.length - 1]
    if (retry?.type !== 'RetryAttempt') throw new Error('no retry recorded')
    expect(retry).toMatchObject({ tick: R, attempt: 1 })
    expect(retry.failedAt - R).toBeGreaterThanOrEqual(60)
    expect(game.history.slice(0, -1).every((e) => e.tick < R)).toBe(true)
    expect(game.stats.retriesUsed).toBe(1)
    const frames = runUntil(game, is('playing'))
    expect(frames).toBeLessThanOrEqual(REWIND_FRAMES + 1)
    game.frame(1)
    expect(game.state.retries).toBe(2)
    expect(game.state.graceUntil).toBe(R + 60)
  })

  it('rolls back coins collected in the rewound span', () => {
    const game = new Game(deps({ levels: retryLevels({ weights: { low: 1, coin: 3 } }) }))
    play(game)
    runUntil(game, is('rewinding'))
    const coins = game.history.filter((e) => e.type === 'ActivityCoinCollected').length
    expect(game.state.score).toBe(coins)
  })

  it('keeps the history replayable after a retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    runUntil(game, is('playing'))
    for (let i = 0; i < 90; i++) game.frame(1)
    const r = replay(game.start, game.history, game.state.tick, counter(), retryLevels())
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(game.state))
  })

  it('rewinds to the segment start when hit on the very first tick', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    game.state = { ...game.state, entities: [{ id: 999, kind: 'low', x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase.kind).toBe('rewinding')
    expect(game.state.tick).toBe(0)
    runUntil(game, is('playing'))
    game.frame(1)
    expect(game.state).toMatchObject({ retries: 2, graceUntil: 60 })
  })

  it('fails the run when no retries are left', () => {
    const game = new Game(deps({ levels: retryLevels({ retries: 1 }) }))
    play(game)
    runUntil(game, is('rewinding'))
    runUntil(game, is('over'))
    expect(game.stats.retriesUsed).toBe(1)
  })

  it('never rewinds past an earlier retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    const first = game.state.tick
    runUntil(game, (g) => g.phase.kind === 'rewinding' && g.stats.retriesUsed === 2)
    expect(game.state.tick).toBeGreaterThan(first)
    expect(game.history.filter((e) => e.type === 'RetryAttempt').map((e) => e.tick)).toEqual([first, game.state.tick])
  })

  it('saves during a rewind and resumes with the retry applied once', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    game.suspend()
    const resumed = new Game(deps({ store, levels: retryLevels() }))
    expect(resumed.phase.kind).toBe('resume')
    resumed.command('confirm')
    runUntil(resumed, is('playing'))
    resumed.frame(1)
    expect(resumed.state.retries).toBe(2)
    expect(resumed.history.filter((e) => e.type === 'RetryAttempt')).toHaveLength(1)
  })

  it('ends a slide released during the rewind once play continues, and records it', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    game.command('slideStart')
    runUntil(game, is('rewinding'))
    game.command('slideEnd')
    runUntil(game, is('playing'))
    const R = game.state.tick
    game.frame(1)
    expect(game.state.player.sliding).toBe(false)
    const atR = game.history.filter((e) => e.tick === R).map((e) => (e.type === 'Input' ? e.kind : e.type))
    expect(atR).toEqual(['RetryAttempt', 'slideEnd'])
  })

  it('keeps a pending crash instead of rescheduling it on a retry', () => {
    const game = new Game(deps({ levels: makeLevels({ retries: 3, scriptedCrashAt: 400 }) }))
    play(game)
    game.frame(100)
    game.state = { ...game.state, entities: [{ id: 999, kind: 'low', x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase.kind).toBe('rewinding')
    runUntil(game, is('crashing'))
    expect(game.state.tick).toBe(400)
  })
})

describe('level montage', () => {
  const short = () => makeLevels({ length: 1200 })

  it('plays a montage at the end of a durable level, then shows the next tip', () => {
    const game = new Game(deps({ levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    expect(game.phase).toMatchObject({ kind: 'montage' })
    expect(game.start.level).toBe(1)
    expect(game.view().montage?.events).toBeGreaterThan(0)
    const frames = runUntil(game, is('tip'))
    expect(frames).toBeLessThanOrEqual(MONTAGE_FRAMES + 2)
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
  })

  it('skips the montage on Enter', () => {
    const game = new Game(deps({ levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
  })

  it('has no montage after a non-durable level', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 1200 }, { 0: { durable: false } }) }))
    play(game)
    runUntil(game, (g) => g.phase.kind === 'montage' || g.phase.kind === 'tip', ['coin'])
    expect(game.phase.kind).toBe('tip')
  })

  it('does not touch the outside world while playing a montage', () => {
    let calls = 0
    const impure = counter()
    const game = new Game(deps({ levels: makeLevels({ length: 1200, weights: { coin: 2, orb: 1 } }), impure: () => { calls++; return impure() } }))
    play(game)
    runUntil(game, is('montage'), ['coin', 'orb'])
    const before = calls
    runUntil(game, is('tip'))
    expect(calls).toBe(before)
  })

  it('includes the boss and hotfix segments of the level', () => {
    const levels = makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'], length: 6000 })
    const game = new Game(deps({ levels }))
    play(game)
    runUntil(game, (g) => g.stats.incidents === 1, ['orb'])
    runUntil(game, is('montage'), ['orb'])
    const m = game.view().montage
    expect(m).not.toBeNull()
    let boundaries = 0
    runUntil(game, (g) => {
      if ((g.view().montage?.flash ?? 0) === 8) boundaries++
      return g.phase.kind === 'tip'
    })
    expect(boundaries).toBeGreaterThanOrEqual(1)
  })

  it('saves during a montage and resumes at the start of the next level', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    game.suspend()
    const resumed = new Game(deps({ store, levels: short() }))
    expect(resumed.phase.kind).toBe('resume')
    resumed.command('confirm')
    runUntil(resumed, is('playing'))
    expect(resumed.start.level).toBe(1)
    expect(resumed.state.tick).toBe(0)
  })
})

describe('run tape', () => {
  const WANT: readonly EntityKind[] = ['coin', 'orb', 'crate']
  const tapeLevels = () =>
    makeLevels({
      weights: { low: 2, coin: 3, orb: 1, crate: 1 }, retries: 3, shieldEnabled: true,
      crashAfterPickup: ['orb', 'crate'], firstCrashTicks: [200, 260], chaosMeanTicks: 600, length: 3000,
    })
  const noWorld = (): number => {
    throw new Error('playback must not read the outside world')
  }

  /** Jumps low racks (unless careless) and otherwise steers toward pickups. */
  function drive(g: Game, careless: boolean): void {
    if (g.phase.kind === 'tip') g.command('confirm')
    if (g.phase.kind !== 'playing') return
    const s = g.state
    const gap = (x: number) => x - (PLAYER_X + 30)
    const rack = !careless && s.player.y >= GROUND_Y && s.entities.some((e) => e.kind === 'low' && !e.taken && gap(e.x) > 0 && gap(e.x) <= 24)
    for (const c of rack ? (['jump'] as const) : autopilot(s, WANT)) g.command(c)
  }

  /** A live run with crashes, retries and a tab-close resume in the middle. */
  function recordRun(): Game {
    const store = memoryStore()
    const live = new Game(deps({ store, levels: tapeLevels(), impure: lcg(1), chaosRand: lcg(2) }))
    play(live)
    for (let f = 0; f < 6000 && !(live.stats.replays >= 1 && live.phase.kind === 'playing' && live.liveTicks > 300); f++) {
      drive(live, false)
      live.frame(1)
    }
    live.suspend()
    const resumed = new Game(deps({ store, levels: tapeLevels(), impure: lcg(3), chaosRand: lcg(4) }))
    resumed.command('confirm')
    for (let f = 0; f < 5000 && resumed.phase.kind !== 'over'; f++) {
      drive(resumed, f % 600 > 200 && f % 600 < 350)
      resumed.frame(1)
    }
    for (let f = 0; f < 600 && resumed.phase.kind !== 'playing' && resumed.phase.kind !== 'over'; f++) resumed.frame(1)
    return resumed
  }

  let recorded: Game | null = null
  const recording = (): Game => (recorded ??= recordRun())

  it('plays a recorded run back exactly, across crashes, retries and a tab-close resume', () => {
    const live = recording()
    expect(live.tape.restarts).toHaveLength(1)
    expect(live.stats.replays).toBeGreaterThanOrEqual(2)
    expect(live.stats.retriesUsed).toBeGreaterThan(0)
    const viewer = new Game(deps({ levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    expect(viewer.watch(live.tape)).toBe(true)
    expect(viewer.playback).toBe(true)
    const L = live.liveTicks
    for (let f = 0; f < 60_000 && !(viewer.liveTicks === L && viewer.phase.kind === live.phase.kind); f++) viewer.frame(1)
    expect(viewer.liveTicks).toBe(L)
    expect(viewer.stats).toEqual(live.stats)
    expect(viewer.history).toEqual(live.history)
    expect(hashState(viewer.state)).toBe(hashState(live.state))
  })

  it('stops with "Run code ended early" on a truncated tape and writes nothing', () => {
    const live = recording()
    const store = memoryStore()
    const viewer = new Game(deps({ store, levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    viewer.watch({ ...live.tape, chaos: live.tape.chaos.slice(0, 1), impure: [] })
    for (let f = 0; f < 60_000 && viewer.phase.kind !== 'over'; f++) viewer.frame(1)
    expect(viewer.phase).toEqual({ kind: 'over', reason: 'Run code ended early' })
    expect(store.saved).toBeNull()
    expect(store.best).toBe(0)
    expect(store.daily).toBeNull()
  })

  it('ignores game keys during playback; Esc returns to the title', () => {
    const live = recording()
    const viewer = new Game(deps({ levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    viewer.watch(live.tape)
    const L = live.liveTicks
    for (let f = 0; f < 60_000 && !(viewer.liveTicks === L && viewer.phase.kind === live.phase.kind); f++) {
      // Mashing keys must not change the run being played back.
      viewer.command('jump')
      viewer.command(f % 2 ? 'slideStart' : 'slideEnd')
      viewer.frame(1)
    }
    expect(viewer.history).toEqual(live.history)
    viewer.command('cancel')
    expect(viewer.phase.kind).toBe('title')
    expect(viewer.playback).toBe(false)
  })

  it('lets Enter unpause a paused playback', () => {
    const viewer = new Game(deps({ levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    viewer.watch(recording().tape)
    for (let f = 0; f < 10 && viewer.phase.kind !== 'playing'; f++) viewer.frame(1)
    expect(viewer.phase.kind).toBe('playing')
    viewer.command('pause')
    expect(viewer.phase.kind).toBe('paused')
    viewer.command('confirm')
    expect(viewer.phase.kind).toBe('playing')
  })

  it('shows today, not the tape date, after leaving a playback with Esc', () => {
    const store = memoryStore()
    store.daily = { date: '2026-10-01', best: 77 }
    const viewer = new Game(deps({ store, levels: tapeLevels(), today: () => '2026-10-01' }))
    viewer.watch(emptyTape('2026-09-30'))
    expect(viewer.runDate).toBe('2026-09-30')
    viewer.command('cancel')
    expect(viewer.phase.kind).toBe('title')
    expect(viewer.runDate).toBe('2026-10-01')
    expect(viewer.dailyBest).toBe(77)
  })

  it('refuses a malformed tape', () => {
    const viewer = new Game(deps())
    expect(viewer.watch({ ...emptyTape('2026-09-30'), v: 2 } as unknown as Tape)).toBe(false)
    expect(viewer.phase.kind).toBe('title')
  })

  it('starts a fresh live run on Enter at the end of a playback', () => {
    const viewer = new Game(deps({ levels: tapeLevels() }))
    viewer.watch(emptyTape('2026-09-30'))
    for (let f = 0; f < 60_000 && viewer.phase.kind !== 'over'; f++) viewer.frame(1)
    expect(viewer.phase).toEqual({ kind: 'over', reason: 'Run code ended early' })
    viewer.command('confirm')
    expect(viewer.playback).toBe(false)
    expect(viewer.phase).toEqual({ kind: 'tip', level: 0 })
  })

  /** Plays a viewer through `live.tape` to the same live tick and phase and compares the runs. */
  function expectPlaybackEquals(live: Game, levels: LevelTable = tapeLevels(), ticksPerFrame = 1): void {
    const viewer = new Game(deps({ levels, impure: noWorld, chaosRand: noWorld }))
    expect(viewer.watch(live.tape)).toBe(true)
    const L = live.liveTicks
    for (let f = 0; f < 60_000 && !(viewer.liveTicks === L && viewer.phase.kind === live.phase.kind); f++) viewer.frame(Math.min(ticksPerFrame, L - viewer.liveTicks))
    expect(viewer.liveTicks).toBe(L)
    expect(viewer.stats).toEqual(live.stats)
    expect(viewer.history).toEqual(live.history)
    expect(hashState(viewer.state)).toBe(hashState(live.state))
  }

  const crashLevels = () => makeLevels({ firstCrashTicks: [120, 120], weights: { coin: 2, low: 1 }, retries: 3 })

  it('plays back a run whose tab closed mid-crash', () => {
    const store = memoryStore()
    const live = new Game(deps({ store, levels: crashLevels(), impure: lcg(5), chaosRand: lcg(6) }))
    play(live)
    for (let f = 0; f < 2000 && live.phase.kind !== 'crashing'; f++) {
      drive(live, false)
      live.frame(1)
    }
    expect(live.phase.kind).toBe('crashing')
    live.suspend()
    const resumed = new Game(deps({ store, levels: crashLevels(), impure: lcg(7), chaosRand: lcg(8) }))
    resumed.command('confirm')
    for (let f = 0; f < 400; f++) {
      drive(resumed, false)
      resumed.frame(1)
    }
    expect(resumed.tape.restarts).toHaveLength(1)
    expectPlaybackEquals(resumed, crashLevels())
  })

  it('plays back a run saved after a crash replay but before the next tick', () => {
    const store = memoryStore()
    const live = new Game(deps({ store, levels: crashLevels(), impure: lcg(5), chaosRand: lcg(6) }))
    play(live)
    for (let f = 0; f < 2000 && live.phase.kind !== 'crashing'; f++) {
      drive(live, false)
      live.frame(1)
    }
    for (let f = 0; f < 600 && live.phase.kind !== 'playing'; f++) live.frame(0)
    expect(live.phase.kind).toBe('playing')
    live.suspend()
    const resumed = new Game(deps({ store, levels: crashLevels(), impure: lcg(7), chaosRand: lcg(8) }))
    resumed.command('confirm')
    for (let f = 0; f < 400; f++) {
      drive(resumed, false)
      resumed.frame(1)
    }
    expect(resumed.stats.replays).toBeGreaterThanOrEqual(2)
    expectPlaybackEquals(resumed, crashLevels())
  })

  it.each([2, 3, 4, 5, 7])('plays back exactly when a slow frame runs %i ticks at once', (n) => {
    // The recording resumes a save mid-play; a multi-tick frame must not step past that restart.
    expectPlaybackEquals(recording(), tapeLevels(), n)
  })

  it("does not overwrite today's daily best when finishing a resumed run from an earlier day", () => {
    const store = memoryStore()
    store.daily = { date: '2026-09-30', best: 50 }
    const a = new Game(deps({ store, today: () => '2026-09-29' }))
    play(a)
    a.frame(5)
    a.suspend()
    expect(store.saved).not.toBeNull()
    const b = new Game(deps({ store, today: () => '2026-09-30' }))
    b.command('confirm')
    expect(b.runDate).toBe('2026-09-29')
    // Direct poke: a high score, then the run fails.
    b.state = { ...b.state, score: 999 }
    ;(b as unknown as { gameOver(r: string): void }).gameOver('hit an obstacle')
    expect(store.best).toBe(999)
    expect(store.daily).toEqual({ date: '2026-09-30', best: 50 })
  })
})
