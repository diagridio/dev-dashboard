import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Icon } from './Icon'

describe('Icon', () => {
  it('renders an svg that inherits currentColor', () => {
    const { container } = render(<Icon name="workflows" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(container.querySelector('path')).not.toBeNull()
  })

  it('applies the size prop as width and height on the svg', () => {
    const { container } = render(<Icon name="workflows" size={24} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('24')
    expect(svg?.getAttribute('height')).toBe('24')
  })
})
