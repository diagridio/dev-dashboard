import type { HistoryEvent, StartInput } from '../engine/types'
import type { RunStats, Save } from './types'

export const SAVE_KEY = 'devdash.replay.save'
export const BEST_KEY = 'devdash.replay.best'
export const SAVE_VERSION = 1

export interface SaveStore {
  load(): Save | null
  save(save: Save): void
  clear(): void
  loadBest(): number
  saveBest(score: number): void
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isStart(v: unknown): v is StartInput {
  return (
    isObj(v) && [0, 1, 2, 3, 4].includes(v.level as number) &&
    isNum(v.seed) && isNum(v.score) && isNum(v.elapsed) && isNum(v.distance) && typeof v.boss === 'boolean'
  )
}

function isEvent(v: unknown): v is HistoryEvent {
  if (!isObj(v) || !isNum(v.tick) || v.tick < 0) return false
  switch (v.type) {
    case 'Input': return v.kind === 'jump' || v.kind === 'slideStart' || v.kind === 'slideEnd'
    case 'OrbTaken': return isNum(v.id) && isNum(v.hash)
    case 'ActivityCoinCollected': return isNum(v.id) && isNum(v.hash)
    case 'ActivityCrateCollected': return isNum(v.id) && isNum(v.hash) && isNum(v.result)
    default: return false
  }
}

function isStats(v: unknown): v is RunStats {
  return isObj(v) && isNum(v.replays) && isNum(v.fromHistory) && isNum(v.executed) && isNum(v.incidents)
}

export function isSave(v: unknown): v is Save {
  if (!isObj(v) || v.version !== SAVE_VERSION || !isStart(v.start) || !isStats(v.stats)) return false
  if (!isNum(v.tick) || v.tick < 0) return false
  if (!(v.divergedAt === null || isNum(v.divergedAt))) return false
  if (!Array.isArray(v.history) || !v.history.every(isEvent)) return false
  const history = v.history as HistoryEvent[]
  // Ordered by tick, and every event happened before the tick we replay to.
  return history.every((e, i) => (i === 0 || history[i - 1].tick <= e.tick) && e.tick < (v.tick as number))
}

export function parseSave(raw: string | null): Save | null {
  if (!raw) return null
  try {
    const data: unknown = JSON.parse(raw)
    return isSave(data) ? data : null
  } catch {
    return null
  }
}

/** localStorage-backed store. Every access is guarded: the game runs without storage. */
export function localSaveStore(storage: () => Storage = () => localStorage): SaveStore {
  function attempt<T>(fn: (s: Storage) => T, fallback: T): T {
    try {
      return fn(storage())
    } catch {
      return fallback
    }
  }
  return {
    load: () => attempt((s) => parseSave(s.getItem(SAVE_KEY)), null),
    save: (save) => attempt((s) => s.setItem(SAVE_KEY, JSON.stringify(save)), undefined),
    clear: () => attempt((s) => s.removeItem(SAVE_KEY), undefined),
    loadBest: () =>
      attempt((s) => {
        const n = Number(s.getItem(BEST_KEY))
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
      }, 0),
    saveBest: (score) => attempt((s) => s.setItem(BEST_KEY, String(score)), undefined),
  }
}
