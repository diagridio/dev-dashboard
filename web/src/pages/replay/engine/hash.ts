import type { EntityKind, GameState } from './types'

const KIND: Record<EntityKind, number> = { low: 1, high: 2, coin: 3, orb: 4, crate: 5 }
const STATUS: Record<GameState['status'], number> = { running: 0, failed: 1, levelDone: 2 }

/** Quantises a float so equal-by-simulation values hash identically. */
function q(n: number): number {
  return Math.round(n * 100)
}

/** FNV-1a over a canonical serialisation of the state. Recorded with each event. */
export function hashState(s: GameState): number {
  const parts: number[] = [
    s.level, s.tick, s.elapsed, s.rng, q(s.score), s.multiplier, s.multUntil,
    q(s.player.y), q(s.player.vy), s.player.sliding ? 1 : 0,
    q(s.scroll), q(s.distance), q(s.nextSpawnAt), s.nextId, s.bossUntil, STATUS[s.status], s.entities.length,
  ]
  for (const e of s.entities) parts.push(e.id, KIND[e.kind], q(e.x), q(e.y), e.taken ? 1 : 0)
  let h = 0x811c9dc5
  for (const p of parts) {
    const v = p | 0
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (i * 8)) & 0xff
      h = Math.imul(h, 0x01000193)
    }
  }
  return h >>> 0
}
