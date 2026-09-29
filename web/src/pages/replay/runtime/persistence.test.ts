import { beforeEach, describe, expect, it } from 'vitest'
import { BEST_KEY, SAVE_KEY, localSaveStore, parseSave } from './persistence'
import type { Save } from './types'

const sample: Save = {
  version: 1,
  start: { level: 2, seed: 99, score: 5, elapsed: 0, distance: 0, boss: false },
  history: [
    { type: 'Input', tick: 3, kind: 'jump' },
    { type: 'ActivityCompleted', tick: 10, id: 4, hash: 123 },
    { type: 'OrbTaken', tick: 20, id: 5, hash: 456 },
    { type: 'ActivityCompleted', tick: 30, id: 6, hash: 789, result: 0.5 },
  ],
  tick: 31,
  stats: { replays: 1, fromHistory: 2, executed: 3, incidents: 0 },
  divergedAt: null,
}

describe('localSaveStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a save', () => {
    const store = localSaveStore()
    store.save(sample)
    expect(store.load()).toEqual(sample)
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
    ['another version', mutate((s) => { s.version = 2 })],
    ['a missing distance', mutate((s) => { delete (s.start as Record<string, unknown>).distance })],
    ['a bad level', mutate((s) => { (s.start as Record<string, unknown>).level = 7 })],
    ['an unknown event type', mutate((s) => { (s.history as unknown[]).push({ type: 'Nope', tick: 30 }) })],
    ['out-of-order events', mutate((s) => { (s.history as unknown[]).push({ type: 'Input', tick: 1, kind: 'jump' }) })],
    ['an event at or after the save tick', mutate((s) => { s.tick = 30 })],
    ['missing stats', mutate((s) => { delete s.stats })],
  ])('rejects %s', (_name, raw) => {
    expect(parseSave(raw as string | null)).toBeNull()
  })

  it('accepts a valid save', () => {
    expect(parseSave(JSON.stringify(sample))).toEqual(sample)
  })
})
