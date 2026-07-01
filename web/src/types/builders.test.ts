import { describe, it, expect } from 'vitest'
import { defaultComponentSpec } from './component'
import { defaultResiliencyConfig } from './resiliency'

describe('defaultComponentSpec', () => {
  it('returns a v1alpha1 Component skeleton', () => {
    const c = defaultComponentSpec()
    expect(c.apiVersion).toBe('dapr.io/v1alpha1')
    expect(c.kind).toBe('Component')
    expect(c.metadata).toEqual({ name: '', namespace: 'default' })
    expect(c.scopes).toEqual([])
    expect(c.spec).toEqual({ type: '', version: '', metadata: [] })
  })
  it('returns a fresh object each call (no shared refs)', () => {
    const a = defaultComponentSpec()
    const b = defaultComponentSpec()
    expect(a.spec.metadata).not.toBe(b.spec.metadata)
  })
})

describe('defaultResiliencyConfig', () => {
  it('returns a v1alpha1 Resiliency skeleton with empty policy/target maps', () => {
    const r = defaultResiliencyConfig()
    expect(r.apiVersion).toBe('dapr.io/v1alpha1')
    expect(r.kind).toBe('Resiliency')
    expect(r.metadata).toEqual({ name: '', namespace: '' })
    expect(r.spec.policies).toEqual({ timeouts: {}, retries: {}, circuitBreakers: {} })
    expect(r.spec.targets).toEqual({ apps: {}, actors: {}, components: {} })
  })
})
