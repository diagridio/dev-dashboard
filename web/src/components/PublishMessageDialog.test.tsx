import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { PublishMessageDialog } from './PublishMessageDialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } })
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [{ path: '/', element: (
      <PublishMessageDialog open onClose={onClose} instanceKey="order" appId="order" pubsubName="pubsub" topic="orders" />
    ) }, { path: '/logs', element: <div>logs page</div> }],
    { initialEntries: ['/'], future: { v7_relativeSplatPath: true } },
  )
  render(
    <QueryProvider client={client}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryProvider>,
  )
  return { onClose }
}

function renderDialogWithToggle() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } })
  const onClose = vi.fn()
  let toggleOpen: () => void = () => {}

  function DialogWrapper() {
    const [open, setOpen] = useState(true)
    toggleOpen = () => setOpen(prev => !prev)
    return (
      <PublishMessageDialog
        open={open}
        onClose={() => {
          setOpen(false)
          onClose()
        }}
        instanceKey="order"
        appId="order"
        pubsubName="pubsub"
        topic="orders"
      />
    )
  }

  const router = createMemoryRouter(
    [{ path: '/', element: <DialogWrapper /> }, { path: '/logs', element: <div>logs page</div> }],
    { initialEntries: ['/'], future: { v7_relativeSplatPath: true } },
  )
  render(
    <QueryProvider client={client}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryProvider>,
  )
  return { onClose, toggleOpen }
}

describe('PublishMessageDialog', () => {
  it('prefills pub/sub and topic', () => {
    renderDialog()
    expect(screen.getByText('pubsub')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
  })

  it('blocks submit on invalid JSON payload', async () => {
    let called = false
    server.use(http.post('/api/apps/order/publish', () => { called = true; return new HttpResponse(null, { status: 200 }) }))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{ not json')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('publishes and shows success with a logs link', async () => {
    let gotBody: unknown
    server.use(http.post('/api/apps/order/publish', async ({ request }) => {
      gotBody = await request.json()
      return HttpResponse.json({ status: 'published' })
    }))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{"id":1}')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    expect(await screen.findByText(/published to/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /logs/i })).toHaveAttribute('href', '/logs?app=order&source=app')
    expect(gotBody).toMatchObject({ pubsubName: 'pubsub', topic: 'orders', data: '{"id":1}', contentType: 'application/json' })
  })

  it('shows the daprd error on failure', async () => {
    server.use(http.post('/api/apps/order/publish', () => HttpResponse.json({ error: 'component pubsub not found' }, { status: 400 })))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{"id":1}')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    await waitFor(() => expect(screen.getByText(/component pubsub not found/i)).toBeInTheDocument())
  })

  it('resets state when dialog is reopened', async () => {
    server.use(http.post('/api/apps/order/publish', () => HttpResponse.json({ status: 'published' })))
    const { toggleOpen } = renderDialogWithToggle()

    // Publish a message successfully
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{"id":1}')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))

    // Assert success screen is shown
    expect(await screen.findByText(/published to/i)).toBeInTheDocument()

    // Close the dialog
    toggleOpen()
    await waitFor(() => expect(screen.queryByText(/published to/i)).not.toBeInTheDocument())

    // Reopen the dialog
    toggleOpen()

    // Assert fresh form is shown: payload textarea is visible with reset value
    await waitFor(() => {
      expect(screen.getByLabelText(/payload/i)).toBeInTheDocument()
      expect((screen.getByLabelText(/payload/i) as HTMLTextAreaElement).value).toBe('{}')
    })
    expect(screen.queryByText(/published to/i)).not.toBeInTheDocument()
  })
})
