import { describe, it, expect } from 'vitest'
import { emptyStateContent } from './emptyState'

describe('emptyStateContent', () => {
  it('has non-empty copy for the Applications page', () => {
    expect(typeof emptyStateContent.apps).toBe('string')
    expect(emptyStateContent.apps.trim().length).toBeGreaterThan(0)
  })

  it('points the Applications copy at the Dapr quickstarts repo', () => {
    expect(emptyStateContent.apps).toContain('https://github.com/dapr/quickstarts')
  })
})
