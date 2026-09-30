import { LEVELS, speedAt, type LevelTable } from '../engine/levels'
import { createReplayer, inputOf, isInputEvent, type Replayer } from '../engine/replay'
import { seedFrom } from '../engine/rng'
import { seedForDate } from '../engine/seed'
import { continueAsNew, initialState, livePlayer, step } from '../engine/step'
import type { GameState, HistoryEvent, InputEvent, InputKind, Level, PlayerInput, StartInput } from '../engine/types'
import { ChaosScheduler } from './chaos'
import { Montage, type MontageSegment } from './montage'
import type { SaveStore } from './persistence'
import { REWIND_FRAMES, REWIND_PX, RewindBuffer, sample } from './rewind'
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
  /** Today's UTC date (YYYY-MM-DD); the run's seed comes from it. */
  today: () => string
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
  /** The level montage playing now, for the renderer; otherwise null. */
  montage: { events: number; flash: number; trail: number[] } | null
}

const emptyStats = (): RunStats => ({ replays: 0, fromHistory: 0, executed: 0, incidents: 0, retriesUsed: 0, circuitTrips: 0, boostsLost: 0 })
const nextLevel = (l: Level): Level => (l >= 5 ? 5 : ((l + 1) as Level))

export class Game {
  phase: Phase = { kind: 'title' }
  runDate: string
  dailyBest: number
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
  private pending: PlayerInput[] = []
  /** Input events already in the history at the current tick; the next tick applies them. */
  private queued: InputEvent[] = []
  /** Whether the slide key is down, tracked in every phase so a release is never lost. */
  private slideHeld = false
  /** Closed segments of the current level, for its montage. */
  private segments: MontageSegment[] = []
  /** Live impure values of this segment's orb pickups, by orb id. */
  private orbValues = new Map<number, number>()
  private montage: Montage | null = null
  private replayer: Replayer | null = null
  private replayTicksPerFrame = REPLAY_MIN_TICKS_PER_FRAME
  private crashTick = 0
  private savedRun: Save | null
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly rewind = new RewindBuffer()
  private readonly levels: LevelTable
  private readonly chaos: ChaosScheduler

  constructor(private readonly deps: GameDeps) {
    this.levels = deps.levels ?? LEVELS
    this.chaos = new ChaosScheduler(deps.chaosRand, this.levels)
    this.best = deps.store.loadBest()
    this.runDate = deps.today()
    this.dailyBest = deps.store.loadDailyBest(this.runDate)
    this.state = initialState(this.start, this.levels)
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
    const p = this.phase
    const m = p.kind === 'montage' ? this.montage : null
    const state = m ? m.state : p.kind === 'rewinding' ? (p.frames[p.index] ?? this.state) : this.state
    return {
      state,
      phase: p,
      divergedAt: this.divergedAt,
      prev: p.kind === 'playing' && this.prevState && this.prevState.tick === this.state.tick - 1 ? this.prevState : null,
      notice: n && this.state.tick < n.untilTick ? n.text : null,
      montage: m ? { events: m.events, flash: m.flash, trail: m.trail } : null,
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
      case 'montage':
        if (c === 'confirm') this.endMontage()
        return
      case 'lost':
        if (c === 'confirm') {
          this.stats = emptyStats()
          this.beginSegment({ level: 1, seed: seedFrom(seedForDate(this.runDate)), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[1].retries, shield: 0 }, true)
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
    } else if (p.kind === 'rewinding') {
      if (p.index + 1 < p.frames.length) this.phase = { ...p, index: p.index + 1 }
      else this.setPhase({ kind: 'playing' })
    } else if (p.kind === 'montage') {
      this.montage?.advance()
      if (!this.montage || this.montage.done) this.endMontage()
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
      version: 2, date: this.runDate, start: this.start, history: this.history, tick, stats: this.stats, divergedAt: this.divergedAt,
      segments: this.segments, orbValues: [...this.orbValues],
    })
  }

  /** Runtime inputs (resume, retry) go into the history at once, so a save before the next tick keeps them. */
  private recordInput(e: InputEvent): void {
    this.history.push(e)
    this.queued.push(e)
  }

