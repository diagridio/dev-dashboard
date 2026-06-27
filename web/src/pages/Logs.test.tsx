import { render, screen, waitFor, act } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Logs } from './Logs'

// FakeES stub (mirrors Task 5 useLogStream.test.tsx pattern)
class FakeES {
  static instances: FakeES[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  constructor(url: string) {
    this.url = url
    FakeES.instances.push(this)
  }
  close() {
    this.closed = true
  }
}

beforeEach(() => {
  FakeES.instances = []
  ;(globalThis as unknown as { EventSource: unknown }).EventSource = FakeES
})

const ORDER_SUMMARY = {
  appId: 'order',
  health: 'healthy',
  runtime: 'go',
  httpPort: 3500,
  grpcPort: 50001,
  appPort: 8080,
  daprdPid: 100,
  appPid: 101,
  cliPid: 102,
  age: '5m',
  created: '',
  runTemplate: 'dapr.yaml',
}

function renderAt(initialEntry = '/logs?app=order&source=daprd') {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [{ path: '/logs', element: <Logs /> }],
    { initialEntries: [initialEntry] },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Logs', () => {
  it('renders a streamed log line when a message is dispatched', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...ORDER_SUMMARY,
          resourcePaths: [],
          configPath: '',
          appLogPath: '/l/app.log',
          daprdLogPath: '/l/daprd.log',
          command: '',
          runtimeVersion: '1.14.0',
          metadataOk: true,
        }),
      ),
    )

    renderAt()

    // Wait for the EventSource to be opened (log path exists)
    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    // Dispatch a message
    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info hello' })
    })

    expect(await screen.findByText(/hello/)).toBeInTheDocument()
  })

  it('shows empty state and does NOT open EventSource when log path is empty', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          ...ORDER_SUMMARY,
          resourcePaths: [],
          configPath: '',
          appLogPath: '',
          daprdLogPath: '',
          command: '',
          runtimeVersion: '1.14.0',
          metadataOk: true,
        }),
      ),
    )

    renderAt()

    await waitFor(() =>
      expect(screen.getByText(/No log file/)).toBeInTheDocument(),
    )

    expect(FakeES.instances).toHaveLength(0)
  })
})
