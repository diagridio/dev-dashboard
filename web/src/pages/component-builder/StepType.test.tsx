import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { StepType } from './StepType'
import { initialState } from './reducer'

const bundle = {
  schemaVersion: '1', date: '2026-01-01',
  components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable', metadata: [] },
    { type: 'pubsub', name: 'kafka', version: 'v1', title: 'Apache Kafka', status: 'stable', metadata: [] },
  ],
}

function renderStep(dispatch = vi.fn()) {
  server.use(http.get('/api/metadata/components', () => HttpResponse.json(bundle)))
  return render(
    <QueryProvider client={makeQueryClient()}>
      <StepType state={initialState()} dispatch={dispatch} />
    </QueryProvider>,
  )
}

describe('StepType', () => {
  it('lists schemas and filters by search text', async () => {
    renderStep()
    await screen.findByText('Redis')
    expect(screen.getByText('Apache Kafka')).toBeInTheDocument()
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'kafka' } })
    expect(screen.queryByText('Redis')).not.toBeInTheDocument()
    expect(screen.getByText('Apache Kafka')).toBeInTheDocument()
  })

  it('dispatches SELECT_SCHEMA with schema + version on click', async () => {
    const dispatch = vi.fn()
    renderStep(dispatch)
    fireEvent.click(await screen.findByText('Redis'))
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SELECT_SCHEMA', version: 'v1' }),
    )
    expect(dispatch.mock.calls[0][0].schema.name).toBe('redis')
  })
})
