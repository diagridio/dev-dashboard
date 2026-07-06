import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
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
})
