import type { EntityKind, Level } from './types'

export interface LevelConfig {
  name: string
  /** Scroll distance (px) that completes the level; Infinity for endless. */
  length: number
  /** px per tick at the start of the level. */
  speed: number
  /** Extra px per tick for every 60 s spent in the level. */
  ramp: number
  maxSpeed: number
  weights: Partial<Record<EntityKind, number>>
  /** What the NonDeterministicError boss phase spawns. */
  bossWeights: Partial<Record<EntityKind, number>>
  /** What each of the three fan-out lanes spawns (they are drawn at half height). */
  laneWeights: Partial<Record<EntityKind, number>>
  /** false: a crash loses everything (level 0). */
  durable: boolean
  /** Mean ticks between chaos crashes; null for no random chaos. */
  chaosMeanTicks: number | null
  /** Lower bound the mean shrinks toward with elapsed time (level 5). */
  chaosFloorTicks?: number
  /** Window for the first crash of the level, so the lesson always shows. */
  firstCrashTicks?: readonly [number, number]
  /** A fixed crash tick (level 0). */
  scriptedCrashAt?: number
  /** Pickups that guarantee a crash CRASH_AFTER_PICKUP ticks later. */
  crashAfterPickup?: readonly EntityKind[]
  /** RetryPolicy attempts per level; 0 = a hit fails the run (unless another layer absorbs it). */
  retries: number
  /** Coins charge a circuit breaker that absorbs one hit. */
  shieldEnabled: boolean
  /** Fan-out gates every `everyPx` of distance; the lanes run for `ticks`. */
  fanOut?: { everyPx: number; ticks: number }
  tip: { body: string }
}

export type LevelTable = Record<Level, LevelConfig>

/** A listed pickup forces a crash this many ticks later (1–5 s). */
export const CRASH_AFTER_PICKUP: readonly [number, number] = [60, 300]

const BOSS: LevelConfig['bossWeights'] = { low: 3, high: 3 }
const LANES: LevelConfig['laneWeights'] = { low: 2, pit: 2, coin: 4 }

export const LEVELS: LevelTable = {
  0: {
    name: 'No Safety Net',
    length: Number.POSITIVE_INFINITY, speed: 3, ramp: 0, maxSpeed: 3,
    weights: { low: 2, coin: 3 }, bossWeights: BOSS, laneWeights: LANES,
    durable: false, chaosMeanTicks: null, scriptedCrashAt: 900,
    retries: 0, shieldEnabled: false,
    tip: {
      body: 'Your workflow keeps its progress in memory. Collect activity coins and see what happens when the process dies.',
    },
  },
  1: {
    name: 'Replay',
    length: 6300, speed: 3.5, ramp: 0, maxSpeed: 3.5,
    weights: { low: 3, high: 2, coin: 4, pit: 2 }, bossWeights: BOSS, laneWeights: LANES,
    durable: true, chaosMeanTicks: 1200, firstCrashTicks: [480, 720],
    retries: 3, shieldEnabled: true,
    tip: {
      body: 'Dapr Workflow is enabled. Every step is written to history. After a crash the workflow replays that history to rebuild its state, and completed activities are not run again. Hitting a rack is a failed activity: your RetryPolicy rewinds and tries again, 3 attempts per level. Every 10 coins arm a circuit breaker that lets you barge through one rack.',
    },
  },
  2: {
    name: 'Temptation',
    length: 8000, speed: 4, ramp: 0, maxSpeed: 4,
    weights: { low: 3, high: 2, coin: 3, orb: 2, pit: 1, falling: 2 }, bossWeights: BOSS, laneWeights: LANES,
    durable: true, chaosMeanTicks: 1200, crashAfterPickup: ['orb'],
    retries: 3, shieldEnabled: true,
    tip: {
      body: 'Workflow code must be deterministic: on replay it has to make exactly the same decisions. The purple orbs are Math.random(), Date.now() and fetch() called straight from workflow code, so avoid them. They look tempting with a ×3 boost, but replay gets a different answer.',
    },
  },
  3: {
    name: 'Wrap It',
    length: 9000, speed: 4.5, ramp: 0, maxSpeed: 4.5,
    weights: { low: 2, high: 2, coin: 3, orb: 1, crate: 2, pit: 1, falling: 1, tall: 2 }, bossWeights: BOSS, laneWeights: LANES,
    durable: true, chaosMeanTicks: 1200, crashAfterPickup: ['orb', 'crate'],
    retries: 3, shieldEnabled: true,
    tip: {
      body: 'Crates give the same boost through callActivity(). The activity result is saved to history, so replay reads it back instead of calling it again.',
    },
  },
  4: {
    name: 'Fan Out',
    length: 9000, speed: 4.5, ramp: 0, maxSpeed: 4.5,
    weights: { low: 2, high: 2, coin: 3, crate: 1, pit: 2, falling: 1, tall: 1 }, bossWeights: BOSS, laneWeights: LANES,
    durable: true, chaosMeanTicks: 1200, retries: 3, shieldEnabled: true,
    fanOut: { everyPx: 2500, ticks: 600 },
    tip: {
      body: 'Fan-out: the workflow calls three activities in parallel. Your hat splits into three lanes that all follow your keys, and WhenAll merges them again. If any lane hits a rack the whole workflow takes the hit, just like WhenAll fails when one task fails.',
    },
  },
  5: {
    name: 'Production',
    length: Number.POSITIVE_INFINITY, speed: 5, ramp: 0.5, maxSpeed: 9,
    weights: { low: 2, high: 2, coin: 3, orb: 1, crate: 1, pit: 2, falling: 1, tall: 1 }, bossWeights: BOSS, laneWeights: LANES,
    durable: true, chaosMeanTicks: 1200, chaosFloorTicks: 480,
    retries: 3, shieldEnabled: true,
    fanOut: { everyPx: 4000, ticks: 600 },
    tip: {
      body: 'Everything at once, faster, with more chaos. How far can your workflow get?',
    },
  },
}

export function speedAt(cfg: LevelConfig, elapsed: number): number {
  return Math.min(cfg.maxSpeed, cfg.speed + cfg.ramp * (elapsed / 3600))
}

export function chaosMeanTicks(cfg: LevelConfig, elapsed: number): number | null {
  if (cfg.chaosMeanTicks === null) return null
  if (cfg.chaosFloorTicks === undefined) return cfg.chaosMeanTicks
  return Math.max(cfg.chaosFloorTicks, cfg.chaosMeanTicks - elapsed / 10)
}
