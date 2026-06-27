import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusPill } from './StatusPill'

describe('StatusPill', () => {
  it('renders the status label as text', () => {
    render(<StatusPill status="Failed" />)
    const pill = screen.getByText('Failed')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute('data-cy', 'status-pill')
  })

  it('renders Running status', () => {
    render(<StatusPill status="Running" />)
    const pill = screen.getByText('Running')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute('data-cy', 'status-pill')
  })
})
