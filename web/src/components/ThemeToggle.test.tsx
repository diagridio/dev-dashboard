import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { ThemeToggle } from './ThemeToggle'
import type { Theme } from '../lib/prefs'

beforeEach(() => {
  localStorage.clear()
})

describe('ThemeToggle', () => {
  it('renders ◐ Theme label', () => {
    render(<ThemeToggle theme="light" onThemeChange={() => {}} />)
    expect(screen.getByRole('button', { name: /toggle theme/i })).toHaveTextContent('◐ Theme')
  })

  it('calls onThemeChange with "dark" when toggling from light', async () => {
    const spy = vi.fn<(t: Theme) => void>()
    render(<ThemeToggle theme="light" onThemeChange={spy} />)
    await userEvent.click(screen.getByRole('button', { name: /toggle theme/i }))
    expect(spy).toHaveBeenCalledWith('dark')
  })

  it('calls onThemeChange with "light" when toggling from dark', async () => {
    const spy = vi.fn<(t: Theme) => void>()
    render(<ThemeToggle theme="dark" onThemeChange={spy} />)
    await userEvent.click(screen.getByRole('button', { name: /toggle theme/i }))
    expect(spy).toHaveBeenCalledWith('light')
  })

  it('has aria-pressed false when theme is light', () => {
    render(<ThemeToggle theme="light" onThemeChange={() => {}} />)
    expect(screen.getByRole('button', { name: /toggle theme/i })).toHaveAttribute('aria-pressed', 'false')
  })

  it('has aria-pressed true when theme is dark', () => {
    render(<ThemeToggle theme="dark" onThemeChange={() => {}} />)
    expect(screen.getByRole('button', { name: /toggle theme/i })).toHaveAttribute('aria-pressed', 'true')
  })

  it('has data-cy="theme-toggle"', () => {
    render(<ThemeToggle theme="light" onThemeChange={() => {}} />)
    expect(document.querySelector('[data-cy="theme-toggle"]')).not.toBeNull()
  })
})
