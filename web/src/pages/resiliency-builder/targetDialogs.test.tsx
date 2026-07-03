import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { AppTargetDialog, ActorTargetDialog, ComponentTargetDialog } from './targetDialogs'

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

describe('AppTargetDialog edit', () => {
  it('prefills name + policy refs and title on edit', () => {
    const onSave = vi.fn()
    render(<AppTargetDialog open editing policies={policies} initialName="orders" initialTarget={{ timeout: 'timeout1', retry: 'retry1' }} onClose={vi.fn()} onSave={onSave} />)
    expect(screen.getByText(/edit app target/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/app id/i) as HTMLInputElement).value).toBe('orders')
    expect((screen.getByLabelText(/^timeout policy/i) as HTMLSelectElement).value).toBe('timeout1')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('orders', expect.objectContaining({ timeout: 'timeout1', retry: 'retry1' }))
  })
})

describe('target dialogs duplicate name guard', () => {
  it('AppTargetDialog blocks saving an App ID that already exists', () => {
    render(<AppTargetDialog open policies={policies} existingNames={['orders']} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText(/^timeout policy/i), { target: { value: 'timeout1' } })
    expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
  it('AppTargetDialog allows keeping the same App ID while editing but blocks renaming onto another', () => {
    render(<AppTargetDialog open editing policies={policies} existingNames={['orders', 'billing']}
      initialName="orders" initialTarget={{ timeout: 'timeout1' }} onClose={vi.fn()} onSave={vi.fn()} />)
    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeEnabled() // unchanged name is the record being edited
    fireEvent.change(screen.getByLabelText(/app id/i), { target: { value: 'billing' } })
    expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    expect(save).toBeDisabled()
  })
  it('ActorTargetDialog blocks saving an actor type that already exists', () => {
    render(<ActorTargetDialog open policies={policies} existingNames={['myactor']} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/actor type/i), { target: { value: 'myactor' } })
    fireEvent.change(screen.getByLabelText(/^retry policy/i), { target: { value: 'retry1' } })
    expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
  it('ComponentTargetDialog blocks saving a component name that already exists', () => {
    render(<ComponentTargetDialog open policies={policies} existingNames={['statestore']} onClose={vi.fn()} onSave={vi.fn()} />)
    fireEvent.change(screen.getByLabelText(/component name/i), { target: { value: 'statestore' } })
    fireEvent.change(screen.getByLabelText(/^retry policy/i), { target: { value: 'retry1' } })
    expect(screen.getByText(/already exists/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
  })
})

describe('ComponentTargetDialog edit', () => {
  it('derives both-direction and prefills from outbound leg', () => {
    render(<ComponentTargetDialog open editing policies={policies} initialName="statestore" initialTarget={{ outbound: { retry: 'retry1' }, inbound: { retry: 'retry1' } }} onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/direction/i) as HTMLSelectElement).value).toBe('both')
    expect((screen.getByLabelText(/^retry policy/i) as HTMLSelectElement).value).toBe('retry1')
  })
})
