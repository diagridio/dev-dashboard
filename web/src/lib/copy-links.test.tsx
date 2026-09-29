import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { renderCopyLinks } from './copy-links'

describe('renderCopyLinks', () => {
  it('renders link-free copy as plain text', () => {
    render(<p>{renderCopyLinks('Nothing running yet.')}</p>)
    expect(screen.getByText('Nothing running yet.')).toBeInTheDocument()
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
  })

  it('renders a markdown link as an external text link', () => {
    render(<p>{renderCopyLinks('See the [quickstarts](https://example.com/qs) repo')}</p>)
    const link = screen.getByRole('link', { name: 'quickstarts' })
    expect(link).toHaveAttribute('href', 'https://example.com/qs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveClass('celllink')
  })

  it('keeps the text around a link', () => {
    const { container } = render(
      <p>{renderCopyLinks('See the [quickstarts](https://example.com/qs) repo')}</p>,
    )
    expect(container.textContent).toBe('See the quickstarts repo')
  })

  it('renders several links in one string', () => {
    render(<p>{renderCopyLinks('[one](https://a.example) and [two](https://b.example)')}</p>)
    expect(screen.getByRole('link', { name: 'one' })).toHaveAttribute('href', 'https://a.example')
    expect(screen.getByRole('link', { name: 'two' })).toHaveAttribute('href', 'https://b.example')
  })

  it('leaves a non-http target as literal text (no link)', () => {
    const { container } = render(<p>{renderCopyLinks('[x](javascript:alert(1))')}</p>)
    expect(screen.queryByRole('link')).not.toBeInTheDocument()
    expect(container.textContent).toBe('[x](javascript:alert(1))')
  })
})
