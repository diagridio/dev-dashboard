import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider, useParams } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ActorType } from './ActorType'

function Detail() {
  return <div>detail:{useParams().actorId}</div>
}

function renderAt(entry = '/actors/a/T') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/actors/:appId/:actorType', element: <ActorType /> },
      { path: '/actors/:appId/:actorType/:actorId', element: <Detail /> },
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
  return router
}

const base = {
  appId: 'a', instanceKey: 'a', type: 'T', count: 2, internal: false, hostReady: true,
  ids: [
    { id: 'one', stateKeys: 3, reminders: 1, sources: ['state', 'reminders'] },
    { id: 'two', stateKeys: 0, reminders: 2, sources: ['reminders'] },
  ],
  truncated: false,
}

function serve(over: Record<string, unknown> = {}) {
  server.use(http.get('/api/actors/a/T', () => HttpResponse.json({ ...base, ...over })))
}

describe('ActorType', () => {
  it('lists IDs with counts, chips and links, plus the note', async () => {
    serve()
    renderAt()
    const link = await screen.findByRole('link', { name: 'one' })
    expect(link).toHaveAttribute('href', '/actors/a/T/one')
    const row = link.closest('tr') as HTMLElement
    expect(row).toHaveTextContent('3')
    expect(row).toHaveTextContent('state')
    expect(row).toHaveTextContent('reminders')
    expect(screen.getByText("Dapr doesn't list active actor IDs. This list shows actors with state or reminders.")).toBeInTheDocument()
  })

  it('Go to actor ID round-trips an ID with a slash', async () => {
    serve()
    const router = renderAt()
    await userEvent.type(await screen.findByLabelText('Go to actor ID'), 'x/y{Enter}')
    expect(await screen.findByText('detail:x/y')).toBeInTheDocument()
    expect(router.state.location.pathname).toBe('/actors/a/T/x%2Fy')
  })

  it('shows the truncated notice', async () => {
    serve({ truncated: true })
    renderAt()
    expect(await screen.findByText('Showing the first 2 actors found in state. Use Go to actor ID for others.')).toBeInTheDocument()
  })

  it('shows stateUnavailable reason with a link to /state', async () => {
    serve({ ids: [], stateUnavailable: { reason: 'no state store configured' } })
    renderAt()
    expect(await screen.findByText(/no state store configured/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /state/i })).toHaveAttribute('href', '/state')
  })

  it('merges recent IDs not already listed with dash counts', async () => {
    localStorage.setItem('actor-recent-ids:a:T', JSON.stringify(['one', 'fresh']))
    serve()
    renderAt()
    const row = (await screen.findByRole('link', { name: 'fresh' })).closest('tr') as HTMLElement
    expect(row).toHaveTextContent('recent')
    expect(row).toHaveTextContent('—')
    expect(screen.getAllByRole('link', { name: 'one' })).toHaveLength(1)
    localStorage.clear()
  })
})
