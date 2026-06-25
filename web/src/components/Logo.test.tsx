import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Logo } from './Logo'

describe('Logo', () => {
  it('renders an accessible svg wordmark', () => {
    const { container } = render(<Logo />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-label')).toBe('Diagrid')
  })
})
