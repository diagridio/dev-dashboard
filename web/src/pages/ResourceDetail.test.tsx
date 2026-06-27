import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ResourceDetail } from './ResourceDetail'

const STATESTORE_FIXTURE = {
  name: 'statestore',
  kind: 'component',
  type: 'state.redis',
  path: '/components/statestore.yaml',
  loadedBy: ['order'],
  raw: 'apiVersion: dapr.io/v1alpha1\nkind: Component\nspec:\n  type: state.redis\n',
}

function renderResourceDetail(entry = '/resources/component/statestore') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/resources/:kind/:name', element: <ResourceDetail /> },
      { path: '/apps/:appId', element: <div data-testid="app-detail">app detail</div> },
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

describe('ResourceDetail', () => {
  it('renders name header, YAML body and loadedBy app link', async () => {
    server.use(
      http.get('/api/resources/component/statestore', () =>
        HttpResponse.json(STATESTORE_FIXTURE),
      ),
    )
    renderResourceDetail()

    // name in header
    await screen.findByText('statestore')

    // YAML body contains the type string (may appear in header + YAML viewer)
    await waitFor(() =>
      expect(screen.getAllByText(/state\.redis/).length).toBeGreaterThan(0),
    )

    // loadedBy app link
    const appLink = screen.getByRole('link', { name: 'order' })
    expect(appLink).toHaveAttribute('href', '/apps/order')
  })

  it('shows "not currently loaded" when loadedBy is empty', async () => {
    server.use(
      http.get('/api/resources/component/statestore', () =>
        HttpResponse.json({ ...STATESTORE_FIXTURE, loadedBy: [] }),
      ),
    )
    renderResourceDetail()
    await screen.findByText('statestore')
    expect(screen.getByText(/not currently loaded/i)).toBeInTheDocument()
  })

  it('shows not-found message on 404', async () => {
    server.use(
      http.get('/api/resources/component/statestore', () =>
        HttpResponse.json({ error: 'not found' }, { status: 404 }),
      ),
    )
    renderResourceDetail()
    await waitFor(() =>
      expect(screen.getByText(/not found/i)).toBeInTheDocument(),
    )
  })
})
