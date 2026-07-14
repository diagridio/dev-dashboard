import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Applications } from './Applications'

function renderAt() {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/', element: <Applications /> },
      { path: '/apps/:appId', element: <div>detail</div> },
    ],
    { initialEntries: ['/'], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

const baseApp = {
  appId: 'order',
  health: 'healthy' as const,
  runtime: 'go',
  httpPort: 3500,
  grpcPort: 50001,
  appPort: 8080,
  daprdPid: 48230,
  appPid: 48213,
  cliPid: 0,
  age: '14m',
  created: '',
  runTemplate: '',
}

function mockApps(apps: object[]) {
  server.use(http.get('/api/apps', () => HttpResponse.json(apps)))
}

const sampleApps = [
  {
    ...baseApp,
  },
  {
    appId: 'shipping',
    health: 'starting',
    runtime: 'python',
    httpPort: 3501,
    grpcPort: 50002,
    appPort: 8090,
    daprdPid: 48231,
    appPid: 0,
    cliPid: 0,
    age: '3s',
    created: '',
    runTemplate: 'dapr.yaml',
  },
]

describe('Applications', () => {
  it('renders an app row with a link to detail', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })

  it('renders a stats row with running/healthy/starting/unhealthy counts', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    // Wait for data
    await screen.findByRole('link', { name: 'order' })
    // Stat labels (uppercased via CSS; assert on the source text)
    expect(screen.getByText(/apps running/i)).toBeInTheDocument()
    expect(screen.getAllByText(/^healthy$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/^starting$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Unhealthy')).toBeInTheDocument()
    // The run-template stat card is gone; only the Mode table column header remains.
    expect(screen.getAllByText(/^mode$/i)).toHaveLength(1)
  })

  it('unhealthy stat shows 0 without the bad class when all apps are fine', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    const num = screen.getByText('Unhealthy').previousElementSibling as HTMLElement
    expect(num).toHaveTextContent('0')
    expect(num).not.toHaveClass('bad')
  })

  it('unhealthy stat counts unhealthy apps (not unknown) and turns bad', async () => {
    mockApps([
      { ...baseApp },
      { ...baseApp, appId: 'billing', health: 'unhealthy' },
      { ...baseApp, appId: 'primes-go', source: 'compose', sidecarReachable: false, health: 'unknown' },
    ])
    renderAt()
    await screen.findByRole('link', { name: 'billing' })
    const num = screen.getByText('Unhealthy').previousElementSibling as HTMLElement
    expect(num).toHaveTextContent('1')
    expect(num).toHaveClass('bad')
  })

  it('shows an empty state when no apps', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json([])))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no dapr apps/i)).toBeInTheDocument())
  })

  it('App ID link uses the table text color (celllink class)', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    // The App ID link must use the table text color (class celllink), not a default/visited link color.
    expect(await screen.findByRole('link', { name: 'order' })).toHaveClass('celllink')
  })

  it('labels compose-discovered apps and shows the publish-port hint when unreachable', async () => {
    mockApps([
      {
        ...baseApp,
        appId: 'primes-go',
        source: 'compose',
        composeProject: 'saga',
        sidecarReachable: false,
        health: 'unknown',
        runTemplate: '',
      },
    ])
    renderAt()
    const composeCells = await screen.findAllByText('Compose')
    expect(composeCells.length).toBeGreaterThanOrEqual(1)
    const hint = screen.getByTitle(/publish the daprd HTTP port/i)
    expect(hint).toBeInTheDocument()
  })

  it('labels testcontainers apps', async () => {
    mockApps([
      { ...baseApp, appId: 'workflow-patterns-app', source: 'testcontainers', runTemplate: '' },
    ])
    renderAt()
    const cells = await screen.findAllByText('TestContainers')
    expect(cells.length).toBeGreaterThanOrEqual(1)
  })

  it('does not show the hint for reachable compose apps', async () => {
    mockApps([
      { ...baseApp, appId: 'primes-go', source: 'compose', composeProject: 'saga', sidecarReachable: true, runTemplate: '' },
    ])
    renderAt()
    const composeCells = await screen.findAllByText('Compose')
    expect(composeCells.length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByTitle(/publish the daprd HTTP port/i)).not.toBeInTheDocument()
  })

  it('sets the document title to Applications', async () => {
    mockApps(sampleApps)
    renderAt()
    await waitFor(() => expect(document.title).toBe('Applications | Diagrid Dev Dashboard'))
  })

  it('compose apps show the app id in bold with the container name underneath, still linking by container name', async () => {
    mockApps([
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-1', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-2', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
    ])
    renderAt()
    const link1 = await screen.findByRole('link', { name: /daprmq-host-1/ })
    expect(link1).toHaveAttribute('href', '/apps/daprmq-host-1')
    expect(screen.getByRole('link', { name: /daprmq-host-2/ })).toHaveAttribute('href', '/apps/daprmq-host-2')
    // The app id is the primary line; the container name renders as the muted secondary line.
    expect(link1.textContent!.startsWith('daprmq-service')).toBe(true)
    expect(link1.querySelector('.muted')).toHaveTextContent('daprmq-host-1')
  })

  it('non-compose apps render a single-line app id and link by app id', async () => {
    mockApps([{ ...baseApp, instanceKey: 'order' }])
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })

  it('shows the aspire label as muted secondary text when it differs from the app id', async () => {
    mockApps([{ ...baseApp, appId: 'order', isAspire: true, label: 'Order Service' }])
    renderAt()
    const link = await screen.findByRole('link', { name: /order/ })
    expect(link.textContent!.startsWith('order')).toBe(true)
    expect(link.querySelector('.muted')).toHaveTextContent('Order Service')
  })

  it('does not duplicate the app id when the aspire label equals it or is absent', async () => {
    mockApps([
      { ...baseApp, appId: 'order', isAspire: true, label: 'order' },
      { ...baseApp, appId: 'shipping', isAspire: true },
    ])
    renderAt()
    const orderLink = await screen.findByRole('link', { name: 'order' })
    expect(orderLink.querySelector('.muted')).toBeNull()
    const shippingLink = screen.getByRole('link', { name: 'shipping' })
    expect(shippingLink.querySelector('.muted')).toBeNull()
  })

  it('renders stopped instances distinctly and excludes them from the running count', async () => {
    mockApps([
      { ...baseApp, appId: 'live', appStatus: 'running', daprdStatus: 'running' },
      {
        ...baseApp,
        appId: 'halted',
        health: 'unknown',
        httpPort: 0,
        grpcPort: 0,
        appPort: 0,
        daprdPid: 0,
        appPid: 0,
        age: '',
        appStatus: 'stopped',
        daprdStatus: 'stopped',
      },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('halted')).toBeInTheDocument())
    expect(screen.getByText('stopped')).toBeInTheDocument()
    const runningStat = screen.getByText('Apps running').previousElementSibling
    expect(runningStat).toHaveTextContent('1')
  })

  it('suppresses the unreachable hint for a stopped compose sidecar', async () => {
    mockApps([
      {
        ...baseApp,
        appId: 'primes-go',
        source: 'compose',
        composeProject: 'saga',
        sidecarReachable: false,
        health: 'unknown',
        runTemplate: '',
        appStatus: 'stopped',
        daprdStatus: 'stopped',
      },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('primes-go')).toBeInTheDocument())
    expect(screen.queryByTitle(/publish the daprd HTTP port/i)).not.toBeInTheDocument()
  })

  it('renders app-down and orphaned states with tooltips', async () => {
    mockApps([
      { ...baseApp, appId: 'appdown', appStatus: 'stopped', daprdStatus: 'running' },
      {
        ...baseApp,
        appId: 'ghost',
        appPid: 0,
        appStatus: 'stopped',
        daprdStatus: 'running',
        sidecarOrphaned: true,
      },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('appdown')).toBeInTheDocument())
    expect(screen.getByText('app down')).toBeInTheDocument()
    expect(screen.getByText('orphaned')).toBeInTheDocument()
    expect(screen.getByTitle('app process is not running')).toBeInTheDocument()
    expect(screen.getByTitle('sidecar has no supervising dapr CLI and no app — safe to stop')).toBeInTheDocument()
  })

  it('counts amber states (app down, orphaned) as Unhealthy in the stat cards', async () => {
    mockApps([
      { ...baseApp, appId: 'ok1', appStatus: 'running', daprdStatus: 'running' },
      { ...baseApp, appId: 'appdown', appStatus: 'stopped', daprdStatus: 'running' },
      { ...baseApp, appId: 'ghost', appPid: 0, appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('ok1')).toBeInTheDocument())
    expect(screen.getByText('Healthy').previousElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Unhealthy').previousElementSibling).toHaveTextContent('2')
  })

  it('renders the stopped row with the grey off LED', async () => {
    mockApps([
      { ...baseApp, appId: 'halted', health: 'unknown', appStatus: 'stopped', daprdStatus: 'stopped' },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('halted')).toBeInTheDocument())
    const badge = screen.getByText('stopped').closest('.health')
    expect(badge?.querySelector('.led')).toHaveClass('off')
  })

  it('keeps the unreachable hint for an unreachable but running compose sidecar', async () => {
    mockApps([
      {
        ...baseApp,
        appId: 'primes-go',
        source: 'compose',
        composeProject: 'saga',
        sidecarReachable: false,
        health: 'unknown',
        appStatus: 'running',
        daprdStatus: 'running',
      },
    ])
    renderAt()
    await waitFor(() => expect(screen.getByText('primes-go')).toBeInTheDocument())
    expect(screen.getByTitle(/publish the daprd HTTP port/i)).toBeInTheDocument()
  })
})
