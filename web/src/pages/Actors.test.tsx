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
          { appId: 'order', instanceKey: 'order', type: 'OrderActor', count: 3, placement: 'placement: connected', hostReady: true },
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
          { appId: 'order', instanceKey: 'order', type: 'dapr.internal.default.order.workflow', count: 5, internal: true },
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

  const row = (o: Record<string, unknown>) => ({
    appId: 'a', instanceKey: 'a', type: 'T', count: 1, internal: false,
    hostReady: true, placement: 'placement: connected', ...o,
  })

  it('placement stat is green, amber or red with not-ready hosts named', async () => {
    const cases: [unknown[], string, string][] = [
      [[row({}), row({ appId: 'b', instanceKey: 'b' })], 'ok', 'All hosts'],
      [[row({}), row({ appId: 'b', instanceKey: 'b', hostReady: false })], 'warn', 'Not ready: b'],
      [[row({ hostReady: false }), row({ appId: 'b', instanceKey: 'b', placement: 'placement: disconnected' })], 'bad', 'Not ready: a, b'],
    ]
    for (const [rows, led, title] of cases) {
      server.use(http.get('/api/actors', () => HttpResponse.json(rows)))
      const { unmount } = renderAt()
      const stat = (await screen.findByText('Placement connected')).closest('.stat') as HTMLElement
      expect(stat.querySelector('.led')).toHaveClass(led)
      expect(stat.getAttribute('title')).toContain(title)
      unmount()
    }
  })

  it('shows config, reminders and unavailable reasons', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          row({ type: 'A', config: { idleTimeout: '5m', idleTimeoutDefault: false, reentrancy: { enabled: false } }, reminders: 4 }),
          row({ type: 'B', config: { idleTimeout: '60m', idleTimeoutDefault: true, reentrancy: { enabled: true, maxStackDepth: 8 } },
            remindersUnavailable: { reason: 'requires Dapr 1.17+' } }),
          row({ type: 'C', configUnavailable: { reason: 'gRPC app: no /dapr/config' } }),
          row({ type: 'D', runtimeStatus: 'DISABLED' }),
        ]),
      ),
    )
    renderAt()
    const a = within((await screen.findByRole('link', { name: 'A' })).closest('tr') as HTMLElement)
    expect(a.getByText('5m')).toBeInTheDocument()
    expect(a.getByText('off')).toBeInTheDocument()
    expect(a.getByText('4')).toBeInTheDocument()
    expect(a.getByRole('link', { name: 'A' })).toHaveAttribute('href', '/actors/a/A')
    const b = within(screen.getByRole('link', { name: 'B' }).closest('tr') as HTMLElement)
    expect(b.getByText('60m (default)')).toBeInTheDocument()
    expect(b.getByText('on (depth 8)')).toBeInTheDocument()
    expect(b.getAllByText('—').some((e) => e.getAttribute('title') === 'requires Dapr 1.17+')).toBe(true)
    const c = within(screen.getByRole('link', { name: 'C' }).closest('tr') as HTMLElement)
    expect(c.getAllByText('—').some((e) => e.getAttribute('title') === 'gRPC app: no /dapr/config')).toBe(true)
    const d = within(screen.getByRole('link', { name: 'D' }).closest('tr') as HTMLElement)
    expect(d.getByText('actors disabled')).toBeInTheDocument()
  })

  it('internal rows have no Invoke button', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([row({ type: 'dapr.internal.x.workflow', internal: true }), row({ type: 'Plain' })]),
      ),
    )
    renderAt()
    const int = within((await screen.findByRole('link', { name: /dapr\.internal/ })).closest('tr') as HTMLElement)
    expect(int.queryByRole('button', { name: 'Invoke' })).not.toBeInTheDocument()
    const plain = within(screen.getByRole('link', { name: 'Plain' }).closest('tr') as HTMLElement)
    expect(plain.getByRole('button', { name: 'Invoke' })).toBeInTheDocument()
  })

  it('lets long actor types wrap after each dot and keeps compact columns', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([row({ type: 'dapr.internal.default.order.workflow', internal: true }), row({ type: 'Plain' })]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'dapr.internal.default.order.workflow' })
    // A break opportunity after each of the four dots; the visible text is unchanged.
    expect(link.querySelectorAll('wbr')).toHaveLength(4)
    expect(screen.getByRole('link', { name: 'Plain' }).querySelectorAll('wbr')).toHaveLength(0)
    // "Idle timeout" header is split over two lines.
    const idle = screen.getByRole('columnheader', { name: /idle\s*timeout/i })
    expect(idle.querySelector('br')).not.toBeNull()
    // Reentrancy values and the Invoke button never wrap.
    const plain = screen.getByRole('link', { name: 'Plain' }).closest('tr') as HTMLElement
    expect(within(plain).getByRole('button', { name: 'Invoke' }).closest('td')).toHaveClass('nowrap')
    expect(plain.querySelector('td.reent')).toHaveClass('nowrap')
  })
})
