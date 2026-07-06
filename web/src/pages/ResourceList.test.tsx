import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ResourceList } from './ResourceList'

const COMPONENT_SUMMARY = {
  id: 'abc123def456',
  name: 'statestore',
  kind: 'component',
  type: 'state.redis',
  version: 'v1',
  path: '/components/statestore.yaml',
  loadedBy: ['order'],
}

const COMPONENT_DETAIL = {
  ...COMPONENT_SUMMARY,
  raw: 'apiVersion: dapr.io/v1alpha1\nkind: Component\nspec:\n  type: state.redis\n',
}

const CONFIG_SUMMARY = {
  id: 'cfg111cfg111',
  name: 'appconfig',
  kind: 'configuration',
  path: '/configurations/appconfig.yaml',
}

const CONFIG_DETAIL = {
  ...CONFIG_SUMMARY,
  raw: 'apiVersion: dapr.io/v1alpha1\nkind: Configuration\n',
  loadedBy: ['order-processing'],
}

function makeRoutes(kind: 'component' | 'configuration') {
  const base = kind === 'component' ? 'components' : 'configurations'
  return [
    { path: `/${base}`, element: <ResourceList kind={kind} /> },
    { path: `/${base}/:name`, element: <ResourceList kind={kind} /> },
    { path: '/apps/:appId', element: <div data-testid="app-detail">app detail</div> },
  ]
}

function renderComponents(entry = '/components') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(makeRoutes('component'), {
    initialEntries: [entry],
    future: { v7_relativeSplatPath: true },
  })
  const renderResult = render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
  return { ...renderResult, router }
}

function renderConfigurations(entry = '/configurations') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(makeRoutes('configuration'), {
    initialEntries: [entry],
    future: { v7_relativeSplatPath: true },
  })
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

// ---- Components ----

describe('ResourceList kind=component', () => {
  beforeEach(() => {
    // The State store connections panel fetches this on every component render.
    server.use(http.get('/api/statestores', () => HttpResponse.json([])))
  })

  it('shows the state store connections panel on components', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([])),
    )
    renderComponents()
    expect(await screen.findByText('State store connections')).toBeInTheDocument()
  })

  it('renders component list items with name and type·version', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([COMPONENT_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json(COMPONENT_DETAIL),
      ),
    )
    renderComponents()
    // list item appears
    await screen.findByText('statestore')
    // ct shows type · version
    expect(screen.getByText('state.redis · v1')).toBeInTheDocument()
  })

  it('auto-selects first item and shows detail pane with loadedBy app link', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([COMPONENT_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json(COMPONENT_DETAIL),
      ),
    )
    renderComponents()
    // detail pane renders the loaded-by app link
    const appLink = await screen.findByRole('link', { name: 'order' })
    expect(appLink).toHaveAttribute('href', '/apps/order')
  })

  it('preselects a named item via deep-link /components/:name', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([COMPONENT_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json(COMPONENT_DETAIL),
      ),
    )
    renderComponents('/components/statestore')
    // the named item should be selected
    await waitFor(() => {
      const sel = document.querySelector('.ci.sel')
      expect(sel).toBeInTheDocument()
      expect(sel?.textContent).toMatch(/statestore/)
    })
  })

  it('shows empty master pane and hint when no components exist', async () => {
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

  it('shows "not currently loaded" in detail pane when loadedBy is empty', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([{ ...COMPONENT_SUMMARY, loadedBy: [] }])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json({ ...COMPONENT_DETAIL, loadedBy: [] }),
      ),
    )
    renderComponents()
    await screen.findByText('statestore')
    await waitFor(() =>
      expect(screen.getByText(/not currently loaded/i)).toBeInTheDocument(),
    )
  })

  it('clicking a list item updates the URL to /components/:id', async () => {
    const PUBSUB = {
      id: 'pub000pub000',
      name: 'pubsub',
      kind: 'component',
      type: 'pubsub.redis',
      version: 'v1',
      path: '/components/pubsub.yaml',
      loadedBy: [],
    }
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'component') {
          return HttpResponse.json([COMPONENT_SUMMARY, PUBSUB])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/component/:idOrName', ({ params }) =>
        HttpResponse.json(
          params.idOrName === 'pub000pub000'
            ? { ...PUBSUB, raw: 'kind: Component\n' }
            : COMPONENT_DETAIL,
        ),
      ),
    )
    const { router } = renderComponents()
    await screen.findByText('pubsub')
    const pubsubItem = screen.getByText('pubsub').closest('.ci')!
    fireEvent.click(pubsubItem)
    // after navigation, pubsub item should be selected
    await waitFor(() => {
      const sel = document.querySelector('.ci.sel')
      expect(sel?.textContent).toMatch(/pubsub/)
    })
    // and the router pathname must reflect the navigation (now uses id)
    expect(router.state.location.pathname).toBe('/components/pub000pub000')
  })
})

