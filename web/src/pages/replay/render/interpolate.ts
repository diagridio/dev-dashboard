import type { Entity, GameState } from '../engine/types'

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * Display-only state between two consecutive ticks. Scroll, the player's height
 * and the x of entities present in both ticks move by `alpha`; everything else
 * (and all collision state) is the current tick's. Pure; never mutates its inputs.
 */
export function blend(prev: GameState | null, curr: GameState, alpha: number): GameState {
  if (!prev || alpha <= 0) return curr
  const before = new Map<number, Entity>()
  for (const e of prev.entities) before.set(e.id, e)
  return {
    ...curr,
    scroll: lerp(prev.scroll, curr.scroll, alpha),
    player: { ...curr.player, y: lerp(prev.player.y, curr.player.y, alpha) },
    entities: curr.entities.map((e) => {
      const p = before.get(e.id)
      return p ? { ...e, x: lerp(p.x, e.x, alpha) } : e
    }),
  }
}
