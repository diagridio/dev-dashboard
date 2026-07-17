import { render, screen, waitFor, within } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { AppDetail } from './AppDetail'

// Click the confirm (or Cancel) button inside the styled confirmation dialog.
async function answerConfirmDialog(label: string) {
  const dialog = await screen.findByRole('dialog')
  within(dialog).getByRole('button', { name: label }).click()
}

function renderDetail() {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/', element: <div>Applications index</div> },
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
  afterEach(() => {
    delete window.__DASH_CAPABILITIES__
  })

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
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stopButtons = screen.getAllByRole('button', { name: 'Stop' })
    stopButtons[0].click() // header button renders first
    await answerConfirmDialog('Stop')
    await waitFor(() => expect(posted).toBe('all/stop'))
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
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getAllByRole('button', { name: 'Stop' })[0].click()
    await answerConfirmDialog('Cancel')
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await new Promise((r) => setTimeout(r, 50))
    expect(posted).toBe(false)
  })

  it('hides Start for a fully stopped Aspire app', async () => {
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

  it('offers per-panel Start for a stopped compose target', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, source: 'compose', daprdStatus: 'stopped' }),
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

  it('shows the aspire label under the header when it differs from the app id', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, isAspire: true, label: 'Order Service' }),
      ),
    )
    const { container } = renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(container.querySelector('.phead .sub')).toHaveTextContent('Order Service')
  })

  it('does not show a label sub-line when it equals the app id or is absent', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, isAspire: true, label: 'order' }),
      ),
    )
    const { container } = renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(container.querySelector('.phead .sub')).toBeNull()
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
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    // Buttons render header-first, then app panel, then daprd panel — the
    // last Stop button is the daprd panel's.
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    stops[stops.length - 1].click()
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('app + sidecar together')
    within(dialog).getByRole('button', { name: 'Stop' }).click()
    await waitFor(() => expect(posted).toBe('all/stop'))
  })

  it('hides Restart and Start for a running dapr run app but keeps Stop and shows a hint', async () => {
    server.use(http.get('/api/apps/order', () => HttpResponse.json({ ...runningApp, source: 'standalone' })))
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'Stop' }).length).toBeGreaterThan(0)
    expect(screen.getByText(/restart and start it from your terminal/i)).toBeInTheDocument()
  })

  it('keeps Restart for a running compose app', async () => {
    server.use(http.get('/api/apps/order', () => HttpResponse.json({ ...runningApp, source: 'compose' })))
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Restart' }).length).toBeGreaterThan(0)
    // Nothing is stopped, so no Start button; and no dapr-run hint for compose.
    expect(screen.queryByText(/restart and start it from your terminal/i)).not.toBeInTheDocument()
  })

  it('hides Start for a fully stopped dapr run app, offering Remove instead', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          source: 'standalone',
          health: 'unknown',
          appStatus: 'stopped',
          daprdStatus: 'stopped',
          appPid: 0,
          daprdPid: 0,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove from list' })).toBeInTheDocument()
  })

  it('renders app protocol when reported', async () => {
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json({ ...runningApp, appProtocol: 'http' })),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText('http')).toBeInTheDocument()
  })

  it('renders Container and Session rows for testcontainers apps', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          source: 'testcontainers',
          daprdContainerName: 'crazy_lamport',
          testcontainersSession: 'efeba7ba-5fdd-4713-ae0c-38f4a462cf46',
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText('crazy_lamport')).toBeInTheDocument()
    expect(screen.getByText('Session')).toBeInTheDocument()
    expect(screen.getByText('efeba7ba')).toBeInTheDocument()
    expect(screen.queryByText('daprd PID')).not.toBeInTheDocument()
    expect(screen.queryByText('CLI PID')).not.toBeInTheDocument()
  })

  it('keeps CLI PID and daprd PID rows for standalone apps', async () => {
    server.use(http.get('/api/apps/order', () => HttpResponse.json(runningApp)))
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByText('CLI PID')).toBeInTheDocument()
    expect(screen.getByText('daprd PID')).toBeInTheDocument()
  })

  it('hides all lifecycle controls for testcontainers apps', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ ...runningApp, source: 'testcontainers', testcontainersSession: 'abc123' }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('hides the whole-instance Start button for a fully stopped testcontainers app', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          source: 'testcontainers',
          testcontainersSession: 'abc123',
          appStatus: 'stopped',
          daprdStatus: 'stopped',
          appPid: 0,
          daprdPid: 0,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
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
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stops = screen.getAllByRole('button', { name: 'Stop' })
    stops[stops.length - 1].click()
    await answerConfirmDialog('Stop')
    await waitFor(() => expect(posted).toBe('daprd/stop'))
  })

  it('offers only Stop for an orphaned sidecar', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          appStatus: 'stopped',
          daprdStatus: 'running',
          sidecarOrphaned: true,
          cliPid: 0,
          appPid: 0,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getAllByRole('button', { name: 'Stop' }).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  })

  it('navigates back to the overview after stopping an orphaned sidecar', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          appStatus: 'stopped',
          daprdStatus: 'running',
          sidecarOrphaned: true,
          cliPid: 0,
          appPid: 0,
        }),
      ),
      http.post('/api/apps/order/all/stop', () => HttpResponse.json({ status: 'ok' })),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getAllByRole('button', { name: 'Stop' })[0].click()
    await answerConfirmDialog('Stop')
    // The stopped orphan vanishes from discovery; the page must not dead-end
    // on "App not found" but return to the overview.
    await waitFor(() => expect(screen.getByText('Applications index')).toBeInTheDocument())
  })

  it('removes a fully stopped instance from the list and returns to the overview', async () => {
    let deleted = false
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          health: 'unknown',
          appStatus: 'stopped',
          daprdStatus: 'stopped',
          appPid: 0,
          daprdPid: 0,
        }),
      ),
      http.delete('/api/apps/order', () => {
        deleted = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getByRole('button', { name: 'Remove from list' }).click()
    await answerConfirmDialog('Remove')
    await waitFor(() => expect(screen.getByText('Applications index')).toBeInTheDocument())
    expect(deleted).toBe(true)
  })

  it('offers Remove from list for a fully stopped Aspire ghost, not for running or compose apps', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...runningApp,
          isAspire: true,
          health: 'unknown',
          appStatus: 'stopped',
          daprdStatus: 'stopped',
          appPid: 0,
          daprdPid: 0,
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.getByRole('button', { name: 'Remove from list' })).toBeInTheDocument()
  })

  it('hides Remove from list for running instances', async () => {
    server.use(http.get('/api/apps/order', () => HttpResponse.json(runningApp)))
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: 'Remove from list' })).not.toBeInTheDocument()
  })

  it('hides the View logs link when the logs capability is off', async () => {
    window.__DASH_CAPABILITIES__ = { lifecycle: false, controlPlane: false, logs: false, workflows: true }
    try {
      server.use(http.get('/api/apps/order', () => HttpResponse.json(runningApp)))
      renderDetail()
      await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
      expect(screen.queryByRole('link', { name: /view logs/i })).not.toBeInTheDocument()
    } finally {
      delete window.__DASH_CAPABILITIES__
    }
  })

  it('offers a back link when the app cannot be loaded', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({ error: 'app not found' }, { status: 404 }),
      ),
    )
    renderDetail()
    // The query client retries once (~1s backoff) before surfacing the error.
    expect(await screen.findByText('App not found or failed to load.', undefined, { timeout: 4000 })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Back to applications/ })).toHaveAttribute('href', '/')
  })

  it('surfaces action errors via toast', async () => {
    server.use(
      http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
      http.post('/api/apps/order/all/stop', () =>
        HttpResponse.json({ error: 'boom from backend' }, { status: 502 }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    screen.getAllByRole('button', { name: 'Stop' })[0].click()
    await answerConfirmDialog('Stop')
    await waitFor(() => expect(screen.getByText('boom from backend')).toBeInTheDocument())
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
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
    const stop = screen.getAllByRole('button', { name: 'Stop' })[0]
    stop.click()
    await answerConfirmDialog('Stop')
    await waitFor(() => expect(stop).toBeDisabled())
    release()
    await waitFor(() => expect(stop).toBeEnabled())
  })
})
