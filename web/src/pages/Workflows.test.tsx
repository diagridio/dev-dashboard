import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Workflows } from './Workflows'

const activeStoreOnly = [
  { name: 'redis', type: 'state.redis', path: '/components/redis.yaml', active: true, connection: 'localhost:6379' },
]

// Register statestores handler for all tests in this file
beforeEach(() => {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(activeStoreOnly)),
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

  it('shows the active store type and connection as a label in the statestore chip', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip).not.toBeNull()
      expect(chip?.textContent).toMatch(/statestore/)
      // "state.redis" → "redis", plus the secrets-free connection summary
      expect(chip?.textContent).toMatch(/redis · localhost:6379/)
    })
  })

  it('renders the statestore as a label, not a select', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip).not.toBeNull()
    })
    expect(document.querySelector('select[aria-label="Switch state store"]')).toBeNull()
  })

  it('keeps the colored status dot in the statestore chip', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => {
      const chip = document.querySelector('.chip')
      expect(chip?.querySelector('.led')).not.toBeNull()
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
    // Find the first row checkbox (cbx span in tbody) and click it
    const checkboxes = document.querySelectorAll('tbody .cbx:not(.on)')
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
    const checkboxes = document.querySelectorAll('tbody .cbx:not(.on)')
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

  it('Instance ID link uses the table text color (celllink class)', async () => {
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
    expect(await screen.findByRole('link', { name: 'abc' })).toHaveClass('celllink')
  })

  it('marks app-ids that are not currently running', async () => {
    server.use(
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'wf-app', health: 'healthy', components: [] }]),
      ),
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'pr-digest', instanceId: 'i1', name: 'AgentRunWorkflow', status: 'Completed', createdAt: '2026-06-29T10:00:00Z' },
            { appId: 'wf-app', instanceId: 'i2', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:01:00Z' },
          ],
        }),
      ),
    )
    renderAt()
    // Row for the running app: no badge.
    await screen.findByRole('link', { name: 'i2' })
    // Row for the stopped app-id shows the badge.
    expect(await screen.findAllByText('not running')).toHaveLength(1)
  })

  it('defaults the dropdown to the active app-id when it has workflows', async () => {
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
      ),
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'order', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
      ),
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [{ appId: 'order', instanceId: 'i1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
        }),
      ),
    )
    renderAt()
    const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('order'))
  })

  it('falls back to All apps when the active app has no workflows', async () => {
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
      ),
      // Running app wf-app loaded the active store but has no workflows.
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'wf-app', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
      ),
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [{ appId: 'pr-digest', instanceId: 'i1', name: 'AgentRunWorkflow', status: 'Completed', createdAt: '2026-06-29T10:00:00Z' }],
        }),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'i1' })
    const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
    expect(select.value).toBe('') // All apps
  })

  it('a ?app= URL param overrides the computed default', async () => {
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([{ name: 'redis', type: 'state.redis', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
      ),
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'order', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
      ),
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [{ appId: 'order', instanceId: 'i1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
        }),
      ),
    )
    renderAt('/workflows?app=pr-digest')
    const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('pr-digest'))
  })
})

function renderPage(initialEntry = '/workflows?status=Failed') {
  return render(
    <QueryProvider>
      <RefreshProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Workflows />
        </MemoryRouter>
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Workflows page — statestore chip', () => {
  it('renders the statestore chip as a link to its component', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/statestores', () =>
        HttpResponse.json([
          { name: 'statestore', type: 'state.redis', path: '/x', active: true, connection: 'localhost:6379' },
        ]),
      ),
    )
    renderPage('/workflows')
    const chip = await screen.findByRole('link', { name: /statestore/ })
    expect(chip).toHaveAttribute('href', '/components/statestore')
  })
})

describe('Workflows page — status counts', () => {
  it('shows per-status counts from /stats even when a status filter is active', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ items: [{ appId: 'order', instanceId: 'f1', name: 'W', status: 'Failed' }] }),
      ),
      http.get('/api/workflows/stats', () =>
        HttpResponse.json({ counts: { Running: 5, Completed: 9, Failed: 1 }, total: 15 }),
      ),
      http.get('/api/statestores', () => HttpResponse.json([])),
    )
    renderPage('/workflows?status=Failed')
    // "Completed" badge stays populated (9) even though the active filter is Failed.
    const completedBtn = await screen.findByRole('button', { name: /Completed/ })
    await waitFor(() => expect(completedBtn).toHaveTextContent('9'))
    const allBtn = screen.getByRole('button', { name: /^All/ })
    expect(allBtn).toHaveTextContent('15')
  })
})

describe('Workflows page — select all', () => {
  it('select-all header checkbox selects then clears all loaded rows', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'a', name: 'W', status: 'Running' },
            { appId: 'order', instanceId: 'b', name: 'W', status: 'Running' },
          ],
        }),
      ),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: { Running: 2 }, total: 2 })),
      http.get('/api/statestores', () => HttpResponse.json([])),
    )
    renderPage('/workflows')
    const selectAll = await screen.findByRole('checkbox', { name: /select all/i })
    fireEvent.click(selectAll)
    await waitFor(() => expect(screen.getByText('2 selected')).toBeInTheDocument())
    fireEvent.click(selectAll)
    await waitFor(() => expect(screen.queryByText('2 selected')).not.toBeInTheDocument())
  })
})
