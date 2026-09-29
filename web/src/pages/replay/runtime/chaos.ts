import { CRASH_AFTER_PICKUP, LEVELS, chaosMeanTicks, type LevelTable } from '../engine/levels'
import type { EntityKind, Level } from '../engine/types'

/**
 * Decides when the "process" dies. Chaos is the outside world, so this uses
 * real randomness on purpose; crashes are never part of the history.
 */
export class ChaosScheduler {
  private dueAt: number | null = null

  constructor(
    private readonly rand: () => number,
    private readonly levels: LevelTable = LEVELS,
  ) {}

  get nextCrashAt(): number | null {
    return this.dueAt
  }

  /** Called at tick 0 of every segment. */
  start(level: Level, firstOfLevel: boolean): void {
    const cfg = this.levels[level]
    if (cfg.scriptedCrashAt !== undefined) this.dueAt = cfg.scriptedCrashAt
    else if (firstOfLevel && cfg.firstCrashTicks) this.dueAt = this.between(cfg.firstCrashTicks)
    else this.scheduleNext(level, 0, 0)
  }

  scheduleNext(level: Level, tick: number, elapsed: number): void {
    const mean = chaosMeanTicks(this.levels[level], elapsed)
    this.dueAt = mean === null ? null : tick + Math.round(mean * (0.5 + this.rand()))
  }

  onPickup(level: Level, kind: EntityKind, tick: number): void {
    if (!this.levels[level].crashAfterPickup?.includes(kind)) return
    const at = tick + this.between(CRASH_AFTER_PICKUP)
    if (this.dueAt === null || at < this.dueAt) this.dueAt = at
  }

  isDue(tick: number): boolean {
    return this.dueAt !== null && tick >= this.dueAt
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + Math.round(this.rand() * (hi - lo))
  }
}
