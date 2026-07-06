import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { RefreshProvider } from '../lib/refresh'
import { ControlPlane } from './ControlPlane'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <RefreshProvider>
        <MemoryRouter>
          <ControlPlane />
        </MemoryRouter>
      </RefreshProvider>
    </QueryClientProvider>,
  )
}

function mockList(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ))
}

describe('ControlPlane', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('shows an unavailable state when no runtime', async () => {
    mockList({ runtime: '', available: false, services: [] })
    renderPage()
    expect(await screen.findByText(/no container runtime/i)).toBeInTheDocument()
  })

  it('shows daemon-down state when runtime installed but daemon unreachable', async () => {
    mockList({ runtime: 'docker', available: true, reachable: false, controlPlanePresent: false, services: [] })
    renderPage()
    expect(await screen.findByText(/docker or podman is installed but not running/i)).toBeInTheDocument()
  })

  it('shows no-containers state when daemon reachable but no control-plane containers', async () => {
    mockList({ runtime: 'docker', available: true, reachable: true, controlPlanePresent: false, services: [] })
    renderPage()
    expect(await screen.findByText(/no dapr control plane found/i)).toBeInTheDocument()
  })

  it('renders a running service with a Restart action', async () => {
    mockList({
      runtime: 'docker', available: true, reachable: true, controlPlanePresent: true,
      services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: ['50006/tcp'], memoryBytes: 1, memoryHuman: '12MiB', logPath: '/x.log', actionable: true }],
    })
    renderPage()
    expect(await screen.findByText('dapr_scheduler')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restart/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument()
  })

  it('renders a stopped service with null ports without crashing', async () => {
    // A stopped container marshals Ports as JSON null; the card must not crash on svc.ports.length.
    mockList({
      runtime: 'docker', available: true, reachable: true, controlPlanePresent: true,
      services: [{ name: 'dapr_scheduler', status: 'stopped', healthy: false, ports: null, memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true }],
    })
    renderPage()
    expect(await screen.findByText('dapr_scheduler')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^start$/i })).toBeInTheDocument()
  })

  it('groups compose-run control-plane services under their project', async () => {
    mockList({
      runtime: 'docker',
      available: true,
      reachable: true,
      controlPlanePresent: true,
      services: [
        { name: 'dapr_placement', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true },
        { name: 'saga-placement-1', status: 'running', healthy: true, ports: ['50005/tcp'], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
        { name: 'saga-scheduler-0-1', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
      ],
    })
    renderPage()
    expect(await screen.findByText('saga-placement-1')).toBeInTheDocument()
    expect(screen.getByText(/compose · saga/i)).toBeInTheDocument()
    expect(screen.getByText('dapr_placement')).toBeInTheDocument()
  })
})
