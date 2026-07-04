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

  it('step 2 blocks an invalid namespace but allows an empty one', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' }) // 1 -> 2
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    expect(canContinue(s)).toBe(true) // default namespace is valid
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: 'bad ns' })
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '1abc' })
    expect(canContinue(s)).toBe(false)
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '' })
    expect(canContinue(s)).toBe(true) // empty namespace is omitted from the YAML
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

  it('keeps the default namespace and emits a custom one', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    expect(assembleComponentSpec(s).metadata).toEqual({ name: 'order-store', namespace: 'default' })
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: 'prod' })
    expect(assembleComponentSpec(s).metadata).toEqual({ name: 'order-store', namespace: 'prod' })
  })

  it('omits namespace when blank and scopes when empty (parity with assembleResiliency)', () => {
    let s = withSchema()
    s = reducer(s, { type: 'NEXT' })
    s = reducer(s, { type: 'SET_NAME', name: 'order-store' })
    s = reducer(s, { type: 'SET_NAMESPACE', namespace: '   ' })
    const spec = assembleComponentSpec(s)
    expect(spec.metadata).toEqual({ name: 'order-store' })
    expect('namespace' in spec.metadata).toBe(false)
    expect('scopes' in spec).toBe(false)
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

describe('SELECT_CATEGORY', () => {
  const redis = {
    type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
    metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' as const }],
  }
  it('sets the active category', () => {
    const s = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    expect(s.category).toBe('state')
    expect(s.activeStep).toBe(0)
  })
  it('SELECT_SCHEMA sets category = schema.type', () => {
    const s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    expect(s.category).toBe('state')
  })
  it('switching to a different category clears schema + config', () => {
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'x' })
    s = reducer(s, { type: 'SELECT_CATEGORY', category: 'pubsub' })
    expect(s.category).toBe('pubsub')
    expect(s.schema).toBeUndefined()
    expect(s.version).toBe('')
    expect(s.values).toEqual({})
  })
  it('re-selecting the same category keeps the schema', () => {
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
    s = reducer(s, { type: 'SELECT_CATEGORY', category: 'state' })
    expect(s.schema?.name).toBe('redis')
  })
})

describe('SELECT_SCHEMA reset behavior', () => {
  const memcached: ComponentMetadataSchema = {
    type: 'state', name: 'memcached', version: 'v1', title: 'Memcached', status: 'stable',
    metadata: [{ name: 'hosts', required: true }],
  }
  const redisWithAuth: ComponentMetadataSchema = {
    ...redis,
    authenticationProfiles: [{ title: 'Password', metadata: [{ name: 'redisPassword', required: true }] }],
  }

  function configured() {
    let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redisWithAuth, version: 'v1' })
    s = reducer(s, { type: 'SET_AUTH_PROFILE', profile: redisWithAuth.authenticationProfiles![0] })
    s = reducer(s, { type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
    s = reducer(s, { type: 'ADD_OPTIONAL', field: 'enableTLS' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'redisPassword', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'redisPassword', ref: { name: 'sec', key: 'pw' } })
    return s
  }

  it('selecting a different schema in the same category clears auth profile + config', () => {
    let s = configured()
    s = reducer(s, { type: 'SELECT_SCHEMA', schema: memcached, version: 'v1' })
    expect(s.schema?.name).toBe('memcached')
    expect(s.authProfile).toBeUndefined()
    expect(s.values).toEqual({})
    expect(s.secretRefs).toEqual({})
    expect(s.useSecret).toEqual({})
    expect(s.optionalAdded).toEqual([])
  })

  it('re-selecting the same schema preserves auth profile + config', () => {
    let s = configured()
    s = reducer(s, { type: 'SELECT_SCHEMA', schema: redisWithAuth, version: 'v1' })
    expect(s.authProfile?.title).toBe('Password')
    expect(s.values).toEqual({ redisHost: 'localhost:6379' })
    expect(s.secretRefs).toEqual({ redisPassword: { name: 'sec', key: 'pw' } })
    expect(s.useSecret).toEqual({ redisPassword: true })
    expect(s.optionalAdded).toEqual(['enableTLS'])
  })
})

describe('REMOVE_OPTIONAL clears field state', () => {
  it('removes the field from optionalAdded and clears its value/secret/useSecret', () => {
    let s = initialState()
    s = reducer(s, { type: 'ADD_OPTIONAL', field: 'enableTLS' })
    s = reducer(s, { type: 'SET_VALUE', field: 'enableTLS', value: 'true' })
    s = reducer(s, { type: 'TOGGLE_SECRET', field: 'enableTLS', on: true })
    s = reducer(s, { type: 'SET_SECRET', field: 'enableTLS', ref: { name: 'n', key: 'k' } })
    s = reducer(s, { type: 'REMOVE_OPTIONAL', field: 'enableTLS' })
    expect(s.optionalAdded).not.toContain('enableTLS')
    expect(s.values.enableTLS).toBeUndefined()
    expect(s.secretRefs.enableTLS).toBeUndefined()
    expect(s.useSecret.enableTLS).toBeUndefined()
  })
})
