import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ResourceList } from './ResourceList'

function renderComponents(entry = '/components') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/components', element: <ResourceList kind="component" /> },
      { path: '/resources/:kind/:name', element: <div>resource detail</div> },
      { path: '/apps/:appId', element: <div>app detail</div> },
    ],
    { initialEntries: [entry] },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

function renderConfigurations(entry = '/configurations') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/configurations', element: <ResourceList kind="configuration" /> },
      { path: '/resources/:kind/:name', element: <div>resource detail</div> },
      { path: '/apps/:appId', element: <div>app detail</div> },
    ],
    { initialEntries: [entry] },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('ResourceList kind=component', () => {
  it('renders a row with name link, type, and loadedBy app link', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([
            {
              name: 'statestore',
              kind: 'component',
              type: 'state.redis',
              version: 'v1',
              path: '/components/statestore.yaml',
              loadedBy: ['order'],
            },
          ])
        }
        return HttpResponse.json([])
      }),
    )
    renderComponents()
    const nameLink = await screen.findByRole('link', { name: 'statestore' })
    expect(nameLink).toHaveAttribute('href', '/resources/component/statestore')
    expect(screen.getByText('state.redis')).toBeInTheDocument()
    expect(screen.getByText('v1')).toBeInTheDocument()
    const appLink = screen.getByRole('link', { name: 'order' })
    expect(appLink).toHaveAttribute('href', '/apps/order')
  })

  it('shows empty state when no components exist', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([])
        }
        return HttpResponse.json([])
      }),
    )
    renderComponents()
    await waitFor(() =>
      expect(screen.getByText(/no components/i)).toBeInTheDocument(),
    )
  })

  it('renders "—" in Loaded by when loadedBy is empty', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([
            {
              name: 'statestore',
              kind: 'component',
              type: 'state.redis',
              version: 'v1',
              path: '/components/statestore.yaml',
              loadedBy: [],
            },
          ])
        }
        return HttpResponse.json([])
      }),
    )
    renderComponents()
    await screen.findByRole('link', { name: 'statestore' })
    expect(screen.getByText('—')).toBeInTheDocument()
  })
})

describe('ResourceList kind=configuration', () => {
  it('renders a row with name link and path', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'configuration') {
          return HttpResponse.json([
            {
              name: 'appconfig',
              kind: 'configuration',
              path: '/configurations/appconfig.yaml',
            },
          ])
        }
        return HttpResponse.json([])
      }),
    )
    renderConfigurations()
    const nameLink = await screen.findByRole('link', { name: 'appconfig' })
    expect(nameLink).toHaveAttribute('href', '/resources/configuration/appconfig')
    expect(screen.getByText('/configurations/appconfig.yaml')).toBeInTheDocument()
  })

  it('shows empty state when no configurations exist', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'configuration') {
          return HttpResponse.json([])
        }
        return HttpResponse.json([])
      }),
    )
    renderConfigurations()
    await waitFor(() =>
      expect(screen.getByText(/no configurations/i)).toBeInTheDocument(),
    )
  })
})