  private tick(): void {
    const t = this.state.tick
    const inputs: InputKind[] = this.queued.map(inputOf)
    this.queued = []
    const pending = this.pending
    this.pending = []
    for (const kind of pending) {
      this.history.push({ type: 'Input', tick: t, kind })
      inputs.push(kind)
    }
    const calls: number[] = []
    const impure = () => {
      const v = this.deps.impure()
      calls.push(v)
      return v
    }
    const ports = { impure, crateValue: () => impure() }
    this.prevState = this.state
    const { state, events } = step(this.state, inputs, ports, this.levels)
    if (state.status === 'retry') {
      this.retry(state)
      return
    }
    this.state = state
    // Each orb and each crate calls impure exactly once, in event order.
    let c = 0
    for (const e of events) {
      if (e.type === 'OrbTaken') this.orbValues.set(e.id, calls[c++])
      else if (e.type === 'ActivityCrateCollected') c++
    }
    for (const e of events) {
      this.history.push(e)
      if (e.type === 'OrbTaken') this.chaos.onPickup(state.level, 'orb', state.tick)
      else if (e.type === 'ActivityCoinCollected' || e.type === 'ActivityCrateCollected') {
        this.stats.executed += 1
        if (e.type === 'ActivityCrateCollected') this.chaos.onPickup(state.level, 'crate', state.tick)
      } else if (e.type === 'CircuitBreakerTripped') this.stats.circuitTrips += 1
      else if (e.type === 'BoostLost') this.stats.boostsLost += 1
      else if (e.type === 'FanOut') this.setNotice('fan-out · 3 activities in parallel')
      else if (e.type === 'FanIn') this.setNotice(`WhenAll · fan-in ${e.results.join(' + ')} coins`)
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
      this.closeSegment(state.tick)
      const segments = this.levels[state.level].durable ? this.segments : []
      this.segments = []
      const next = nextLevel(state.level)
      // The next level starts (and is saved) first, so a tab closed during the montage resumes there.
      this.beginSegment(continueAsNew(state, { level: next, elapsed: 0, distance: 0, retries: this.levels[next].retries }), true)
      if (segments.length > 0) {
        this.montage = new Montage(segments, this.levels)
        this.setPhase({ kind: 'montage', events: this.montage.events })
      }
      return
    }
    this.rewind.push(state)
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

  /** RetryPolicy: rewind to a safe spot about half a screen back and try again. */
  private retry(hit: GameState): void {
    const cfg = this.levels[hit.level]
    const lastRetry = [...this.history].reverse().find((e) => e.type === 'RetryAttempt')
    const floor = lastRetry ? lastRetry.tick + 1 : 0
    const target = this.rewind.pick(hit.failedAt, Math.ceil(REWIND_PX / speedAt(cfg, hit.elapsed)), floor)
    const frames = sample(this.rewind.between(target.tick, hit.failedAt).reverse(), REWIND_FRAMES)
    this.history = this.history.filter((e) => e.tick < target.tick)
    this.rewind.dropAfter(target.tick)
    this.state = target
    this.prevState = null
    this.pending = []
    this.queued = []
    this.stats.retriesUsed += 1
    const attempt = cfg.retries - target.retries + 1
    this.recordInput({ type: 'RetryAttempt', tick: target.tick, attempt, failedAt: hit.failedAt })
    // A crash already pending (scripted, teaching or post-pickup) stays; only schedule one when none is due.
    if (this.chaos.nextCrashAt === null) this.chaos.scheduleNext(target.level, target.tick, target.elapsed)
    this.setPhase({ kind: 'rewinding', frames, index: 0, attempt, of: cfg.retries })
    this.save()
  }

  private newRun(): void {
    this.stats = emptyStats()
    this.divergedAt = null
    this.segments = []
    this.deps.store.clear()
    this.runDate = this.deps.today()
    this.dailyBest = this.deps.store.loadDailyBest(this.runDate)
    this.beginSegment({ level: 0, seed: seedForDate(this.runDate), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[0].retries, shield: 0 }, true)
  }

  private beginSegment(start: StartInput, showTip: boolean): void {
    this.start = start
    this.history = []
    this.orbValues = new Map()
    this.state = initialState(start, this.levels)
    this.rewind.reset(this.state)
    this.prevState = null
    this.pending = []
    this.queued = []
    this.notice = null
    this.chaos.start(start.level, showTip, start.elapsed)
    this.setPhase(showTip ? { kind: 'tip', level: start.level } : { kind: 'playing' })
    this.save()
  }

  private closeSegment(endTick: number): void {
    this.segments.push({ start: this.start, history: [...this.history], endTick, orbValues: [...this.orbValues] })
  }

  private endMontage(): void {
    this.montage = null
    this.setPhase({ kind: 'tip', level: this.start.level })
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
    this.rewind.reset(this.replayer.state)
    this.replayTicksPerFrame = Math.max(REPLAY_MIN_TICKS_PER_FRAME, Math.ceil(this.crashTick / REPLAY_MAX_FRAMES))
    this.state = this.replayer.state
    this.prevState = null
    this.setPhase({ kind: 'replaying' })
  }

  private advanceReplay(): void {
    const r = this.replayer
    if (!r) return
    for (let i = 0; i < this.replayTicksPerFrame && !r.done; i++) {
      r.advance(1)
      if (r.state.status === 'running') this.rewind.push(r.state)
    }
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
      // Runtime inputs recorded at the resume tick were not applied by the replay (it stops before that tick).
      this.queued = this.history.filter((e): e is InputEvent => isInputEvent(e) && e.tick === this.state.tick)
      this.recordInput({ type: 'OrchestratorStarted', tick: this.state.tick })
      this.setNotice(`Replayed ${this.history.length} events · resumed at tick ${this.state.tick}`)
      this.setPhase({ kind: 'playing' })
      return
    }
    this.stats.incidents += 1
    this.divergedAt = result.divergedAt
    this.closeSegment(this.crashTick)
    this.beginSegment(continueAsNew(result.state, { boss: true }), false)
    this.recordInput({ type: 'OrchestratorStarted', tick: 0 })
    this.setNotice(`NonDeterministicError at event #${result.divergedAt + 1}`)
  }

  private hotfix(): void {
    this.divergedAt = null
    this.closeSegment(this.state.tick)
    this.beginSegment(continueAsNew(this.state), false)
    this.setNotice('Hotfix deployed · continue-as-new')
  }

  private resumeSaved(save: Save): void {
    this.savedRun = null
    this.runDate = save.date
    this.dailyBest = this.deps.store.loadDailyBest(save.date)
    this.start = save.start
    this.history = save.history
    this.stats = save.stats
    this.divergedAt = save.divergedAt
    this.segments = save.segments
    this.orbValues = new Map(save.orbValues)
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
    if (this.state.score > this.dailyBest) {
      this.dailyBest = this.state.score
      this.deps.store.saveDailyBest(this.runDate, this.dailyBest)
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
    const sliding = livePlayer(this.state).sliding
    if (sliding && !this.slideHeld) this.pending.push('slideEnd')
    else if (!sliding && this.slideHeld) this.pending.push('slideStart')
  }

  private touch(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}
