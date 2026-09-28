import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { SecretStatusPill } from './SecretStatusPill'

describe('SecretStatusPill', () => {
  it('renders a resolved status as a success pill', () => {
    render(<SecretStatusPill status="resolved" />)
    const pill = screen.getByText('RESOLVED')
    expect(pill).toHaveClass('pill', 'secref-ok')
  })

  it('renders a hard failure as an error pill', () => {
    render(<SecretStatusPill status="key-not-found" />)
    expect(screen.getByText('KEY NOT FOUND')).toHaveClass('pill', 'secref-err')
  })

  it('renders a soft problem as a warning pill', () => {
    render(<SecretStatusPill status="empty-value" />)
    expect(screen.getByText('EMPTY VALUE')).toHaveClass('pill', 'secref-warn')
  })

  it('falls back to a warning pill for an unknown status', () => {
    render(<SecretStatusPill status={'something-new' as never} />)
    expect(screen.getByText('SOMETHING NEW')).toHaveClass('pill', 'secref-warn')
  })
})
