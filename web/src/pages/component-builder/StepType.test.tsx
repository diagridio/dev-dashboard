import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { StepType } from './StepType'
import { initialState, reducer } from './reducer'
import type { ComponentBuilderState } from './reducer'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] },
    { type: 'state', name: 'postgresql', version: 'v1', title: 'PostgreSQL', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'kafka', version: 'v1', title: 'Apache Kafka', status: 'stable', metadata: [] },
  ],
}

function renderStep(state: ComponentBuilderState, dispatch = vi.fn()) {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  return render(
    <QueryProvider client={makeQueryClient()}>
      <StepType state={state} dispatch={dispatch} />
    </QueryProvider>,
  )
}

describe('StepType category filter', () => {
  it('shows category chips and a hint before any category is chosen', async () => {
    renderStep(initialState())
    expect(await screen.findByRole('button', { name: 'state' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'pubsub' })).toBeInTheDocument()
    expect(screen.getByText(/choose a category/i)).toBeInTheDocument()
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
  })

  it('clicking a category chip dispatches SELECT_CATEGORY', async () => {
    const dispatch = vi.fn()
    renderStep(initialState(), dispatch)
    fireEvent.click(await screen.findByRole('button', { name: 'state' }))
    expect(dispatch).toHaveBeenCalledWith({ type: 'SELECT_CATEGORY', category: 'state' })
  })

  it('with a category selected, lists only that category and scopes search', async () => {
    const state = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    renderStep(state)
    expect(await screen.findByText('Redis')).toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
    expect(screen.queryByText('Apache Kafka')).not.toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'postgres' } })
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
    expect(screen.getByText('PostgreSQL')).toBeInTheDocument()
  })

  it('clicking a component dispatches SELECT_SCHEMA with its version', async () => {
    const dispatch = vi.fn()
    const state = reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' })
    renderStep(state, dispatch)
    fireEvent.click(await screen.findByText('Redis'))
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: 'SELECT_SCHEMA', version: 'v1' }))
    expect(dispatch.mock.calls[dispatch.mock.calls.length - 1]?.[0].schema.name).toBe('redis')
  })

  it('clears the search query when the category changes', async () => {
    const { rerender } = renderStep(reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'state' }))
    const box = await screen.findByRole('searchbox')
    fireEvent.change(box, { target: { value: 'redis' } })
    expect((box as HTMLInputElement).value).toBe('redis')
    // switch category via a fresh state prop
    rerender(
      <QueryProvider client={makeQueryClient()}>
        <StepType state={reducer(initialState(), { type: 'SELECT_CATEGORY', category: 'pubsub' })} dispatch={vi.fn()} />
      </QueryProvider>,
    )
    expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('')
  })
})
