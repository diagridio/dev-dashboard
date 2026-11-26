import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ActorDetail } from './ActorDetail'
import { recentIds } from '../lib/actorRecents'

function renderAt(entry = '/actors/a/T/x1') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/actors/:appId/:actorType/:actorId', element: <ActorDetail /> },
      { path: '/state', element: <div>state page</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

const sched = {
  name: 'r1', actorId: 'x1', dueTime: '5s', period: '10s', ttl: '1h', callback: '', data: 'hello', dataEncoding: 'text',
}

const base = {
  appId: 'a', instanceKey: 'a', type: 'T', id: 'x1', storeId: 'st1',
  state: [
    {
      key: 'a||T||x1||count', appId: 'a', logicalKey: 'T||x1||count', kind: 'actor',
      preview: '42', encoding: 'text', size: 2,
    },
  ],
  reminders: [sched],
  timers: [],
  stateTruncated: false,
}

function serveInternal() {
  server.use(
    http.get('/api/actors/a/dapr.internal.ns.a.wf/x1', () =>
      HttpResponse.json({ ...base, type: 'dapr.internal.ns.a.wf' }),
    ),
  )
}

function serve(over: Record<string, unknown> = {}) {
  let hits = 0
  server.use(
    http.get('/api/actors/a/T/x1', () => {
      hits++
      return HttpResponse.json({ ...base, ...over })
    }),
  )
  return () => hits
}

describe('ActorDetail', () => {
  it('shows the header with links and an Invoke button', async () => {
    serve()
    renderAt()
    expect(await screen.findByRole('heading', { name: 'x1' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'T' })).toHaveAttribute('href', '/actors/a/T')
    expect(screen.getByRole('link', { name: 'a' })).toHaveAttribute('href', '/apps/a')
    expect(screen.getByRole('link', { name: 'View logs' })).toHaveAttribute('href', '/logs?app=a&source=app')
    expect(screen.getByRole('button', { name: 'Invoke' })).toBeInTheDocument()
  })

  it('hides Invoke and reminder Delete for internal actor types', async () => {
    serveInternal()
    renderAt('/actors/a/dapr.internal.ns.a.wf/x1')
    expect(await screen.findByText('r1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Invoke' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument()
  })

  it('hides the Open State link when the state capability is off', async () => {
    serve({ state: [], stateUnavailable: { reason: 'sidecar unreachable' } })
    window.__DASH_CAPABILITIES__ = {
      lifecycle: true, controlPlane: true, logs: true, workflows: true, state: false,
    }
    try {
      renderAt()
      expect(await screen.findByText(/sidecar unreachable/)).toBeInTheDocument()
      expect(screen.queryByRole('link', { name: 'Open State' })).not.toBeInTheDocument()
    } finally {
      delete window.__DASH_CAPABILITIES__
    }
  })

  it('lists state keys without the prefix and opens the full value', async () => {
    serve()
    let url = ''
    server.use(
      http.get('/api/state/record', ({ request }) => {
        url = request.url
        return HttpResponse.json({
          key: 'a||T||x1||count', appId: 'a', logicalKey: 'T||x1||count', kind: 'actor',
          value: '{"full":true}', encoding: 'text', size: 13, truncated: false,
        })
      }),
    )
    renderAt()
    const key = await screen.findByRole('button', { name: 'count' })
    const row = key.closest('tr') as HTMLElement
    expect(row).toHaveTextContent('42')
    await userEvent.click(key)
    expect(await screen.findByText('{"full":true}')).toBeInTheDocument()
    const u = new URL(url)
    expect(u.searchParams.get('store')).toBe('st1')
    expect(u.searchParams.get('key')).toBe('a||T||x1||count')
  })

  it('shows the state reason with a link to /state', async () => {
    serve({ state: [], stateUnavailable: { reason: 'sidecar unreachable' } })
    renderAt()
    expect(await screen.findByText(/sidecar unreachable/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open State' })).toHaveAttribute('href', '/state')
  })

  it('shows reminder fields and deletes only after confirming', async () => {
    serve()
    const deleted: string[] = []
    server.use(
      http.delete('/api/actors/a/T/x1/reminders/:name', ({ params }) => {
        deleted.push(String(params.name))
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderAt()
    const cell = await screen.findByText('r1')
    const row = cell.closest('tr') as HTMLElement
    for (const t of ['5s', '10s', '1h', 'hello']) expect(row).toHaveTextContent(t)

    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    expect(await screen.findByText('Delete reminder r1?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(deleted).toEqual([])

    await userEvent.click(within(row).getByRole('button', { name: 'Delete' }))
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm' }))
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Confirm' })).not.toBeInTheDocument())
    expect(deleted).toEqual(['r1'])
  })

  it('labels base64 reminder data', async () => {
    serve({ reminders: [{ ...sched, data: 'aGk=', dataEncoding: 'base64' }] })
    renderAt()
    const row = (await screen.findByText('aGk=')).closest('tr') as HTMLElement
    expect(within(row).getByText('base64')).toBeInTheDocument()
  })

  it('shows timer unavailable reasons', async () => {
    serve({ timers: [], timersUnavailable: { reason: 'requires Dapr 1.19+' } })
    renderAt()
    expect(await screen.findByText('requires Dapr 1.19+')).toBeInTheDocument()
  })

  it('shows the not-owned reason for timers', async () => {
    serve({ timersUnavailable: { reason: 'This actor is hosted by another replica' } })
    renderAt()
    expect(await screen.findByText('This actor is hosted by another replica')).toBeInTheDocument()
  })

  it('refetches the detail after a successful invoke', async () => {
    const hits = serve()
    server.use(
      http.post('/api/actors/a/T/x1/invoke', () =>
        HttpResponse.json({ status: 200, durationMs: 3, contentType: 'text/plain', body: 'ok' }),
      ),
    )
    renderAt()
    await userEvent.click(await screen.findByRole('button', { name: 'Invoke' }))
    const before = hits()
    await userEvent.type(await screen.findByLabelText('Method'), 'Ping')
    await userEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Invoke' }))
    await screen.findByText('ok')
    await waitFor(() => expect(hits()).toBeGreaterThan(before))
  })

  it('says when the state scan was truncated', async () => {
    serve({ stateTruncated: true })
    renderAt()
    expect(
      await screen.findByText('Only part of the state store was scanned; this actor may have more keys.'),
    ).toBeInTheDocument()
  })

  it('shows no truncation note when the whole store was scanned', async () => {
    serve()
    renderAt()
    await screen.findByRole('button', { name: 'count' })
    expect(screen.queryByText(/Only part of the state store was scanned/)).not.toBeInTheDocument()
  })

  it('shows the timer callback column', async () => {
    serve({ reminders: [], timers: [{ ...sched, name: 't1', callback: 'onTick' }] })
    renderAt()
    const row = (await screen.findByText('t1')).closest('tr') as HTMLElement
    expect(within(row).getByText('onTick')).toBeInTheDocument()
    const timersTable = row.closest('table') as HTMLElement
    expect(within(timersTable).getByRole('columnheader', { name: 'Callback' })).toBeInTheDocument()
    expect(screen.getAllByRole('columnheader', { name: 'Callback' })).toHaveLength(1)
  })

  it('formats state size in readable units', async () => {
    serve({ state: [{ ...base.state[0], size: 2048 }] })
    renderAt()
    const row = (await screen.findByRole('button', { name: 'count' })).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('2.0 KiB')
  })

  it('remembers an opened actor ID as recent', async () => {
    localStorage.clear()
    serve()
    renderAt()
    await screen.findByRole('heading', { name: 'x1' })
    await waitFor(() => expect(recentIds('a', 'T')).toEqual(['x1']))
  })
})
