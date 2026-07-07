import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, MemoryRouter } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { QueryClient, focusManager } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Workflows } from './Workflows'

const activeStoreOnly = [
  { id: 'redis-auto', name: 'redis', type: 'state.redis', source: 'auto', path: '/components/redis.yaml', active: true, connection: 'localhost:6379' },
]

// Register default handlers for all tests in this file.
// Individual tests may override these with server.use(...) before the assertion.
beforeEach(() => {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(activeStoreOnly)),
    http.get('/api/apps', () => HttpResponse.json([])),
    http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
    http.get('/api/workflows/appids', () => HttpResponse.json([])),
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
  it('sets the document title to Workflows', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => expect(document.title).toBe('Workflows | Diagrid Dev Dashboard'))
  })

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
    // Store id 'redis-auto' is auto-selected from the default activeStoreOnly fixture.
    expect(link).toHaveAttribute('href', '/workflows/order/abc?store=redis-auto')
    // StatusPill renders status in UPPERCASE per mock design
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('degrades gracefully on a no-store 503: banner + chrome, no full-page guidance', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'no state store detected' }, { status: 503 }),
      ),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent(/no state store detected/i)
    expect(banner).toHaveTextContent(/select another state store or check the connection/i)
    // Page chrome still rendered: store selector and filters are usable.
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Status filter' })).toBeInTheDocument()
    // The --statestore full-page guidance is only for an empty store list.
    expect(screen.queryByText(/--statestore/)).toBeNull()
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

  it('renders the store selector with the active store selected and an active marker', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    // value is the store id, not its name
    await waitFor(() => expect(storeSelect.value).toBe('redis-auto'))
    const opt = storeSelect.querySelector('option[value="redis-auto"]') as HTMLOptionElement
    // label: "name — type · connection (active)"
    expect(opt.textContent).toMatch(/redis — redis · localhost:6379 \(active\)/)
  })

  it('keeps a component link beside the store selector pointing at the selected store', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: /open the .* component page/i })
    expect(link).toHaveAttribute('href', '/components/redis')
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

  it('Prev navigates back to the previous page after going Next', async () => {
    server.use(
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        const page = url.searchParams.get('page')
        if (page === 'tok1') {
          // Second (last) page — no further nextToken.
          return HttpResponse.json({
            items: [
              { appId: 'order', instanceId: 'def', name: 'OrderWorkflow', status: 'Completed', createdAt: '2026-06-26T11:00:00Z' },
            ],
          })
        }
        // First page.
        return HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
          ],
          nextToken: 'tok1',
        })
      }),
    )
    renderAt()
    await screen.findByRole('link', { name: 'abc' })
    const prevBtn = screen.getByRole('button', { name: '← Prev' })
    expect(prevBtn).toBeDisabled()

    // Go to the next page.
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await screen.findByRole('link', { name: 'def' })
    expect(screen.queryByRole('link', { name: 'abc' })).toBeNull()
    // Prev is now enabled on the second page.
    expect(screen.getByRole('button', { name: '← Prev' })).not.toBeDisabled()

    // Go back — the first page must reappear and Prev disable again.
    await userEvent.click(screen.getByRole('button', { name: '← Prev' }))
    await screen.findByRole('link', { name: 'abc' })
    expect(screen.queryByRole('link', { name: 'def' })).toBeNull()
    expect(screen.getByRole('button', { name: '← Prev' })).toBeDisabled()
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
    // Row for the running app: green led.
    await screen.findByRole('link', { name: 'i2' })
    expect(await screen.findAllByRole('img', { name: 'running' })).toHaveLength(1)
    // Row for the stopped app-id: red led.
    expect(await screen.findAllByRole('img', { name: 'not running' })).toHaveLength(1)
  })

  it('keeps every store app-id in the filter after one is selected', async () => {
    // The app filter must list all app-ids in the store regardless of the active
    // selection — selecting one must not collapse the dropdown to just that app.
    server.use(
      http.get('/api/workflows/appids', () => HttpResponse.json(['order', 'pr-digest', 'ship'])),
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        const appId = url.searchParams.get('appId')
        const all = [
          { appId: 'order', instanceId: 'o1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' },
          { appId: 'pr-digest', instanceId: 'p1', name: 'AgentRunWorkflow', status: 'Completed', createdAt: '2026-06-29T09:00:00Z' },
          { appId: 'ship', instanceId: 's1', name: 'ShipWorkflow', status: 'Running', createdAt: '2026-06-29T08:00:00Z' },
        ]
        const items = appId ? all.filter((w) => w.appId === appId) : all
        return HttpResponse.json({ items })
      }),
    )
    renderAt()
    const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
    // All apps + the three store app-ids.
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(4))

    await userEvent.selectOptions(select, 'order')
    await waitFor(() => expect(select.value).toBe('order'))

    // Bug regression: the other app-ids must still be selectable.
    await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(4))
    const values = Array.from(select.querySelectorAll('option')).map((o) => o.value)
    expect(values).toEqual(expect.arrayContaining(['', 'order', 'pr-digest', 'ship']))
  })

  it('defaults the dropdown to the active app-id when it has workflows', async () => {
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([{ id: 'redis-auto', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
      ),
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'order', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
      ),
      http.get('/api/workflows/appids', () => HttpResponse.json(['order'])),
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
        HttpResponse.json([{ id: 'redis-auto', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
      ),
      // Running app wf-app loaded the active store but has no workflows.
      http.get('/api/apps', () =>
        HttpResponse.json([{ appId: 'wf-app', health: 'healthy', components: [{ name: 'redis', type: 'state.redis' }] }]),
      ),
      http.get('/api/workflows/appids', () => HttpResponse.json(['pr-digest'])),
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
        HttpResponse.json([{ id: 'redis-auto', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis.yaml', active: true, connection: 'localhost:6379' }]),
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

describe('Workflows page — selection reset', () => {
  const twoRows = [
    { appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' },
    { appId: 'ship', instanceId: 'xyz', name: 'ShipWorkflow', status: 'Completed', createdAt: '2026-06-26T09:00:00Z' },
  ]

  async function selectFirstRow() {
    await screen.findByRole('link', { name: 'abc' })
    const checkboxes = document.querySelectorAll('tbody .cbx:not(.on)')
    await userEvent.click(checkboxes[0])
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument())
  }

  it('clears the selection when the status filter changes', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: twoRows })))
    renderAt()
    await selectFirstRow()
    const group = screen.getByRole('group', { name: 'Status filter' })
    const runningBtn = Array.from(group.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('Running'),
    )!
    await userEvent.click(runningBtn)
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
  })

  it('clears the selection when navigating to the next page', async () => {
    server.use(
      http.get('/api/workflows', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        if (page === 'tok1') {
          return HttpResponse.json({
            items: [{ appId: 'order', instanceId: 'def', name: 'OrderWorkflow', status: 'Completed', createdAt: '2026-06-26T11:00:00Z' }],
          })
        }
        return HttpResponse.json({ items: twoRows, nextToken: 'tok1' })
      }),
    )
    renderAt()
    await selectFirstRow()
    await userEvent.click(screen.getByRole('button', { name: 'Next →' }))
    await screen.findByRole('link', { name: 'def' })
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
    // Going back must not resurrect the stale selection either.
    await userEvent.click(screen.getByRole('button', { name: '← Prev' }))
    await screen.findByRole('link', { name: 'abc' })
    expect(screen.queryByText('1 selected')).not.toBeInTheDocument()
  })

  it('clears the selection when the app filter changes', async () => {
    server.use(
      http.get('/api/workflows/appids', () => HttpResponse.json(['order', 'ship'])),
      http.get('/api/workflows', () => HttpResponse.json({ items: twoRows })),
    )
    renderAt()
    await selectFirstRow()
    const select = (await screen.findByTestId('app-select')) as HTMLSelectElement
    await userEvent.selectOptions(select, 'ship')
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
  })

  it('clears the selection when the search input changes', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: twoRows })))
    renderAt()
    await selectFirstRow()
    await userEvent.type(screen.getByLabelText('Search'), 'x')
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
  })

  it('clears the selection when the store changes', async () => {
    window.localStorage.clear()
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([
          { id: 'statestore-a', name: 'statestore', type: 'state.redis', source: 'auto', path: '/a', active: true, connection: 'localhost:6379' },
          { id: 'statestore-b', name: 'statestore', type: 'state.redis', source: 'manual', path: '/b', active: false, connection: 'localhost:16379' },
        ]),
      ),
      http.get('/api/workflows', () => HttpResponse.json({ items: twoRows })),
    )
    renderAt()
    await selectFirstRow()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await userEvent.selectOptions(storeSelect, 'statestore-b')
    await waitFor(() => expect(screen.queryByText('1 selected')).not.toBeInTheDocument())
  })
})

