import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppTargetDialog, ComponentTargetDialog } from './targetDialogs'

const policies = { timeouts: ['timeout1'], retries: ['retry1'], circuitBreakers: ['cb1'] }

describe('AppTargetDialog', () => {
  it('requires a name and at least one policy reference', () => {
    const onSave = vi.fn()
    render(<AppTargetDialog open policies={policies} onClose={vi.fn()} onSave={onSave} />)
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'orders' } })
    expect(save).toBeDisabled() // no policy chosen yet
    fireEvent.change(screen.getByLabelText(/^timeout/i), { target: { value: 'timeout1' } })
    expect(save).toBeEnabled()
    fireEvent.click(save)
    expect(onSave).toHaveBeenCalledWith('orders', expect.objectContaining({ timeout: 'timeout1' }))
  })
})

describe('ComponentTargetDialog', () => {
  it('saves an outbound-only component target', () => {
    const onSave = vi.fn()
    render(<ComponentTargetDialog open policies={policies} onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText(/component name/i), { target: { value: 'statestore' } })
    fireEvent.change(screen.getByLabelText(/direction/i), { target: { value: 'outbound' } })
    fireEvent.change(screen.getByLabelText(/^retry/i), { target: { value: 'retry1' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('statestore', { outbound: { retry: 'retry1' } })
  })
})
