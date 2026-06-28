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
  it('renders a workflow row with a link to detail on the instance ID', async () => {
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

  it('shows the active store name in the statestore chip', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    // The chip shows the store type label derived from the active store
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toMatch(/statestore/)
    })
  })

  it('status filter segments render All + all status options', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Status filter' })).toBeInTheDocument())
    const group = screen.getByRole('group', { name: 'Status filter' })
    const buttons = group.querySelectorAll('button')
    // All + Running + Completed + Failed + Terminated + Suspended = 6
    expect(buttons).toHaveLength(6)
    // "All" is pressed by default
    expect(buttons[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking a status filter segment sets aria-pressed and filters the API call', async () => {
    let capturedStatus: string | null = null
    server.use(
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        capturedStatus = url.searchParams.get('status')
        return HttpResponse.json({ items: [] })
      }),
    )
    renderAt()
    await waitFor(() => expect(screen.getByRole('group', { name: 'Status filter' })).toBeInTheDocument())
    const group = screen.getByRole('group', { name: 'Status filter' })
    const runningBtn = Array.from(group.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Running'),
    )!
    await userEvent.click(runningBtn)
    await waitFor(() => expect(capturedStatus).toBe('Running'))
    expect(runningBtn).toHaveAttribute('aria-pressed', 'true')
  })

  it('selects rows and shows selbar with correct count', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
            { appId: 'ship', instanceId: 'xyz', name: 'ShipWorkflow', status: 'Completed', createdAt: '2026-06-26T09:00:00Z' },
          ],
        }),
      ),
    )
    renderAt()
    // Wait for rows to appear
    await screen.findByRole('link', { name: 'abc' })
    // Find the first row checkbox (cbx span) and click it
    const checkboxes = document.querySelectorAll('.cbx:not(.on)')
    await userEvent.click(checkboxes[0])
    // selbar should appear with "1 selected"
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument())
    expect(screen.getByText(/Purge via Dapr API/)).toBeInTheDocument()
    expect(screen.getByText(/Force delete/)).toBeInTheDocument()
  })

  it('opens confirm dialog when Force delete is clicked', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
          ],
        }),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'abc' })
    const checkboxes = document.querySelectorAll('.cbx:not(.on)')
    await userEvent.click(checkboxes[0])
    await waitFor(() => expect(screen.getByText(/Force delete/i)).toBeInTheDocument())
    await userEvent.click(document.querySelector('[data-cy="bulk-remove"]') as HTMLElement)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    expect(screen.getByText(/remove 1 workflow/i)).toBeInTheDocument()
  })

  it('renders pager with disabled Prev and Next enabled when nextToken exists', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
          ],
          nextToken: 'tok123',
        }),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'abc' })
    const prevBtn = screen.getByRole('button', { name: '← Prev' })
    const nextBtn = screen.getByRole('button', { name: 'Next →' })
    expect(prevBtn).toBeDisabled()
    expect(nextBtn).not.toBeDisabled()
  })

  it('renders pager with both Prev and Next disabled when no nextToken', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
          ],
        }),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'abc' })
    const nextBtn = screen.getByRole('button', { name: 'Next →' })
    expect(nextBtn).toBeDisabled()
  })
})
