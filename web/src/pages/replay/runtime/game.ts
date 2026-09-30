import { LEVELS, type LevelTable } from '../engine/levels'
import { createReplayer, type Replayer } from '../engine/replay'
import { continueAsNew, initialState, step } from '../engine/step'
import type { GameState, HistoryEvent, InputKind, Level, StartInput } from '../engine/types'
import { ChaosScheduler } from './chaos'
import type { SaveStore } from './persistence'
import type { Command, Phase, RunStats, Save } from './types'

/** Frames the crash glitch shows before the replay starts. */
export const CRASH_FRAMES = 36
/** Replay runs at least this many ticks per frame (8×)… */
export const REPLAY_MIN_TICKS_PER_FRAME = 8
/** …and fast enough to finish within this many frames (~2 s). */
export const REPLAY_MAX_FRAMES = 120
/** How long an on-screen notice stays up. */
export const NOTICE_TICKS = 180

export interface GameDeps {
  /** The one deliberate source of non-determinism (Math.random at runtime). */
  impure: () => number
  /** Chaos timing (the outside world). */
  chaosRand: () => number
  newSeed: () => number
  store: SaveStore
  levels?: LevelTable
}

export interface GameView {
  state: GameState
  phase: Phase
  notice: string | null
  divergedAt: number | null
  /** The state one tick before `state` while playing live, for display interpolation; otherwise null. */
  prev: GameState | null
}

const emptyStats = (): RunStats => ({ replays: 0, fromHistory: 0, executed: 0, incidents: 0 })
const nextLevel = (l: Level): Level => (l >= 4 ? 4 : ((l + 1) as Level))

export class Game {
  phase: Phase = { kind: 'title' }
  start: StartInput = { level: 0, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }
  history: HistoryEvent[] = []
  state: GameState
  stats: RunStats = emptyStats()
  best: number
  /** History index of the non-deterministic event behind the current boss phase. */
  divergedAt: number | null = null

  /** The state before the latest live tick; null whenever `state` was replaced wholesale. */
  private prevState: GameState | null = null
  private notice: { text: string; untilTick: number } | null = null
  private pending: InputKind[] = []
  /** Whether the slide key is down, tracked in every phase so a release is never lost. */
  private slideHeld = false
  private replayer: Replayer | null = null
  private replayTicksPerFrame = REPLAY_MIN_TICKS_PER_FRAME
  private crashTick = 0
  private savedRun: Save | null
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly levels: LevelTable
  private readonly chaos: ChaosScheduler

