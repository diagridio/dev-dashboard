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
/** Keys the player presses. */
export type PlayerInput = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd'
/** Everything step() accepts as an input. */
export type InputKind = PlayerInput | 'resume' | 'retry'
export type EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate' | 'tall' | 'falling' | 'pit'

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
  /** Vertical speed; only falling racks move vertically. */
  vy?: number
}

export interface Player {
  /** Feet position; GROUND_Y when standing. */
  y: number
  vy: number
  sliding: boolean
  /** A jump key is down: releasing it early cuts the jump short. */
  jumpHeld: boolean
  /** The player can still jump while tick < coyoteUntil after walking off an edge. */
  coyoteUntil: number
  /** A jump pressed in the air fires on landing while tick < jumpBufferUntil. */
  jumpBufferUntil: number
}

/** The input a history segment starts from (a new run, a level, continue-as-new). */
export interface StartInput {
  level: Level
  seed: number
  score: number
  /** Ticks already spent in this level, drives the level-4 speed ramp. */
  elapsed: number
  /** Distance (px) already travelled in this level by earlier segments. */
  distance: number
  /** True when this segment is the NonDeterministicError boss phase. */
  boss: boolean
  /** RetryPolicy attempts left in this level. */
  retries: number
  /** Circuit-breaker charge (coins), 0..SHIELD_FULL. */
  shield: number
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
  /** Distance travelled in this level before this segment, px. The level ends at distance + scroll. */
  distance: number
  nextSpawnAt: number
  nextId: number
  entities: Entity[]
  /** Tick at which the boss phase ends; 0 when not in a boss phase. */
  bossUntil: number
  /** RetryPolicy attempts left in this level. */
  retries: number
  /** Circuit-breaker charge, 0..SHIELD_FULL. */
  shield: number
  /** Hits are ignored while tick < graceUntil. */
  graceUntil: number
  /** Tick of the hit that set status 'retry'; 0 otherwise. */
  failedAt: number
  status: 'running' | 'failed' | 'levelDone' | 'retry'
}

export type HistoryEvent =
  | { type: 'Input'; tick: number; kind: PlayerInput }
  /** Recorded by the runtime whenever a replay resumes live play (grants grace). */
  | { type: 'OrchestratorStarted'; tick: number }
  /** Recorded by the runtime after a retry rewind (spends a retry, grants grace). */
  | { type: 'RetryAttempt'; tick: number; attempt: number; failedAt: number }
  | { type: 'ActivityCoinCollected'; tick: number; id: number; hash: number }
  | { type: 'ActivityCrateCollected'; tick: number; id: number; hash: number; result: number }
  | { type: 'OrbTaken'; tick: number; id: number; hash: number }
  /** id is the smashed rack, or 0 for a pit. */
  | { type: 'CircuitBreakerTripped'; tick: number; id: number; hash: number }
  | { type: 'BoostLost'; tick: number; id: number; hash: number }

/** History events that are fed back to step() as inputs. */
export type InputEvent = Extract<HistoryEvent, { type: 'Input' | 'OrchestratorStarted' | 'RetryAttempt' }>
/** Events produced by step() itself; replay checks each one. */
export type OutcomeEvent = Exclude<HistoryEvent, InputEvent>

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
