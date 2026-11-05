import { render, screen, waitFor, fireEvent, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { HttpEndpoints } from './HttpEndpoints'

const IDENTITY = {
  id: 'ep111ep111ep',
  name: 'identity-api',
  kind: 'httpendpoint',
  path: '/proj/resources/common/identity-endpoint.yaml',
  scopes: ['party-api'],
  loadedBy: ['party-api'],
  httpEndpoint: {
    baseUrl: 'http://localhost:8091',
    headers: [
      { name: 'Accept-Language', value: 'en-US' },
      { name: 'Authorization', secretKeyRef: { name: 'iam-token', key: 'token' } },
      { name: 'X-Tenant', envRef: 'TENANT_ID' },
    ],
    clientTLS: true,
  },
}

const BILLING = {
  id: 'ep222ep222ep',
  name: 'billing',
  kind: 'httpendpoint',
  path: '/home/.dapr/resources/billing.yaml',
  httpEndpoint: { baseUrl: 'https://billing.example.com' },
}

function renderPage(entry = '/http-endpoints') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/http-endpoints', element: <HttpEndpoints /> },
      { path: '/http-endpoints/:name', element: <HttpEndpoints /> },
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
      new URL(request.url).searchParams.get('kind') === 'httpendpoint'
        ? HttpResponse.json(list)
        : HttpResponse.json({ error: 'wrong kind' }, { status: 400 }),
    ),
    http.get('/api/resources/httpendpoint/:id', ({ params }) => {
      const r = (list as { id: string }[]).find((x) => x.id === params.id)
      return r
        ? HttpResponse.json({ ...r, raw: 'kind: HTTPEndpoint\n' })
        : HttpResponse.json({ error: 'resource not found' }, { status: 404 })
    }),
  )
}

describe('HttpEndpoints page', () => {
  it('shows the empty state', async () => {
    serve([])
    renderPage()
    expect(await screen.findByText(/no httpendpoint resources found/i)).toBeInTheDocument()
  })

  it('names the folders the dashboard actually scans', async () => {
    serve([])
    renderPage()
    await screen.findByText(/no httpendpoint resources found/i)
    const sub = document.querySelector('.phead .sub')?.textContent ?? ''
    expect(sub).toContain('~/.dapr/components')
    expect(sub).not.toContain('~/.dapr/resources')
  })

  it('shows an error when the endpoints cannot be loaded', async () => {
    server.use(http.get('/api/resources', () => HttpResponse.json({ error: 'boom' }, { status: 500 })))
    renderPage()
    expect(await screen.findByText('Failed to load HTTP endpoints.')).toBeInTheDocument()
    expect(screen.queryByText(/no httpendpoint resources found/i)).not.toBeInTheDocument()
  })

  it('shows base URL, scopes, loaded-by and masks referenced header values', async () => {
    serve([BILLING, IDENTITY])
    renderPage('/http-endpoints/ep111ep111ep')

    expect(await screen.findByText('billing', { selector: '.cn' })).toBeInTheDocument()
    expect(screen.getByText('all apps')).toBeInTheDocument()
    expect(screen.getByText('scopes: party-api')).toBeInTheDocument()
    expect(screen.getAllByText('http://localhost:8091').length).toBeGreaterThan(0)
    expect(screen.getByText('configured')).toBeInTheDocument()

    const headers = screen.getByText('Headers').closest('.panel') as HTMLElement
    const plain = within(headers).getByText('Accept-Language').closest('tr') as HTMLElement
    expect(within(plain).getByText('en-US')).toBeInTheDocument()
    const secret = within(headers).getByText('Authorization').closest('tr') as HTMLElement
    expect(within(secret).getByText('secretKeyRef iam-token/token')).toBeInTheDocument()
    expect(within(secret).getByText('••••••••')).toBeInTheDocument()
    const env = within(headers).getByText('X-Tenant').closest('tr') as HTMLElement
    expect(within(env).getByText('envRef TENANT_ID')).toBeInTheDocument()

    expect(screen.getByRole('link', { name: 'party-api' })).toHaveAttribute('href', '/apps/party-api')
    expect(screen.getByText('/proj/resources/common/identity-endpoint.yaml')).toBeInTheDocument()
    await waitFor(() => expect(document.querySelector('pre.code')?.textContent).toContain('kind: HTTPEndpoint'))
  })

  it('navigates to the selected endpoint on click', async () => {
    serve([BILLING, IDENTITY])
    const router = renderPage()
    await screen.findByText('billing', { selector: '.cn' })
    // First item is selected by default; it has no headers and no loader.
    expect(screen.getByText('No headers defined.')).toBeInTheDocument()
    expect(screen.getByText('not currently loaded')).toBeInTheDocument()
    fireEvent.click(screen.getByText('identity-api', { selector: '.cn' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/http-endpoints/ep111ep111ep'))
    expect(await screen.findByText('Authorization')).toBeInTheDocument()
  })
})
