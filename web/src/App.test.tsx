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

// Register MSW handlers so route-switch tests and sidebar fetches don't error
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

// Test App shell by wrapping with MemoryRouter
function renderApp(path = '/') {
  const client = makeQueryClient()
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <MemoryRouter initialEntries={[path]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
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
    // TopNav has aria-label="Primary navigation"; ResourcesSidebar aside has aria-label="Resources"
    expect(screen.getByRole('navigation', { name: 'Primary navigation' })).toBeInTheDocument()
    expect(screen.getByRole('complementary', { name: 'Resources' })).toBeInTheDocument()
  })

  it('does not render StatusFooter', () => {
    renderApp()
    // The old footer had role="contentinfo" (<footer>)
    expect(screen.queryByRole('contentinfo')).not.toBeInTheDocument()
  })

  it('renders .app root with data-theme attribute', () => {
    const { container } = renderApp()
    const appDiv = container.querySelector('.app')
    expect(appDiv).not.toBeNull()
    expect(appDiv?.getAttribute('data-theme')).toBe('light')
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
    const router = createMemoryRouter(routes, { initialEntries: ['/workflows'], future: { v7_relativeSplatPath: true } })
    render(
      <QueryProvider client={client}>
        <RefreshProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </RefreshProvider>
      </QueryProvider>,
    )
    expect(screen.getAllByText(/Workflows/i).length).toBeGreaterThan(0)
  })
})
