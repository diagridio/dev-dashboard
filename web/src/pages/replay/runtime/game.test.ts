import { describe, expect, it } from 'vitest'
import { hashState } from '../engine/hash'
import { chaosMeanTicks } from '../engine/levels'
import { BOSS_TICKS, GRACE_RESUME } from '../engine/step'
import { GROUND_Y, PLAYER_X, type EntityKind } from '../engine/types'
import type { Palette } from '../render/palette'
import { render } from '../render/canvas'
import { autopilot, counter, makeLevels } from '../testing'
import { CRASH_FRAMES, Game, REPLAY_MAX_FRAMES, type GameDeps } from './game'
import type { SaveStore } from './persistence'
import type { Save } from './types'

type MemoryStore = SaveStore & { saved: Save | null; best: number }

function memoryStore(): MemoryStore {
  const s: MemoryStore = {
    saved: null,
    best: 0,
    load: () => (s.saved ? (JSON.parse(JSON.stringify(s.saved)) as Save) : null),
    save: (x) => { s.saved = JSON.parse(JSON.stringify(x)) as Save },
    clear: () => { s.saved = null },
    loadBest: () => s.best,
    saveBest: (n) => { s.best = n },
  }
  return s
}

function deps(overrides: Partial<GameDeps> = {}): GameDeps {
  return { impure: counter(), chaosRand: () => 0.5, newSeed: () => 42, store: memoryStore(), levels: makeLevels(), ...overrides }
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
