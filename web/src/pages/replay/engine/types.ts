// Engine data model. Everything in engine/ is pure: the same state, inputs and
// port values always produce the same result (enforced by purity.test.ts).

export const TICK_HZ = 60
export const VIEW_W = 480
export const VIEW_H = 270
/** y of the ground line; the player's feet rest here. */
export const GROUND_Y = 230
/** Fixed screen x of the player's left edge. */
export const PLAYER_X = 80
/** Screen x where new entities appear (just off the right edge). */
export const SPAWN_X = 490

export type Level = 0 | 1 | 2 | 3 | 4
export type InputKind = 'jump' | 'slideStart' | 'slideEnd'
export type EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate'

export interface Entity {
  id: number
  kind: EntityKind
  /** Left edge, screen px. */
  x: number
  /** Top edge, screen px. */
  y: number
  w: number
  h: number
  taken: boolean
}

export interface Player {
  /** Feet position; GROUND_Y when standing. */
  y: number
  vy: number
  sliding: boolean
}

/** The input a history segment starts from (a new run, a level, continue-as-new). */
export interface StartInput {
  level: Level
  seed: number
  score: number
  /** Ticks already spent in this level, drives the level-4 speed ramp. */
  elapsed: number
  /** True when this segment is the NonDeterministicError boss phase. */
  boss: boolean
}

export interface GameState {
  level: Level
  /** Ticks since this segment's StartInput. */
  tick: number
  elapsed: number
  /** mulberry32 state (uint32). */
  rng: number
  score: number
  multiplier: number
  multUntil: number
  player: Player
  /** World distance travelled this segment, px. */
  scroll: number
  nextSpawnAt: number
  nextId: number
  entities: Entity[]
  /** Tick at which the boss phase ends; 0 when not in a boss phase. */
  bossUntil: number
  status: 'running' | 'failed' | 'levelDone'
}

export type HistoryEvent =
  | { type: 'Input'; tick: number; kind: InputKind }
  | { type: 'ActivityCompleted'; tick: number; id: number; hash: number; result?: number }
  | { type: 'OrbTaken'; tick: number; id: number; hash: number }

/** Events produced by step() itself (everything except recorded inputs). */
export type OutcomeEvent = Exclude<HistoryEvent, { type: 'Input' }>

/**
 * The only way non-determinism reaches the engine.
 * - impure(): an outside value (Math.random at runtime). Orbs use it unrecorded.
 * - crateValue(id): the activity result for a crate. Live play calls impure();
 *   replay reads the recorded result from history.
 */
export interface Ports {
  impure: () => number
  crateValue: (id: number) => number
}

export type ReplayResult =
  | { ok: true; state: GameState }
  | { ok: false; divergedAt: number; state: GameState }
