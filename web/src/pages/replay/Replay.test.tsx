import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { routes } from '../../router'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { RefreshProvider } from '../../lib/refresh'
import { ConnectionContext } from '../../lib/connection'
import { trackAction } from '../../lib/telemetry'
import { SAVE_KEY } from './runtime/persistence'

vi.mock('../../lib/telemetry', () => ({ trackAction: vi.fn(), trackView: vi.fn(), setTelemetryContext: vi.fn(), trackError: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  server.use(
    http.get('/api/version', () => HttpResponse.json({ version: '9.9.9', commit: 'abc1234', date: '2026-01-01' })),
    http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
    http.get('/api/apps', () => HttpResponse.json([])),
    http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    http.get('/api/statestores', () => HttpResponse.json([])),
    http.get('/api/news', () => HttpResponse.json({ blog: null, report: null, webinar: null, event: null })),
    http.get('/api/update-check', () => HttpResponse.json({ current: '9.9.9', latest: '9.9.9', updateAvailable: false, releaseUrl: '' })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path], future: { v7_relativeSplatPath: true } })
  return render(
    <QueryProvider client={makeQueryClient()}>
      <RefreshProvider>
        <ConnectionContext value={{ online: true }}>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </ConnectionContext>
      </RefreshProvider>
    </QueryProvider>,
  )
}

/**
 * Waits until the page is interactive, not merely rendered: the key listeners
 * and the game loop are attached in effects that can run after the first
 * heading appears (easily under a loaded test run), and keys sent before then
 * are lost. The stage auto-focus runs in the same effect flush, so a focused
 * stage means everything is wired up.
 */
async function gameReady(heading: string) {
  await screen.findByRole('heading', { name: heading })
  await waitFor(() => expect(document.activeElement).toBe(document.querySelector('.replay-stage')))
}

describe('Replay page', () => {
  it('lazy-loads at /replay and shows the title card', async () => {
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'REPLAY' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    expect(screen.getByLabelText('REPLAY game screen')).toBeInTheDocument()
  })

  it('Enter opens the level-0 tip without a docs link', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Level 0 · No Safety Net' })).toBeInTheDocument()
    expect(screen.getByText(/keeps its progress in memory/)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /learn more/i })).toBeNull()
  })

  it('opens the Share dialog from the game-over card, and Enter there does not restart the run', async () => {
    // Drive the real loop: capture rAF callbacks and fire them with advancing time.
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', vi.fn((cb: FrameRequestCallback) => frames.push(cb)))
    vi.spyOn(Math, 'random').mockReturnValue(0.5)
    renderAt('/replay')
    await gameReady('Press Enter to start')
    let now = 0
    for (let i = 0; i < 5000 && !screen.queryByRole('heading', { name: 'Workflow FAILED' }); i++) {
      // Dismiss tip / "Progress lost" cards; the hat never jumps, so it soon hits a rack.
      if (screen.queryByRole('heading', { name: /^Level \d|Progress lost|Press Enter/ })) {
        fireEvent.keyDown(window, { key: 'Enter' })
      }
      act(() => {
        now += 100
        frames.shift()?.(now)
      })
    }
    expect(screen.getByRole('heading', { name: 'Workflow FAILED' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '↗ Share' }))
    expect(trackAction).toHaveBeenCalledWith('share_open', { source: 'replay' })
    const dialog = await screen.findByRole('dialog', { name: 'Share the dashboard' })
    fireEvent.keyDown(dialog.querySelector('button') as HTMLButtonElement, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Workflow FAILED' })).toBeInTheDocument()
  })

  it('pauses a running game when the window loses focus', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.blur(window)
    expect(await screen.findByRole('heading', { name: 'Paused' })).toBeInTheDocument()
  })

  it('sizes the canvas backing store to its displayed size times the device pixel ratio', async () => {
    let onResize: () => void = () => {}
    const observe = vi.fn()
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { onResize = cb }
      observe = observe
      disconnect = disconnect
      unobserve = vi.fn()
    })
    vi.stubGlobal('devicePixelRatio', 2)
    let width = 0
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockImplementation(() => width)
    const { unmount } = renderAt('/replay')
    const canvas = (await screen.findByLabelText('REPLAY game screen')) as HTMLCanvasElement
    expect(observe).toHaveBeenCalledWith(canvas)
    expect(canvas.width).toBe(480) // clientWidth 0: keeps the previous size
    width = 700
    act(() => onResize())
    expect(canvas.width).toBe(1400)
    expect(canvas.height).toBe(Math.round((1400 * 270) / 480))
    width = 960
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect(canvas.width).toBe(1920)
    expect(canvas.height).toBe(1080)
    unmount()
    expect(disconnect).toHaveBeenCalled()
  })

  it('keeps the 480x270 backing store without ResizeObserver', async () => {
    vi.stubGlobal('ResizeObserver', undefined)
    vi.stubGlobal('devicePixelRatio', 2)
    vi.spyOn(HTMLCanvasElement.prototype, 'clientWidth', 'get').mockReturnValue(960)
    renderAt('/replay')
    const canvas = (await screen.findByLabelText('REPLAY game screen')) as HTMLCanvasElement
    act(() => { window.dispatchEvent(new Event('resize')) })
    expect([canvas.width, canvas.height]).toEqual([480, 270])
  })

  it('focuses the game stage on mount and starts on Enter there', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    const stage = screen.getByLabelText('REPLAY game')
    expect(stage).toHaveFocus()
    fireEvent.keyDown(stage, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Level 0 · No Safety Net' })).toBeInTheDocument()
  })

  it('leaves Enter to a focused button', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    const button = screen.getAllByRole('button')[0]
    button.focus()
    const e = fireEvent.keyDown(button, { key: 'Enter' })
    expect(e).toBe(true) // not preventDefault-ed
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
  })

  it('leaves keys pressed inside a dialog alone', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    const inner = document.createElement('div')
    dialog.appendChild(inner)
    document.body.appendChild(dialog)
    fireEvent.keyDown(inner, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    dialog.remove()
  })

  it('ignores keys pressed with a modifier', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Level 0 · No Safety Net' })).not.toBeInTheDocument()
  })

  const savedRun = () => JSON.stringify({
    version: 1,
    start: { level: 1, seed: 5, score: 2, elapsed: 0, distance: 0, boss: false },
    history: [{ type: 'Input', tick: 3, kind: 'jump' }],
    tick: 40,
    stats: { replays: 0, fromHistory: 0, executed: 0, incidents: 0 },
    divergedAt: null,
  })

  it('saves a durable run and stops the loop when the page unmounts mid-run', async () => {
    localStorage.setItem(SAVE_KEY, savedRun())
    const { unmount } = renderAt('/replay')
    await gameReady('Resume your run?')
    fireEvent.keyDown(window, { key: 'Enter' })
    localStorage.removeItem(SAVE_KEY)
    unmount()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(localStorage.getItem(SAVE_KEY)).not.toBeNull()
  })

  it('never saves level 0, which has no durable history', async () => {
    const { unmount } = renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    unmount()
    expect(localStorage.getItem(SAVE_KEY)).toBeNull()
  })

  it('offers to resume when a saved run exists', async () => {
    localStorage.setItem(SAVE_KEY, savedRun())
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'Resume your run?' })).toBeInTheDocument()
    expect(screen.getByText(/tick 40/)).toBeInTheDocument()
  })
})
