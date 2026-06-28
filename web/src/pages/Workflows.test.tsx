import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Workflows } from './Workflows'

const twoStores = [
  { name: 'redis', type: 'state.redis', path: '/components/redis.yaml', active: true },
  { name: 'postgres', type: 'state.postgresql', path: '/components/pg.yaml', active: false },
]

// Register statestores handler for all tests in this file
beforeEach(() => {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(twoStores)),
  )
})

function renderAt(entry = '/workflows', retries = 0) {
  // Fresh QueryClient per test; retry:0 for fast error-state tests
  const client = new QueryClient({
    defaultOptions: { queries: { retry: retries, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/workflows', element: <Workflows /> },
      { path: '/workflows/:appId/:instanceId', element: <div>detail</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Workflows', () => {
  it('renders a workflow row linking to detail', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            {
              appId: 'order',
              instanceId: 'abc',
              name: 'OrderWorkflow',
              status: 'Running',
              createdAt: '2026-06-26T10:00:00Z',
            },
          ],
        }),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'abc' })
    expect(link).toHaveAttribute('href', '/workflows/order/abc')
    // StatusPill renders status in UPPERCASE per mock design
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('shows the no-store message on 503', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'no state store detected' }, { status: 503 }),
      ),
    )
    renderAt()
    await waitFor(() => expect(screen.getByText(/no state store detected/i)).toBeInTheDocument())
    expect(screen.getByText(/--statestore/)).toBeInTheDocument()
  })

  it('shows an empty state when items is an empty array', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no workflows/i)).toBeInTheDocument())
  })

  it('shows empty state and does not crash when items is null', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: null })))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no workflows/i)).toBeInTheDocument())
  })

  it('renders store-select with both store options', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    // Wait for stores to load (select appears once statestores resolves)
    await waitFor(() => expect(document.querySelector('[data-cy="store-select"]')).not.toBeNull())
    const select = document.querySelector('[data-cy="store-select"]') as HTMLSelectElement
    const options = select.querySelectorAll('option')
    expect(options).toHaveLength(2)
    expect(options[0]).toHaveValue('redis')
    expect(options[1]).toHaveValue('postgres')
  })

  it('selecting a non-active store updates URL and passes store param to /api/workflows', async () => {
    let capturedStoreParam: string | null = null
    server.use(
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        capturedStoreParam = url.searchParams.get('store')
        return HttpResponse.json({ items: [] })
      }),
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: 0, staleTime: 0 } },
    })
    const router = createMemoryRouter(
      [
        { path: '/workflows', element: <Workflows /> },
        { path: '/workflows/:appId/:instanceId', element: <div>detail</div> },
      ],
      { initialEntries: ['/workflows'], future: { v7_relativeSplatPath: true } },
    )
    render(
      <QueryProvider client={client}>
        <RefreshProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </RefreshProvider>
      </QueryProvider>,
    )
    // Wait for store-select to appear with stores loaded
    await waitFor(() => expect(document.querySelector('[data-cy="store-select"]')).not.toBeNull())
    const select = document.querySelector('[data-cy="store-select"]') as HTMLSelectElement
    // Change to the non-active store
    await userEvent.selectOptions(select, 'postgres')
    // Assert URL search params updated
    await waitFor(() => expect(router.state.location.search).toContain('store=postgres'))
    // Assert workflow query fired with store param
    await waitFor(() => expect(capturedStoreParam).toBe('postgres'))
  })
})