describe('Workflows page — URL status validation', () => {
  it('falls back to All and sends no status param when ?status= is not a valid status', async () => {
    const statusParams: (string | null)[] = []
    server.use(
      http.get('/api/workflows', ({ request }) => {
        statusParams.push(new URL(request.url).searchParams.get('status'))
        return HttpResponse.json({ items: [] })
      }),
    )
    renderAt('/workflows?status=Garbage')
    await waitFor(() => expect(statusParams.length).toBeGreaterThan(0))
    // No bogus status must ever reach the API.
    statusParams.forEach((s) => expect(s).toBeNull())
    const group = screen.getByRole('group', { name: 'Status filter' })
    expect(group.querySelectorAll('button')[0]).toHaveAttribute('aria-pressed', 'true')
  })

  it('still honors a valid ?status= param', async () => {
    const statusParams: (string | null)[] = []
    server.use(
      http.get('/api/workflows', ({ request }) => {
        statusParams.push(new URL(request.url).searchParams.get('status'))
        return HttpResponse.json({ items: [] })
      }),
    )
    renderAt('/workflows?status=Failed')
    await waitFor(() => expect(statusParams).toContain('Failed'))
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
  it('renders the store selector and a component link for the selected store', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/statestores', () =>
        HttpResponse.json([
          { id: 'statestore-auto', name: 'statestore', type: 'state.redis', source: 'auto', path: '/x', active: true, connection: 'localhost:6379' },
        ]),
      ),
    )
    renderPage('/workflows')
    const link = await screen.findByRole('link', { name: /open the statestore component page/i })
    expect(link).toHaveAttribute('href', '/components/statestore')
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

describe('Workflows page — store-resolve loading gate', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  it('shows no-store guidance (not "Loading…") when /api/statestores returns an empty array', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json([])),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    )
    renderAt()
    await waitFor(() => expect(screen.getByText(/no state store detected/i)).toBeInTheDocument())
    expect(screen.getByText(/--statestore/)).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()
  })

  it('shows the loading state (not "No workflows found") while the store list is unresolved', async () => {
    // Delay the /api/statestores response so selectedStore stays null initially
    let resolveStores!: () => void
    const storesPromise = new Promise<void>((res) => { resolveStores = res })
    server.use(
      http.get('/api/statestores', async () => {
        await storesPromise
        return HttpResponse.json(activeStoreOnly)
      }),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    )
    renderAt()
    // Before stores resolve the page must show Loading…, not the empty state
    expect(screen.getByText('Loading…')).toBeInTheDocument()
    expect(screen.queryByText(/no workflows/i)).toBeNull()
    // Unblock and confirm transition to empty state
    resolveStores()
    await waitFor(() => expect(screen.getByText(/no workflows/i)).toBeInTheDocument())
  })

  it('does not issue a /api/workflows/stats request without a ?store= before the store resolves', async () => {
    const statsRequests: string[] = []
    let resolveStores!: () => void
    const storesPromise = new Promise<void>((res) => { resolveStores = res })
    server.use(
      http.get('/api/statestores', async () => {
        await storesPromise
        return HttpResponse.json(activeStoreOnly)
      }),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', ({ request }) => {
        const url = new URL(request.url)
        statsRequests.push(url.search)
        return HttpResponse.json({ counts: {}, total: 0 })
      }),
    )
    renderAt()
    // No stats request should fire before the store resolves
    expect(statsRequests).toHaveLength(0)
    resolveStores()
    // After store resolves, any stats request must carry ?store=
    await waitFor(() => expect(statsRequests.length).toBeGreaterThan(0))
    statsRequests.forEach((qs) => expect(qs).toMatch(/store=/))
  })
})

