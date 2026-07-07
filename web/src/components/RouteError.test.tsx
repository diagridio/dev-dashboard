import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { routes } from '../router'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { ConnectionContext } from '../lib/connection'
import { trackError } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackError: vi.fn(), trackAction: vi.fn(), trackView: vi.fn() }))

// jsdom does not implement matchMedia; stub it so SmallScreenGuard works
beforeAll(() => {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }))
})

// Register MSW handlers so App-shell fetches (sidebar, news, version) don't error
beforeEach(() => {
  server.use(
    http.get('/api/version', () => HttpResponse.json({ version: '9.9.9', commit: 'abc1234', date: '2026-01-01' })),
    http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
    http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    http.get('/api/statestores', () => HttpResponse.json([])),
    http.get('/api/news', () =>
      HttpResponse.json({ blog: null, report: null, webinar: null, event: null }),
    ),
  )
})

function Bomb(): never {
  throw new Error('kaboom: render exploded')
}

/** Replace the element of every index route in the real route tree with a throwing component. */
function withBombAtIndex(route: RouteObject): RouteObject {
  if (route.index) return { ...route, element: <Bomb /> }
  if (route.children) return { ...route, children: route.children.map(withBombAtIndex) }
  return route
}

function renderBombed() {
  const client = makeQueryClient()
  const router = createMemoryRouter(routes.map(withBombAtIndex), {
    initialEntries: ['/'],
    future: { v7_relativeSplatPath: true },
  })
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <ConnectionContext value={{ online: true }}>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </ConnectionContext>
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('route error boundary', () => {
  let errSpy: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    // React logs caught render errors; keep test output quiet
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    errSpy.mockRestore()
  })

  it('renders the error boundary with a Reload button instead of the raw router error screen', () => {
    renderBombed()
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument()
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument()
  })

  it('shows the error text', () => {
    renderBombed()
    expect(screen.getByText(/kaboom: render exploded/)).toBeInTheDocument()
  })

  it('keeps the app shell (TopNav) usable', () => {
    renderBombed()
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
  })

  it('offers a link back to the home route', () => {
    renderBombed()
    const back = screen.getByRole('link', { name: /back to applications/i })
    expect(back).toHaveAttribute('href', '/')
  })

  it('reports the error to telemetry', () => {
    renderBombed()
    expect(trackError).toHaveBeenCalledWith(expect.any(Error))
  })
})