// ---- Configurations ----

describe('ResourceList kind=configuration', () => {
  it('renders configuration list items with name', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'configuration') {
          return HttpResponse.json([CONFIG_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/configuration/:idOrName', () =>
        HttpResponse.json(CONFIG_DETAIL),
      ),
    )
    renderConfigurations()
    await screen.findByText('appconfig')
  })

  it('auto-selects first item and shows "Configuration · used by" meta with app links', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'configuration') {
          return HttpResponse.json([CONFIG_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/configuration/:idOrName', () =>
        HttpResponse.json(CONFIG_DETAIL),
      ),
    )
    renderConfigurations()
    // meta label
    await screen.findByText(/Configuration · used by/)
    // app link
    const appLink = screen.getByRole('link', { name: 'order-processing' })
    expect(appLink).toHaveAttribute('href', '/apps/order-processing')
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

  it('does not show the connection panel on configurations', async () => {
    server.use(http.get('/api/resources', () => HttpResponse.json([])))
    renderConfigurations()
    // Give the page a tick to settle, then assert the panel is absent.
    await screen.findByRole('heading', { name: /configurations/i })
    expect(screen.queryByText('State store connections')).not.toBeInTheDocument()
  })

  it('preselects a named item via deep-link /configurations/:name', async () => {
    server.use(
      http.get('/api/resources', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('kind') === 'configuration') {
          return HttpResponse.json([CONFIG_SUMMARY])
        }
        return HttpResponse.json([])
      }),
      http.get('/api/resources/configuration/:idOrName', () =>
        HttpResponse.json(CONFIG_DETAIL),
      ),
    )
    renderConfigurations('/configurations/appconfig')
    await waitFor(() => {
      const sel = document.querySelector('.ci.sel')
      expect(sel).toBeInTheDocument()
      expect(sel?.textContent).toMatch(/appconfig/)
    })
  })
})

const DUPLICATE_A = {
  id: 'aaa111aaa111',
  name: 'statestore',
  kind: 'component',
  type: 'state.redis',
  version: 'v1',
  path: '/projA/statestore.yaml',
}

const DUPLICATE_B = {
  id: 'bbb222bbb222',
  name: 'statestore',
  kind: 'component',
  type: 'state.sqlite',
  version: 'v1',
  path: '/projB/statestore.yaml',
}

describe('ResourceList unique selection', () => {
  beforeEach(() => {
    server.use(http.get('/api/statestores', () => HttpResponse.json([])))
  })

  it('renders both duplicate-name components with their file paths and selects by id', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([DUPLICATE_A, DUPLICATE_B])),
      http.get('/api/resources/component/:idOrName', ({ params }) =>
        HttpResponse.json(
          params.idOrName === 'bbb222bbb222'
            ? { ...DUPLICATE_B, raw: 'spec:\n  type: state.sqlite\n' }
            : { ...DUPLICATE_A, raw: 'spec:\n  type: state.redis\n' },
        ),
      ),
    )
    renderComponents()

    // Both rows render, each showing its file path.
    await waitFor(() => expect(screen.getAllByText('statestore')).toHaveLength(2))
    expect(screen.getByText('/projA/statestore.yaml')).toBeInTheDocument()
    expect(screen.getByText('/projB/statestore.yaml')).toBeInTheDocument()

    // Clicking the second duplicate selects it (not the first).
    fireEvent.click(screen.getByText('/projB/statestore.yaml'))
    await waitFor(() => expect(screen.getByText(/state\.sqlite/)).toBeInTheDocument())
    expect(screen.getByText('/projB/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('/projA/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'false')
  })

  it('still selects by name for old deep links', async () => {
    server.use(
      http.get('/api/resources', () => HttpResponse.json([DUPLICATE_A, DUPLICATE_B])),
      http.get('/api/resources/component/:idOrName', () =>
        HttpResponse.json({ ...DUPLICATE_A, raw: 'spec:\n  type: state.redis\n' }),
      ),
    )
    renderComponents('/components/statestore')

    await waitFor(() => expect(screen.getAllByText('statestore')).toHaveLength(2))
    expect(screen.getByText('/projA/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByText('/projB/statestore.yaml').closest('.ci')).toHaveAttribute('aria-selected', 'false')
  })
})
