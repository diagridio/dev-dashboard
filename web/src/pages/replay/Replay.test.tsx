import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { routes } from '../../router'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { RefreshProvider } from '../../lib/refresh'
import { ConnectionContext } from '../../lib/connection'
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

describe('Replay page', () => {
  it('lazy-loads at /replay and shows the title card', async () => {
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'REPLAY' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    expect(screen.getByLabelText('REPLAY game screen')).toBeInTheDocument()
  })

  it('Enter opens the level-0 tip with a docs link', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Level 0 · No Safety Net' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Learn more ↗' })).toHaveAttribute('target', '_blank')
  })

  it('pauses a running game when the window loses focus', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.blur(window)
    expect(await screen.findByRole('heading', { name: 'Paused' })).toBeInTheDocument()
  })

  it('focuses the game stage on mount and starts on Enter there', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    const stage = screen.getByLabelText('REPLAY game')
    expect(stage).toHaveFocus()
    fireEvent.keyDown(stage, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Level 0 · No Safety Net' })).toBeInTheDocument()
  })

  it('leaves Enter to a focused button', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    const button = screen.getAllByRole('button')[0]
    button.focus()
    const e = fireEvent.keyDown(button, { key: 'Enter' })
    expect(e).toBe(true) // not preventDefault-ed
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
  })

  it('leaves keys pressed inside a dialog alone', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
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
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: 'Level 0 · No Safety Net' })).not.toBeInTheDocument()
  })

  it('saves the run and stops the loop when the page unmounts mid-run', async () => {
    const { unmount } = renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    localStorage.removeItem(SAVE_KEY)
    unmount()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(localStorage.getItem(SAVE_KEY)).not.toBeNull()
  })

  it('offers to resume when a saved run exists', async () => {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: 1,
      start: { level: 1, seed: 5, score: 2, elapsed: 0, distance: 0, boss: false },
      history: [{ type: 'Input', tick: 3, kind: 'jump' }],
      tick: 40,
      stats: { replays: 0, fromHistory: 0, executed: 0, incidents: 0 },
      divergedAt: null,
    }))
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'Resume your run?' })).toBeInTheDocument()
    expect(screen.getByText(/tick 40/)).toBeInTheDocument()
  })
})
