import { describe, it, expect } from 'vitest'
import { initialState, reducer, canContinue, assembleResiliency, nextName } from './reducer'

describe('nextName', () => {
  it('produces sequential names when no gaps exist', () => {
    expect(nextName('retry', {})).toBe('retry1')
    expect(nextName('retry', { retry1: {}, retry2: {} })).toBe('retry3')
  })
  it('suggests the first free slot after deletions instead of colliding', () => {
    // deleting timeout1 from {timeout1, timeout2} must not suggest the existing timeout2
    expect(nextName('timeout', { timeout2: '10s' })).toBe('timeout1')
    expect(nextName('timeout', { timeout1: '5s', timeout3: '10s' })).toBe('timeout2')
  })
  it('ignores non-numeric and foreign keys when scanning for a free slot', () => {
    expect(nextName('retry', { important: {}, DaprBuiltInServiceRetries: {} })).toBe('retry1')
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

describe('policy remove/rename cascades to target references', () => {
  function stateWithReferences() {
    let s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3 } })
    s = reducer(s, { type: 'UPSERT_CB', name: 'circuitBreaker1', policy: { maxRequests: 1, timeout: '30s' } })
    s = reducer(s, { type: 'UPSERT_APP', name: 'orders', target: { timeout: 'timeout1', retry: 'retry1' } })
    s = reducer(s, {
      type: 'UPSERT_ACTOR', name: 'myactor',
      target: { retry: 'retry1', circuitBreaker: 'circuitBreaker1', circuitBreakerScope: 'both', circuitBreakerCacheSize: 5000 },
    })
    s = reducer(s, {
      type: 'UPSERT_COMPONENT', name: 'statestore',
      target: { outbound: { timeout: 'timeout1', retry: 'retry1' }, inbound: { retry: 'retry1' } },
    })
    return s
  }

  it('removing a timeout clears its refs from targets but keeps other policy refs', () => {
    const s = reducer(stateWithReferences(), { type: 'REMOVE_TIMEOUT', name: 'timeout1' })
    expect(s.config.spec.targets.apps!.orders).toEqual({ retry: 'retry1' })
    expect(s.config.spec.targets.components!.statestore.outbound).toEqual({ retry: 'retry1' })
    expect(s.config.spec.targets.components!.statestore.inbound).toEqual({ retry: 'retry1' })
  })

  it('removing a retry clears its refs from every target that references it', () => {
    const s = reducer(stateWithReferences(), { type: 'REMOVE_RETRY', name: 'retry1' })
    expect(s.config.spec.targets.apps!.orders).toEqual({ timeout: 'timeout1' })
    expect(s.config.spec.targets.actors!.myactor.retry).toBeUndefined()
    expect(s.config.spec.targets.components!.statestore.outbound).toEqual({ timeout: 'timeout1' })
    expect(s.config.spec.targets.components!.statestore.inbound).toEqual({})
  })

  it('removing a circuit breaker also clears actor scope and cache size', () => {
    const s = reducer(stateWithReferences(), { type: 'REMOVE_CB', name: 'circuitBreaker1' })
    expect(s.config.spec.targets.actors!.myactor).toEqual({ retry: 'retry1' })
  })

  it('removing a policy referenced by no target leaves targets untouched', () => {
    let s = reducer(stateWithReferences(), { type: 'UPSERT_RETRY', name: 'retry2', policy: { policy: 'exponential', duration: '2s' } })
    const before = s.config.spec.targets
    s = reducer(s, { type: 'REMOVE_RETRY', name: 'retry2' })
    expect(s.config.spec.policies.retries.retry2).toBeUndefined()
    expect(s.config.spec.targets).toBe(before)
  })

  it('renaming a timeout rewrites refs in targets and renames the policy key', () => {
    const s = reducer(stateWithReferences(), { type: 'RENAME_TIMEOUT', from: 'timeout1', to: 'fast-timeout' })
    expect(s.config.spec.policies.timeouts).toEqual({ 'fast-timeout': '30s' })
    expect(s.config.spec.targets.apps!.orders).toEqual({ timeout: 'fast-timeout', retry: 'retry1' })
    expect(s.config.spec.targets.components!.statestore.outbound).toEqual({ timeout: 'fast-timeout', retry: 'retry1' })
  })

  it('renaming a retry rewrites refs in targets and preserves other refs', () => {
    const s = reducer(stateWithReferences(), { type: 'RENAME_RETRY', from: 'retry1', to: 'important' })
    expect(s.config.spec.policies.retries.important).toEqual({ policy: 'constant', duration: '5s', maxRetries: 3 })
    expect(s.config.spec.policies.retries.retry1).toBeUndefined()
    expect(s.config.spec.targets.apps!.orders).toEqual({ timeout: 'timeout1', retry: 'important' })
    expect(s.config.spec.targets.actors!.myactor.retry).toBe('important')
    expect(s.config.spec.targets.components!.statestore.inbound).toEqual({ retry: 'important' })
  })

  it('renaming a circuit breaker rewrites refs and keeps actor scope and cache size', () => {
    const s = reducer(stateWithReferences(), { type: 'RENAME_CB', from: 'circuitBreaker1', to: 'cb-main' })
    expect(s.config.spec.policies.circuitBreakers).toEqual({ 'cb-main': { maxRequests: 1, timeout: '30s' } })
    expect(s.config.spec.targets.actors!.myactor).toEqual({
      retry: 'retry1', circuitBreaker: 'cb-main', circuitBreakerScope: 'both', circuitBreakerCacheSize: 5000,
    })
  })

  it('removing a DaprBuiltIn override leaves unrelated custom refs untouched', () => {
    let s = reducer(stateWithReferences(), { type: 'UPSERT_RETRY', name: 'DaprBuiltInServiceRetries', policy: { policy: 'constant', duration: '1s', maxRetries: 3 } })
    s = reducer(s, { type: 'REMOVE_RETRY', name: 'DaprBuiltInServiceRetries' })
    expect(s.config.spec.policies.retries.DaprBuiltInServiceRetries).toBeUndefined()
    expect(s.config.spec.targets.apps!.orders).toEqual({ timeout: 'timeout1', retry: 'retry1' })
  })
})

describe('assembleResiliency', () => {
  it('keeps name + default namespace, cleans spec, omits empty scopes', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s', maxRetries: 3, maxInterval: '', matching: { httpStatusCodes: '', grpcStatusCodes: '' } } })
    const out = assembleResiliency(s.config) as {
      metadata: Record<string, unknown>
      scopes?: unknown
      spec: { policies: { retries: Record<string, unknown> } }
    }
    expect(out.metadata).toEqual({ name: 'r', namespace: 'default' })
    expect(out.scopes).toBeUndefined()
    expect(out.spec.policies.retries.retry1).toEqual({ policy: 'constant', duration: '5s', maxRetries: 3 })
  })
  it('omits namespace when cleared', () => {
    let s = reducer(initialState(), { type: 'SET_NAME', name: 'r' })
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '' })
    const out = assembleResiliency(s.config) as { metadata: Record<string, unknown> }
    expect(out.metadata).toEqual({ name: 'r' })
  })
})
