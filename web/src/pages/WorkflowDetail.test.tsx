import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { WorkflowDetail } from './WorkflowDetail'

function renderDetail() {
  const router = createMemoryRouter(
    [{ path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> }],
    { initialEntries: ['/workflows/order/abc'] },
  )
  return render(<QueryProvider><RefreshProvider><RouterProvider router={router} /></RefreshProvider></QueryProvider>)
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
})
