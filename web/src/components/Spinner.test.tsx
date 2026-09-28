import { render, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { Spinner } from './Spinner'

function stubReducedMotion(reduce: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: reduce && query.includes('prefers-reduced-motion'),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('Spinner', () => {
  it('cycles braille frames', () => {
    vi.useFakeTimers()
    stubReducedMotion(false)
    const { container } = render(<Spinner />)
    const el = container.querySelector('[data-cy="spinner"]') as HTMLElement
    expect(el).toHaveAttribute('aria-hidden', 'true')
    expect(el.textContent).toBe('⠋')
    act(() => {
      vi.advanceTimersByTime(100)
    })
    expect(el.textContent).toBe('⠙')
  })

  it('renders nothing when the user prefers reduced motion', () => {
    stubReducedMotion(true)
    const { container } = render(<Spinner />)
    expect(container.querySelector('[data-cy="spinner"]')).toBeNull()
  })

  it('still animates where matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined)
    const { container } = render(<Spinner />)
    expect(container.querySelector('[data-cy="spinner"]')).not.toBeNull()
  })
})
