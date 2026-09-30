import type { Entity, EntityKind, GameState, Player } from './types'

const KIND: Record<EntityKind, number> = { low: 1, high: 2, coin: 3, orb: 4, crate: 5, tall: 6, falling: 7, pit: 8, fanout: 9 }
const STATUS: Record<GameState['status'], number> = { running: 0, failed: 1, levelDone: 2, retry: 3 }

/** Quantises a float so equal-by-simulation values hash identically. */
function q(n: number): number {
  return Math.round(n * 100)
}

function pushPlayer(parts: number[], p: Player): void {
  parts.push(q(p.y), q(p.vy), p.sliding ? 1 : 0, p.jumpHeld ? 1 : 0, p.coyoteUntil, p.jumpBufferUntil)
}

function pushEntities(parts: number[], entities: readonly Entity[]): void {
  parts.push(entities.length)
  for (const e of entities) parts.push(e.id, KIND[e.kind], q(e.x), q(e.y), q(e.vy ?? 0), e.taken ? 1 : 0)
}

/** FNV-1a over a canonical serialisation of the state. Recorded with each event. */
export function hashState(s: GameState): number {
  const parts: number[] = [s.level, s.tick, s.elapsed, s.rng, q(s.score), s.multiplier, s.multUntil]
  pushPlayer(parts, s.player)
  parts.push(
    q(s.scroll), q(s.distance), q(s.nextSpawnAt), s.nextId, s.bossUntil, STATUS[s.status],
    s.retries, s.shield, s.graceUntil, s.failedAt,
    // Infinity (no gate) folds to 0 through `| 0`, which is stable.
    q(s.nextGateAt),
  )
  pushEntities(parts, s.entities)
  if (s.fan) {
    parts.push(1, s.fan.until, s.fan.lanes.length)
    for (const lane of s.fan.lanes) {
      pushPlayer(parts, lane.player)
      parts.push(q(lane.nextSpawnAt), lane.coins)
      pushEntities(parts, lane.entities)
    }
  } else {
    parts.push(0)
  }
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