describe('Workflows page — child workflows toggle', () => {
  it('shows a child badge for child workflow rows', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({
          items: [
            { appId: 'order', instanceId: 'child-1', name: 'ChildWorkflow', status: 'Running', parentInstanceId: 'parent-1' },
          ],
        }),
      ),
    )
    renderAt()
    expect(await screen.findByText('child')).toBeInTheDocument()
  })

  it('requests includeChildren=false when the toggle is unchecked', async () => {
    const urls: string[] = []
    const statsUrls: string[] = []
    server.use(
      http.get('/api/workflows', ({ request }) => {
        urls.push(request.url)
        return HttpResponse.json({ items: [] })
      }),
      http.get('/api/workflows/stats', ({ request }) => {
        statsUrls.push(request.url)
        return HttpResponse.json({ counts: {}, total: 0 })
      }),
    )
    renderAt()
    // wait for the initial list request (default: children shown)
    await waitFor(() => expect(urls.length).toBeGreaterThan(0))
    const toggle = screen.getByLabelText('Show child workflows')
    await userEvent.click(toggle)
    await waitFor(() => expect(urls.some((u) => u.includes('includeChildren=false'))).toBe(true))
    await waitFor(() => expect(statsUrls.some((u) => u.includes('includeChildren=false'))).toBe(true))
  })
})

