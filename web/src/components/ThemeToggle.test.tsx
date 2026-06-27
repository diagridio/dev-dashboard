import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach } from 'vitest'
import { ThemeToggle } from './ThemeToggle'

beforeEach(() => {
  localStorage.clear()
})

describe('ThemeToggle', () => {
  it('shows "Switch to dark" when current theme is light', () => {
    render(<ThemeToggle />)
    expect(screen.getByRole('button', { name: /toggle theme/i })).toHaveTextContent('Switch to dark')
  })

  it('shows "Switch to light" after toggling to dark', async () => {
    render(<ThemeToggle />)
    const btn = screen.getByRole('button', { name: /toggle theme/i })
    await userEvent.click(btn)
    expect(btn).toHaveTextContent('Switch to light')
  })

  it('has aria-pressed reflecting dark state', async () => {
    render(<ThemeToggle />)
    const btn = screen.getByRole('button', { name: /toggle theme/i })
    expect(btn).toHaveAttribute('aria-pressed', 'false')
    await userEvent.click(btn)
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('has data-cy="theme-toggle"', () => {
    render(<ThemeToggle />)
    expect(document.querySelector('[data-cy="theme-toggle"]')).not.toBeNull()
  })
})
