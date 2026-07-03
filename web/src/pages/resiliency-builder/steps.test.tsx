import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepGeneral } from './StepGeneral'
import { StepPolicies } from './StepPolicies'
import { StepTargets } from './StepTargets'
import { initialState, reducer } from './reducer'

describe('StepGeneral', () => {
  it('dispatches SET_NAME', () => {
    const dispatch = vi.fn()
    render(<StepGeneral state={initialState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-res' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAME', name: 'my-res' })
  })
  it('dispatches SET_NAMESPACE', () => {
    const dispatch = vi.fn()
    render(<StepGeneral state={initialState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText('Namespace'), { target: { value: 'my-ns' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAMESPACE', namespace: 'my-ns' })
  })
})

describe('StepPolicies', () => {
  it('opens the timeout dialog and dispatches UPSERT_TIMEOUT on save', () => {
    const dispatch = vi.fn()
    render(<StepPolicies state={initialState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '30s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
  })
  it('second add timeout uses name timeout2 not timeout1', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /add timeouts/i }))
    fireEvent.change(screen.getByLabelText(/duration/i), { target: { value: '60s' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_TIMEOUT', name: 'timeout2', duration: '60s' })
  })
  it('lists an existing retry and removes it', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s' } })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /remove retry1/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_RETRY', name: 'retry1' })
  })
  it('edits an existing timeout via chip click (rename dispatches rename + upsert)', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /edit timeout1/i }))
    fireEvent.change(screen.getByLabelText(/timeout name/i), { target: { value: 'renamed' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'RENAME_TIMEOUT', from: 'timeout1', to: 'renamed' })
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_TIMEOUT', name: 'renamed', duration: '30s' })
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'REMOVE_TIMEOUT', name: 'timeout1' })
  })
  it('adds a DaprBuiltIn override with prefilled defaults', () => {
    const dispatch = vi.fn()
    render(<StepPolicies state={initialState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /add DaprBuiltInServiceRetries/i }))
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({
      type: 'UPSERT_RETRY',
      name: 'DaprBuiltInServiceRetries',
      policy: expect.objectContaining({ policy: 'constant', duration: '1s', maxRetries: 3 }),
    })
  })
  it('does not list a DaprBuiltIn override in the regular Retries list', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'DaprBuiltInServiceRetries', policy: { policy: 'constant', duration: '1s', maxRetries: 3 } })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    // present as an editable override chip, but not offered as an "Add" row anymore
    expect(screen.getByRole('button', { name: /edit DaprBuiltInServiceRetries/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /add DaprBuiltInServiceRetries/i })).not.toBeInTheDocument()
  })
})

describe('StepTargets', () => {
  it('edits an existing app target via chip click', () => {
    const dispatch = vi.fn()
    let s = reducer(initialState(), { type: 'UPSERT_TIMEOUT', name: 'timeout1', duration: '30s' })
    s = reducer(s, { type: 'UPSERT_APP', name: 'orders', target: { timeout: 'timeout1' } })
    render(<StepTargets state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /edit orders/i }))
    expect((screen.getByLabelText(/app id/i) as HTMLInputElement).value).toBe('orders')
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'UPSERT_APP', name: 'orders', target: expect.objectContaining({ timeout: 'timeout1' }) })
  })
})
