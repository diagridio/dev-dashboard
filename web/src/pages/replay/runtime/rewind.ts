import { HAZARDS, PLAYER_W } from '../engine/step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState, type Player } from '../engine/types'

/** How many recent states the rewind can reach back to (3 s). */
export const REWIND_BUFFER_TICKS = 180
/** A retry rewinds at least this far (half a screen). */
export const REWIND_PX = 240
/** Frames the rewind effect takes. */
export const REWIND_FRAMES = 30

const SAFE_BEHIND = 10
const SAFE_AHEAD = 120

export function hatSafe(p: Player, entities: readonly Entity[]): boolean {
  if (p.y !== GROUND_Y || p.vy !== 0) return false
  const lo = PLAYER_X - SAFE_BEHIND
  const hi = PLAYER_X + PLAYER_W + SAFE_AHEAD
  return !entities.some((e) => HAZARDS.has(e.kind) && !e.taken && e.x < hi && e.x + e.w > lo)
}

/** The hat stands on solid ground with no hazard close by: a fair place to try again. */
export function isSafe(s: GameState): boolean {
  return hatSafe(s.player, s.entities)
}

/** Recent states of the current segment, for the RetryPolicy rewind. */
export class RewindBuffer {
  private anchor: GameState | null = null
  private ring: GameState[] = []
  private wrapped = false

  /** Starts a segment: its tick-0 state is the fallback until the ring wraps. */
  reset(anchor: GameState): void {
    this.anchor = anchor
    this.ring = []
    this.wrapped = false
  }

  push(s: GameState): void {
    this.ring.push(s)
    if (this.ring.length > REWIND_BUFFER_TICKS) {
      this.ring.shift()
      this.wrapped = true
    }
  }

  private all(): GameState[] {
    return this.wrapped || !this.anchor ? this.ring : [this.anchor, ...this.ring]
  }

  /**
   * The latest safe state at least `minBack` ticks before the hit and not before
   * `floor` (the tick after the last retry, so a rewind can't undo one). If none is
   * safe, the oldest such candidate; if there is none at all, the newest state.
   */
  pick(failedAt: number, minBack: number, floor: number): GameState {
    const all = this.all()
    const candidates = all.filter((s) => s.tick >= floor)
    const limit = failedAt - minBack
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].tick <= limit && isSafe(candidates[i])) return candidates[i]
    }
    const fallback = candidates[0] ?? all[all.length - 1]
    if (!fallback) throw new Error('rewind buffer is empty')
    return fallback
  }

  between(from: number, to: number): GameState[] {
    return this.all().filter((s) => s.tick >= from && s.tick <= to)
  }

  dropAfter(tick: number): void {
    this.ring = this.ring.filter((s) => s.tick <= tick)
  }
}

/** Up to n items spread evenly over `items`, keeping the first and last. */
export function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items]
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))])
}
