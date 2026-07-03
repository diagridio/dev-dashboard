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

  it('renders a running service with a Restart action', async () => {
    mockList({
      runtime: 'docker', available: true,
      services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: ['50006/tcp'], memoryBytes: 1, memoryHuman: '12MiB', logPath: '/x.log', actionable: true }],
    })
    renderPage()
    expect(await screen.findByText('dapr_scheduler')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restart/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument()
  })

  it('renders k8s-only services without actions', async () => {
    mockList({
      runtime: 'docker', available: true,
      services: [{ name: 'dapr_sentry', status: 'kubernetes-only', healthy: false, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: false }],
    })
    renderPage()
    expect(await screen.findByText('dapr_sentry')).toBeInTheDocument()
    expect(screen.getByText(/kubernetes only/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
