import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

function Hello() {
  return <div>Dev Dashboard</div>
}

describe('smoke', () => {
  it('renders', () => {
    render(<Hello />)
    expect(screen.getByText('Dev Dashboard')).toBeInTheDocument()
  })
})
