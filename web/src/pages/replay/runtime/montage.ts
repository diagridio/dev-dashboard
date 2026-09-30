import type { LevelTable } from '../engine/levels'
import { createReplayer, type Replayer } from '../engine/replay'
import type { GameState, HistoryEvent, StartInput } from '../engine/types'

/** Frames a whole level's montage aims for (~4 s). */
export const MONTAGE_FRAMES = 240
export const MONTAGE_MIN_TICKS_PER_FRAME = 8
/** Frames the continue-as-new flash lasts. */
export const FLASH_FRAMES = 8
/** Ghost positions kept for the trail. */
export const TRAIL = 6

/** One history segment of a level, with the orb values live play saw (never part of history). */
export interface MontageSegment {
  start: StartInput
  history: HistoryEvent[]
  endTick: number
  orbValues: [id: number, value: number][]
}

/**
 * Replays a level's segments back to back at high speed. Crate results come
 * from history as usual; orbs get the values live play saw, so the montage
 * shows what really happened. It reads nothing from the outside world.
 */
export class Montage {
  readonly events: number
  readonly ticksPerFrame: number
  flash = 0
  trail: number[] = []
  private index = 0
  private replayer: Replayer

  constructor(
    private readonly segments: readonly MontageSegment[],
    private readonly levels: LevelTable,
  ) {
    const ticks = segments.reduce((n, s) => n + s.endTick, 0)
    this.ticksPerFrame = Math.max(MONTAGE_MIN_TICKS_PER_FRAME, Math.ceil(ticks / MONTAGE_FRAMES))
    this.events = segments.reduce((n, s) => n + s.history.length, 0)
    this.replayer = this.open(0)
  }

  get state(): GameState {
    return this.replayer.state
  }

  get done(): boolean {
    return this.index >= this.segments.length
  }

  /** One frame of fast-forward. */
  advance(): void {
    if (this.done) return
    if (this.flash > 0) this.flash -= 1
    this.replayer.advance(this.ticksPerFrame)
    this.trail = [this.replayer.state.player.y, ...this.trail].slice(0, TRAIL)
    if (!this.replayer.done) return
    this.index += 1
    if (this.done) return
    this.replayer = this.open(this.index)
    this.flash = FLASH_FRAMES
    this.trail = []
  }

  private open(i: number): Replayer {
    const seg = this.segments[i]
    const values = new Map(seg.orbValues)
    const queue = seg.history.filter((e) => e.type === 'OrbTaken').map((e) => ('id' in e ? values.get(e.id) : undefined) ?? 0)
    return createReplayer(seg.start, seg.history, seg.endTick, () => queue.shift() ?? 0, this.levels)
  }
}
