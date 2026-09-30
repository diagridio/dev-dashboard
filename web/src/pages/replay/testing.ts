// Shared helpers for REPLAY tests. Not imported by production code.
import type { LevelConfig, LevelTable } from './engine/levels'
import { PLAYER_H, PLAYER_W } from './engine/step'
import { GROUND_Y, PLAYER_X, type EntityKind, type GameState, type Level, type PlayerInput } from './engine/types'

const BASE: LevelConfig = {
  name: 'Test',
  length: Number.POSITIVE_INFINITY, speed: 4, ramp: 0, maxSpeed: 4,
  weights: { coin: 1 }, bossWeights: { coin: 1 },
  durable: true, chaosMeanTicks: null,
  retries: 0, shieldEnabled: false,
  tip: { body: 'Test level' },
}

/** A level table where every level is BASE + overrides + its own perLevel patch. */
export function makeLevels(
  overrides: Partial<LevelConfig> = {},
  perLevel: Partial<Record<Level, Partial<LevelConfig>>> = {},
): LevelTable {
  const lv = (l: Level): LevelConfig => ({ ...BASE, ...overrides, ...perLevel[l] })
  return { 0: lv(0), 1: lv(1), 2: lv(2), 3: lv(3), 4: lv(4) }
}

/** A deterministic "impure" source that returns a different value on every call. */
export function counter(): () => number {
  let i = 0
  return () => ((++i) * 0.37) % 1
}

/**
 * Jumps when a wanted pickup that is out of standing reach is 0–24 px ahead.
 * With speed 4 and JUMP_VY -9 that reaches pickups 48–70 px above the ground;
 * low coins are collected by running through them, so it doesn't jump for those.
 */
export function autopilot(state: GameState, want: readonly EntityKind[]): PlayerInput[] {
  if (state.player.y < GROUND_Y) return []
  const ahead = state.entities.some((e) => {
    const gap = e.x - (PLAYER_X + PLAYER_W)
    const overhead = e.y + e.h <= GROUND_Y - PLAYER_H
    return !e.taken && overhead && want.includes(e.kind) && gap > 0 && gap <= 24
  })
  return ahead ? ['jump'] : []
}
