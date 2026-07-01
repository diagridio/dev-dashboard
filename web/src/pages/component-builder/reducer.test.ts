import { describe, it, expect } from 'vitest'
import { initialState, reducer, canContinue, assembleComponentSpec } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const redis: ComponentMetadataSchema = {
  type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
  metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
}

function withSchema() {
  return reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
}

describe('reducer / canContinue', () => {
  it('step 0 requires a schema', () => {
    expect(canContinue(initialState())).toBe(false)
    expect(canContinue(withSchema())).toBe(true)
  })

  it('SELECT_SCHEMA advances to step 1 and detects no auth profiles', () => {
    const s = withSchema()
    expect(s.activeStep).toBe(1)
    expect(s.hasAuthProfiles).toBe(false)
  })

  it('step 2 requires a valid name and all required fields filled', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' }) // 1 -> 2
    expect(s.activeStep).toBe(2)
    expect(canContinue(s)).toBe(false) // no name, redisHost empty
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    expect(canContinue(s)).toBe(true)
  })

  it('a required field satisfied by a secret ref also passes the gate', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'redisHost', ref: { name: 'sec', key: 'host' } })
    expect(canContinue(s)).toBe(true)
  })
})

describe('assembleComponentSpec', () => {
  it('builds spec.type from type.name and emits only populated metadata keys', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.type).toBe('state.redis')
    expect(spec.spec.version).toBe('v1')
    expect(spec.metadata.name).toBe('order-store')
    expect(spec.spec.metadata).toEqual([{ name: 'redisHost', value: 'localhost:6379' }])
  })

  it('emits secretKeyRef (never value) when use-secret is on', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'redisHost', ref: { name: 'sec', key: 'host' } })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.metadata).toEqual([{ name: 'redisHost', secretKeyRef: { name: 'sec', key: 'host' } }])
  })

  it('does not emit secretKeyRef when use-secret is on but name/key are whitespace-only', () => {
    const schema: ComponentMetadataSchema = {
      type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true }, { name: 'password', required: false }],
    }
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    // Optional field with use-secret on but whitespace-only name and key
    s = reducer(s, { type: 'ADD_OPTIONAL', field: 'password' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'password', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'password', ref: { name: '  ', key: '  ' } })
    const spec = assembleComponentSpec(s)
    // Only redisHost should appear; whitespace-only secret ref must not be emitted
    expect(spec.spec.metadata).toEqual([{ name: 'redisHost', value: 'localhost:6379' }])
  })

  it('keeps raw string value when number field contains non-numeric input (NaN guard)', () => {
    const schema: ComponentMetadataSchema = {
      type: 'state', name: 'x', version: 'v1', title: 'X', status: 'stable',
      metadata: [{ name: 'port', type: 'number', required: true }],
    }
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'x1' })
    s = reducer(s, { type: 'SET_VALUE', field: 'port', value: 'not-a-number' })
    const spec = assembleComponentSpec(s)
    // Should keep raw string, not emit NaN
    expect(spec.spec.metadata).toEqual([{ name: 'port', value: 'not-a-number' }])
  })

  it('coerces number and bool field values', () => {
    const schema: ComponentMetadataSchema = {
      type: 'state', name: 'x', version: 'v1', title: 'X', status: 'stable',
      metadata: [{ name: 'port', type: 'number', required: true }, { name: 'tls', type: 'bool', required: true }],
    }
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'x1' })
    s = reducer(s, { type: 'SET_VALUE', field: 'port', value: '6379' })
    s = reducer(s, { type: 'SET_VALUE', field: 'tls', value: 'true' })
    const spec = assembleComponentSpec(s)
    expect(spec.spec.metadata).toEqual([{ name: 'port', value: 6379 }, { name: 'tls', value: true }])
  })
})
