import { describe, it, expect } from 'vitest'
import { dedupeStores } from './dedupeStores'
import type { StateStore } from '../types/workflow'

function store(over: Partial<StateStore>): StateStore {
  return {
    id: 'id',
    name: 'redis',
    type: 'state.redis',
    source: 'auto',
    path: '/c/redis.yaml',
    active: false,
    connection: 'localhost:6379',
    ...over,
  }
}

describe('dedupeStores', () => {
  it('returns the list unchanged when there are no duplicates', () => {
    const input = [
      store({ id: 'a', connection: 'localhost:6379' }),
      store({ id: 'b', connection: 'localhost:16379' }),
    ]
    expect(dedupeStores(input).map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('does NOT collapse stores that differ by connection', () => {
    const input = [
      store({ id: 'a', name: 'statestore', connection: 'localhost:6379' }),
      store({ id: 'b', name: 'statestore', connection: 'localhost:16379' }),
    ]
    expect(dedupeStores(input)).toHaveLength(2)
  })

  it('collapses same name+type+connection differing only by path, keeping the active member', () => {
    const input = [
      store({ id: 'p1', path: '/c/a.yaml', active: false }),
      store({ id: 'p2', path: '/c/b.yaml', active: true }),
    ]
    const out = dedupeStores(input)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p2') // the active member represents the group
  })

  it('keeps the first member when no member of the group is active', () => {
    const input = [
      store({ id: 'p1', path: '/c/a.yaml', active: false }),
      store({ id: 'p2', path: '/c/b.yaml', active: false }),
    ]
    const out = dedupeStores(input)
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe('p1')
  })

  it('emits one entry per group in first-appearance order', () => {
    const input = [
      store({ id: 'r1', name: 'redis', path: '/c/r1.yaml' }),
      store({ id: 'pg1', name: 'pg', type: 'state.postgresql', connection: 'db:5432', path: '/c/pg1.yaml' }),
      store({ id: 'r2', name: 'redis', path: '/c/r2.yaml' }),
    ]
    const out = dedupeStores(input)
    expect(out.map((s) => s.name)).toEqual(['redis', 'pg'])
    expect(out[0].id).toBe('r1')
  })

  it('does not mutate the input array', () => {
    const input = [store({ id: 'p1', active: false }), store({ id: 'p2', active: true })]
    const snapshot = input.map((s) => s.id)
    dedupeStores(input)
    expect(input.map((s) => s.id)).toEqual(snapshot)
  })

  it('returns an empty array for empty input', () => {
    expect(dedupeStores([])).toEqual([])
  })
})
