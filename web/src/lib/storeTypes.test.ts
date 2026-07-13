import { describe, it, expect } from 'vitest'
import { SUPPORTED_STORE_TYPES, storeTypeLabel, implFor } from './storeTypes'

describe('storeTypes', () => {
  it('includes MongoDB in the supported set', () => {
    expect(SUPPORTED_STORE_TYPES).toContain('state.mongodb')
  })

  it('labels MongoDB', () => {
    expect(storeTypeLabel('state.mongodb')).toBe('MongoDB')
  })

  it('maps state.mongodb to the mongodb catalog name', () => {
    expect(implFor('state.mongodb')).toBe('mongodb')
  })
})
