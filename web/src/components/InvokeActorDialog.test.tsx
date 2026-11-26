import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { InvokeActorDialog } from './InvokeActorDialog'
import { rememberInvoke, recentIds } from '../lib/actorRecents'

const URL = '/api/actors/order/Cart/c1/invoke'

function renderDialog(props: { actorId?: string; suggestedIds?: string[] } = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } })
  const router = createMemoryRouter(
    [{ path: '/', element: (
      <InvokeActorDialog open onClose={vi.fn()} appKey="order" appId="order-app" actorType="Cart" {...props} />
    ) }],
    { initialEntries: ['/'], future: { v7_relativeSplatPath: true } },
  )
  render(
    <QueryProvider client={client}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryProvider>,
  )
}

async function fill(id: string, method: string, body?: string) {
  if (id) await userEvent.type(screen.getByLabelText(/actor id/i), id)
  if (method) await userEvent.type(screen.getByLabelText(/^method/i), method)
  if (body) await userEvent.type(screen.getByLabelText(/body/i), body)
}

describe('InvokeActorDialog', () => {
  beforeEach(() => localStorage.clear())

  it('requires a method and sends nothing', async () => {
    let called = false
    server.use(http.post(URL, () => { called = true; return HttpResponse.json({}) }))
    renderDialog({ actorId: 'c1' })
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(screen.getByText('Method is required')).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('blocks invalid JSON but allows an empty body', async () => {
    let calls = 0
    server.use(http.post(URL, () => { calls++; return HttpResponse.json({ status: 200, durationMs: 1, contentType: 'application/json', body: '' }) }))
    renderDialog({ actorId: 'c1' })
    await fill('', 'Add', '{{ nope')
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(screen.getByText('Invalid JSON body')).toBeInTheDocument()
    expect(calls).toBe(0)
    await userEvent.clear(screen.getByLabelText(/body/i))
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    await waitFor(() => expect(calls).toBe(1))
  })

  it('shows a 200 result with pretty JSON and links, and remembers the invoke', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ status: 200, durationMs: 12, contentType: 'application/json', body: '{"a":1}' })))
    renderDialog({ actorId: 'c1' })
    await fill('', 'Add')
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(await screen.findByText('200')).toBeInTheDocument()
    expect(screen.getByText(/12\s*ms/)).toBeInTheDocument()
    expect(screen.getByText(/"a": 1/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Open actor' })).toHaveAttribute('href', '/actors/order/Cart/c1')
    expect(screen.getByRole('link', { name: 'Open order-app logs' })).toHaveAttribute('href', '/logs?app=order-app&source=app')
    expect(recentIds('order', 'Cart')).toEqual(['c1'])
  })

  it('shows status and error for a 500 result', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ status: 500, durationMs: 3, contentType: '', body: '', error: 'boom' })))
    renderDialog({ actorId: 'c1' })
    await fill('', 'Add')
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(await screen.findByText('500')).toBeInTheDocument()
    expect(screen.getByText('boom')).toBeInTheDocument()
  })

  it('shows a non-JSON body as is', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ status: 200, durationMs: 3, contentType: 'text/plain', body: 'ok' })))
    renderDialog({ actorId: 'c1' })
    await fill('', 'Add')
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(await screen.findByText('ok')).toBeInTheDocument()
  })

  it('shows a rejected mutation as a form error', async () => {
    server.use(http.post(URL, () => HttpResponse.json({ error: 'internal actor' }, { status: 400 })))
    renderDialog({ actorId: 'c1' })
    await fill('', 'Add')
    await userEvent.click(screen.getByRole('button', { name: /^invoke$/i }))
    expect(await screen.findByText(/internal actor/)).toBeInTheDocument()
  })

  it('offers recent and suggested values as datalists, recent first', () => {
    rememberInvoke('order', 'Cart', 'r1', 'Clear')
    renderDialog({ suggestedIds: ['s1', 'r1'] })
    const ids = Array.from(document.querySelectorAll('datalist#invoke-ids option')).map((o) => o.getAttribute('value'))
    expect(ids).toEqual(['r1', 's1'])
    const methods = Array.from(document.querySelectorAll('datalist#invoke-methods option')).map((o) => o.getAttribute('value'))
    expect(methods).toEqual(['Clear'])
  })

  it('prefills a read-only ID when actorId is given', () => {
    renderDialog({ actorId: 'c1' })
    const input = screen.getByLabelText(/actor id/i) as HTMLInputElement
    expect(input.value).toBe('c1')
    expect(input.readOnly).toBe(true)
  })
})
