import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { RefreshContext } from '../lib/refresh'
import { LiveIndicator } from './LiveIndicator'

function wrap(intervalMs: number, paused: boolean) {
  return render(
    <RefreshContext
      value={{ intervalMs, paused, setInterval: () => {}, setPaused: () => {} }}
    >
      <LiveIndicator />
    </RefreshContext>,
  )
}

describe('LiveIndicator', () => {
  it('shows "refreshing every Ns" with a beat when active', () => {
    const { container } = wrap(3000, false)
    expect(screen.getByText(/refreshing every 3s/i)).toBeInTheDocument()
    expect(container.querySelector('.beat')).not.toBeNull()
  })

  it('shows "auto-refresh off" with no beat when paused', () => {
    const { container } = wrap(3000, true)
    expect(screen.getByText(/auto-refresh off/i)).toBeInTheDocument()
    expect(container.querySelector('.beat')).toBeNull()
  })

  it('shows "auto-refresh off" when interval is 0', () => {
    const { container } = wrap(0, false)
    expect(screen.getByText(/auto-refresh off/i)).toBeInTheDocument()
    expect(container.querySelector('.beat')).toBeNull()
  })
})
