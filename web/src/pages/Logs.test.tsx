import { render, screen, waitFor, act, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
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

    // app select
    expect(bar.querySelector('[aria-label="App"]')).not.toBeNull()
    // source select
    expect(bar.querySelector('[aria-label="Source"]')).not.toBeNull()
    // .lvchips group
    expect(bar.querySelector('.lvchips')).not.toBeNull()
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

    await waitFor(() => expect(FakeES.instances.length).toBeGreaterThanOrEqual(1))

    const appSelect = screen.getByRole('combobox', { name: /App/i })
    expect(appSelect).toBeInTheDocument()

    const sourceSelect = screen.getByRole('combobox', { name: /Source/i })
    expect(sourceSelect).toBeInTheDocument()

    // Source options match mock
    expect(screen.getByRole('option', { name: 'daprd + app' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'daprd only' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'app only' })).toBeInTheDocument()
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
})
