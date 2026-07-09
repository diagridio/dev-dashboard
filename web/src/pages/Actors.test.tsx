import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse, delay } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Actors } from './Actors'

function renderAt(entry = '/actors') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/actors', element: <Actors /> },
      { path: '/apps/:appId', element: <div>app detail</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return {
    router,
    ...render(
      <QueryProvider client={client}>
        <RefreshProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </RefreshProvider>
      </QueryProvider>,
    ),
  }
}

describe('Actors', () => {
  it('renders a row with actor type, count, app link, and connected placement', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          { appId: 'order', type: 'OrderActor', count: 3, placement: 'localhost:50005' },
        ]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
    // Scope assertions to the table row so they don't collide with stat cards
    const row = within(link.closest('tr') as HTMLElement)
    expect(row.getByText('OrderActor')).toBeInTheDocument()
    expect(row.getByText('3')).toBeInTheDocument()
    // Placement shown as a "connected" health pill, not the raw address
    expect(row.getByText(/connected/i)).toBeInTheDocument()
    expect(screen.queryByText('localhost:50005')).not.toBeInTheDocument()
  })

  it('tags internal actor types with an internal badge', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          { appId: 'order', type: 'dapr.internal.default.order.workflow', count: 5 },
        ]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    // Scope to the table row so the .tag-int badge in the hint footer doesn't collide
    const row = within(link.closest('tr') as HTMLElement)
    expect(row.getByText(/dapr\.internal/i)).toBeInTheDocument()
    expect(row.getByText(/^internal$/i)).toBeInTheDocument()
  })

  it('shows friendly empty state when no actors are registered', async () => {
    server.use(http.get('/api/actors', () => HttpResponse.json([])))
    renderAt()
    await waitFor(() =>
      expect(screen.getByText(/no actors registered/i)).toBeInTheDocument(),
    )
  })

  it('shows filter affordance when ?appId= is set and clears it on click', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([{ appId: 'order', type: 'OrderActor', count: 1 }]),
      ),
    )
    const { router } = renderAt('/actors?appId=order')
    await screen.findByText(/filtered to order/i)
    const clearBtn = screen.getByRole('button', { name: /clear filter/i })
    await userEvent.click(clearBtn)
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('shows filter affordance during loading when ?appId= is set', async () => {
    server.use(
      http.get('/api/actors', async () => {
        await delay(200)
        return HttpResponse.json([{ appId: 'order', type: 'OrderActor', count: 1 }])
      }),
    )
    renderAt('/actors?appId=order')
    expect(screen.getByText(/filtered to order/i)).toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    await screen.findByText('OrderActor')
  })

  it('duplicate-app-id instances render distinct rows linking by instanceKey', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-1', type: 'QueueActor', count: 1, placement: 'connected' },
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-2', type: 'QueueActor', count: 2, placement: 'connected' },
        ]),
      ),
    )
    renderAt()
    const links = await screen.findAllByRole('link', { name: /daprmq-service/ })
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/apps/daprmq-host-1', '/apps/daprmq-host-2'])
    // Container names shown to tell the rows apart.
    expect(screen.getByText('(daprmq-host-1)')).toBeInTheDocument()
    expect(screen.getByText('(daprmq-host-2)')).toBeInTheDocument()
  })
})
