import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { RefreshProvider } from '../lib/refresh'
import { ConnectionContext } from '../lib/connection'
import { RefreshControl } from './RefreshControl'

function renderWithProvider(online = true) {
  return render(
    <RefreshProvider>
      <ConnectionContext value={{ online }}>
        <RefreshControl />
      </ConnectionContext>
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

  it('toggles to the paused state when clicked, keeping a constant toggle label', () => {
    renderWithProvider()
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    // Toggle-button pattern: the accessible name stays "Pause auto-refresh";
    // aria-pressed=true means the pause is engaged.
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn).toHaveAttribute('title', expect.stringContaining('paused'))
    expect(btn.className).toContain('off')
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

  it('keeps the "Auto-refresh off" title when Off and paused are combined (off wins)', () => {
    renderWithProvider()
    // Select Off, then pause — the compound off+paused state.
    fireEvent.change(screen.getByRole('combobox', { name: /refresh interval/i }), {
      target: { value: '0' },
    })
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    // aria-pressed reflects the paused toggle; the title reports the effective "off" state.
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    expect(btn.className).toContain('off')
    expect(btn).toHaveAttribute('title', 'Auto-refresh off')
  })
})

describe('RefreshControl offline indicator', () => {
  it('shows the offline dot state, label, and title when the backend is offline', () => {
    const { container } = renderWithProvider(false)
    const btn = container.querySelector('button.beatbtn')!
    // classList (not className.includes): 'offline' contains 'off' as a substring.
    expect(btn.classList.contains('offline')).toBe(true)
    expect(btn.classList.contains('off')).toBe(false)
    expect(screen.getByText('Backend offline')).toBeInTheDocument()
    expect(btn).toHaveAttribute('title', 'Backend unreachable — retrying…')
  })

  it('offline styling wins over paused', () => {
    const { container } = renderWithProvider(false)
    fireEvent.click(screen.getByRole('button', { name: /pause auto-refresh/i }))
    const btn = container.querySelector('button.beatbtn')!
    expect(btn.classList.contains('offline')).toBe(true)
    expect(btn.classList.contains('off')).toBe(false)
    expect(btn).toHaveAttribute('title', 'Backend unreachable — retrying…')
  })

  it('renders no offline label when online', () => {
    renderWithProvider(true)
    expect(screen.queryByText('Backend offline')).not.toBeInTheDocument()
  })

  it('keeps the pause button and interval picker functional while offline', () => {
    renderWithProvider(false)
    const btn = screen.getByRole('button', { name: /pause auto-refresh/i })
    fireEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
    const sel = screen.getByRole('combobox', { name: /refresh interval/i }) as HTMLSelectElement
    fireEvent.change(sel, { target: { value: '5000' } })
    expect(sel.value).toBe('5000')
  })
})
