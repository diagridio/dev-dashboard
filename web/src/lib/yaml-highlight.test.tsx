import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { highlightYaml } from './yaml-highlight'

describe('highlightYaml', () => {
  it('highlights keys, comments, and values', () => {
    const { container } = render(<pre>{highlightYaml('# comment\nname: statestore\n')}</pre>)
    const text = container.textContent ?? ''
    expect(text).toContain('# comment')
    expect(text).toContain('name')
    expect(text).toContain('statestore')
    // a key span exists
    expect(container.querySelector('[data-cy="yaml-key"]')).not.toBeNull()
  })
})
