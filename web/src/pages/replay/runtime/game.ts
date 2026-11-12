import { LEVELS, speedAt, type LevelTable } from '../engine/levels'
import { createReplayer, inputOf, isInputEvent, type Replayer } from '../engine/replay'
import { seedFrom } from '../engine/rng'
import { seedForDate } from '../engine/seed'
import { FAN_LANES, continueAsNew, initialState, livePlayer, step } from '../engine/step'
import type { GameState, HistoryEvent, InputEvent, InputKind, Level, PlayerInput, StartInput } from '../engine/types'
import { ChaosScheduler } from './chaos'
import { KIOSK_SEED, KioskBot, KioskSource } from './kiosk'
import { Montage, type MontageSegment } from './montage'
import type { SaveStore } from './persistence'
import { REWIND_FRAMES, REWIND_PX, RewindBuffer, sample } from './rewind'
import { TapePlayer, TapeRecorder, emptyTape, isTape, type Source, type Tape } from './tape'
import type { Command, Phase, RunStats, Save, SaveBody } from './types'

/** Frames the crash glitch shows before the replay starts. */
export const CRASH_FRAMES = 90
/** Replay runs at least this many ticks per frame (8×)… */
export const REPLAY_MIN_TICKS_PER_FRAME = 8
/** …and fast enough to finish within this many frames (~2 s). */
export const REPLAY_MAX_FRAMES = 120
/** How long an on-screen notice stays up. */
export const NOTICE_TICKS = 180
/** Speeds a recorded run can be watched at. */
export const PLAYBACK_SPEEDS = [1, 2, 5, 10] as const
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number]
/** Kiosk mode: 60 Hz ticks a tip or "Progress lost" card stays up before it confirms itself (~4 s). */
export const KIOSK_CARD_TICKS = 240
/** Kiosk mode: 60 Hz ticks the end card stays up if the bot ever fails (~6 s). */
export const KIOSK_OVER_TICKS = 360
/** Kiosk mode: the last level played; its montage ends the loop. */
export const KIOSK_LAST_LEVEL = 3

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
  /** The date of the run being played back; null during live play. */
  playbackDate: string | null
  /** The playback speed while watching a run; null in live play. */
  playbackSpeed: PlaybackSpeed | null
  /** Whether the game is playing itself (kiosk mode). */
  kiosk: boolean
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
  /** Everything the outside world has fed this run. */
  tape: Tape
  /** Whether a recorded tape is being played back instead of live play. */
  playback = false
  /** Whether the game plays itself (booth kiosk mode): seeded world, bot inputs, nothing stored. */
  kiosk = false
  private speed: PlaybackSpeed = 1

  private source: Source
  private player: TapePlayer | null = null
  private liveTick = 0
  private inputCursor = 0
  private restartCursor = 0
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
  private readonly bot: KioskBot
  /** Kiosk: whether this loop's level-2 orb was taken (the bot takes exactly one, for the boss). */
  private kioskOrbTaken = false
  /** Kiosk: frames the current card has been up. */
  private kioskWait = 0

  get liveTicks(): number {
    return this.liveTick
  }

  constructor(private readonly deps: GameDeps) {
    this.levels = deps.levels ?? LEVELS
    this.chaos = new ChaosScheduler(() => this.source.chaos(), this.levels)
    this.bot = new KioskBot(this.levels)
    this.best = deps.store.loadBest()
    this.runDate = deps.today()
    this.tape = emptyTape(this.runDate)
    this.source = new TapeRecorder(this.tape, deps)
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
      playbackDate: this.playback ? this.runDate : null,
      playbackSpeed: this.playback ? this.speed : null,
      kiosk: this.kiosk,
    }
  }

  command(c: Command): void {
    // The page stops kiosk mode before it sends commands; anything that slips through is ignored.
    if (this.kiosk) return
    if (c === 'slideStart') this.slideHeld = true
    else if (c === 'slideEnd') this.slideHeld = false
    if (this.playback) {
      if (c === 'confirm' && this.phase.kind === 'over') {
        this.newRun()
        return
      }
      if (c === 'cancel' && this.phase.kind !== 'paused') {
        this.leavePlayback()
        this.setPhase({ kind: 'title' })
        return
      }
      const unpause = c === 'confirm' && this.phase.kind === 'paused'
      if (c !== 'pause' && c !== 'cancel' && !unpause) return
    }
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
        if (c === 'confirm') this.confirm()
        return
      case 'montage':
        if (c === 'confirm') this.endMontage()
        return
      case 'lost':
        if (c === 'confirm') this.confirm()
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
  /** Called once per animation frame; a playback at N× runs N frame steps. */
  frame(liveTicks: number): void {
    const steps = this.playback ? this.playbackSpeed : 1
    for (let i = 0; i < steps; i++) this.frameStep(liveTicks)
  }

  /** Watching a run: how many frame steps each animation frame runs (1× in live play). */
  get playbackSpeed(): PlaybackSpeed {
    return this.playback ? this.speed : 1
  }

  /** Sets the playback speed; ignored outside playback and for unsupported values. */
  setPlaybackSpeed(speed: number): void {
    if (!this.playback || !PLAYBACK_SPEEDS.includes(speed as PlaybackSpeed)) return
    this.speed = speed as PlaybackSpeed
    this.touch()
  }

  private frameStep(liveTicks: number): void {
    if (this.kiosk) this.kioskStep(liveTicks)
    if (this.playback) this.autoplay()
    const p = this.phase
    if (p.kind === 'playing') {
      for (let i = 0; i < liveTicks && this.phase.kind === 'playing' && !this.restartDue(); i++) this.tick()
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
    if (this.playback && this.source.exhausted && this.phase.kind !== 'over') this.gameOver('Run code ended early')
  }

  /** Playback confirms cards by itself and repeats the recorded tab-close resumes. */
  private autoplay(): void {
    const k = this.phase.kind
    if (k === 'tip' || k === 'lost') this.confirm()
    const r = this.tape.restarts[this.restartCursor]
    if (r && r.liveTick === this.liveTick && this.player && k !== 'over' && k !== 'title') {
      this.restartCursor += 1
      this.player.seek(r.impureAt, r.chaosAt)
      this.restoreSave(structuredClone(r.save))
    }
  }

  /** Playback only: the next recorded resume is due now, so the next frame's autoplay must apply it before any more ticks. */
  private restartDue(): boolean {
    return this.playback && this.tape.restarts[this.restartCursor]?.liveTick === this.liveTick
  }

  /** Kiosk: cards confirm themselves after a dwell, and the loop starts over after level 3 or a failure. */
  private kioskStep(liveTicks: number): void {
    const p = this.phase
    if (p.kind === 'tip' && p.level > KIOSK_LAST_LEVEL) this.startKioskRun()
    else if (p.kind === 'tip' || p.kind === 'lost') {
      if ((this.kioskWait += liveTicks) >= KIOSK_CARD_TICKS) this.confirm()
    } else if (p.kind === 'over') {
      if ((this.kioskWait += liveTicks) >= KIOSK_OVER_TICKS) this.startKioskRun()
    }
  }

  /** Starts kiosk mode; false (and nothing changes) unless a title, end, pause or resume card is up and kiosk is not already running. */
  startKiosk(): boolean {
    if (this.kiosk) return false
    const k = this.phase.kind
    if (k !== 'title' && k !== 'over' && k !== 'paused' && k !== 'resume') return false
    // The one store write of kiosk mode: an interrupted run would otherwise be offered later.
    this.deps.store.clear()
    this.savedRun = null
    this.leavePlayback()
    this.kiosk = true
    this.startKioskRun()
    return true
  }

  /** A fresh kiosk loop: same seed, freshly seeded world, so every loop is the same show. */
  private startKioskRun(): void {
    this.source = new KioskSource(KIOSK_SEED)
    this.bot.reset()
    // Never written in kiosk mode; it only keeps `tape` meaningful for the page.
    this.tape = emptyTape(this.runDate)
    this.kioskOrbTaken = false
    this.slideHeld = false
    this.kioskWait = 0
    this.montage = null
    this.replayer = null
    this.startRun()
  }

  /** Leaves kiosk mode for the title card, with live mode's date, scores and tape restored. */
  stopKiosk(): void {
    if (!this.kiosk) return
    this.kiosk = false
    this.runDate = this.deps.today()
    this.best = this.deps.store.loadBest()
    this.dailyBest = this.deps.store.loadDailyBest(this.runDate)
    this.tape = emptyTape(this.runDate)
    this.source = new TapeRecorder(this.tape, this.deps)
    this.montage = null
    this.replayer = null
    this.notice = null
    this.divergedAt = null
    this.history = []
    this.segments = []
    this.orbValues = new Map()
    this.pending = []
    this.queued = []
    this.stats = emptyStats()
    this.liveTick = 0
    this.start = this.levelZero()
    this.state = initialState(this.start, this.levels)
    this.prevState = null
    this.setPhase({ kind: 'title' })
  }

  /** The run's seed: the kiosk constant, or today's daily seed. */
  private runSeed(): number {
    return this.kiosk ? KIOSK_SEED : seedForDate(this.runDate)
  }

  private levelZero(): StartInput {
    return { level: 0, seed: this.runSeed(), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[0].retries, shield: 0 }
  }

  /** Dismisses a tip or "Progress lost" card. */
  private confirm(): void {
    if (this.phase.kind === 'tip') {
      this.setPhase({ kind: 'playing' })
    } else if (this.phase.kind === 'lost') {
      this.stats = emptyStats()
      this.beginSegment({ level: 1, seed: seedFrom(this.runSeed()), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[1].retries, shield: 0 }, true)
      this.setNotice('Dapr Workflow enabled')
    }
  }

  /** Tab hidden or page left: pause a running game and persist it. */
  suspend(): void {
    if (this.kiosk) return
    if (this.phase.kind === 'playing') this.setPhase({ kind: 'paused' })
    this.save()
  }

  save(): void {
    if (this.playback || this.kiosk) return
    const k = this.phase.kind
    if (k === 'title' || k === 'resume' || k === 'over' || k === 'lost') return
    // A non-durable level keeps nothing: a save would promise a resume it can't deliver.
    if (!this.levels[this.start.level].durable) return
    const tick = k === 'crashing' || k === 'replaying' ? this.crashTick : this.state.tick
    this.deps.store.save({
      version: 2, date: this.runDate, start: this.start, history: this.history, tick, stats: this.stats, divergedAt: this.divergedAt,
      segments: this.segments, orbValues: [...this.orbValues], tape: this.tape,
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
    const L = this.liveTick++
    let pending: PlayerInput[]
    if (this.kiosk) {
      // The bot sees every live tick's state before the step, exactly once.
      pending = this.bot.inputs(this.state, this.state.level === 2 && !this.kioskOrbTaken)
    } else if (this.playback) {
      pending = []
      const ins = this.tape.inputs
      while (this.inputCursor < ins.length && ins[this.inputCursor][0] === L) pending.push(ins[this.inputCursor++][1])
    } else {
      pending = this.pending
      for (const kind of pending) this.tape.inputs.push([L, kind])
      this.tape.liveTick = this.liveTick
    }
    this.pending = []
    for (const kind of pending) {
      this.history.push({ type: 'Input', tick: t, kind })
      inputs.push(kind)
    }
    const calls: number[] = []
    const impure = () => {
      const v = this.source.impure()
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
      if (e.type === 'OrbTaken') {
        this.chaos.onPickup(state.level, 'orb', state.tick)
        if (this.kiosk) this.kioskOrbTaken = true
      }
      else if (e.type === 'ActivityCoinCollected' || e.type === 'ActivityCrateCollected') {
        this.stats.executed += 1
        if (e.type === 'ActivityCrateCollected') this.chaos.onPickup(state.level, 'crate', state.tick)
      } else if (e.type === 'CircuitBreakerTripped') this.stats.circuitTrips += 1
      else if (e.type === 'BoostLost') this.stats.boostsLost += 1
      else if (e.type === 'FanOut') this.setNotice(`fan-out · ${FAN_LANES} activities in parallel`)
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

  /** Back to live play: the tape's date and scores give way to today's. */
  private leavePlayback(): void {
    this.playback = false
    this.speed = 1
    this.player = null
    this.runDate = this.deps.today()
    this.dailyBest = this.deps.store.loadDailyBest(this.runDate)
  }

  private newRun(): void {
    this.leavePlayback()
    this.tape = emptyTape(this.runDate)
    this.source = new TapeRecorder(this.tape, this.deps)
    this.deps.store.clear()
    this.startRun()
  }

  /** Plays a recorded run back. Returns false (and changes nothing) for a malformed tape. */
  watch(tape: Tape): boolean {
    if (!isTape(tape)) return false
    this.playback = true
    this.runDate = tape.date
    this.tape = tape
    this.player = new TapePlayer(tape)
    this.source = this.player
    this.startRun()
    return true
  }

  private startRun(): void {
    this.stats = emptyStats()
    this.divergedAt = null
    this.segments = []
    this.liveTick = 0
    this.inputCursor = 0
    this.restartCursor = 0
    this.beginSegment(this.levelZero(), true)
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
    // Only durable, finite levels end in a montage; elsewhere segments would pile up unused.
    const cfg = this.levels[this.start.level]
    if (!cfg.durable || !Number.isFinite(cfg.length)) return
    this.segments.push({ start: this.start, history: [...this.history], endTick, orbValues: [...this.orbValues] })
  }

  private endMontage(): void {
    this.montage = null
    // The kiosk loop: level 3's montage leads straight back to level 0, never to the level-4 tip.
    if (this.kiosk && this.start.level > KIOSK_LAST_LEVEL) {
      this.startKioskRun()
      return
    }
    this.setPhase({ kind: 'tip', level: this.start.level })
  }

  private crash(): void {
    this.crashTick = this.state.tick
    this.setPhase({ kind: 'crashing', framesLeft: CRASH_FRAMES })
    this.save()
  }

  private startReplay(): void {
    if (!this.levels[this.start.level].durable) {
      if (!this.playback && !this.kiosk) this.deps.store.clear()
      this.setPhase({ kind: 'lost' })
      return
    }
    this.stats.replays += 1
    this.replayer = createReplayer(this.start, this.history, this.crashTick, () => this.source.impure(), this.levels)
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

  /** The process restarted on a saved history: rebuild it by replay, then resume. */
  private restartFromHistory(tick: number): void {
    this.montage = null
    this.crashTick = tick
    this.pending = []
    this.queued = []
    this.notice = null
    this.chaos.start(this.start.level, false, this.start.elapsed)
    this.startReplay()
  }

  /** Restores a saved run's fields and rebuilds it by replay; shared by live resumes and their playback. */
  private restoreSave(save: SaveBody): void {
    this.start = save.start
    this.history = save.history
    this.stats = save.stats
    this.divergedAt = save.divergedAt
    this.segments = save.segments
    this.orbValues = new Map(save.orbValues)
    this.runDate = save.date
    // Playback reads no storage; its dailyBest stays as it was.
    if (!this.playback) this.dailyBest = this.deps.store.loadDailyBest(save.date)
    this.restartFromHistory(save.tick)
  }

  private resumeSaved(save: Save): void {
    this.savedRun = null
    const { tape, ...body } = save
    this.tape = tape
    this.liveTick = tape.liveTick
    this.source = new TapeRecorder(tape, this.deps)
    tape.restarts.push({ liveTick: this.liveTick, impureAt: tape.impure.length, chaosAt: tape.chaos.length, save: structuredClone(body) })
    this.restoreSave(body)
  }

  private gameOver(reason: string): void {
    if (!this.playback && !this.kiosk) {
      this.deps.store.clear()
      if (this.state.score > this.best) {
        this.best = this.state.score
        this.deps.store.saveBest(this.best)
      }
      // A resumed run from an earlier UTC day must not touch today's slot.
      if (this.runDate === this.deps.today() && this.state.score > this.dailyBest) {
        this.dailyBest = this.state.score
        this.deps.store.saveDailyBest(this.runDate, this.dailyBest)
      }
    }
    this.setPhase({ kind: 'over', reason })
  }

  private setNotice(text: string): void {
    this.notice = { text, untilTick: this.state.tick + NOTICE_TICKS }
    this.touch()
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    if (this.kiosk) {
      this.kioskWait = 0
      if (phase.kind !== 'playing') this.bot.reset()
    }
    if (phase.kind === 'playing') this.syncSlide()
    this.touch()
  }

  /**
   * On (re)entering play, queue the slide input that matches the key as it is
   * now: a release (or press) that happened while input was ignored is then
   * recorded at the next tick like any other input, so replay stays exact.
   */
  private syncSlide(): void {
    // The bot re-derives slides from the state; no key is held in kiosk mode.
    if (this.kiosk) return
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
