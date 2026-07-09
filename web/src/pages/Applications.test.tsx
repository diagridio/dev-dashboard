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

  it('renders a stats row with running/healthy/starting counts', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    renderAt()
    // Wait for data
    await screen.findByRole('link', { name: 'order' })
    // Stat labels (uppercased via CSS; assert on the source text)
    expect(screen.getByText(/apps running/i)).toBeInTheDocument()
    expect(screen.getAllByText(/^healthy$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/^starting$/i).length).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText(/run template/i).length).toBeGreaterThanOrEqual(1)
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

  it('compose apps with duplicate app ids link by container name with the app id underneath', async () => {
    mockApps([
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-1', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-2', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
    ])
    renderAt()
    const link1 = await screen.findByRole('link', { name: /daprmq-host-1/ })
    expect(link1).toHaveAttribute('href', '/apps/daprmq-host-1')
    expect(screen.getByRole('link', { name: /daprmq-host-2/ })).toHaveAttribute('href', '/apps/daprmq-host-2')
    // The app id renders as a secondary line in each of the two rows.
    expect(screen.getAllByText('daprmq-service')).toHaveLength(2)
  })

  it('non-compose apps render a single-line app id and link by app id', async () => {
    mockApps([{ ...baseApp, instanceKey: 'order' }])
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })
})
