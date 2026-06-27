import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { WorkflowDetail } from './WorkflowDetail'

function renderDetail(client?: QueryClient) {
  const router = createMemoryRouter(
    [{ path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> }],
    { initialEntries: ['/workflows/order/abc'], future: { v7_relativeSplatPath: true } },
  )
  return render(<QueryProvider client={client}><RefreshProvider><RouterProvider router={router} future={{ v7_startTransition: true }} /></RefreshProvider></QueryProvider>)
}

describe('WorkflowDetail', () => {
  it('renders header, input and history', async () => {
    server.use(http.get('/api/workflows/order/abc', () => HttpResponse.json({
      appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
      createdAt: '2026-06-26T10:00:00Z', replayCount: 0, input: '{"id":1}',
      history: [
        { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
        { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
      ],
    })))
    renderDetail()
    await waitFor(() => expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0))
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()
  })

  it('Running→Completed: refetch replaces history with updated server state (all rows present)', async () => {
    // Phase 1: Running with 2 history events
    server.use(http.get('/api/workflows/order/abc', () => HttpResponse.json({
      appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
      createdAt: '2026-06-26T10:00:00Z', replayCount: 0,
      history: [
        { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
        { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
      ],
    })))
    const client = makeQueryClient()
    renderDetail(client)
    await waitFor(() => expect(screen.getByText('Running')).toBeInTheDocument())
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()

    // Phase 2: Same workflow now Completed with 3 events (first 2 same sequenceIds + new 3rd)
    server.use(http.get('/api/workflows/order/abc', () => HttpResponse.json({
      appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Completed',
      createdAt: '2026-06-26T10:00:00Z', lastUpdatedAt: '2026-06-26T10:00:05Z', replayCount: 0,
      history: [
        { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
        { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
        { sequenceId: 2, timestamp: '2026-06-26T10:00:05Z', type: 'ExecutionCompleted', name: 'OrderWorkflow' },
      ],
    })))

    // Drive a refetch via QueryClient invalidation
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workflow', 'order', 'abc'] })
    })

    await waitFor(() => expect(screen.getByText('Completed')).toBeInTheDocument())
    // All 3 events rendered
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()
    expect(screen.getByText('ExecutionCompleted')).toBeInTheDocument()
    // Original 2 rows still present (same sequenceIds preserved)
    expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0)
  })

  it('clicking wf-remove opens confirm-remove dialog', async () => {
    server.use(http.get('/api/workflows/order/abc', () => HttpResponse.json({
      appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
      createdAt: '2026-06-26T10:00:00Z', replayCount: 0,
      history: [],
    })))
    renderDetail()
    await waitFor(() => expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0))
    // Dialog should not be visible yet
    expect(document.querySelector('[data-cy="confirm-remove"]')).toBeNull()
    // Click wf-remove button
    await userEvent.click(document.querySelector('[data-cy="wf-remove"]') as HTMLElement)
    // Dialog confirm button should now be in the DOM
    expect(document.querySelector('[data-cy="confirm-remove"]')).not.toBeNull()
  })
})
