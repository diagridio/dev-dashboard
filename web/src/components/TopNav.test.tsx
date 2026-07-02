import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { TopNav, NAV_ITEMS } from './TopNav'
import { RefreshProvider } from '../lib/refresh'

const noop = () => {}

describe('NAV_ITEMS', () => {
  it('has exactly 8 items in the correct order', () => {
    const labels = NAV_ITEMS.map((i) => i.label)
    expect(labels).toEqual([
      'Applications',
      'Workflows',
      'Actors',
      'Subscriptions',
      'Components',
      'Configurations',
      'Resiliency',
      'Logs',
    ])
  })

  it('has correct paths', () => {
    const paths = NAV_ITEMS.map((i) => i.to)
    expect(paths).toEqual([
      '/',
      '/workflows',
      '/actors',
      '/subscriptions',
      '/components',
      '/configurations',
      '/resiliency',
      '/logs',
    ])
  })
})

describe('TopNav', () => {
  function renderNav() {
    return render(
      <RefreshProvider>
        <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
          <TopNav theme="light" onThemeChange={noop} />
        </MemoryRouter>
      </RefreshProvider>,
    )
  }

  it('renders the Logo', () => {
    renderNav()
    expect(screen.getByRole('img', { name: /diagrid/i })).toBeInTheDocument()
  })

  it('renders all 8 nav links', () => {
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
})
