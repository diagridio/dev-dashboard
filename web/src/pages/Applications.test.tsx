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

const sampleApps = [
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
  {
    appId: 'shipping',
    health: 'starting',
    runtime: 'python',
    httpPort: 3501,
    grpcPort: 50002,
    appPort: 8090,
    daprdPid: 48231,
    appPid: 0,
    age: '3s',
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

  it('shows a display-only refresh indicator', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json(sampleApps)))
    const { container } = renderAt()
    await screen.findByRole('link', { name: 'order' })
    expect(screen.getByText(/refreshing every 3s/i)).toBeInTheDocument()
    expect(container.querySelector('.beat')).not.toBeNull()
  })

  it('shows an empty state when no apps', async () => {
    server.use(http.get('/api/apps', () => HttpResponse.json([])))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no dapr apps/i)).toBeInTheDocument())
  })
})
