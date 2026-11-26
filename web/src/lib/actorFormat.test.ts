import { describe, it, expect } from 'vitest'
import { isInternalActorType } from './actorFormat'

describe('isInternalActorType', () => {
  it('matches the dapr.internal. prefix only', () => {
    expect(isInternalActorType('dapr.internal.default.app.workflow')).toBe(true)
    expect(isInternalActorType('MyActor')).toBe(false)
    expect(isInternalActorType('x.dapr.internal.y')).toBe(false)
  })
})
