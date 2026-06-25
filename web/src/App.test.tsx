import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi, beforeAll } from 'vitest'
import { MemoryRouter, Routes, Route } from 'react-router-dom'
import App from './App'
import { Placeholder } from './pages/Placeholder'

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

// Test App shell by wrapping with MemoryRouter (router.tsx uses createBrowserRouter externally)
function renderApp(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/*" element={<App />} />
      </Routes>
    </MemoryRouter>,
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
    expect(screen.getByRole('navigation')).toBeInTheDocument()
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
