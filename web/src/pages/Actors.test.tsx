import { render, screen, waitFor } from '@testing-library/react'
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
  return { router, ...render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )}
}

describe('Actors', () => {
  it('renders a row with actor type, count, and app link', async () => {
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
    expect(screen.getByText('OrderActor')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    expect(screen.getByText('localhost:50005')).toBeInTheDocument()
  })

  it('shows friendly empty state when no actors are registered', async () => {
    server.use(
      http.get('/api/actors', () => HttpResponse.json([])),
    )
    renderAt()
    await waitFor(() =>
      expect(screen.getByText(/no actors registered/i)).toBeInTheDocument(),
    )
  })

  it('shows filter affordance when ?appId= is set and clears it on click', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          { appId: 'order', type: 'OrderActor', count: 1 },
        ]),
      ),
    )
    const { router } = renderAt('/actors?appId=order')
    await screen.findByText(/filtered to order/i)
    const clearBtn = screen.getByRole('button', { name: /clear filter/i })
    await userEvent.click(clearBtn)
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('shows filter badge during loading when ?appId= is set', async () => {
    server.use(
      http.get('/api/actors', async () => {
        await delay(200)
        return HttpResponse.json([{ appId: 'order', type: 'OrderActor', count: 1 }])
      }),
    )
    renderAt('/actors?appId=order')
    // Badge should be present immediately (during loading)
    expect(screen.getByText(/filtered to order/i)).toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    // Wait for data to settle
    await screen.findByText('OrderActor')
  })
})
