import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusPill } from './StatusPill'

describe('StatusPill', () => {
  it('renders FAILED in uppercase with pill + s-fail classes', () => {
    render(<StatusPill status="Failed" />)
    const pill = screen.getByText('FAILED')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute('data-cy', 'status-pill')
    expect(pill.className).toContain('pill')
    expect(pill.className).toContain('s-fail')
  })

  it('renders RUNNING in uppercase with pill + s-run classes', () => {
    render(<StatusPill status="Running" />)
    const pill = screen.getByText('RUNNING')
    expect(pill).toBeInTheDocument()
    expect(pill.className).toContain('pill')
    expect(pill.className).toContain('s-run')
  })

  it('renders COMPLETED with s-done class', () => {
    render(<StatusPill status="Completed" />)
    const pill = screen.getByText('COMPLETED')
    expect(pill.className).toContain('s-done')
  })

  it('renders TERMINATED with s-term class', () => {
    render(<StatusPill status="Terminated" />)
    const pill = screen.getByText('TERMINATED')
    expect(pill.className).toContain('s-term')
  })

  it('renders SUSPENDED with s-susp class', () => {
    render(<StatusPill status="Suspended" />)
    const pill = screen.getByText('SUSPENDED')
    expect(pill.className).toContain('s-susp')
  })

  it('renders PENDING with s-pend class', () => {
    render(<StatusPill status="Pending" />)
    const pill = screen.getByText('PENDING')
    expect(pill.className).toContain('s-pend')
  })

  it('has no inline style (uses CSS classes only)', () => {
    render(<StatusPill status="Running" />)
    const pill = screen.getByText('RUNNING')
    expect(pill).not.toHaveAttribute('style')
  })
})
