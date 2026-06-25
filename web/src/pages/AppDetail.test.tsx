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
    [{ path: '/apps/:appId', element: <AppDetail /> }],
    { initialEntries: ['/apps/order'] },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} />
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
    await waitFor(() => expect(screen.getByText('order')).toBeInTheDocument())
    expect(screen.getByText('3500')).toBeInTheDocument()
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
})
