import { render, screen, fireEvent, waitFor, act, cleanup } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { PromoBanner } from './PromoBanner'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { trackAction } from '../lib/telemetry'
import { isPromoDismissed } from '../lib/promoDismissed'

vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))

const promo = (id = 'aow-2026') => ({
  id,
  title: `Advent of Workflow ${id}`,
  text: '25 days of Dapr Workflow challenges',
  url: 'https://www.diagrid.io/advent-of-workflow?utm_medium=banner&utm_source=dev-dashboard',
  cta: 'Join now',
})

const news = (promotion: unknown) => ({ blog: null, report: null, webinar: null, event: null, promotion })

function serve(promotion: unknown) {
  server.use(http.get('/api/news', () => HttpResponse.json(news(promotion))))
}

function renderBanner(client = makeQueryClient()) {
  render(
    <QueryProvider client={client}>
      <PromoBanner delayMs={0} />
    </QueryProvider>,
  )
  return client
}

const banner = () => screen.findByRole('complementary', { name: 'Promotion' })
const noBanner = () => expect(screen.queryByRole('complementary', { name: 'Promotion' })).toBeNull()

describe('PromoBanner', () => {
  beforeEach(() => {
    localStorage.clear()
    vi.mocked(trackAction).mockClear()
  })

  it('shows title, text and a "Join now ↗" link', async () => {
    serve(promo())
    renderBanner()
    const el = await banner()
    expect(el).toHaveTextContent('Advent of Workflow aow-2026')
    expect(el).toHaveTextContent('25 days of Dapr Workflow challenges')
    const link = screen.getByRole('link', { name: /Join now ↗/ })
    expect(link).toHaveAttribute('href', promo().url)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    await waitFor(() => expect(el).toHaveClass('show'))
  })

  it('renders nothing when promotion is null', async () => {
    let hit = false
    server.use(
      http.get('/api/news', () => {
        hit = true
        return HttpResponse.json(news(null))
      }),
    )
    renderBanner()
    await waitFor(() => expect(hit).toBe(true))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    noBanner()
  })

  it('renders nothing when the feed request fails', async () => {
    let hits = 0
    server.use(
      http.get('/api/news', () => {
        hits++
        return new HttpResponse(null, { status: 500 })
      }),
    )
    renderBanner()
    await waitFor(() => expect(hits).toBeGreaterThan(0))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    noBanner()
  })

  it('renders nothing when the id was dismissed', async () => {
    localStorage.setItem('devdash.promoDismissed', JSON.stringify(['aow-2026']))
    let hit = false
    server.use(
      http.get('/api/news', () => {
        hit = true
        return HttpResponse.json(news(promo()))
      }),
    )
    renderBanner()
    await waitFor(() => expect(hit).toBe(true))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    noBanner()
  })

  it('close button dismisses and persists', async () => {
    serve(promo())
    renderBanner()
    await banner()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss promotion' }))
    noBanner()
    expect(isPromoDismissed('aow-2026')).toBe(true)
    expect(trackAction).toHaveBeenCalledWith('promo_dismiss', { id: 'aow-2026' })
  })

  it('Escape inside the banner dismisses; Escape elsewhere does not', async () => {
    serve(promo())
    renderBanner()
    await banner()
    fireEvent.keyDown(document.body, { key: 'Escape' })
    expect(await banner()).toBeInTheDocument()
    const close = screen.getByRole('button', { name: 'Dismiss promotion' })
    close.focus()
    fireEvent.keyDown(close, { key: 'Escape' })
    noBanner()
    expect(isPromoDismissed('aow-2026')).toBe(true)
  })

  it('link click dismisses and tracks promo_click', async () => {
    serve(promo())
    renderBanner()
    await banner()
    fireEvent.click(screen.getByRole('link', { name: /Join now/ }))
    noBanner()
    expect(isPromoDismissed('aow-2026')).toBe(true)
    expect(trackAction).toHaveBeenCalledWith('promo_click', { id: 'aow-2026' })
  })

  it('tracks promo_shown once', async () => {
    serve(promo())
    renderBanner()
    await banner()
    await waitFor(() => expect(trackAction).toHaveBeenCalledWith('promo_shown', { id: 'aow-2026' }))
    expect(vi.mocked(trackAction).mock.calls.filter(([n]) => n === 'promo_shown')).toHaveLength(1)
  })

  it('re-shows for a new promotion id', async () => {
    serve(promo('a'))
    const client = renderBanner()
    await banner()
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss promotion' }))
    noBanner()
    serve(promo('b'))
    await act(() => client.invalidateQueries({ queryKey: ['news'] }))
    expect(await banner()).toHaveTextContent('Advent of Workflow b')
  })

  it('hides in an open tab once endsAt passes, without a refetch', async () => {
    let hits = 0
    const endsAt = new Date(Date.now() + 300).toISOString()
    server.use(
      http.get('/api/news', () => {
        hits++
        return HttpResponse.json(news({ ...promo(), endsAt }))
      }),
    )
    renderBanner()
    await banner()
    await waitFor(noBanner, { timeout: 2000 })
    expect(hits).toBe(1)
    expect(isPromoDismissed('aow-2026')).toBe(false)
  })

  it('treats a bare-date endsAt as the end of that UTC day', async () => {
    const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10)
    const today = new Date().toISOString().slice(0, 10)
    serve({ ...promo(), endsAt: today })
    renderBanner()
    expect(await banner()).toBeInTheDocument()
    cleanup()
    let hit = false
    server.use(
      http.get('/api/news', () => {
        hit = true
        return HttpResponse.json(news({ ...promo(), endsAt: yesterday }))
      }),
    )
    renderBanner()
    await waitFor(() => expect(hit).toBe(true))
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    noBanner()
  })
})
