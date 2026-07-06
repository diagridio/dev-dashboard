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
  version: 'v1',
  path: '/components/statestore.yaml',
  loadedBy: ['order'],
  raw: 'apiVersion: dapr.io/v1alpha1\nkind: Component\nspec:\n  type: state.redis\n',
}

const APPCONFIG_FIXTURE = {
  name: 'appconfig',
  kind: 'configuration',
  path: '/configurations/appconfig.yaml',
  loadedBy: ['order-processing'],
  raw: 'apiVersion: dapr.io/v1alpha1\nkind: Configuration\n',
}

function renderResourceDetail(kind: 'component' | 'configuration' = 'component', name = 'statestore') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const base = kind === 'component' ? 'components' : 'configurations'
  const router = createMemoryRouter(
    [
      {
        path: `/${base}/:name`,
        element: <ResourceDetail kind={kind} idOrName={name} />,
      },
      { path: '/apps/:appId', element: <div data-testid="app-detail">app detail</div> },
    ],
    { initialEntries: [`/${base}/${name}`], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('ResourceDetail', () => {
  it('renders YAML body and loadedBy app link', async () => {
    server.use(
      http.get('/api/resources/component/statestore', () =>
        HttpResponse.json(STATESTORE_FIXTURE),
      ),
    )
    renderResourceDetail()

    // meta header shows type + loaded by label, and YAML body also contains state.redis
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
    await waitFor(() =>
      expect(screen.getByText(/not currently loaded/i)).toBeInTheDocument(),
    )
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

  it('renders Configuration right-pane header with "Configuration · used by" meta', async () => {
    server.use(
      http.get('/api/resources/configuration/appconfig', () =>
        HttpResponse.json(APPCONFIG_FIXTURE),
      ),
    )
    renderResourceDetail('configuration', 'appconfig')
    await waitFor(() =>
      expect(screen.getByText(/Configuration · used by/)).toBeInTheDocument(),
    )
    const appLink = screen.getByRole('link', { name: 'order-processing' })
    expect(appLink).toHaveAttribute('href', '/apps/order-processing')
  })
})
