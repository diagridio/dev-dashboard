import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { ResourcesSidebar } from './ResourcesSidebar'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { trackAction } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))

// Default news response for most tests: blog + webinar present, report + event absent
const defaultNews = {
  blog: { title: 'Blog A', url: 'u1' },
  report: null,
  webinar: { title: 'WB', url: 'u2' },
  event: null,
}

/** Wrapper that owns the lifted state so ResourcesSidebar can be tested standalone */
function SidebarWrapper({ initialCollapsed = false }: { initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [hasNew, setHasNew] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  return (
    // Wrap in .app so CSS selectors (data-theme, has-new) resolve correctly
    <div
      className={['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : '', updateAvailable ? 'update-available' : '']
        .filter(Boolean)
        .join(' ')}
      data-theme="light"
    >
      <ResourcesSidebar
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        onHasNewChange={setHasNew}
        onUpdateAvailableChange={setUpdateAvailable}
      />
    </div>
  )
}

function renderSidebar(opts?: { initialCollapsed?: boolean }) {
  const client = makeQueryClient()
  return render(
    <QueryProvider client={client}>
      <SidebarWrapper initialCollapsed={opts?.initialCollapsed} />
    </QueryProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  server.use(http.get('/api/news', () => HttpResponse.json(defaultNews)))
  server.use(http.get('/api/version', () => HttpResponse.json({ version: '1.2.3', commit: 'abc', date: '2026-01-01' })))
  server.use(
    http.get('/api/update-check', () =>
      HttpResponse.json({ current: 'v1.2.3', latest: 'v1.2.3', updateAvailable: false, releaseUrl: '' }),
    ),
  )
})

describe('ResourcesSidebar static links', () => {
  it('renders Dapr Docs link with correct href and target', async () => {
    renderSidebar()
    // Accessible name includes "↗" from the .ext span; use regex
    const link = screen.getByRole('link', { name: /Dapr Docs/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-dapr-docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Docs link with correct href and target', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Diagrid Docs/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-diagrid-docs')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Catalyst link with correct href and target', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Diagrid Catalyst/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-try-catalyst')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Dapr Workflow Skills link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Dapr Workflow Skills/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-workflow-skill')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Workflow Composer link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Workflow Composer/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-workflow-composer')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Dapr University link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Dapr University/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-dapr-university')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Diagrid Webinars link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Diagrid Webinars/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-webinars')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders section titles', () => {
    renderSidebar()
    // sbtitle elements (CSS uppercases them, but text content is mixed case)
    expect(screen.getByText('Community')).toBeInTheDocument()
    expect(screen.getByText('Build')).toBeInTheDocument()
    expect(screen.getByText('Learn')).toBeInTheDocument()
    expect(screen.getByText('Read')).toBeInTheDocument()
    expect(screen.getByText('Run & Operate')).toBeInTheDocument()
  })

  it('renders Dapr Discord link under Community', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Dapr Discord/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-dapr-discord')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Dapr Support link under Run & Operate', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: /Dapr Support/ })
    expect(link).toHaveAttribute('href', 'https://diagrid.ws/dev-dashboard-dapr-support')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('orders sections Community, Read, Learn, Build, Run & Operate, News', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    const titles = Array.from(document.querySelectorAll('.sbtitle')).map((el) => el.textContent)
    expect(titles).toEqual(['Community', 'Read', 'Learn', 'Build', 'Run & Operate', 'News'])
  })
})

describe('ResourcesSidebar collapse toggle', () => {
  it('is expanded by default', () => {
    renderSidebar()
    // When expanded, sbscroll nav and links are visible in DOM
    expect(screen.getByRole('link', { name: /Dapr Docs/ })).toBeInTheDocument()
    // The sbvert label is always in DOM (CSS controls visibility)
    expect(screen.getByTestId('sidebar-collapsed-label')).toBeInTheDocument()
  })

  it('clicking toggle collapses the sidebar', () => {
    renderSidebar()
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    fireEvent.click(toggle)
    // After collapse, toggle label changes
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('clicking toggle twice restores expanded state', () => {
    renderSidebar()
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    fireEvent.click(toggle)
    const toggleAgain = screen.getByRole('button', { name: 'Expand sidebar' })
    fireEvent.click(toggleAgain)
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
  })

  it('persists collapsed state to localStorage', () => {
    renderSidebar()
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    fireEvent.click(toggle)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('true')
  })

  it('persists expanded state to localStorage after re-expanding', () => {
    renderSidebar()
    const toggle = screen.getByRole('button', { name: 'Collapse sidebar' })
    fireEvent.click(toggle)
    const toggleAgain = screen.getByRole('button', { name: 'Expand sidebar' })
    fireEvent.click(toggleAgain)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('false')
  })

  it('reads initial collapsed state from localStorage', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    renderSidebar({ initialCollapsed: true })
    // Starts collapsed — toggle button says "Expand sidebar"
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeInTheDocument()
  })

  it('clicking vertical Resources label in collapsed state expands sidebar', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    renderSidebar({ initialCollapsed: true })
    const label = screen.getByRole('button', { name: 'Resources — expand sidebar' })
    fireEvent.click(label)
    expect(screen.getByRole('button', { name: 'Collapse sidebar' })).toBeInTheDocument()
  })
})

