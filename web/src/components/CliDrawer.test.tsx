import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliDrawer } from './CliDrawer'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('CliDrawer', () => {
  it('renders nothing for a context with no content', () => {
    const { container } = render(<CliDrawer context="Logs" values={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when context is undefined', () => {
    const { container } = render(<CliDrawer context={undefined} values={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the CLI tab and resolves values into commands on AppDetail', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    expect(screen.getByRole('button', { name: 'CLI commands' })).toBeInTheDocument()
    expect(screen.getByText('dapr stop --app-id order')).toBeInTheDocument()
  })

  it('starts collapsed and toggles open/closed via the tab', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    const drawer = document.querySelector('.cli-drawer')!
    expect(drawer.className).not.toContain('open')
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    expect(document.querySelector('.cli-drawer')!.className).toContain('open')
  })

  it('persists the open state to localStorage', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    expect(localStorage.getItem('devdash.cliDrawerOpen')).toBe('true')
  })

  it('opens collapsed=false initially when localStorage says open', () => {
    localStorage.setItem('devdash.cliDrawerOpen', 'true')
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    expect(document.querySelector('.cli-drawer')!.className).toContain('open')
  })

  it('falls back to a literal <app-id> when appId is absent', () => {
    render(<CliDrawer context="Workflows" values={{}} />)
    expect(screen.getByText('dapr workflow list --app-id <app-id>')).toBeInTheDocument()
  })

  it('copies the resolved command and shows a Copied toast', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy command: dapr stop --app-id order' }))
    expect(copyText).toHaveBeenCalledWith('dapr stop --app-id order')
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })
})
