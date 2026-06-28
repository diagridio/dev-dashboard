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

describe('RefreshControl', () => {
  it('renders the .live indicator with .beat dot', () => {
    const { container } = renderWithProvider()
    const live = container.querySelector('.live')
    expect(live).not.toBeNull()
    expect(container.querySelector('.live .beat')).not.toBeNull()
  })

  it('shows "refreshing every 3s" text by default', () => {
    renderWithProvider()
    expect(screen.getByText(/refreshing every 3s/i)).toBeInTheDocument()
  })

  it('renders pause button as .tbtn with ⏸ Pause label', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toBeInTheDocument()
    expect(btn.className).toContain('tbtn')
    expect(btn.textContent).toContain('⏸')
    expect(btn.textContent).toContain('Pause')
  })

  it('renders the interval <select> with class "select"', () => {
    const { container } = renderWithProvider()
    const sel = container.querySelector('select.select')
    expect(sel).not.toBeNull()
    expect(screen.getByRole('combobox', { name: /refresh interval/i })).toBeInTheDocument()
  })

  it('toggles to Resume state when paused', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    fireEvent.click(btn)
    // After clicking, button should now say Resume
    expect(screen.getByRole('button', { name: /resume auto-refresh/i })).toBeInTheDocument()
    expect(screen.getByText(/paused/i)).toBeInTheDocument()
  })

  it('changes interval label in .live when a different interval is selected', () => {
    renderWithProvider()
    const sel = screen.getByRole('combobox', { name: /refresh interval/i })
    fireEvent.change(sel, { target: { value: '5000' } })
    expect(screen.getByText(/refreshing every 5s/i)).toBeInTheDocument()
  })

  it('has aria-pressed=false on the pause button when not paused', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
  })

  it('has aria-pressed=true on the pause button when paused', () => {
    renderWithProvider()
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    fireEvent.click(btn)
    const resumeBtn = screen.getByRole('button', { name: /resume auto-refresh/i })
    expect(resumeBtn).toHaveAttribute('aria-pressed', 'true')
  })
})
