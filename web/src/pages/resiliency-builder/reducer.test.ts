import { describe, it, expect } from 'vitest'
import { initialState, reducer, canContinue, assembleResiliency, nextName } from './reducer'

describe('nextName', () => {
  it('produces sequential names by count of existing keys', () => {
    expect(nextName('retry', {})).toBe('retry1')
    expect(nextName('retry', { retry1: {}, retry2: {} })).toBe('retry3')
  })
})

describe('canContinue', () => {
  it('step 0 needs a valid name', () => {
    let s = initialState()
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'SET_NAME', name: 'my-resiliency' })
    expect(canContinue(s)).toBe(true)
  })
  it('step 1 needs at least one policy of any kind', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'NEXT' }) // -> 1
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    expect(canContinue(s)).toBe(true)
  })
  it('step 2 needs at least one target of any kind', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    s = reducer(s, { type: 'NEXT' }) // 0->1
    s = reducer(s, { type: 'NEXT' }) // 1->2
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'UPSERT_APP', name: 'orders', target: { timeout: 'timeout1' } })
    expect(canContinue(s)).toBe(true)
  })
  it('step 2 passes with a DaprBuiltIn override and no explicit target', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'DaprBuiltInServiceRetries', policy: { policy: 'constant', duration: '1s', maxRetries: 3 } })
    s = reducer(s, { type: 'NEXT' }) // 0->1
    s = reducer(s, { type: 'NEXT' }) // 1->2
    expect(canContinue(s)).toBe(true)
  })
  it('step 2 fails with only a non-builtin retry and no target', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s' } })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'NEXT' })
    expect(canContinue(s)).toBe(false)
  })
})

describe('reducer upserts/removes', () => {
  it('adds and removes a retry policy', () => {
    let s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3 } })
    expect(s.config.spec.policies.retries.retry1.duration).toBe('5s')
    s = reducer(s, { type: 'REMOVE_RETRY', name: 'retry1' })
    expect(s.config.spec.policies.retries.retry1).toBeUndefined()
  })
})

describe('assembleResiliency', () => {
  it('keeps name + default namespace, cleans spec, omits empty scopes', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3, maxInterval: '', matching: { httpStatusCodes: '', grpcStatusCodes: '' } } })
    const out = assembleResiliency(s.config) as any
    expect(out.metadata).toEqual({ name: 'r', namespace: 'default' })
    expect(out.scopes).toBeUndefined()
    expect(out.spec.policies.retries.retry1).toEqual({ policy: 'constant', duration: '5s', maxRetries: 3 })
  })
  it('omits namespace when cleared', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '' })
    const out = assembleResiliency(s.config) as any
    expect(out.metadata).toEqual({ name: 'r' })
  })
})
