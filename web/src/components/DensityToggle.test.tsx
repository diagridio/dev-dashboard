import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, beforeEach } from 'vitest'
import { DensityToggle } from './DensityToggle'

beforeEach(() => {
  localStorage.clear()
})

describe('DensityToggle', () => {
  it('shows "Switch to comfortable" when current density is compact (default)', () => {
    render(<DensityToggle />)
    expect(screen.getByRole('button', { name: /toggle density/i })).toHaveTextContent('Switch to comfortable')
  })

  it('shows "Switch to compact" after toggling to comfortable', async () => {
    render(<DensityToggle />)
    const btn = screen.getByRole('button', { name: /toggle density/i })
    await userEvent.click(btn)
    expect(btn).toHaveTextContent('Switch to compact')
  })

  it('has aria-pressed reflecting compact state (true when compact)', () => {
    render(<DensityToggle />)
    const btn = screen.getByRole('button', { name: /toggle density/i })
    // Default is compact → aria-pressed=true
    expect(btn).toHaveAttribute('aria-pressed', 'true')
  })

  it('has data-cy="density-toggle"', () => {
    render(<DensityToggle />)
    expect(document.querySelector('[data-cy="density-toggle"]')).not.toBeNull()
  })
})
