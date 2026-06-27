import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { ResourcesSidebar } from './ResourcesSidebar'
import { QueryProvider, makeQueryClient } from '../lib/query'

// Default news response for most tests: blog + webinar present, report + event absent
const defaultNews = {
  blog: { title: 'Blog A', url: 'u1' },
  report: null,
  webinar: { title: 'WB', url: 'u2' },
  event: null,
}

function renderSidebar() {
  const client = makeQueryClient()
  return render(
    <QueryProvider client={client}>
      <ResourcesSidebar />
    </QueryProvider>,
  )
}

beforeEach(() => {
  localStorage.clear()
  server.use(http.get('/api/news', () => HttpResponse.json(defaultNews)))
})

describe('ResourcesSidebar static links', () => {
  it('renders Dapr Docs link with correct href and target', async () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Dapr Docs' })
    expect(link).toHaveAttribute('href', 'https://docs.dapr.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Docs link with correct href and target', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Diagrid Docs' })
    expect(link).toHaveAttribute('href', 'https://docs.diagrid.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Catalyst link with correct href and target', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Diagrid Catalyst' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/catalyst')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Dapr Workflow Skills link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Dapr Workflow Skills' })
    expect(link).toHaveAttribute('href', 'https://docs.diagrid.io/develop/workflows/dapr-skills/')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Dapr Composer link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Dapr Composer' })
    expect(link).toHaveAttribute('href', 'https://workflows.diagrid.io/')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Dapr University link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Dapr University' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/university')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Diagrid Webinars link', () => {
    renderSidebar()
    const link = screen.getByRole('link', { name: 'Diagrid Webinars' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/webinars')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders all 4 section headers in uppercase', () => {
    renderSidebar()
    expect(screen.getByText('BUILD')).toBeInTheDocument()
    expect(screen.getByText('LEARN')).toBeInTheDocument()
    expect(screen.getByText('READ')).toBeInTheDocument()
    expect(screen.getByText('RUN & OPERATE')).toBeInTheDocument()
  })
})

describe('ResourcesSidebar collapse toggle', () => {
  it('is expanded by default', () => {
    renderSidebar()
    // When expanded, links are visible
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
    // Vertical "Resources" label should not be visible when expanded
    expect(screen.queryByTestId('sidebar-collapsed-label')).not.toBeInTheDocument()
  })

  it('clicking toggle collapses the sidebar', () => {
    renderSidebar()
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    // When collapsed, section links should be hidden (not in DOM or hidden)
    expect(screen.queryByRole('link', { name: 'Dapr Docs' })).not.toBeInTheDocument()
    // Vertical "Resources" label should appear
    expect(screen.getByTestId('sidebar-collapsed-label')).toBeInTheDocument()
  })

  it('clicking toggle twice restores expanded state', () => {
    renderSidebar()
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-collapsed-label')).not.toBeInTheDocument()
  })

  it('persists collapsed state to localStorage', () => {
    renderSidebar()
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('true')
  })

  it('persists expanded state to localStorage after re-expanding', () => {
    renderSidebar()
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('false')
  })

  it('reads initial collapsed state from localStorage', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    renderSidebar()
    // When starting collapsed, links hidden and vertical label visible
    expect(screen.queryByRole('link', { name: 'Dapr Docs' })).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-collapsed-label')).toBeInTheDocument()
  })

  it('clicking vertical Resources label in collapsed state expands sidebar', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    renderSidebar()
    const label = screen.getByTestId('sidebar-collapsed-label')
    fireEvent.click(label)
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
  })
})

describe('ResourcesSidebar News section', () => {
  it('renders blog link with correct href and new-tab attributes', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Blog A/i })
    expect(link).toHaveAttribute('href', 'u1')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders webinar link', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /WB/i })
    expect(link).toHaveAttribute('href', 'u2')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders empty state for absent report slot', async () => {
    renderSidebar()
    // blog link signals news loaded
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.getByText('No reports')).toBeInTheDocument()
  })

  it('renders empty state for absent event slot', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.getByText('No upcoming events')).toBeInTheDocument()
  })

  it('shows bell indicator (data-cy=news-bell) when items are unseen', async () => {
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.getByTestId('news-bell')).toBeInTheDocument()
  })

  it('clicking bell marks items as seen and hides the bell', async () => {
    renderSidebar()
    const bell = await screen.findByTestId('news-bell')
    fireEvent.click(bell)
    await waitFor(() => {
      expect(screen.queryByTestId('news-bell')).not.toBeInTheDocument()
    })
    // Persisted to localStorage
    const raw = localStorage.getItem('devdash.newsSeen')
    expect(raw).toBeTruthy()
    const seen = JSON.parse(raw!)
    expect(seen).toContain('u1')
    expect(seen).toContain('u2')
  })

  it('clicking a news link marks items as seen and hides the bell', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Blog A/i })
    fireEvent.click(link)
    await waitFor(() => {
      expect(screen.queryByTestId('news-bell')).not.toBeInTheDocument()
    })
  })

  it('does not show bell when all items already seen', async () => {
    // Pre-mark both urls as seen
    localStorage.setItem('devdash.newsSeen', JSON.stringify(['u1', 'u2']))
    renderSidebar()
    await screen.findByRole('link', { name: /Blog A/i })
    expect(screen.queryByTestId('news-bell')).not.toBeInTheDocument()
  })

  it('shows bell in collapsed rail when items are unseen', async () => {
    renderSidebar()
    // Wait for news to load
    await screen.findByTestId('news-bell')
    // Collapse the sidebar
    fireEvent.click(screen.getByTestId('sidebar-toggle'))
    // Bell should still be present in collapsed state
    expect(screen.getByTestId('news-bell')).toBeInTheDocument()
  })
})
