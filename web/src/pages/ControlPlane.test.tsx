import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
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

  it('shows test-containers-specific copy (no dapr init suggestion) in test-containers mode', async () => {
    window.__DASH_CAPABILITIES__ = { lifecycle: true, controlPlane: true, logs: true, workflows: true, mode: 'test-containers' }
    try {
      mockList({ runtime: 'docker', available: true, reachable: true, controlPlanePresent: false, services: [] })
      renderPage()
      expect(
        await screen.findByText(/control-plane detection is not available in test-containers mode/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/dapr init/i)).not.toBeInTheDocument()
    } finally {
      delete window.__DASH_CAPABILITIES__
    }
  })

  it('shows compose-specific copy (no dapr init suggestion) in compose mode', async () => {
    window.__DASH_CAPABILITIES__ = { lifecycle: true, controlPlane: true, logs: true, workflows: true, mode: 'compose' }
    try {
      mockList({ runtime: 'docker', available: true, reachable: true, controlPlanePresent: false, services: [] })
      renderPage()
      expect(
        await screen.findByText(/no compose-managed placement\/scheduler containers were found/i),
      ).toBeInTheDocument()
      expect(screen.queryByText(/dapr init/i)).not.toBeInTheDocument()
    } finally {
      delete window.__DASH_CAPABILITIES__
    }
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

  it('confirms an action through the styled dialog before posting', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(
        JSON.stringify({
          runtime: 'docker', available: true, reachable: true, controlPlanePresent: true,
          services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true }],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )
    })
    vi.stubGlobal('fetch', fetchMock)
    renderPage()
    expect(await screen.findByText('dapr_scheduler')).toBeInTheDocument()

    // Restart opens the dialog; Cancel must not post.
    screen.getByRole('button', { name: /restart/i }).click()
    let dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('Restart dapr_scheduler?')
    expect(dialog).toHaveTextContent('docker restart dapr_scheduler')
    within(dialog).getByRole('button', { name: 'Cancel' }).click()
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)

    // Confirming posts the action.
    screen.getByRole('button', { name: /restart/i }).click()
    dialog = await screen.findByRole('dialog')
    within(dialog).getByRole('button', { name: 'Restart' }).click()
    await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true))
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
