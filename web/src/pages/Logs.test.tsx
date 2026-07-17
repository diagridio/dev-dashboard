import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse, delay } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Logs } from './Logs'
import { parseLogTime } from '../lib/logtime'

// FakeES stub (mirrors Task 5 useLogStream.test.tsx pattern)
class FakeES {
  static instances: FakeES[] = []
  url: string
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onopen: (() => void) | null = null
  closed = false
  readyState = 0 // EventSource.CONNECTING
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
  // The Logs page polls /api/controlplane for the CP service selector; give
  // every test a static-services default (tests can server.use() to override).
  server.use(http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)))
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

// Compose-discovered app: no log files on disk — logs stream from containers.
const COMPOSE_SUMMARY = {
  ...ORDER_SUMMARY,
  appId: 'primes-go',
  source: 'compose',
  composeProject: 'saga',
  composeService: 'primes-go-dapr',
  daprdPid: 0,
  appPid: 0,
  cliPid: 0,
  runTemplate: '',
}

const COMPOSE_DETAIL = {
  ...COMPOSE_SUMMARY,
  resourcePaths: [],
  configPath: '',
  appLogPath: '',
  daprdLogPath: '',
  command: '',
  runtimeVersion: '1.17.5',
  metadataOk: true,
  daprdContainerId: 'aaaa1111bbbb',
  daprdContainerName: 'saga-primes-go-dapr-1',
  appContainerId: 'cccc2222dddd',
  appContainerName: 'saga-primes-go-1',
}

// Minimal /api/controlplane payload: statics only, no compose services.
const CP_LIST_BASE = {
  runtime: 'docker',
  available: true,
  reachable: true,
  controlPlanePresent: true,
  services: [
    { name: 'dapr_scheduler', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true },
    { name: 'dapr_placement', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true },
  ],
}

