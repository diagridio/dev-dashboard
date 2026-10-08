import { isTape } from './tape'
import type { Save } from './types'
import { isDate, isNum, isObj, isSaveBody } from './validate'

export const SAVE_KEY = 'devdash.replay.save'
export const BEST_KEY = 'devdash.replay.best'
export const DAILY_KEY = 'devdash.replay.daily'
export const SAVE_VERSION = 2

export interface SaveStore {
  loadDailyBest(date: string): number
  saveDailyBest(date: string, score: number): void
  load(): Save | null
  save(save: Save): void
  clear(): void
  loadBest(): number
  saveBest(score: number): void
}

export { isDate }

export function isSave(v: unknown): v is Save {
  return isSaveBody(v) && isTape((v as Record<string, unknown>).tape)
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
    loadDailyBest: (date) =>
      attempt((s) => {
        const data: unknown = JSON.parse(s.getItem(DAILY_KEY) ?? 'null')
        return isObj(data) && data.date === date && isNum(data.best) && data.best > 0 ? Math.floor(data.best) : 0
      }, 0),
    saveDailyBest: (date, score) => attempt((s) => s.setItem(DAILY_KEY, JSON.stringify({ date, best: score })), undefined),
  }
}