describe('Workflows page — store selector', () => {
  const twoStores = [
    { id: 'statestore-a', name: 'statestore', type: 'state.redis', source: 'auto', path: '/a', active: true, connection: 'localhost:6379' },
    { id: 'statestore-b', name: 'statestore', type: 'state.redis', source: 'manual', path: '/b', active: false, connection: 'localhost:16379' },
  ]

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('lists every store with a disambiguating "name — type · connection" label', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    const labels = Array.from(storeSelect.querySelectorAll('option')).map((o) => o.textContent)
    expect(labels).toContain('statestore — redis · localhost:6379 (active)')
    expect(labels).toContain('statestore — redis · localhost:16379')
  })

  it('selecting a store sends ?store=<id>, shows that store rows, and resets the app filter', async () => {
    let capturedStore: string | null = null
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        capturedStore = url.searchParams.get('store')
        const rows =
          url.searchParams.get('store') === 'statestore-b'
            ? [{ appId: 'pr-digest', instanceId: 'b1', name: 'AgentRunWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }]
            : [{ appId: 'order', instanceId: 'a1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }]
        return HttpResponse.json({ items: rows })
      }),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt('/workflows?app=order')
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await screen.findByRole('link', { name: 'a1' })
    await userEvent.selectOptions(storeSelect, 'statestore-b')
    await waitFor(() => expect(capturedStore).toBe('statestore-b'))
    expect(await screen.findByRole('link', { name: 'b1' })).toBeInTheDocument()
    // The app filter was reset to "All apps".
    const appSelect = screen.getByTestId('app-select') as HTMLSelectElement
    await waitFor(() => expect(appSelect.value).toBe(''))
  })

  it('persists the selection to localStorage and restores it on reload', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    const first = renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await userEvent.selectOptions(storeSelect, 'statestore-b')
    await waitFor(() => expect(window.localStorage.getItem('devdash.workflowStore')).toBe('statestore-b'))
    first.unmount()

    // Reload: a fresh render reads the persisted id.
    renderAt()
    const restored = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await waitFor(() => expect(restored.value).toBe('statestore-b'))
  })

  it('falls back to the active store when the persisted id is no longer in the list', async () => {
    window.localStorage.setItem('devdash.workflowStore', 'gone-store-id')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await waitFor(() => expect(storeSelect.value).toBe('statestore-a')) // the active one
  })

  it('shows a banner with the server "could not connect…" message and keeps the store selector usable', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'could not connect to state store "statestore" (localhost:16379)' }, { status: 503 }),
      ),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent(/could not connect to state store/i)
    expect(banner).toHaveTextContent(/localhost:16379/)
    // The --statestore guidance is only for the genuine no-store case.
    expect(screen.queryByText(/--statestore/)).toBeNull()
    // Chrome stays interactive and the table shows the degraded placeholder.
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
    expect(screen.getByText(/couldn't load workflows from this store/i)).toBeInTheDocument()
  })

  it('recovers when the user switches to a reachable store from the degraded state', async () => {
    // Store b (persisted selection) is unreachable; store a works.
    window.localStorage.setItem('devdash.workflowStore', 'statestore-b')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('store') === 'statestore-b') {
          return HttpResponse.json(
            { error: 'could not connect to state store "statestore" (localhost:16379)' },
            { status: 503 },
          )
        }
        return HttpResponse.json({
          items: [{ appId: 'order', instanceId: 'a1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
        })
      }),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    await screen.findByTestId('load-error-banner')
    const storeSelect = screen.getByTestId('store-select') as HTMLSelectElement
    await userEvent.selectOptions(storeSelect, 'statestore-a')
    // Rows from the reachable store render and the banner clears.
    expect(await screen.findByRole('link', { name: 'a1' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('load-error-banner')).toBeNull())
  })

  it('instance-row links carry ?store=<id> for the selected store', async () => {
    window.localStorage.setItem('devdash.workflowStore', 'statestore-b')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }] }),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'abc' })
    expect(link).toHaveAttribute('href', '/workflows/order/abc?store=statestore-b')
  })

  it('bulk removal sends ?store=<id> for the selected (non-active) store', async () => {
    window.localStorage.setItem('devdash.workflowStore', 'statestore-b')
    let capturedStore: string | null = null
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }] }),
      ),
      http.post('/api/workflows/purge', ({ request }) => {
        capturedStore = new URL(request.url).searchParams.get('store')
        return HttpResponse.json([{ instanceId: 'abc', mechanism: 'force', ok: true }])
      }),
    )
    renderAt()
    await screen.findByRole('link', { name: 'abc' })
    const checkboxes = document.querySelectorAll('tbody .cbx:not(.on)')
    await userEvent.click(checkboxes[0])
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument())
    await userEvent.click(document.querySelector('[data-cy="bulk-remove"]') as HTMLElement)
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument())
    await userEvent.click(document.querySelector('[data-cy="confirm-remove"]') as HTMLElement)
    // The purge request must target the store the page is scoped to,
    // not fall back to the server's active store.
    await waitFor(() => expect(capturedStore).toBe('statestore-b'))
  })

  it('collapses duplicate-path stores (same name+type+connection) into one option, showing the active one', async () => {
    const dupPaths = [
      { id: 'redis-p1', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis-a.yaml', active: false, connection: 'localhost:6379' },
      { id: 'redis-p2', name: 'redis', type: 'state.redis', source: 'auto', path: '/c/redis-b.yaml', active: true, connection: 'localhost:6379' },
    ]
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(dupPaths)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', () => HttpResponse.json({ counts: {}, total: 0 })),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    // Only one option for the duplicated store.
    await waitFor(() => expect(storeSelect.querySelectorAll('option')).toHaveLength(1))
    // The active member (redis-p2) is the representative shown and selected.
    const opt = storeSelect.querySelector('option') as HTMLOptionElement
    expect(opt.value).toBe('redis-p2')
    expect(opt.textContent).toMatch(/redis — redis · localhost:6379 \(active\)/)
    await waitFor(() => expect(storeSelect.value).toBe('redis-p2'))
  })
})

