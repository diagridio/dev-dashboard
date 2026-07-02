import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NamedList, TimeoutDialog, RetryDialog } from './policyDialogs'

describe('NamedList', () => {
  it('renders names, add, and remove', () => {
    const onAdd = vi.fn(); const onRemove = vi.fn()
    render(<NamedList title="Timeouts" names={['timeout1']} onAdd={onAdd} onRemove={onRemove} />)
    expect(screen.getByText('timeout1')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    expect(onAdd).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /remove timeout1/i }))
    expect(onRemove).toHaveBeenCalledWith('timeout1')
  })
})

describe('TimeoutDialog', () => {
  it('saves a valid name + duration and blocks invalid duration', () => {
    const onSave = vi.fn(); const onClose = vi.fn()
    render(<TimeoutDialog open initialName="timeout1" onClose={onClose} onSave={onSave} />)
    const confirm = screen.getByRole('button', { name: /save/i })
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: 'nope' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    expect(onSave).toHaveBeenCalledWith('timeout1', '30s')
  })
})

describe('RetryDialog', () => {
  it('saves a constant retry policy', () => {
    const onSave = vi.fn()
    render(<RetryDialog open initialName="retry1" onClose={vi.fn()} onSave={onSave} />)
    fireEvent.change(screen.getByLabelText(/^duration/i), { target: { value: '5s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('retry1', expect.objectContaining({ policy: 'constant', duration: '5s' }))
  })
})
