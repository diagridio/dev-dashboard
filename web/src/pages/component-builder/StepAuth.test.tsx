import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { StepAuth } from './StepAuth'
import { initialState, reducer } from './reducer'
import type { ComponentMetadataSchema } from '../../types/metadata'

const withProfiles: ComponentMetadataSchema = {
  type: 'bindings', name: 'aws.s3', version: 'v1', title: 'AWS S3', status: 'stable', metadata: [],
  authenticationProfiles: [
    { title: 'AWS IAM', metadata: [{ name: 'accessKey', required: true }] },
    { title: 'AWS STS', metadata: [{ name: 'sessionToken', required: true }] },
  ],
}

function stateWith(schema: ComponentMetadataSchema) {
  return reducer(initialState(), { type: 'SELECT_SCHEMA', schema, version: 'v1' })
}

describe('StepAuth', () => {
  it('shows a no-profiles message when the schema has none', () => {
    const schema: ComponentMetadataSchema = { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] }
    render(<StepAuth state={stateWith(schema)} dispatch={vi.fn()} />)
    expect(screen.getByText(/no authentication profiles/i)).toBeInTheDocument()
  })

  it('dispatches SET_AUTH_PROFILE with the chosen profile', () => {
    const dispatch = vi.fn()
    render(<StepAuth state={stateWith(withProfiles)} dispatch={dispatch} />)
    fireEvent.change(screen.getByLabelText(/authentication profile/i), { target: { value: 'AWS STS' } })
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SET_AUTH_PROFILE', profile: expect.objectContaining({ title: 'AWS STS' }) }),
    )
  })
})