describe('ResourcesSidebar News section', () => {
  it('renders blog link with correct href and new-tab attributes', async () => {
    renderSidebar()
    // Link accessible name includes title + "↗" from .ext span
    const link = await screen.findByRole('link', { name: /Blog A/ })
    expect(link).toHaveAttribute('href', 'u1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders webinar link', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /WB/ })
    expect(link).toHaveAttribute('href', 'u2')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders nothing (no label) for absent report slot', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.queryByText(/No reports/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Report/)).not.toBeInTheDocument()
  })

  it('renders nothing (no label) for absent event slot', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.queryByText(/No upcoming events/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/Event/)).not.toBeInTheDocument()
  })

  it('orders present news items Blog before Webinar', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    const links = screen.getAllByRole('link')
    const blogIdx = links.findIndex((l) => /Blog A/.test(l.textContent ?? ''))
    const webinarIdx = links.findIndex((l) => /WB/.test(l.textContent ?? ''))
    expect(blogIdx).toBeGreaterThanOrEqual(0)
    expect(webinarIdx).toBeGreaterThan(blogIdx)
  })

  it('shows bell indicator when items are unseen', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    // Both bell buttons exist in the DOM (CSS-controlled); at least one "Mark news as seen" button present
    const bells = screen.getAllByRole('button', { name: 'Mark news as seen' })
    expect(bells.length).toBeGreaterThan(0)
  })

  it('clicking bell marks items as seen — stored to localStorage', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    const bells = screen.getAllByRole('button', { name: 'Mark news as seen' })
    fireEvent.click(bells[0])
    await waitFor(() => {
      const raw = localStorage.getItem('devdash.newsSeen')
      expect(raw).toBeTruthy()
      const seen = JSON.parse(raw!)
      expect(seen).toContain('u1')
      expect(seen).toContain('u2')
    })
  })

  it('clicking a news link marks items as seen', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Blog A/ })
    fireEvent.click(link)
    await waitFor(() => {
      const raw = localStorage.getItem('devdash.newsSeen')
      expect(raw).toBeTruthy()
    })
  })

  it('news item with a zero-value publish date shows the type only, no date', async () => {
    // Upstream sends Go's zero time for dateless items (e.g. reports). The UI must
    // show just the label ("Report"), never "Report · Jan 1".
    server.use(
      http.get('/api/news', () =>
        HttpResponse.json({
          blog: null,
          report: {
            title: 'Start of Dapr 2026 Report',
            url: 'https://example.com/report',
            publishedAt: '0001-01-01T00:00:00Z',
          },
          webinar: null,
          event: null,
        }),
      ),
    )
    renderSidebar()
    expect(await screen.findByText('Start of Dapr 2026 Report')).toBeInTheDocument()
    expect(screen.getByText('Report')).toBeInTheDocument()
    expect(screen.queryByText(/Report · /)).not.toBeInTheDocument()
    expect(screen.queryByText(/Jan 1/)).not.toBeInTheDocument()
  })

  it('news item shows type + publish date, not the description', async () => {
    // Arrange: blog item with an excerpt that must NOT render, and a publish date
    server.use(
      http.get('/api/news', () =>
        HttpResponse.json({
          blog: {
            title: 'Durable Execution',
            url: 'https://example.com/blog',
            excerpt: 'THIS DESCRIPTION SHOULD NOT RENDER',
            publishedAt: '2026-06-22T09:00:00Z',
          },
          report: null,
          webinar: null,
          event: null,
        }),
      ),
    )
    renderSidebar() // use the existing render helper in this file
    expect(await screen.findByText('Durable Execution')).toBeInTheDocument()
    // Type + date (time excluded)
    expect(screen.getByText('Blog · Jun 22')).toBeInTheDocument()
    // Description must not appear
    expect(screen.queryByText(/THIS DESCRIPTION SHOULD NOT RENDER/)).not.toBeInTheDocument()
  })
})