  constructor(private readonly deps: GameDeps) {
    this.levels = deps.levels ?? LEVELS
    this.chaos = new ChaosScheduler(deps.chaosRand, this.levels)
    this.best = deps.store.loadBest()
    this.state = initialState(this.start)
    this.savedRun = deps.store.load()
    if (this.savedRun) this.phase = { kind: 'resume', tick: this.savedRun.tick }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = (): number => this.version

  view(): GameView {
    const n = this.notice
    return {
      state: this.state,
      phase: this.phase,
      divergedAt: this.divergedAt,
      prev: this.phase.kind === 'playing' && this.prevState && this.prevState.tick === this.state.tick - 1 ? this.prevState : null,
      notice: n && this.state.tick < n.untilTick ? n.text : null,
    }
  }

  command(c: Command): void {
    if (c === 'slideStart') this.slideHeld = true
    else if (c === 'slideEnd') this.slideHeld = false
    switch (this.phase.kind) {
      case 'title':
      case 'over':
        if (c === 'confirm') this.newRun()
        return
      case 'resume':
        if (c === 'confirm' && this.savedRun) this.resumeSaved(this.savedRun)
        else if (c === 'cancel') {
          this.savedRun = null
          this.deps.store.clear()
          this.setPhase({ kind: 'title' })
        }
        return
      case 'tip':
        if (c === 'confirm') this.setPhase({ kind: 'playing' })
        return
      case 'lost':
        if (c === 'confirm') {
          this.stats = emptyStats()
          this.beginSegment({ level: 1, seed: this.deps.newSeed() >>> 0, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }, true)
          this.setNotice('Dapr Workflow enabled')
        }
        return
      case 'playing':
        if (c === 'cancel' || c === 'pause') {
          this.setPhase({ kind: 'paused' })
          this.save()
        } else if (c === 'jump' || c === 'jumpEnd' || c === 'slideStart' || c === 'slideEnd') {
          this.pending.push(c)
        }
        return
      case 'paused':
        if (c === 'cancel' || c === 'pause' || c === 'confirm') this.setPhase({ kind: 'playing' })
        return
      default:
        // crashing / replaying: input is ignored, like a restarting process.
        return
    }
  }

  /** Called once per animation frame with the number of whole 60 Hz ticks elapsed. */
  frame(liveTicks: number): void {
    const p = this.phase
    if (p.kind === 'playing') {
      for (let i = 0; i < liveTicks && this.phase.kind === 'playing'; i++) this.tick()
    } else if (p.kind === 'crashing') {
      // Per-frame countdown only drives the glitch effect; no re-render needed.
      if (p.framesLeft > 1) this.phase = { kind: 'crashing', framesLeft: p.framesLeft - 1 }
      else this.startReplay()
    } else if (p.kind === 'replaying') {
      this.advanceReplay()
    }
  }

  /** Tab hidden or page left: pause a running game and persist it. */
  suspend(): void {
    if (this.phase.kind === 'playing') this.setPhase({ kind: 'paused' })
    this.save()
  }

  save(): void {
    const k = this.phase.kind
    if (k === 'title' || k === 'resume' || k === 'over' || k === 'lost') return
    // A non-durable level keeps nothing: a save would promise a resume it can't deliver.
    if (!this.levels[this.start.level].durable) return
    const tick = k === 'crashing' || k === 'replaying' ? this.crashTick : this.state.tick
    this.deps.store.save({
      version: 2, start: this.start, history: this.history, tick, stats: this.stats, divergedAt: this.divergedAt,
    })
  }

  private tick(): void {
    const inputs = this.pending
    this.pending = []
    const t = this.state.tick
    for (const kind of inputs) this.history.push({ type: 'Input', tick: t, kind })
    const ports = { impure: this.deps.impure, crateValue: () => this.deps.impure() }
    this.prevState = this.state
    const { state, events } = step(this.state, inputs, ports, this.levels)
    this.state = state
    for (const e of events) {
      this.history.push(e)
      if (e.type === 'OrbTaken') {
        this.chaos.onPickup(state.level, 'orb', state.tick)
      } else {
        this.stats.executed += 1
        if (e.type === 'ActivityCrateCollected') this.chaos.onPickup(state.level, 'crate', state.tick)
      }
    }

    if (state.status === 'failed') {
      const reason = state.bossUntil > 0 && this.divergedAt !== null
        ? `non-determinism detected at event #${this.divergedAt + 1}`
        : 'hit an obstacle'
      this.gameOver(reason)
      return
    }
    if (state.status === 'levelDone') {
      // A level can end mid-boss now that distance carries across segments.
      this.divergedAt = null
      this.beginSegment(continueAsNew(state, { level: nextLevel(state.level), elapsed: 0, distance: 0 }), true)
      return
    }
    if (state.bossUntil > 0) {
      if (state.tick >= state.bossUntil) this.hotfix()
      else if (events.length > 0 || inputs.length > 0) this.touch()
      return
    }
    if (this.chaos.isDue(state.tick)) {
      this.crash()
      return
    }
    if (events.length > 0) this.save()
    if (events.length > 0 || inputs.length > 0) this.touch()
  }

  private newRun(): void {
    this.stats = emptyStats()
    this.divergedAt = null
    this.deps.store.clear()
    this.beginSegment({ level: 0, seed: this.deps.newSeed() >>> 0, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }, true)
  }

  private beginSegment(start: StartInput, showTip: boolean): void {
    this.start = start
    this.history = []
    this.state = initialState(start)
    this.prevState = null
    this.pending = []
    this.notice = null
    this.chaos.start(start.level, showTip, start.elapsed)
    this.setPhase(showTip ? { kind: 'tip', level: start.level } : { kind: 'playing' })
    this.save()
  }

  private crash(): void {
    this.crashTick = this.state.tick
    this.setPhase({ kind: 'crashing', framesLeft: CRASH_FRAMES })
    this.save()
  }

  private startReplay(): void {
    if (!this.levels[this.start.level].durable) {
      this.deps.store.clear()
      this.setPhase({ kind: 'lost' })
      return
    }
    this.stats.replays += 1
    this.replayer = createReplayer(this.start, this.history, this.crashTick, this.deps.impure, this.levels)
    this.replayTicksPerFrame = Math.max(REPLAY_MIN_TICKS_PER_FRAME, Math.ceil(this.crashTick / REPLAY_MAX_FRAMES))
    this.state = this.replayer.state
    this.prevState = null
    this.setPhase({ kind: 'replaying' })
  }

  private advanceReplay(): void {
    const r = this.replayer
    if (!r) return
    r.advance(this.replayTicksPerFrame)
    this.state = r.state
    this.prevState = null
    if (!r.done) return
    this.replayer = null
    const result = r.result()
    const served = this.history.slice(0, result.ok ? this.history.length : result.divergedAt)
    this.stats.fromHistory += served.filter(
      (e) => e.type === 'ActivityCoinCollected' || e.type === 'ActivityCrateCollected',
    ).length
    if (result.ok) {
      this.state = result.state
      this.prevState = null
      this.chaos.scheduleNext(this.state.level, this.state.tick, this.state.elapsed)
      this.setNotice(`Replayed ${this.history.length} events · resumed at tick ${this.state.tick}`)
      this.setPhase({ kind: 'playing' })
      return
    }
    this.stats.incidents += 1
    this.divergedAt = result.divergedAt
    this.beginSegment(continueAsNew(result.state, { boss: true }), false)
    this.setNotice(`NonDeterministicError at event #${result.divergedAt + 1}`)
  }

  private hotfix(): void {
    this.divergedAt = null
    this.beginSegment(continueAsNew(this.state), false)
    this.setNotice('Hotfix deployed · continue-as-new')
  }

  private resumeSaved(save: Save): void {
    this.savedRun = null
    this.start = save.start
    this.history = save.history
    this.stats = save.stats
    this.divergedAt = save.divergedAt
    this.crashTick = save.tick
    this.pending = []
    this.notice = null
    this.chaos.start(save.start.level, false, save.start.elapsed)
    this.startReplay()
  }

  private gameOver(reason: string): void {
    this.deps.store.clear()
    if (this.state.score > this.best) {
      this.best = this.state.score
      this.deps.store.saveBest(this.best)
    }
    this.setPhase({ kind: 'over', reason })
  }

  private setNotice(text: string): void {
    this.notice = { text, untilTick: this.state.tick + NOTICE_TICKS }
    this.touch()
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    if (phase.kind === 'playing') this.syncSlide()
    this.touch()
  }

  /**
   * On (re)entering play, queue the slide input that matches the key as it is
   * now: a release (or press) that happened while input was ignored is then
   * recorded at the next tick like any other input, so replay stays exact.
   */
  private syncSlide(): void {
    this.pending = this.pending.filter((k) => k === 'jump')
    const sliding = this.state.player.sliding
    if (sliding && !this.slideHeld) this.pending.push('slideEnd')
    else if (!sliding && this.slideHeld) this.pending.push('slideStart')
  }

  private touch(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}
