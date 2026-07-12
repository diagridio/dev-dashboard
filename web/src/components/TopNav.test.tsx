import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { TopNav, NAV_ITEMS } from './TopNav'
import { RefreshProvider } from '../lib/refresh'
import { ConnectionContext } from '../lib/connection'
import { trackAction } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))

const noop = () => {}

describe('NAV_ITEMS', () => {
  it('has exactly 9 items in the correct order', () => {
    const labels = NAV_ITEMS.map((i) => i.label)
    expect(labels).toEqual([
      'Applications',
      'Components',
      'Workflows',
      'Actors',
      'Subscriptions',
      'Resiliency',
      'Configurations',
      'Control Plane',
      'Logs',
    ])
  })

  it('has correct paths', () => {
    const paths = NAV_ITEMS.map((i) => i.to)
    expect(paths).toEqual([
      '/',
      '/components',
      '/workflows',
      '/actors',
      '/subscriptions',
      '/resiliency',
      '/configurations',
      '/control-plane',
      '/logs',
    ])
  })

  it('includes a Control Plane nav item', () => {
    expect(NAV_ITEMS.some((i) => i.to === '/control-plane')).toBe(true)
  })
})

describe('TopNav', () => {
  afterEach(() => {
    delete window.__DASH_CAPABILITIES__
  })

  function renderNav() {
    return render(
      <RefreshProvider>
        <ConnectionContext value={{ online: true }}>
          <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
            <TopNav theme="light" onThemeChange={noop} />
          </MemoryRouter>
        </ConnectionContext>
      </RefreshProvider>,
    )
  }

  it('renders the Logo', () => {
    renderNav()
    expect(screen.getByRole('img', { name: /diagrid/i })).toBeInTheDocument()
  })

  it('renders all 9 nav links', () => {
    renderNav()
    for (const item of NAV_ITEMS) {
      expect(screen.getByRole('link', { name: item.label })).toBeInTheDocument()
    }
  })

  it('renders ThemeToggle', () => {
    renderNav()
    expect(screen.getByRole('button', { name: /toggle theme/i })).toBeInTheDocument()
  })

  it('renders the compact refresh control', () => {
    renderNav()
    expect(screen.getByRole('combobox', { name: /refresh interval/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /pause auto-refresh/i })).toBeInTheDocument()
  })

  it('does not render DensityToggle', () => {
    renderNav()
    expect(screen.queryByRole('button', { name: /toggle density/i })).not.toBeInTheDocument()
  })

  it('Applications link points to /', () => {
    renderNav()
    const link = screen.getByRole('link', { name: 'Applications' })
    expect(link).toHaveAttribute('href', '/')
  })

  it('Logs link points to /logs', () => {
    renderNav()
    const link = screen.getByRole('link', { name: 'Logs' })
    expect(link).toHaveAttribute('href', '/logs')
  })

  it('tracks nav_click with the item label when a nav link is clicked', () => {
    renderNav()
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }))
    expect(trackAction).toHaveBeenCalledWith('nav_click', { label: 'Workflows' })
  })

  it('hides capability-gated entries when their capability is off', () => {
    window.__DASH_CAPABILITIES__ = {
      lifecycle: false,
      controlPlane: false,
      logs: false,
      workflows: true,
    }
    renderNav()
    expect(screen.queryByText('Control Plane')).toBeNull()
    expect(screen.queryByText('Logs')).toBeNull()
    expect(screen.getByText('Workflows')).toBeInTheDocument()
    expect(screen.getByText('Applications')).toBeInTheDocument()
  })

  describe('topbar height tracking', () => {
    afterEach(() => {
      vi.unstubAllGlobals()
      document.documentElement.style.removeProperty('--topbar-h')
    })

    it('publishes the topbar height as --topbar-h so the sidebar can start below it', () => {
      let onResize: (() => void) | undefined
      const observed: Element[] = []
      vi.stubGlobal(
        'ResizeObserver',
        class {
          constructor(cb: () => void) {
            onResize = cb
          }
          observe(el: Element) {
            observed.push(el)
          }
          unobserve() {}
          disconnect() {}
        },
      )
      renderNav()
      const header = document.querySelector('header.topbar')
      expect(header).not.toBeNull()
      expect(observed).toContain(header)
      // Simulate the topbar wrapping to multiple rows (e.g. zoom / narrow window)
      Object.defineProperty(header, 'offsetHeight', { value: 82, configurable: true })
      onResize?.()
      expect(document.documentElement.style.getPropertyValue('--topbar-h')).toBe('82px')
    })

    it('removes --topbar-h on unmount', () => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      )
      const { unmount } = renderNav()
      expect(document.documentElement.style.getPropertyValue('--topbar-h')).not.toBe('')
      unmount()
      expect(document.documentElement.style.getPropertyValue('--topbar-h')).toBe('')
    })
  })
})
