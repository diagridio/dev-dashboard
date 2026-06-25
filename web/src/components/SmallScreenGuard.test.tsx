import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SmallScreenGuard } from './SmallScreenGuard'

function mockMatch(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
}

describe('SmallScreenGuard', () => {
  it('shows content when wide enough', () => {
    mockMatch(true)
    render(<SmallScreenGuard><div>content</div></SmallScreenGuard>)
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText(/wider screen/i)).toBeNull()
  })

  it('shows the overlay when too narrow', () => {
    mockMatch(false)
    render(<SmallScreenGuard><div>content</div></SmallScreenGuard>)
    expect(screen.getByText(/wider screen/i)).toBeInTheDocument()
    expect(screen.queryByText('content')).toBeNull()
  })
})
