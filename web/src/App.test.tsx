import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import { MemoryRouter, Routes, Route, createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from './test/setup'
import { App } from './App'
import { Placeholder } from './pages/Placeholder'
import { routes } from './router'
import { QueryProvider, makeQueryClient } from './lib/query'
import { RefreshProvider } from './lib/refresh'

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

// Register MSW handlers so StatusFooter fetches and route-switch tests don't error
beforeEach(() => {
  server.use(
    http.get('/api/version', () => HttpResponse.json({ version: 'dev', commit: 'none', date: 'unknown' })),
    http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
    http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    http.get('/api/statestores', () => HttpResponse.json([])),
    http.get('/api/news', () =>
      HttpResponse.json({ blog: null, report: null, webinar: null, event: null }),
    ),
  )
})

// Test App shell by wrapping with MemoryRouter (router.tsx uses createBrowserRouter externally)
function renderApp(path = '/') {
  const client = makeQueryClient()
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/*" element={<App />} />
          </Routes>
        </MemoryRouter>
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('App shell', () => {
  it('renders TopNav', () => {
    renderApp()
    // Nav links are present
    expect(screen.getByRole('link', { name: 'Applications' })).toBeInTheDocument()
  })

  it('wraps content in SmallScreenGuard', () => {
    // SmallScreenGuard shows children when screen is wide (jsdom default)
    renderApp()
    // If SmallScreenGuard is present and screen is wide, children render
    // Note: there are multiple navs (TopNav primary nav + ResourcesSidebar nav)
    expect(screen.getAllByRole('navigation').length).toBeGreaterThan(0)
  })

  it('renders StatusFooter', () => {
    renderApp()
    expect(screen.getByRole('contentinfo')).toBeInTheDocument()
  })
})

describe('Placeholder', () => {
  it('renders the title', () => {
    render(<Placeholder title="Applications" />)
    expect(screen.getByText('Applications')).toBeInTheDocument()
  })

  it('renders with different titles', () => {
    render(<Placeholder title="Workflows" />)
    expect(screen.getByText('Workflows')).toBeInTheDocument()
  })
})

describe('route switching', () => {
  it('renders Workflows page at /workflows', () => {
    const client = makeQueryClient()
    const router = createMemoryRouter(routes, { initialEntries: ['/workflows'] })
    render(
      <QueryProvider client={client}>
        <RefreshProvider>
          <RouterProvider router={router} />
        </RefreshProvider>
      </QueryProvider>,
    )
    expect(screen.getAllByText(/Workflows/i).length).toBeGreaterThan(0)
  })
})
