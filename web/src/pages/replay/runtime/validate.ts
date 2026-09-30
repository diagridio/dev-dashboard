import { isInputEvent } from '../engine/replay'
import type { HistoryEvent, StartInput } from '../engine/types'
import type { MontageSegment } from './montage'
import type { RunStats, SaveBody } from './types'

export type Obj = Record<string, unknown>
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
export const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)

function isStart(v: unknown): v is StartInput {
  return (
    isObj(v) && [0, 1, 2, 3, 4, 5].includes(v.level as number) &&
    isNum(v.seed) && isNum(v.score) && isNum(v.elapsed) && isNum(v.distance) && typeof v.boss === 'boolean' &&
    isNum(v.retries) && v.retries >= 0 && isNum(v.shield) && v.shield >= 0
  )
}

function isEvent(v: unknown): v is HistoryEvent {
  if (!isObj(v) || !isNum(v.tick) || v.tick < 0) return false
  switch (v.type) {
    case 'Input': return v.kind === 'jump' || v.kind === 'jumpEnd' || v.kind === 'slideStart' || v.kind === 'slideEnd'
    case 'OrchestratorStarted': return true
    case 'RetryAttempt': return isNum(v.attempt) && isNum(v.failedAt)
    case 'CircuitBreakerTripped':
    case 'BoostLost':
      return isNum(v.id) && isNum(v.hash)
    case 'FanOut': return isNum(v.hash)
    case 'FanIn': return isNum(v.hash) && Array.isArray(v.results) && v.results.every(isNum)
    case 'OrbTaken': return isNum(v.id) && isNum(v.hash)
    case 'ActivityCoinCollected': return isNum(v.id) && isNum(v.hash)
    case 'ActivityCrateCollected': return isNum(v.id) && isNum(v.hash) && isNum(v.result)
    default: return false
  }
}

const STAT_KEYS = ['replays', 'fromHistory', 'executed', 'incidents', 'retriesUsed', 'circuitTrips', 'boostsLost'] as const

function isStats(v: unknown): v is RunStats {
  return isObj(v) && STAT_KEYS.every((k) => isNum(v[k]))
}

const isPairs = (v: unknown): v is [number, number][] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]))

function isSegment(v: unknown): v is MontageSegment {
  return isObj(v) && isStart(v.start) && Array.isArray(v.history) && v.history.every(isEvent) && isNum(v.endTick) && isPairs(v.orbValues)
}

/** Everything in a save except its tape. */
export function isSaveBody(v: unknown): v is SaveBody {
  if (!isObj(v) || v.version !== 2 || !isStart(v.start) || !isStats(v.stats)) return false
  if (!isDate(v.date)) return false
  if (!isNum(v.tick) || v.tick < 0) return false
  if (!(v.divergedAt === null || isNum(v.divergedAt))) return false
  if (!Array.isArray(v.history) || !v.history.every(isEvent)) return false
  if (!Array.isArray(v.segments) || !v.segments.every(isSegment) || !isPairs(v.orbValues)) return false
  const history = v.history as HistoryEvent[]
  // Ordered by tick; outcomes happened before the tick we replay to, runtime inputs may sit on it.
  const tick = v.tick as number
  return history.every((e, i) => (i === 0 || history[i - 1].tick <= e.tick) && (isInputEvent(e) ? e.tick <= tick : e.tick < tick))
}

