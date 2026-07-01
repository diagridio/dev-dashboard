import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepConfigure } from './StepConfigure'
import { initialState, reducer } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const redis: ComponentMetadataSchema = {
  type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
  metadata: [{ name: 'redisHost', required: true }, { name: 'enableTLS', type: 'bool' }],
}
function configureState() {
  let s = reducer(initialState(), { type: 'SELECT_SCHEMA', schema: redis, version: 'v1' })
  s = reducer(s, { type: 'NEXT' }) // -> step 2
  return s
}

describe('StepConfigure', () => {
  it('dispatches SET_NAME and shows a validation error for a bad name', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    const name = screen.getByLabelText(/^Name\s*\*?$/)
    fireEvent.change(name, { target: { value: 'Bad Name' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_NAME', name: 'Bad Name' })
  })

  it('renders the required field and dispatches SET_VALUE', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    expect(dispatch).toHaveBeenCalledWith({ type: 'SET_VALUE', field: 'redisHost', value: 'localhost:6379' })
  })

  it('toggling "use secret" for a field dispatches TOGGLE_SECRET', () => {
    const dispatch = vi.fn()
    render(<StepConfigure state={configureState()} dispatch={dispatch} />)
    fireEvent.click(screen.getByLabelText(/use secret for redisHost/i))
    expect(dispatch).toHaveBeenCalledWith({ type: 'TOGGLE_SECRET', field: 'redisHost', on: true })
  })
})
