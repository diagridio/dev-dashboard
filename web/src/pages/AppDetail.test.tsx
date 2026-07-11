import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { AppDetail } from './AppDetail'

function renderDetail() {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/apps/:appId', element: <AppDetail /> },
      { path: '/components/:name', element: <div>Component detail</div> },
    ],
    { initialEntries: ['/apps/order'], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('AppDetail', () => {
  const runningApp = {
    appId: 'order',
    health: 'healthy',
    runtime: 'go',
    httpPort: 3500,
    grpcPort: 50001,
    appPort: 8080,
    daprdPid: 48230,
    appPid: 48213,
    cliPid: 48201,
    command: 'go run ./cmd/order',
    runtimeVersion: '1.14.4',
    metadataOk: true,
    appStatus: 'running',
    daprdStatus: 'running',
  }

  it('stops the whole instance from the header after confirm', async () => {
    let posted = ''
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
      http.post('/api/apps/order/all/stop', () => {
        posted = 'all/stop'
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stopButtons = screen.getAllByRole('button', { name: 'Stop' })
    stopButtons[0].click() // header button renders first
    await waitFor(() => expect(posted).toBe('all/stop'))
    confirmSpy.mockRestore()
  })

  it('does not act when confirm is declined', async () => {
    let posted = false
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
      http.post('/api/apps/order/all/stop', () => {
        posted = true
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getAllByRole('button', { name: 'Stop' })[0].click()
    await new Promise((r) => setTimeout(r, 50))
    expect(posted).toBe(false)
    confirmSpy.mockRestore()
  })

  it('offers Start for a stopped target and hides Start for Aspire', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, appStatus: 'stopped', daprdStatus: 'stopped', isAspire: true }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.getByText(/Managed by Aspire/)).toBeInTheDocument()
  })

  it('offers per-panel Start for a stopped non-Aspire target', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, daprdStatus: 'stopped' }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Start' }).length).toBeGreaterThan(0)
  })

  it('renders header and sidecar fields', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          daprdPid: 48230,
          appPid: 48213,
          cliPid: 48201,
          command: 'go run ./cmd/order',
          runtimeVersion: '1.14.4',
          metadataOk: true,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText('3500')).toBeInTheDocument()
    // Breadcrumb must point at the Applications index route ('/'), not a non-existent '/apps'
    expect(screen.getByRole('link', { name: 'Applications' })).toHaveAttribute('href', '/')
  })

  it('renders copy-path affordance on non-empty path values', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          daprdPid: 48230,
          appPid: 48213,
          cliPid: 48201,
          command: 'go run ./cmd/order',
          runtimeVersion: '1.14.4',
          metadataOk: true,
          configPath: '/home/user/.dapr/config.yaml',
          appLogPath: '/tmp/order.log',
          resourcePaths: ['/home/user/.dapr/components'],
        }),
      ),
    )
    const { container } = renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const copyEls = container.querySelectorAll('[data-cy="copy-path"]')
    expect(copyEls.length).toBeGreaterThan(0)
  })

  it('notes metadata unavailable', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'unhealthy',
          runtime: 'python',
          httpPort: 3500,
          daprdPid: 9,
          appPid: 0,
          metadataOk: false,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText(/metadata unavailable/i)).toBeInTheDocument())
  })

  it('shows container identities instead of PIDs for compose apps', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'primes-go',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          metadataOk: true,
          source: 'compose',
          composeProject: 'saga',
          composeService: 'primes-go-dapr',
          sidecarReachable: true,
          daprdContainerId: 'aaa111bbb222',
          daprdContainerName: 'saga-primes-go-dapr-1',
          appContainerId: 'ccc333ddd444',
          appContainerName: 'saga-primes-go-1',
        }),
      ),
    )
    renderDetail()
    expect(await screen.findByText('saga-primes-go-1')).toBeInTheDocument()
    expect(screen.getByText('saga-primes-go-dapr-1')).toBeInTheDocument()
    expect(screen.getByText(/compose project/i)).toBeInTheDocument()
    expect(screen.getByText('saga')).toBeInTheDocument()
    expect(screen.queryByText('App PID')).not.toBeInTheDocument()
    expect(screen.queryByText('daprd PID')).not.toBeInTheDocument()
  })

  it('shows the publish-port hint for unreachable compose apps', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'x',
          health: 'unhealthy',
          runtime: 'go',
          httpPort: 3500,
          metadataOk: false,
          source: 'compose',
          sidecarReachable: false,
        }),
      ),
    )
    renderDetail()
    expect(await screen.findByText(/publish the daprd HTTP port/i)).toBeInTheDocument()
  })

  it('renders metadata section with component chips and enabled features', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          daprdPid: 48230,
          appPid: 48213,
          cliPid: 48201,
          command: 'go run ./cmd/order',
          runtimeVersion: '1.14.4',
          metadataOk: true,
          components: [{ name: 'statestore', type: 'state.redis', version: 'v1' }],
          enabledFeatures: ['StateStore'],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())

    // Component chip should be a link to /components/statestore
    const chip = screen.getByRole('link', { name: /statestore/ })
    expect(chip).toBeInTheDocument()
    expect(chip).toHaveAttribute('href', '/components/statestore')

    // Enabled features should render
    expect(screen.getByText('StateStore')).toBeInTheDocument()
  })

  it('sets the document title to the app id', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          daprdPid: 48230,
          appPid: 48213,
          cliPid: 48201,
          command: 'go run ./cmd/order',
          runtimeVersion: '1.14.4',
          metadataOk: true,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(document.title).toBe('order | Diagrid Dev Dashboard'))
  })

  it('titles compose apps by app id with the container name underneath and links logs by instance key', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'daprmq-service',
          instanceKey: 'daprmq-host-1',
          health: 'healthy',
          runtime: 'dotnet',
          httpPort: 3502,
          grpcPort: 50003,
          appPort: 8080,
          metadataOk: true,
          source: 'compose',
          composeProject: 'dapr-mq',
          sidecarReachable: true,
          daprdContainerId: 'aaa111bbb222',
          daprdContainerName: 'daprmq-host-1-dapr',
          appContainerId: 'ccc333ddd444',
          appContainerName: 'daprmq-host-1',
        }),
      ),
    )
    const { container } = renderDetail()
    // App id is the title; the container name renders as the sub-line under it.
    await waitFor(() => expect(screen.getByRole('heading', { name: 'daprmq-service' })).toBeInTheDocument())
    expect(container.querySelector('.phead .sub')).toHaveTextContent('daprmq-host-1')
    // Breadcrumb leaf shows the instance key.
    expect(container.querySelector('.crumbs .cur')).toHaveTextContent('daprmq-host-1')
    expect(screen.getByRole('link', { name: /view logs/i })).toHaveAttribute(
      'href',
      '/logs?app=daprmq-host-1&source=daprd',
    )
  })

  it('shows per-target status and ticking uptime', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    vi.setSystemTime(new Date('2026-07-09T10:05:00Z'))
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'healthy',
          runtime: 'go',
          httpPort: 3500,
          grpcPort: 50001,
          appPort: 8080,
          daprdPid: 48230,
          appPid: 48213,
          cliPid: 48201,
          command: 'go run ./cmd/order',
          runtimeVersion: '1.14.4',
          metadataOk: true,
          appStatus: 'running',
          daprdStatus: 'stopped',
          appStartedAt: '2026-07-09T10:00:00Z',
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText('running')).toBeInTheDocument()
    expect(screen.getByText('stopped')).toBeInTheDocument()
    expect(screen.getByText(/^5m 0[0-2]s$/)).toBeInTheDocument() // app uptime ticks from startedAt
    vi.useRealTimers()
  })

  it('shows the orphan banner and orphaned header state', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true, cliPid: 0, appPid: 0 }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText(/Orphaned sidecar — this daprd has no supervising dapr CLI/)).toBeInTheDocument()
    expect(screen.getByText('orphaned')).toBeInTheDocument()
  })

  it('funnels sidecar stop to the whole instance for dapr run apps', async () => {
    let posted = ''
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)), // standalone, not Aspire
      http.post('/api/apps/order/all/stop', () => {
        posted = 'all/stop'
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    // Buttons render header-first, then app panel, then daprd panel — the
    // last Stop button is the daprd panel's.
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    stops[stops.length - 1].click()
    await waitFor(() => expect(posted).toBe('all/stop'))
    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('app + sidecar together'))
    confirmSpy.mockRestore()
  })

  it('keeps per-container sidecar target for compose apps', async () => {
    let posted = ''
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, source: 'compose', daprdContainerName: 'proj-daprd-1' }),
      ),
      http.post('/api/apps/order/daprd/stop', () => {
        posted = 'daprd/stop'
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    stops[stops.length - 1].click()
    await waitFor(() => expect(posted).toBe('daprd/stop'))
    confirmSpy.mockRestore()
  })

  it('surfaces action errors via toast', async () => {
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
      http.post('/api/apps/order/all/stop', () =>
        HttpResponse.json({ error: 'boom from backend' }, { status: 502 }),
      ),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getAllByRole('button', { name: 'Stop' })[0].click()
    await waitFor(() => expect(screen.getByText('boom from backend')).toBeInTheDocument())
    confirmSpy.mockRestore()
  })

  it('disables lifecycle buttons while an action is in flight', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
      http.post('/api/apps/order/all/stop', async () => {
        await gate
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stop = screen.getAllByRole('button', { name: 'Stop' })[0]
    stop.click()
    await waitFor(() => expect(stop).toBeDisabled())
    release()
    await waitFor(() => expect(stop).toBeEnabled())
    confirmSpy.mockRestore()
  })
})