describe('Workflows page — stale-data error-state gating', () => {
  beforeEach(() => {
    window.localStorage.clear()
  })

  // setFocused(true) forces the manager for the process lifetime; restore
  // auto-detection so later tests don't inherit a forced-focused state.
  afterEach(() => {
    focusManager.setFocused(undefined)
  })

  it('hides stale rows, selection bar, and stale nextToken when a background refetch errors', async () => {
    // First call: returns one row + nextToken so pager shows "1–1 loaded" and Next is enabled.
    // Subsequent calls: return 503 (simulates store going down while page is open).
    let callCount = 0
    server.use(
      http.get('/api/workflows', () => {
        callCount++
        if (callCount === 1) {
          return HttpResponse.json({
            items: [{ appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' }],
            nextToken: 'tok-stale',
          })
        }
        return HttpResponse.json(
          { error: 'could not connect to state store "statestore" (localhost:16379)' },
          { status: 503 },
        )
      }),
    )

    renderAt()

    // Wait for the initial successful load: row + enabled Next button.
    await screen.findByRole('link', { name: 'abc' })
    expect(screen.getByRole('button', { name: 'Next →' })).not.toBeDisabled()

    // Select the row so we have an active selection before the error hits.
    const checkboxes = document.querySelectorAll('tbody .cbx:not(.on)')
    await userEvent.click(checkboxes[0])
    await waitFor(() => expect(screen.getByText('1 selected')).toBeInTheDocument())

    // Trigger a background refetch via TanStack Query's focusManager
    // (refetchOnWindowFocus is on by default; setFocused(true) fires the same path
    // as a real window-focus/visibilitychange event without needing DOM hacks).
    focusManager.setFocused(true)

    // After the refetch errors the page must gate all stale-data-derived UI:
    await screen.findByTestId('load-error-banner')
    // Placeholder replaces the table.
    expect(screen.getByText(/couldn't load workflows from this store/i)).toBeInTheDocument()
    // Pager shows "No results" (not "1–1 loaded").
    await waitFor(() => expect(screen.getByText('No results')).toBeInTheDocument())
    expect(screen.queryByText(/1–1 loaded/)).toBeNull()
    // Selection bar is hidden even though selected state was non-empty.
    expect(screen.queryByText('1 selected')).toBeNull()
    // Next button is disabled (stale nextToken must not enable it).
    expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled()
  })
})
