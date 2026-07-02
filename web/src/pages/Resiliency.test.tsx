import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { Resiliency } from './Resiliency'

describe('Resiliency landing', () => {
  it('shows the empty state and a New resiliency policy link', () => {
    render(<MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><Resiliency /></MemoryRouter>)
    expect(screen.getByText(/no resiliency policies/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /new resiliency policy/i })
    expect(link).toHaveAttribute('href', '/resiliency/new')
  })
})
