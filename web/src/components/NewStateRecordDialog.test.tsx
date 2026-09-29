import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { NewStateRecordDialog } from './NewStateRecordDialog'

function renderDialog(props?: { defaultAppId?: string }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  })
  const onClose = vi.fn()
  render(
    <QueryProvider client={client}>
      <NewStateRecordDialog
        open
        onClose={onClose}
        store="store-1"
        appIds={['order-app', 'cart-service']}
        defaultAppId={props?.defaultAppId}
      />
    </QueryProvider>,
  )
  return { onClose }
}

/** A dialog whose open state a test can flip, to assert the form resets. */
function renderReopenable() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } },
  })
  let toggleOpen: () => void = () => {}

  function Wrapper() {
    const [open, setOpen] = useState(true)
    toggleOpen = () => setOpen((v) => !v)
    return (
      <NewStateRecordDialog
        open={open}
        onClose={() => setOpen(false)}
        store="store-1"
        appIds={['order-app']}
      />
    )
  }

  render(
    <QueryProvider client={client}>
      <Wrapper />
    </QueryProvider>,
  )
  return { toggleOpen: () => toggleOpen() }
}

describe('NewStateRecordDialog', () => {
  it('prefills the app id from the page filter and offers the known prefixes', () => {
    renderDialog({ defaultAppId: 'order-app' })
    expect(screen.getByLabelText(/app id/i)).toHaveValue('order-app')
    // A datalist, not a select: the field can be picked from or typed into
    // freely, so a prefix with no records yet is still reachable.
    const listId = screen.getByLabelText(/app id/i).getAttribute('list')
    expect(listId).toBeTruthy()
    const suggested = Array.from(
      document.getElementById(listId as string)?.querySelectorAll('option') ?? [],
    ).map((o) => o.value)
    expect(suggested).toEqual(['order-app', 'cart-service'])
  })

  it('shows the key that will be stored', async () => {
    renderDialog({ defaultAppId: 'order-app' })
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    expect(screen.getByTestId('composed-key')).toHaveTextContent('order-app||cart-1')
  })

  it('marks every field as required', () => {
    renderDialog()
    for (const name of ['App ID', 'Key', 'Value']) {
      const label = screen.getByText(new RegExp(`^${name}`), { selector: 'label' })
      expect(label.querySelector('.req'), `${name} label`).not.toBeNull()
    }
  })

  it('cannot save until every field is filled in', async () => {
    renderDialog()
    const save = screen.getByRole('button', { name: /^save$/i })
    expect(save).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/app id/i), 'order-app')
    expect(save).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    expect(save).toBeDisabled()

    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    expect(save).toBeEnabled()
  })

  it('does not accept an all-whitespace app id or key', async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText(/app id/i), '   ')
    await userEvent.type(screen.getByLabelText(/^key/i), '   ')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })

  it('stores the typed value verbatim and reports the created key', async () => {
    let gotBody: unknown
    let gotUrl = ''
    server.use(
      http.post('/api/state/record', async ({ request }) => {
        gotUrl = request.url
        gotBody = await request.json()
        return HttpResponse.json({ key: 'order-app||cart-1' }, { status: 201 })
      }),
    )
    renderDialog({ defaultAppId: 'order-app' })
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/order-app\|\|cart-1/)).toBeInTheDocument()
    expect(gotUrl).toContain('store=store-1')
    expect(gotBody).toEqual({
      appId: 'order-app',
      key: 'cart-1',
      value: 'hello',
      overwrite: false,
    })
  })

  it('offers an overwrite once the server reports a conflict', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post('/api/state/record', async ({ request }) => {
        bodies.push(await request.json())
        if (bodies.length === 1) {
          return HttpResponse.json(
            { error: 'record already exists: order-app||cart-1' },
            { status: 409 },
          )
        }
        return HttpResponse.json({ key: 'order-app||cart-1' }, { status: 201 })
      }),
    )
    renderDialog({ defaultAppId: 'order-app' })
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/already exists/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^overwrite$/i }))

    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({ overwrite: true })
    expect(await screen.findByText(/order-app\|\|cart-1/)).toBeInTheDocument()
  })

  // Otherwise the only button left would overwrite whatever the edited key
  // happens to name, which is not what the conflict was about.
  it('drops the overwrite offer once the key is edited', async () => {
    const bodies: unknown[] = []
    server.use(
      http.post('/api/state/record', async ({ request }) => {
        bodies.push(await request.json())
        if (bodies.length === 1) {
          return HttpResponse.json({ error: 'record already exists' }, { status: 409 })
        }
        return HttpResponse.json({ key: 'order-app||cart-2' }, { status: 201 })
      }),
    )
    renderDialog({ defaultAppId: 'order-app' })
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByRole('button', { name: /^overwrite$/i })).toBeInTheDocument()

    await userEvent.type(screen.getByLabelText(/^key/i), '-renamed')

    expect(screen.queryByRole('button', { name: /^overwrite$/i })).not.toBeInTheDocument()
    expect(screen.queryByText(/already exists/i)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    await waitFor(() => expect(bodies).toHaveLength(2))
    expect(bodies[1]).toMatchObject({ key: 'cart-1-renamed', overwrite: false })
  })

  it('shows the server error on failure', async () => {
    server.use(
      http.post('/api/state/record', () =>
        HttpResponse.json({ error: 'could not connect to state store' }, { status: 503 }),
      ),
    )
    renderDialog({ defaultAppId: 'order-app' })
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    await waitFor(() =>
      expect(screen.getByText(/could not connect to state store/i)).toBeInTheDocument(),
    )
    // A plain failure is retryable in place, not a conflict.
    expect(screen.queryByRole('button', { name: /^overwrite$/i })).not.toBeInTheDocument()
  })

  it('starts from a blank form when reopened', async () => {
    server.use(
      http.post('/api/state/record', () =>
        HttpResponse.json({ key: 'order-app||cart-1' }, { status: 201 }),
      ),
    )
    const { toggleOpen } = renderReopenable()
    await userEvent.type(screen.getByLabelText(/app id/i), 'order-app')
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))
    expect(await screen.findByText(/created/i)).toBeInTheDocument()

    toggleOpen()
    await waitFor(() => expect(screen.queryByText(/created/i)).not.toBeInTheDocument())
    toggleOpen()

    await waitFor(() => expect(screen.getByLabelText(/^key/i)).toHaveValue(''))
    expect(screen.getByLabelText(/^value/i)).toHaveValue('')
    expect(screen.getByRole('button', { name: /^save$/i })).toBeDisabled()
  })
})
