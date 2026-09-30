import { beforeEach, describe, expect, it } from 'vitest'
import { BEST_KEY, DAILY_KEY, SAVE_KEY, localSaveStore, parseSave } from './persistence'
import { emptyTape } from './tape'
import type { Save } from './types'

const sample: Save = {
  version: 2,
  date: '2026-09-30',
  start: { level: 2, seed: 99, score: 5, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 },
  history: [
    { type: 'Input', tick: 3, kind: 'jump' },
    { type: 'Input', tick: 4, kind: 'jumpEnd' },
    { type: 'ActivityCoinCollected', tick: 10, id: 4, hash: 123 },
    { type: 'OrchestratorStarted', tick: 11 },
    { type: 'BoostLost', tick: 12, id: 7, hash: 1 },
    { type: 'CircuitBreakerTripped', tick: 13, id: 8, hash: 2 },
    { type: 'RetryAttempt', tick: 14, attempt: 1, failedAt: 70 },
    { type: 'OrbTaken', tick: 20, id: 5, hash: 456 },
    { type: 'ActivityCrateCollected', tick: 30, id: 6, hash: 789, result: 0.5 },
  ],
  tick: 31,
  stats: { replays: 1, fromHistory: 2, executed: 3, incidents: 0, retriesUsed: 0, circuitTrips: 1, boostsLost: 2 },
  divergedAt: null,
  segments: [],
  orbValues: [],
  tape: { ...emptyTape('2026-09-30'), liveTick: 31 },
}

describe('montage save fields', () => {
  it('round-trips montage segments and rejects malformed ones', () => {
    const seg = { start: sample.start, history: sample.history, endTick: 31, orbValues: [[5, 0.25]] }
    const withSeg = { ...sample, segments: [seg], orbValues: [[9, 0.5]] }
    expect(parseSave(JSON.stringify(withSeg))).toEqual(withSeg)
    expect(parseSave(JSON.stringify({ ...withSeg, segments: [{ ...seg, orbValues: [[5]] }] }))).toBeNull()
  })
})

describe('localSaveStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a save', () => {
    const store = localSaveStore()
    store.save(sample)
    expect(store.load()).toEqual(sample)
  })

  it('treats a version-1 save as no save', () => {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...sample, version: 1 }))
    expect(localSaveStore().load()).toBeNull()
  })

  it('accepts runtime input events at the save tick but not outcomes', () => {
    const atTick = { ...sample, history: [...sample.history, { type: 'RetryAttempt' as const, tick: 31, attempt: 1, failedAt: 90 }] }
    expect(parseSave(JSON.stringify(atTick))).not.toBeNull()
    const outcome = { ...sample, history: [...sample.history, { type: 'ActivityCoinCollected' as const, tick: 31, id: 1, hash: 1 }] }
    expect(parseSave(JSON.stringify(outcome))).toBeNull()
  })

  it('rejects a save whose start input lacks retries or shield', () => {
    const start: Partial<Save['start']> = { ...sample.start }
    delete start.retries
    expect(parseSave(JSON.stringify({ ...sample, start }))).toBeNull()
  })

  it('rejects a save whose tape is malformed', () => {
    expect(parseSave(JSON.stringify({ ...sample, tape: { ...sample.tape, v: 2 } }))).toBeNull()
    const noTape: Partial<Save> = { ...sample }
    delete noTape.tape
    expect(parseSave(JSON.stringify(noTape))).toBeNull()
  })

  it('rejects a save without a valid date', () => {
    expect(parseSave(JSON.stringify({ ...sample, date: 'yesterday' }))).toBeNull()
  })

  it("round-trips today's best and reads another day's as 0", () => {
    const store = localSaveStore()
    expect(store.loadDailyBest('2026-09-30')).toBe(0)
    store.saveDailyBest('2026-09-30', 12)
    expect(store.loadDailyBest('2026-09-30')).toBe(12)
    expect(store.loadDailyBest('2026-10-01')).toBe(0)
    localStorage.setItem(DAILY_KEY, '{nope')
    expect(store.loadDailyBest('2026-09-30')).toBe(0)
  })

  it('returns null when there is no save, and after clear()', () => {
    const store = localSaveStore()
    expect(store.load()).toBeNull()
    store.save(sample)
    store.clear()
    expect(store.load()).toBeNull()
  })

  it('round-trips the best score and ignores garbage', () => {
    const store = localSaveStore()
    expect(store.loadBest()).toBe(0)
    store.saveBest(42)
    expect(store.loadBest()).toBe(42)
    localStorage.setItem(BEST_KEY, 'lots')
    expect(store.loadBest()).toBe(0)
    localStorage.setItem(BEST_KEY, '-3')
    expect(store.loadBest()).toBe(0)
  })

  it('never throws when storage is unavailable', () => {
    const store = localSaveStore(() => {
      throw new Error('denied')
    })
    expect(store.load()).toBeNull()
    expect(() => store.save(sample)).not.toThrow()
    expect(() => store.clear()).not.toThrow()
    expect(store.loadBest()).toBe(0)
    expect(() => store.saveBest(1)).not.toThrow()
  })

  it('never throws when storage methods throw (quota, private mode)', () => {
    const broken = {
      getItem: () => { throw new Error('x') },
      setItem: () => { throw new Error('x') },
      removeItem: () => { throw new Error('x') },
    } as unknown as Storage
    const store = localSaveStore(() => broken)
    expect(store.load()).toBeNull()
    expect(() => store.save(sample)).not.toThrow()
  })

  it('stores under the versioned key', () => {
    localSaveStore().save(sample)
    expect(localStorage.getItem(SAVE_KEY)).not.toBeNull()
  })
})

describe('parseSave', () => {
  const mutate = (fn: (s: Record<string, unknown>) => void): string => {
    const s = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    fn(s)
    return JSON.stringify(s)
  }

  it.each([
    ['null', null],
    ['corrupt JSON', 'not json{'],
    ['another version', mutate((s) => { s.version = 3 })],
    ['a missing distance', mutate((s) => { delete (s.start as Record<string, unknown>).distance })],
    ['a bad level', mutate((s) => { (s.start as Record<string, unknown>).level = 7 })],
    ['an unknown event type', mutate((s) => { (s.history as unknown[]).push({ type: 'Nope', tick: 30 }) })],
    ['the retired ActivityCompleted event', mutate((s) => { (s.history as unknown[]).push({ type: 'ActivityCompleted', tick: 30, id: 7, hash: 1 }) })],
    ['a crate event without its result', mutate((s) => { (s.history as unknown[]).push({ type: 'ActivityCrateCollected', tick: 30, id: 7, hash: 1 }) })],
    ['out-of-order events', mutate((s) => { (s.history as unknown[]).push({ type: 'Input', tick: 1, kind: 'jump' }) })],
    ['an event at or after the save tick', mutate((s) => { s.tick = 30 })],
    ['missing stats', mutate((s) => { delete s.stats })],
  ])('rejects %s', (_name, raw) => {
    expect(parseSave(raw as string | null)).toBeNull()
  })

  it('accepts a valid save', () => {
    expect(parseSave(JSON.stringify(sample))).toEqual(sample)
  })

  it('accepts a level-5 save', () => {
    expect(parseSave(JSON.stringify({ ...sample, start: { ...sample.start, level: 5 } }))).not.toBeNull()
  })
})
