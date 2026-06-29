import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { RefreshProvider } from '../lib/refresh'
import { RefreshControl } from './RefreshControl'

function renderWithProvider() {
  return render(
    <RefreshProvider>
      <RefreshControl />
    </RefreshProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
})

describe('RefreshControl (compact)', () => {
  it('renders the .beatbtn pause control with a .beat dot', () => {
    const { container } = renderWithProvider()
    const btn = container.querySelector('button.beatbtn')
    expect(btn).not.toBeNull()
    expect(container.querySelector('button.beatbtn .beat')).not.toBeNull()
    expect(btn).toHaveAttribute('data-cy', 'refresh-pause')
  })

  it('renders the interval <select> with classes "select compact"', () => {
    const { container } = renderWithProvider()
    const sel = container.querySelector('select.select.compact')
    expect(sel).not.toBeNull()
    expect(sel).toHaveAttribute('data-cy', 'refresh-interval')
    expect(screen.getByRole('combobox', { name: /refresh interval/i })).toBeInTheDocument()
  })

  it('is live (not paused) by default: aria-pressed=false, pause label, title names interval', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    expect(btn).toHaveAttribute('title', expect.stringContaining('every 3s'))
    expect(btn.className).not.toContain('off')
  })

  it('toggles to the resumed/paused state when clicked', () => {
    renderWithProvider()
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    const resumeBtn = screen.getByRole('button', { name: /resume auto-refresh/i })
    expect(resumeBtn).toHaveAttribute('aria-pressed', 'true')
    expect(resumeBtn).toHaveAttribute('title', expect.stringContaining('paused'))
    expect(resumeBtn.className).toContain('off')
  })

  it('updates the title interval when a different interval is selected', () => {
    renderWithProvider()
    fireEvent.change(screen.getByRole('combobox', { name: /refresh interval/i }), {
      target: { value: '5000' },
    })
    expect(screen.getByRole('button', { name: /pause auto-refresh/i })).toHaveAttribute(
      'title',
      expect.stringContaining('every 5s'),
    )
  })

  it('shows the off state and "Auto-refresh off" title when interval is Off', () => {
    renderWithProvider()
    fireEvent.change(screen.getByRole('combobox', { name: /refresh interval/i }), {
      target: { value: '0' },
    })
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn.className).toContain('off')
    expect(btn).toHaveAttribute('title', 'Auto-refresh off')
  })
})