// Same list plus compose-managed placement/scheduler containers.
const CP_LIST_COMPOSE = {
  ...CP_LIST_BASE,
  services: [
    ...CP_LIST_BASE.services,
    { name: 'saga-placement-1', status: 'running', healthy: true, ports: ['50005/tcp'], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
    { name: 'saga-scheduler-0-1', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
  ],
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

// ─── parseLogTime unit tests ────────────────────────────────────────────────

describe('parseLogTime', () => {
  it('parses HH:MM:SS.mmm correctly', () => {
    expect(parseLogTime('12:04:50.980 foo')).toBe(
      12 * 3_600_000 + 4 * 60_000 + 50 * 1_000 + 980,
    )
  })

  it('parses HH:MM:SS without millis', () => {
    expect(parseLogTime('09:00:01 bar')).toBe(9 * 3_600_000 + 0 * 60_000 + 1 * 1_000)
  })

  it('parses ISO timestamp and extracts time portion', () => {
    const val = parseLogTime('2006-01-02T15:04:05.123 something')
    expect(val).toBe(15 * 3_600_000 + 4 * 60_000 + 5 * 1_000 + 123)
  })

  it('returns Infinity when no time token', () => {
    expect(parseLogTime('no timestamp here')).toBe(Infinity)
  })

  it('earlier time < later time', () => {
    expect(parseLogTime('12:04:50.980')).toBeLessThan(parseLogTime('12:04:51.020'))
  })
})

describe('Logs document title', () => {
  it('sets the document title to Logs (plus suffix) when no app or control-plane filter is active', async () => {
    renderAt('/logs')
    await waitFor(() => expect(document.title).toBe('Logs | Diagrid Dev Dashboard'))
  })
})

// ─── Logs page tests ─────────────────────────────────────────────────────────

describe('Logs', () => {
  it('renders a streamed log line in a .logrow when a message is dispatched', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    // Wait for at least one EventSource to be opened (daprd stream)
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // Dispatch a message on the first instance
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

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument()
    expect(screen.getByText(/Tailing/)).toBeInTheDocument()
    expect(screen.getByText(/live tail \(SSE\)/)).toBeInTheDocument()
  })

  // F1: single .logbar with all 5 controls
  it('F1 — renders exactly ONE .logbar containing all five controls', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    const logbars = document.querySelectorAll('.logbar')
    expect(logbars).toHaveLength(1)

    const bar = logbars[0]

    // target select
    expect(bar.querySelector('[aria-label="Target"]')).not.toBeNull()
    // source chip group (role=group, aria-label Source)
    expect(bar.querySelector('[aria-label="Source"]')).not.toBeNull()
    // level chips group still present
    expect(bar.querySelector('.lvchips[aria-label="Levels"]')).not.toBeNull()
    // search input
    expect(bar.querySelector('input[aria-label="Filter logs"]')).not.toBeNull()
    // follow button
    expect(bar.querySelector('.followbtn')).not.toBeNull()
  })

  it('renders logbar with level chips, search input, and follow button', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

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

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

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

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

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
      expect(screen.getByText(/No captured log file/)).toBeInTheDocument(),
    )

    expect(FakeES.instances).toHaveLength(0)
  })

  // ── Compose apps: logs stream from containers, not files ──────────────────

  it('compose — app with container IDs but no log files streams daprd logs', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([COMPOSE_SUMMARY])),
      http.get('/api/apps/primes-go', () => HttpResponse.json(COMPOSE_DETAIL)),
    )

    renderAt('/logs?app=primes-go&source=daprd')

    // The stream must open despite appLogPath/daprdLogPath being empty
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    expect(FakeES.instances[0].url).toContain('source=daprd')
    expect(screen.queryByText(/No captured log file/)).toBeNull()

    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info compose daprd line' })
    })
    expect(await screen.findByText(/compose daprd line/)).toBeInTheDocument()
  })

  it('compose — source=both opens both container streams', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([COMPOSE_SUMMARY])),
      http.get('/api/apps/primes-go', () => HttpResponse.json(COMPOSE_DETAIL)),
    )

    renderAt('/logs?app=primes-go&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))
    const urls = FakeES.instances.map(es => es.url)
    expect(urls.some(u => u.includes('source=daprd'))).toBe(true)
    expect(urls.some(u => u.includes('source=app'))).toBe(true)
  })

  it('compose — unpaired app (no app container) in app-only mode shows empty state', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([COMPOSE_SUMMARY])),
      http.get('/api/apps/primes-go', () =>
        HttpResponse.json({ ...COMPOSE_DETAIL, appContainerId: '', appContainerName: '' }),
      ),
    )

    renderAt('/logs?app=primes-go&source=app')

    await waitFor(() =>
      expect(screen.getByText(/No captured log file/)).toBeInTheDocument(),
    )
    expect(FakeES.instances).toHaveLength(0)
  })

  it('shows prompt to select app when no app is in URL', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
    )

    renderAt('/logs')

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument())

    expect(screen.getByText(/Select a target/)).toBeInTheDocument()
    expect(FakeES.instances).toHaveLength(0)
  })

  it('renders daprd|app source chips in .logbar', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // Source is now a chip toggle group, not a combobox.
    // renderAt()'s default URL is `?source=daprd`, so only the daprd chip is pressed.
    expect(screen.queryByRole('combobox', { name: /Source/i })).toBeNull()
    const daprd = screen.getByRole('button', { name: 'daprd' })
    const app = screen.getByRole('button', { name: 'app' })
    expect(daprd).toHaveAttribute('aria-pressed', 'true')
    expect(app).toHaveAttribute('aria-pressed', 'false')
  })

  it('renders a single grouped Target select (no separate App/CP selects)', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
    )

    renderAt()

    const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
    expect(target).toBeInTheDocument()
    // Old peer selects are gone
    expect(screen.queryByRole('combobox', { name: /^App$/i })).toBeNull()
    expect(screen.queryByRole('combobox', { name: /Control Plane/i })).toBeNull()
    // Grouped: an Applications optgroup with the app, a Control plane optgroup with a dapr_* service.
    // Wait for the async /api/apps + /api/controlplane fetches to populate the options —
    // the select itself renders synchronously with zero options.
    await screen.findByRole('option', { name: 'order' })
    expect(target.querySelector('optgroup[label="Applications"]')).not.toBeNull()
    expect(target.querySelector('optgroup[label="Control plane"]')).not.toBeNull()
    expect(screen.getByRole('option', { name: 'dapr_scheduler' })).toBeInTheDocument()
  })

  it('reflects a ?app deep link as the selected Target', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )
    renderAt('/logs?app=order&source=daprd')
    const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
    await waitFor(() => expect(target.value).toBe('app:order'))
  })

  it('reflects a ?cp deep link as the selected Target and clears app on switch', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
    )
    renderAt('/logs?cp=dapr_scheduler')
    const target = (await screen.findByRole('combobox', { name: /Target/i })) as HTMLSelectElement
    await waitFor(() => expect(target.value).toBe('cp:dapr_scheduler'))
  })

  it('renders daprd|app source chips reflecting ?source=daprd (no Source select)', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )
    renderAt('/logs?app=order&source=daprd')
    // Source is now chips, not a combobox
    expect(screen.queryByRole('combobox', { name: /Source/i })).toBeNull()
    const daprd = await screen.findByRole('button', { name: 'daprd' })
    const app = screen.getByRole('button', { name: 'app' })
    expect(daprd).toHaveAttribute('aria-pressed', 'true')
    expect(app).toHaveAttribute('aria-pressed', 'false')
  })

  it('toggling the app chip while on daprd yields source=both (adds the stream)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )
    renderAt('/logs?app=order&source=daprd')
    const app = await screen.findByRole('button', { name: 'app' })
    await user.click(app)
    await waitFor(() => expect(app).toHaveAttribute('aria-pressed', 'true'))
    expect(screen.getByRole('button', { name: 'daprd' })).toHaveAttribute('aria-pressed', 'true')
  })

  it('clicking the only active source chip is a no-op (at-least-one invariant)', async () => {
    const user = userEvent.setup()
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )
    renderAt('/logs?app=order&source=daprd')
    const daprd = await screen.findByRole('button', { name: 'daprd' })
    await user.click(daprd)
    // still pressed — cannot turn off the last active stream
    expect(daprd).toHaveAttribute('aria-pressed', 'true')
  })

  it('hides the source chips in control-plane view', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_BASE)),
    )
    renderAt('/logs?cp=dapr_scheduler')
    await screen.findByRole('combobox', { name: /Target/i })
    expect(screen.queryByRole('button', { name: 'daprd' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'app' })).toBeNull()
  })

  it('falls back to "both" for an invalid ?source= URL param', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    const { container } = renderAt('/logs?app=order&source=garbage')

    // An unknown source falls back to "both": both chips pressed.
    const daprd = (await screen.findByRole('button', { name: 'daprd' }))
    const app = screen.getByRole('button', { name: 'app' })
    await waitFor(() => expect(daprd).toHaveAttribute('aria-pressed', 'true'))
    expect(app).toHaveAttribute('aria-pressed', 'true')
    // Subtitle reflects the fallback, not the garbage value.
    expect(screen.getByText(/daprd \+ application/)).toBeInTheDocument()
    // The raw URL value must not leak into rendering: the source-column width is
    // sized to the "both" labels (max "daprd" = 5ch + 1), not to "garbage" (8ch).
    await waitFor(() => expect(container.querySelector('.logwin')).not.toBeNull())
    const logwin = container.querySelector('.logwin') as HTMLElement
    expect(logwin.style.getPropertyValue('--lsrc-w')).toBe('6ch')
  })

  // F2: combined "daprd + app" streams, both streams open, lines tagged by source
  it('F2 — "both" source opens two EventSources and tags lines by stream', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    // Both daprd and app streams must open
    await waitFor(() => expect(FakeES.instances).toHaveLength(2))

    // Identify which instance is which by URL
    const daprdES = FakeES.instances.find(es => es.url.includes('source=daprd'))
    const appES = FakeES.instances.find(es => es.url.includes('source=app'))
    expect(daprdES).toBeDefined()
    expect(appES).toBeDefined()

    // Dispatch lines from both streams with differing timestamps to test ordering
    act(() => {
      daprdES!.onmessage?.({ data: '12:04:51.020 level=info daprd-line-two' })
      appES!.onmessage?.({ data: '12:04:51.300 level=info app-line-three' })
      daprdES!.onmessage?.({ data: '12:04:50.980 level=info daprd-line-one' })
    })

    // All three lines visible
    await screen.findByText(/daprd-line-one/)
    expect(screen.getByText(/daprd-line-two/)).toBeInTheDocument()
    expect(screen.getByText(/app-line-three/)).toBeInTheDocument()

    // daprd rows carry .lsrc.lsrc-daprd, app rows carry .lsrc.lsrc-app
    const daprdSrcSpans = document.querySelectorAll('.lsrc.lsrc-daprd')
    const appSrcSpans = document.querySelectorAll('.lsrc.lsrc-app')
    expect(daprdSrcSpans.length).toBeGreaterThanOrEqual(2)
    expect(appSrcSpans.length).toBeGreaterThanOrEqual(1)
  })

  // Regression: the source-tag span must not reuse the bare "app" class token,
  // which collides with the global ".app" app-shell class (min-height: 100vh)
  // and blows up the row height. Source modifiers must be namespaced.
  it('F2 — app source span does not collide with the global .app shell class', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))
    const appES = FakeES.instances.find(es => es.url.includes('source=app'))

    act(() => {
      appES!.onmessage?.({ data: '12:04:51.300 level=info app-collision-line' })
    })

    await screen.findByText(/app-collision-line/)

    const srcSpans = Array.from(document.querySelectorAll<HTMLElement>('.lsrc'))
    const appSrcSpan = srcSpans.find(s => s.textContent === 'app')
    expect(appSrcSpan).toBeDefined()
    // Must NOT carry the bare "app"/"daprd" tokens that collide with global classes
    expect(appSrcSpan!.classList.contains('app')).toBe(false)
  })

  it('F2 — chronological ordering: earlier timestamp appears before later', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))

    const daprdES = FakeES.instances.find(es => es.url.includes('source=daprd'))
    const appES = FakeES.instances.find(es => es.url.includes('source=app'))

    // App line arrives first but has later timestamp → should appear after daprd line
    act(() => {
      appES!.onmessage?.({ data: '12:04:51.300 level=info later-app' })
      daprdES!.onmessage?.({ data: '12:04:50.980 level=info earlier-daprd' })
    })

    await screen.findByText(/earlier-daprd/)
    await screen.findByText(/later-app/)

    const rows = document.querySelectorAll('.logrow')
    const texts = Array.from(rows).map(r => r.querySelector('.lmsg')?.textContent ?? '')
    const daprdIdx = texts.findIndex(t => t.includes('earlier-daprd'))
    const appIdx = texts.findIndex(t => t.includes('later-app'))
    expect(daprdIdx).toBeGreaterThanOrEqual(0)
    expect(appIdx).toBeGreaterThanOrEqual(0)
    expect(daprdIdx).toBeLessThan(appIdx)
  })

  // Regression: untimestamped daprd startup banner lines (no clock token) must
  // stay anchored where they arrived — at the TOP — instead of sorting to the
  // bottom because parseLogTime returns Infinity for them.
  it('F2 — untimestamped startup banner stays at the top, not the bottom', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))

    const daprdES = FakeES.instances.find(es => es.url.includes('source=daprd'))
    const appES = FakeES.instances.find(es => es.url.includes('source=app'))

    // daprd emits its untimestamped startup banner first, THEN timestamped logs
    act(() => {
      daprdES!.onmessage?.({ data: "You're up and running! Dapr logs will appear here." })
      daprdES!.onmessage?.({ data: 'Updating metadata for app command: dotnet run' })
      daprdES!.onmessage?.({ data: '12:04:50.980 level=info daprd-real-log' })
      appES!.onmessage?.({ data: '12:04:51.300 level=info app-real-log' })
    })

    await screen.findByText(/up and running/)
    await screen.findByText(/daprd-real-log/)

    const rows = document.querySelectorAll('.logrow')
    const texts = Array.from(rows).map(r => r.querySelector('.lmsg')?.textContent ?? '')
    const bannerIdx = texts.findIndex(t => t.includes('up and running'))
    const metaIdx = texts.findIndex(t => t.includes('Updating metadata'))
    const realIdx = texts.findIndex(t => t.includes('daprd-real-log'))
    expect(bannerIdx).toBeGreaterThanOrEqual(0)
    expect(realIdx).toBeGreaterThanOrEqual(0)
    // Banner + metadata lines (no timestamp, arrived first) must sort ABOVE the
    // timestamped log, and keep their own arrival order.
    expect(bannerIdx).toBeLessThan(metaIdx)
    expect(metaIdx).toBeLessThan(realIdx)
  })

  // F3: dynamic subtitle
  it('F3 — subtitle shows "daprd + application" for source=both', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    expect(screen.getByText(/daprd \+ application/)).toBeInTheDocument()
  })

  it('F3 — subtitle shows "daprd" for source=daprd', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=daprd')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // The .sub element should contain the word "daprd" (not "application")
    const sub = document.querySelector('.sub')
    expect(sub?.textContent).toMatch(/daprd/)
    expect(sub?.textContent).not.toMatch(/application/)
  })

  it('F3 — subtitle shows "application" for source=app', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=app')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    const sub = document.querySelector('.sub')
    expect(sub?.textContent).toMatch(/application/)
    expect(sub?.textContent).not.toMatch(/daprd \+ application/)
  })

  // New F1: scroll-away disengages follow
  it('F1-new — scrolling away from bottom disengages following', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // Following should be ON initially
    expect(screen.getByRole('button', { name: /Following/i })).toHaveClass('on')

    const logwin = document.querySelector('.logwin') as HTMLDivElement
    expect(logwin).not.toBeNull()

    // Simulate a scroll event where the user has scrolled away from the bottom
    // (scrollHeight=500, scrollTop=0, clientHeight=200 → distFromBottom=300 > threshold 24)
    Object.defineProperty(logwin, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(logwin, 'scrollTop', { value: 0, configurable: true, writable: true })
    Object.defineProperty(logwin, 'clientHeight', { value: 200, configurable: true })

    act(() => { fireEvent.scroll(logwin) })

    // Following should now be OFF
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Follow$/i })).not.toHaveClass('on'),
    )
    expect(screen.getByRole('button', { name: /^Follow$/i })).toHaveAttribute('aria-pressed', 'false')
  })

  // Follow must keep pinning at the line cap: once the buffer is full, each
  // new line drops the oldest so lines.length stops changing — an effect keyed
  // on length alone silently stops scrolling while "Following" stays lit.
  it('F4 — follow still pins to bottom after the 2000-line cap is reached', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=daprd')
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    expect(screen.getByRole('button', { name: /Following/i })).toHaveClass('on')

    const logwin = document.querySelector('.logwin') as HTMLDivElement
    Object.defineProperty(logwin, 'scrollHeight', { value: 500, configurable: true })
    Object.defineProperty(logwin, 'scrollTop', { value: 0, configurable: true, writable: true })
    Object.defineProperty(logwin, 'clientHeight', { value: 200, configurable: true })

    // Fill exactly to the cap (one batched render), then reset the pin marker.
    act(() => {
      for (let i = 0; i < 2000; i++) {
        FakeES.instances[0].onmessage?.({ data: `level=info line-${i}` })
      }
    })
    logwin.scrollTop = 0

    // One more line while at the cap: length stays 2000, but follow must re-pin.
    act(() => { FakeES.instances[0].onmessage?.({ data: 'level=info past-cap' }) })
    expect(logwin.scrollTop).toBe(500)
  })

  // New F2: single-source mode opens exactly ONE EventSource
  it('F2-new — source=daprd opens exactly ONE EventSource (daprd only)', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=daprd')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // Give a tick for any second stream to open if it were going to
    await new Promise(r => setTimeout(r, 50))

    expect(FakeES.instances).toHaveLength(1)
    expect(FakeES.instances[0].url).toContain('source=daprd')
  })

  it('F2-new — source=app opens exactly ONE EventSource (app only)', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=app')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    await new Promise(r => setTimeout(r, 50))

    expect(FakeES.instances).toHaveLength(1)
    expect(FakeES.instances[0].url).toContain('source=app')
  })

  it('F2-new — source=both opens exactly TWO EventSources', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))

    const urls = FakeES.instances.map(es => es.url)
    expect(urls.some(u => u.includes('source=daprd'))).toBe(true)
    expect(urls.some(u => u.includes('source=app'))).toBe(true)
  })

  // New F3: tailKB reflects full buffer, not filtered view
  it('F3-new — tailKB reflects full buffer size even when search filter is active', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    // Send two lines
    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info hello world' })
      FakeES.instances[0].onmessage?.({ data: 'level=info goodbye planet' })
    })

    await screen.findByText(/hello world/)

    const logfoot = document.querySelector('.logfoot')
    const tailTextUnfiltered = logfoot?.textContent ?? ''
    const matchUnfiltered = tailTextUnfiltered.match(/tail (\d+) KB/)
    expect(matchUnfiltered).not.toBeNull()
    const kbUnfiltered = parseInt(matchUnfiltered![1], 10)

    // Apply a search filter that matches only one line
    const searchInput = screen.getByPlaceholderText('Search…')
    act(() => { fireEvent.change(searchInput, { target: { value: 'hello' } }) })

    await waitFor(() =>
      expect(screen.queryByText(/goodbye planet/)).toBeNull(),
    )

    // tailKB should be unchanged (still based on full buffer)
    const tailTextFiltered = document.querySelector('.logfoot')?.textContent ?? ''
    const matchFiltered = tailTextFiltered.match(/tail (\d+) KB/)
    expect(matchFiltered).not.toBeNull()
    const kbFiltered = parseInt(matchFiltered![1], 10)

    expect(kbFiltered).toBe(kbUnfiltered)
  })

  // F4: follow button toggles on every click
  it('F4 — follow button toggles off then on with every click', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    const followBtn = screen.getByRole('button', { name: /Following/i })

    // Initially ON
    expect(followBtn).toHaveClass('on')
    expect(followBtn).toHaveAttribute('aria-pressed', 'true')

    // Click → OFF
    act(() => { fireEvent.click(followBtn) })
    const followBtnOff = screen.getByRole('button', { name: /^Follow$/i })
    expect(followBtnOff).not.toHaveClass('on')
    expect(followBtnOff).toHaveAttribute('aria-pressed', 'false')

    // Click again → ON
    act(() => { fireEvent.click(followBtnOff) })
    const followBtnOn = screen.getByRole('button', { name: /Following/i })
    expect(followBtnOn).toHaveClass('on')
    expect(followBtnOn).toHaveAttribute('aria-pressed', 'true')
  })

  // Status dot: the app-log footer dot must reflect the real stream status,
  // not a hardcoded green — same treatment as the control-plane viewer.
  it('status dot — off while connecting, on when open, off again on error', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=daprd')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    const es = FakeES.instances[0]

    // Connecting → dot is off
    const dot = () => document.querySelector('.logfoot .beatbtn') as HTMLElement
    await waitFor(() => expect(dot()).not.toBeNull())
    expect(dot().classList.contains('off')).toBe(true)

    // Open → dot is on
    act(() => { es.onopen?.() })
    expect(dot().classList.contains('off')).toBe(false)

    // Transient error (reconnecting) → dot off, surfaced as "error"
    es.readyState = 0
    act(() => { es.onerror?.() })
    expect(dot().classList.contains('off')).toBe(true)
    expect(dot().dataset.status).toBe('error')
  })

  it('status dot — surfaces terminal "closed" when the server ends the stream', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=daprd')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    const es = FakeES.instances[0]

    act(() => { es.onopen?.() })
    es.readyState = 2 // EventSource.CLOSED
    act(() => { es.onerror?.() })

    const dot = document.querySelector('.logfoot .beatbtn') as HTMLElement
    expect(dot.classList.contains('off')).toBe(true)
    expect(dot.dataset.status).toBe('closed')
  })

  it('status dot — source=both is on only when BOTH streams are open', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt('/logs?app=order&source=both')

    await waitFor(() => expect(FakeES.instances).toHaveLength(2))
    const [first, second] = FakeES.instances

    const dot = () => document.querySelector('.logfoot .beatbtn') as HTMLElement
    await waitFor(() => expect(dot()).not.toBeNull())

    // Only one stream open → still not fully live
    act(() => { first.onopen?.() })
    expect(dot().classList.contains('off')).toBe(true)

    // Both open → on
    act(() => { second.onopen?.() })
    expect(dot().classList.contains('off')).toBe(false)

    // One stream errors → off again
    act(() => { second.onerror?.() })
    expect(dot().classList.contains('off')).toBe(true)
    expect(dot().dataset.status).toBe('error')
  })

  // ── Control-plane selector: compose services come from /api/controlplane ──

  it('CP — compose control-plane services appear in the selector', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_COMPOSE)),
    )

    renderAt('/logs')

    // Static entries render immediately; compose ones arrive with the fetch.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'saga-placement-1' })).toBeInTheDocument(),
    )
    expect(screen.getByRole('option', { name: 'saga-scheduler-0-1' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'dapr_placement' })).toBeInTheDocument()

    // Statics must not be duplicated by the fetched list.
    const target = screen.getByRole('combobox', { name: /Target/i })
    const names = Array.from(target.querySelectorAll('option')).map(o => o.textContent)
    expect(names.filter(n => n === 'dapr_placement')).toHaveLength(1)
  })

  // Mode-aware static fallback: only host-mode-ish modes (complete scan / dapr-run
  // / aspire) get the dapr_* fallback entries — compose (and test-containers) must
  // not offer them, since those sidecars never run as `dapr init` containers.
  it('CP — compose mode omits the static dapr_* control-plane targets', async () => {
    window.__DASH_CAPABILITIES__ = { lifecycle: true, controlPlane: true, logs: true, workflows: true, mode: 'compose' }
    try {
      server.use(
        http.get('/api/apps', () => HttpResponse.json([])),
        http.get('/api/controlplane', () => HttpResponse.json({ ...CP_LIST_BASE, services: [] })),
      )

      renderAt('/logs')

      await waitFor(() => expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument())
      expect(screen.queryByRole('option', { name: 'dapr_scheduler' })).not.toBeInTheDocument()
      expect(screen.queryByRole('option', { name: 'dapr_placement' })).not.toBeInTheDocument()
    } finally {
      delete window.__DASH_CAPABILITIES__
    }
  })

  it('CP — default mode (no injected capabilities) offers the static dapr_scheduler target', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/controlplane', () => HttpResponse.json({ ...CP_LIST_BASE, services: [] })),
    )

    renderAt('/logs')

    await waitFor(() => expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument())
    expect(screen.getByRole('option', { name: 'dapr_scheduler' })).toBeInTheDocument()
  })

  it('CP — ?cp=<compose service> streams its container logs', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_COMPOSE)),
    )

    renderAt('/logs?cp=saga-placement-1')

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    expect(FakeES.instances[0].url).toContain('/controlplane/saga-placement-1/logs')

    // Subtitle names the service
    expect(document.querySelector('.sub')?.textContent).toContain('saga-placement-1')

    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info placement raft leader' })
    })
    expect(await screen.findByText(/placement raft leader/)).toBeInTheDocument()
  })

  it('CP — while the CP list is still loading, a ?cp= deep link shows loading, not "Select a target"', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/controlplane', async () => {
        await delay(250)
        return HttpResponse.json(CP_LIST_COMPOSE)
      }),
    )

    renderAt('/logs?cp=saga-placement-1')

    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Logs' })).toBeInTheDocument(),
    )
    // The compose name can't be validated until the fetch lands — but the page
    // must not claim "Select a target" while a cp target is pending.
    expect(screen.queryByText(/Select a target/)).toBeNull()

    // Once the list arrives the CP stream mounts.
    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))
    expect(FakeES.instances[0].url).toContain('/controlplane/saga-placement-1/logs')
  })

  it('CP — a garbage ?cp= value opens no stream and falls back to no selection', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/controlplane', () => HttpResponse.json(CP_LIST_COMPOSE)),
    )

    renderAt('/logs?cp=garbage-name')

    // Give the CP list time to load — the value must still be rejected.
    await waitFor(() =>
      expect(screen.getByRole('option', { name: 'saga-placement-1' })).toBeInTheDocument(),
    )
    expect(FakeES.instances).toHaveLength(0)
    const target = screen.getByRole('combobox', { name: /Target/i }) as HTMLSelectElement
    expect(target.value).toBe('')
    expect(screen.getByText(/Select a target/)).toBeInTheDocument()
  })

  // F5: logfoot tail size
  it('F5 — logfoot shows "tail N KB" segment', async () => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([ORDER_SUMMARY])),
      http.get('/api/apps/order', () => HttpResponse.json(ORDER_DETAIL)),
    )

    renderAt()

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    act(() => {
      FakeES.instances[0].onmessage?.({ data: 'level=info some log line' })
    })

    await screen.findByText(/some log line/)

    // logfoot must contain "tail N KB" pattern
    const logfoot = document.querySelector('.logfoot')
    expect(logfoot?.textContent).toMatch(/tail \d+ KB/)
  })

  it('app dropdown lists duplicate-app-id compose instances as distinct options keyed by instanceKey', async () => {
    const host1 = { ...COMPOSE_SUMMARY, appId: 'daprmq-service', instanceKey: 'daprmq-host-1' }
    const host2 = { ...COMPOSE_SUMMARY, appId: 'daprmq-service', instanceKey: 'daprmq-host-2' }
    server.use(
      http.get('/api/apps', () => HttpResponse.json([host1, host2])),
      http.get('/api/apps/daprmq-host-1', () =>
        HttpResponse.json({ ...COMPOSE_DETAIL, appId: 'daprmq-service', instanceKey: 'daprmq-host-1' }),
      ),
    )
    renderAt('/logs?app=daprmq-host-1&source=daprd')
    const select = await screen.findByLabelText('Target')
    await waitFor(() => {
      const values = Array.from(select.querySelectorAll('option')).map(o => o.value)
      expect(values).toContain('app:daprmq-host-1')
      expect(values).toContain('app:daprmq-host-2')
    })
    // Labels disambiguate: app id + container name.
    expect(screen.getByRole('option', { name: 'daprmq-service (daprmq-host-1)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'daprmq-service (daprmq-host-2)' })).toBeInTheDocument()
  })
})
