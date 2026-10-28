import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Resiliency } from './Resiliency'

const PARTY = {
  id: 'res111res111',
  name: 'party-api-resiliency',
  kind: 'resiliency',
  path: '/proj/resources/common/resiliency.yaml',
  scopes: ['party-api'],
  loadedBy: ['party-api'],
  resiliency: {
    policies: {
      timeouts: { downstream: '2s' },
      retries: { threeTimes: { policy: 'constant', duration: '500ms', maxRetries: 3 } },
      circuitBreakers: { registryCB: { maxRequests: 1, timeout: '15s', trip: 'consecutiveFailures >= 5' } },
    },
    targets: {
      apps: { 'party-registry': { timeout: 'downstream', retry: 'threeTimes', circuitBreaker: 'registryCB' } },
      components: { statestore: { outbound: { retry: 'threeTimes' } } },
    },
  },
}

const GLOBAL = {
  id: 'res222res222',
  name: 'global-resiliency',
  kind: 'resiliency',
  path: '/home/.dapr/resources/global.yaml',
  resiliency: { policies: {}, targets: {} },
}

function renderPage(entry = '/resiliency') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/resiliency', element: <Resiliency /> },
      { path: '/resiliency/new', element: <div data-testid="builder">builder</div> },
      { path: '/resiliency/:name', element: <Resiliency /> },
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

function serve(list: unknown[]) {
  server.use(
    http.get('/api/resources', ({ request }) =>
      new URL(request.url).searchParams.get('kind') === 'resiliency'
        ? HttpResponse.json(list)
        : HttpResponse.json({ error: 'wrong kind' }, { status: 400 }),
    ),
    http.get('/api/resources/resiliency/:id', ({ params }) => {
      const r = (list as { id: string }[]).find((x) => x.id === params.id)
      return r
        ? HttpResponse.json({ ...r, raw: 'kind: Resiliency\n' })
        : HttpResponse.json({ error: 'resource not found' }, { status: 404 })
    }),
  )
}

describe('Resiliency page', () => {
  it('shows the empty state and a New resiliency policy link', async () => {
    serve([])
    renderPage()
    expect(await screen.findByText(/no resiliency policies/i)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /new resiliency policy/i })
    expect(link).toHaveAttribute('href', '/resiliency/new')
  })

  it('lists discovered policies and shows the first one with scopes, policies and targets', async () => {
    serve([GLOBAL, PARTY])
    renderPage('/resiliency/res111res111')

    expect(await screen.findByText('global-resiliency', { selector: '.cn' })).toBeInTheDocument()
    expect(screen.getByText('all apps')).toBeInTheDocument()
    expect(screen.getByText('scopes: party-api')).toBeInTheDocument()

    const policies = screen.getByText('Policies').closest('.panel') as HTMLElement
    expect(within(policies).getByText('downstream')).toBeInTheDocument()
    expect(within(policies).getByText('2s')).toBeInTheDocument()
    expect(within(policies).getByText('policy=constant · duration=500ms · maxRetries=3')).toBeInTheDocument()
    expect(within(policies).getByText('registryCB')).toBeInTheDocument()

    const targets = screen.getByText('Targets').closest('.panel') as HTMLElement
    const appRow = within(targets).getByText('party-registry').closest('tr') as HTMLElement
    expect(within(appRow).getByText('app')).toBeInTheDocument()
    expect(within(appRow).getByText('downstream')).toBeInTheDocument()
    expect(within(appRow).getByText('registryCB')).toBeInTheDocument()
    expect(within(targets).getByText('component · outbound')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: 'party-api' })).toHaveAttribute('href', '/apps/party-api')
    expect(screen.getAllByText('/proj/resources/common/resiliency.yaml').length).toBeGreaterThan(0)
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: Resiliency'))
  })

  it('navigates to the selected policy on click', async () => {
    serve([GLOBAL, PARTY])
    const router = renderPage()
    await screen.findByText('global-resiliency', { selector: '.cn' })
    // First item is selected by default; it has no policies or targets.
    expect(screen.getByText('No policies defined.')).toBeInTheDocument()
    expect(screen.getByText('not currently loaded')).toBeInTheDocument()
    fireEvent.click(screen.getByText('party-api-resiliency', { selector: '.cn' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/resiliency/res111res111'))
    expect(await screen.findByText('party-registry')).toBeInTheDocument()
  })

  it('keeps the builder link when policies are listed', async () => {
    serve([PARTY])
    renderPage()
    await screen.findByText('party-api-resiliency', { selector: '.cn' })
    fireEvent.click(screen.getByRole('link', { name: /new resiliency policy/i }))
    expect(await screen.findByTestId('builder')).toBeInTheDocument()
  })
})
