import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepGeneral } from './StepGeneral'
import { StepPolicies } from './StepPolicies'
import { initialState, reducer } from './reducer'

describe('StepGeneral', () => {
  it('dispatches SET_NAME', () => {
    const dispatch = vi.fn()
    render(<StepGeneral state={initialState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'my-res' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAME', name: 'my-res' })
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
  it('lists an existing retry and removes it', () => {
    const dispatch = vi.fn()
    const s = reducer(initialState(), { type: 'UPSERT_RETRY', name: 'retry1', policy: { policy: 'constant', duration: '5s' } })
    render(<StepPolicies state={s} dispatch={dispatch} />)
    fireEvent.click(screen.getByRole('button', { name: /remove retry1/i }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'REMOVE_RETRY', name: 'retry1' })
  })
})
