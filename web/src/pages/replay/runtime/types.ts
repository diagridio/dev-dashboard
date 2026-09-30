import type { HistoryEvent, Level, StartInput } from '../engine/types'

export interface RunStats {
  /** Crash recoveries (and resumes) that replayed history. */
  replays: number
  /** Activities served from history during replays. */
  fromHistory: number
  /** Activities actually executed in live play. */
  executed: number
  /** Non-determinism incidents (boss phases). */
  incidents: number
  /** RetryPolicy attempts spent (rewinds). */
  retriesUsed: number
  /** Hits absorbed by the circuit breaker. */
  circuitTrips: number
  /** Hits absorbed by losing the ×3 boost. */
  boostsLost: number
}

export type Phase =
  | { kind: 'title' }
  | { kind: 'resume'; tick: number }
  | { kind: 'tip'; level: Level }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'crashing'; framesLeft: number }
  | { kind: 'replaying' }
  | { kind: 'lost' }
  | { kind: 'over'; reason: string }

export type Command = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd' | 'pause' | 'confirm' | 'cancel'

export interface Save {
  version: 2
  start: StartInput
  history: HistoryEvent[]
  /** The tick to replay to on resume. */
  tick: number
  stats: RunStats
  divergedAt: number | null
}
