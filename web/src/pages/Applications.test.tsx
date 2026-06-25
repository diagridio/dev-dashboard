import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Applications } from './Applications'

function renderAt() {
  // Fresh QueryClient per test to avoid cross-test cache pollution
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [
      { path: '/', element: <Applications /> },
      { path: '/apps/:appId', element: <div>detail</div> },
    ],
    { initialEntries: ['/'] },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Applications', () => {
  it('renders an app row with a link to detail', async () => {
    server.use(
      http.get('/api/apps', () =>
        HttpResponse.json([
          {
            appId: 'order',
            health: 'healthy',
            runtime: 'go',
            httpPort: 3500,
            grpcPort: 50001,
            appPort: 8080,
            daprdPid: 48230,
            appPid: 48213,
            age: '14m',
            runTemplate: 'dapr.yaml',
          },
        ]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })

  it('shows an empty state when no apps', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json([])))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no dapr apps/i)).toBeInTheDocument())
  })
})
