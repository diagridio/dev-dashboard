import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
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

const ORDER_DETAIL = {
  ...ORDER_SUMMARY,
  resourcePaths: [],
  configPath: '',
  appLogPath: '/l/app.log',
  daprdLogPath: '/l/daprd.log',
  command: '',
  runtimeVersion: '1.14.0',
  metadataOk: true,
}

function renderAt(initialEntry = '/logs?app=order&source=daprd') {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [{ path: '/logs', element: <Logs /> }],
    { initialEntries: [initialEntry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Logs', () => {
  it('renders a streamed log line in a .logrow when a message is dispatched', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    // Wait for the EventSource to be opened (log path exists)
    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    // Dispatch a message
    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info hello world' })
    })

    // Text appears in the log message span
    const msg = await screen.findByText(/hello world/)
    expect(msg).toBeInTheDocument()
    // The row itself should be a .logrow
    const row = msg.closest('.logrow')
    expect(row).not.toBeNull()
  })

  it('shows the page header with .phead, h1, .sub, and .live indicator', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument()
    expect(screen.getByText(/Tailing/)).toBeInTheDocument()
    expect(screen.getByText(/live tail \(SSE\)/)).toBeInTheDocument()
  })

  it('renders logbar with level chips, search input, and follow button', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    // Level chips
    const chips = screen.getAllByRole('button', { name: /debug|info|warn|error/i })
    expect(chips.length).toBeGreaterThanOrEqual(4)
    chips.forEach(chip => expect(chip).toHaveAttribute('aria-pressed', 'true'))

    // Search input
    expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument()

    // Follow button (on by default)
    const followBtn = screen.getByRole('button', { name: /Following/i })
    expect(followBtn).toBeInTheDocument()
    expect(followBtn).toHaveClass('followbtn', 'on')
  })

  it('level chip toggles off and filters out that level', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    // Send a debug line
    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=debug trace message' })
    })

    await screen.findByText(/trace message/)

    // Toggle debug chip off
    const debugChip = screen.getByRole('button', { name: /^debug$/i })
    act(() => { fireEvent.click(debugChip) })

    expect(debugChip).toHaveAttribute('aria-pressed', 'false')
    expect(screen.queryByText(/trace message/)).toBeNull()
  })

  it('search filters log lines and highlights matches', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info hello world' })
      FakeES.instances[0].onmessage?.({ data: 'level=info goodbye world' })
    })

    await screen.findByText(/hello world/)

    const searchInput = screen.getByPlaceholderText('Search…')
    act(() => { fireEvent.change(searchInput, { target: { value: 'hello' } }) })

    // goodbye line is filtered out
    expect(screen.queryByText(/goodbye world/)).toBeNull()

    // highlight span exists inside .lmsg
    const hl = document.querySelector('.lmsg .hl')
    expect(hl).not.toBeNull()
    expect(hl!.textContent).toMatch(/hello/i)

    // logfoot shows highlight summary
    expect(screen.getByText(/highlighting "hello"/)).toBeInTheDocument()
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

  it('shows prompt to select app when no app is in URL', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    )

    renderAt('/logs')

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument())

    expect(screen.getByText(/Select an app/)).toBeInTheDocument()
    expect(FakeES.instances).toHaveLength(0)
  })

  it('renders app and source selects in .logbar', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances).toHaveLength(1))

    const appSelect = screen.getByRole('combobox', { name: /App/i })
    expect(appSelect).toBeInTheDocument()

    const sourceSelect = screen.getByRole('combobox', { name: /Source/i })
    expect(sourceSelect).toBeInTheDocument()

    // Source options match mock
    expect(screen.getByRole('option', { name: 'daprd + app' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'daprd only' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'app only' })).toBeInTheDocument()
  })
})
