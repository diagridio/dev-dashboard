import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { ResourcesSidebar } from './ResourcesSidebar'

beforeEach(() => {
  localStorage.clear()
})

describe('ResourcesSidebar static links', () => {
  it('renders Dapr Docs link with correct href and target', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Dapr Docs' })
    expect(link).toHaveAttribute('href', 'https://docs.dapr.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Docs link with correct href and target', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Diagrid Docs' })
    expect(link).toHaveAttribute('href', 'https://docs.diagrid.io')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Diagrid Catalyst link with correct href and target', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Diagrid Catalyst' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/catalyst')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('renders Dapr Workflow Skills link', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Dapr Workflow Skills' })
    expect(link).toHaveAttribute('href', 'https://docs.diagrid.io/develop/workflows/dapr-skills/')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Dapr Composer link', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Dapr Composer' })
    expect(link).toHaveAttribute('href', 'https://workflows.diagrid.io/')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Dapr University link', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Dapr University' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/university')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders Diagrid Webinars link', () => {
    render(<ResourcesSidebar />)
    const link = screen.getByRole('link', { name: 'Diagrid Webinars' })
    expect(link).toHaveAttribute('href', 'https://www.diagrid.io/webinars')
    expect(link).toHaveAttribute('target', '_blank')
  })

  it('renders all 4 section headers in uppercase', () => {
    render(<ResourcesSidebar />)
    expect(screen.getByText('BUILD')).toBeInTheDocument()
    expect(screen.getByText('LEARN')).toBeInTheDocument()
    expect(screen.getByText('READ')).toBeInTheDocument()
    expect(screen.getByText('RUN & OPERATE')).toBeInTheDocument()
  })
})

describe('ResourcesSidebar collapse toggle', () => {
  it('is expanded by default', () => {
    render(<ResourcesSidebar />)
    // When expanded, links are visible
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
    // Vertical "Resources" label should not be visible when expanded
    expect(screen.queryByTestId('sidebar-collapsed-label')).not.toBeInTheDocument()
  })

  it('clicking toggle collapses the sidebar', () => {
    render(<ResourcesSidebar />)
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    // When collapsed, section links should be hidden (not in DOM or hidden)
    expect(screen.queryByRole('link', { name: 'Dapr Docs' })).not.toBeInTheDocument()
    // Vertical "Resources" label should appear
    expect(screen.getByTestId('sidebar-collapsed-label')).toBeInTheDocument()
  })

  it('clicking toggle twice restores expanded state', () => {
    render(<ResourcesSidebar />)
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
    expect(screen.queryByTestId('sidebar-collapsed-label')).not.toBeInTheDocument()
  })

  it('persists collapsed state to localStorage', () => {
    render(<ResourcesSidebar />)
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('true')
  })

  it('persists expanded state to localStorage after re-expanding', () => {
    render(<ResourcesSidebar />)
    const toggle = screen.getByTestId('sidebar-toggle')
    fireEvent.click(toggle)
    fireEvent.click(toggle)
    expect(localStorage.getItem('devdash.sidebarCollapsed')).toBe('false')
  })

  it('reads initial collapsed state from localStorage', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    render(<ResourcesSidebar />)
    // When starting collapsed, links hidden and vertical label visible
    expect(screen.queryByRole('link', { name: 'Dapr Docs' })).not.toBeInTheDocument()
    expect(screen.getByTestId('sidebar-collapsed-label')).toBeInTheDocument()
  })

  it('clicking vertical Resources label in collapsed state expands sidebar', () => {
    localStorage.setItem('devdash.sidebarCollapsed', 'true')
    render(<ResourcesSidebar />)
    const label = screen.getByTestId('sidebar-collapsed-label')
    fireEvent.click(label)
    expect(screen.getByRole('link', { name: 'Dapr Docs' })).toBeInTheDocument()
  })
})