describe('ResourcesSidebar footer', () => {
  it('renders Powered by Diagrid link and version in sbfoot', async () => {
    renderSidebar()
    // Wait for the Diagrid link to appear
    const link = await screen.findByRole('link', { name: 'Diagrid' })
    expect(link).toHaveAttribute(
      'href',
      'https://diagrid.io/?utm_source=dev-dashboard&utm_medium=footer',
    )
    expect(link).toHaveAttribute('target', '_blank')
    // Version comes from /api/version mock returning "1.2.3"
    // Text is split across nodes, so poll until the async version resolves
    const sbfoot = document.querySelector('.sbfoot')
    await waitFor(() => {
      expect(sbfoot?.textContent).toContain('Powered by Diagrid · v1.2.3')
    })
  })

  it('renders Issues & feedback link to the GitHub repo', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: 'Issues & feedback' })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // Lives inside the footer, below the Powered by line
    expect(link.closest('.sbfoot')).not.toBeNull()
  })
})

describe('ResourcesSidebar onHasNewChange contract', () => {
  /** Minimal wrapper that passes a spy as onHasNewChange so we can assert on it. */
  function renderWithSpy(onHasNewChange: (v: boolean) => void) {
    const client = makeQueryClient()
    return render(
      <QueryProvider client={client}>
        <div className="app" data-theme="light">
          <ResourcesSidebar
            collapsed={false}
            onCollapsedChange={() => undefined}
            onHasNewChange={onHasNewChange}
            onUpdateAvailableChange={() => undefined}
          />
        </div>
      </QueryProvider>,
    )
  }

  it('calls onHasNewChange(true) when news has unseen URLs', async () => {
    // defaultNews has blog (u1) and webinar (u2) — localStorage is clear so both are unseen
    const spy = vi.fn()
    renderWithSpy(spy)
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(true)
    })
  })

  it('calls onHasNewChange(false) when all news URLs have been seen', async () => {
    // Pre-mark both URLs from defaultNews as seen
    localStorage.setItem('devdash.newsSeen', JSON.stringify(['u1', 'u2']))
    const spy = vi.fn()
    renderWithSpy(spy)
    await waitFor(() => {
      // After news loads, unseen = false → callback fires with false
      expect(spy).toHaveBeenCalledWith(false)
    })
    // Must never have been called with true
    expect(spy).not.toHaveBeenCalledWith(true)
  })

  it('calls onHasNewChange(false) when news API returns no items', async () => {
    server.use(http.get('/api/news', () => HttpResponse.json({ blog: null, report: null, webinar: null, event: null })))
    const spy = vi.fn()
    renderWithSpy(spy)
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith(false)
    })
    expect(spy).not.toHaveBeenCalledWith(true)
  })
})

describe('ResourcesSidebar update indicator', () => {
  const withUpdate = () =>
    server.use(
      http.get('/api/update-check', () =>
        HttpResponse.json({
          current: 'v1.2.0',
          latest: 'v1.3.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
        }),
      ),
    )

  it('shows an Update available link in the footer when an update exists', async () => {
    withUpdate()
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Update available/i })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    // The badge is its own footer line above Powered by, so nothing is cut off
    // by the nowrap version line; Issues & feedback stays visible below.
    const lines = Array.from(document.querySelectorAll('.sbfoot .pw')).map((el) => el.textContent ?? '')
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('Update available')
    expect(lines[0]).not.toContain('Powered by')
    expect(lines[1]).toContain('Powered by')
    expect(lines[2]).toContain('Issues & feedback')
  })

  it('shows no update link when up to date', async () => {
    // default beforeEach mock has updateAvailable:false
    renderSidebar()
    await screen.findByRole('link', { name: 'Diagrid' })
    expect(screen.queryByRole('link', { name: /Update available/i })).not.toBeInTheDocument()
  })

  it('renders the collapsed update indicator linking to the release', async () => {
    withUpdate()
    renderSidebar({ initialCollapsed: true })
    const link = await screen.findByRole('link', { name: /version .* is available/i })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0')
  })
})

describe('ResourcesSidebar telemetry', () => {
  it('tracks resource_click with section and label when a static link is clicked', () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('link', { name: /Dapr Docs/ }))
    expect(trackAction).toHaveBeenCalledWith('resource_click', { section: 'Read', label: 'Dapr Docs' })
  })

  it('tracks resource_click for a news item, in addition to marking it seen', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Blog A/ })
    fireEvent.click(link)
    expect(trackAction).toHaveBeenCalledWith('resource_click', { section: 'News', label: 'Blog A', kind: 'blog' })
    await waitFor(() => {
      expect(localStorage.getItem('devdash.newsSeen')).toBeTruthy()
    })
  })
})
