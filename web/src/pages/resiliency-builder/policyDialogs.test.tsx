import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { NamedList, TimeoutDialog, RetryDialog, CircuitBreakerDialog } from './policyDialogs'

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
  it('fires onEdit from the chip body and not on remove', () => {
    const onEdit = vi.fn(); const onRemove = vi.fn()
    render(<NamedList title="Timeouts" names={['timeout1']} onAdd={vi.fn()} onRemove={onRemove} onEdit={onEdit} />)
    fireEvent.click(screen.getByRole('button', { name: /edit timeout1/i }))
    expect(onEdit).toHaveBeenCalledWith('timeout1')
    expect(onRemove).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /remove timeout1/i }))
    expect(onRemove).toHaveBeenCalledWith('timeout1')
    expect(onEdit).toHaveBeenCalledTimes(1)
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

describe('TimeoutDialog defaults + edit', () => {
  it('prefills 5s on add', () => {
    render(<TimeoutDialog open initialName="timeout1" onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/duration/i) as HTMLInputElement).value).toBe('5s')
  })
  it('prefills the existing duration and title on edit', () => {
    const onSave = vi.fn()
    render(<TimeoutDialog open editing initialName="timeout1" initialDuration="42s" onClose={vi.fn()} onSave={onSave} />)
    expect(screen.getByText(/edit timeout policy/i)).toBeInTheDocument()
    expect((screen.getByLabelText(/duration/i) as HTMLInputElement).value).toBe('42s')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('timeout1', '42s')
  })
})

describe('CircuitBreakerDialog defaults', () => {
  it('prefills canonical defaults as real text', () => {
    render(<CircuitBreakerDialog open initialName="circuitBreaker1" onClose={vi.fn()} onSave={vi.fn()} />)
    expect((screen.getByLabelText(/max requests/i) as HTMLInputElement).value).toBe('1')
    expect((screen.getByLabelText(/^timeout/i) as HTMLInputElement).value).toBe('45s')
    expect((screen.getByLabelText(/trip/i) as HTMLInputElement).value).toBe('consecutiveFailures >= 5')
    expect((screen.getByLabelText(/interval/i) as HTMLInputElement).value).toBe('8s')
  })
})

describe('RetryDialog edit + lock + keep-duration', () => {
  it('locks the name when lockName is set', () => {
    render(<RetryDialog open initialName="DaprBuiltInServiceRetries" lockName onClose={vi.fn()} onSave={vi.fn()} />)
    expect(screen.queryByLabelText(/retry name/i)).not.toBeInTheDocument()
    expect(screen.getByText('DaprBuiltInServiceRetries')).toBeInTheDocument()
  })
  it('keeps duration for an exponential override on save', () => {
    const onSave = vi.fn()
    render(
      <RetryDialog open editing lockName keepDurationForExponential
        initialName="DaprBuiltInActorReminderRetries"
        initialPolicy={{ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 }}
        onClose={vi.fn()} onSave={onSave} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalledWith('DaprBuiltInActorReminderRetries', expect.objectContaining({ policy: 'exponential', duration: '15m', maxInterval: '60s', maxRetries: 3 }))
  })
})
