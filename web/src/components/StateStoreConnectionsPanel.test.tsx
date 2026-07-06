import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { StateStoreConnectionsPanel } from './StateStoreConnectionsPanel'

const stores = [
  { id: 'a1', name: 'statestore', type: 'state.redis', source: 'auto', path: '/x/a.yaml', active: true, connection: 'localhost:6379' },
  { id: 'm1', name: 'orders-pg', type: 'state.postgresql', source: 'manual', path: '', active: false, connection: 'host=db' },
]

const catalog = {
  schemaVersion: 'v1', date: '2026', components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }] },
  ],
}

describe('StateStoreConnectionsPanel', () => {
  it('shows auto rows read-only and manual rows with actions', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json(stores)))
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByText('statestore')).toBeInTheDocument())
    expect(screen.getByText('orders-pg')).toBeInTheDocument()
    // ACTIVE badge on the active auto store.
    expect(screen.getByText(/active/i)).toBeInTheDocument()
    // Manual row has delete only (no edit); the active row has neither.
    expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit statestore/i })).not.toBeInTheDocument()
    // Add button present.
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument()
  })

  it('shows a success toast after a successful add, even though the dialog unmounts', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(stores)),
      http.get('/api/metadata/components', () => HttpResponse.json(catalog)),
      http.post('/api/statestores', () => HttpResponse.json({ name: 'orders' }, { status: 201 })),
    )
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    fireEvent.click(screen.getByRole('button', { name: /add connection/i }))
    await waitFor(() => expect(screen.getByLabelText('redisHost')).toBeInTheDocument())

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    fireEvent.click(screen.getByRole('button', { name: /save/i }))

    // Dialog closes…
    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /add state store connection/i })).not.toBeInTheDocument(),
    )
    // …and the confirmation toast is still visible (rendered by the panel, not the dialog).
    expect(screen.getByText('Added orders')).toBeInTheDocument()
  })

  it('shows error feedback and keeps the confirm modal open when delete fails', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(stores)),
      http.delete('/api/statestores/m1', () =>
        HttpResponse.json({ error: 'store is in use' }, { status: 500 }),
      ),
    )
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete orders-pg/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    // Error surfaced to the user, modal still open, no crash / unhandled rejection.
    await waitFor(() => expect(screen.getByText('store is in use')).toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: /delete connection/i })).toBeInTheDocument()
  })

  it('closes the confirm modal and shows a toast on successful delete', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(stores)),
      http.delete('/api/statestores/m1', () => new HttpResponse(null, { status: 204 })),
    )
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete orders-pg/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(screen.queryByRole('dialog', { name: /delete connection/i })).not.toBeInTheDocument(),
    )
    expect(screen.getByText('Removed orders-pg')).toBeInTheDocument()
  })

  it('renames the panel, shows paths, and offers delete on non-active rows only', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json(stores)))
    render(<QueryProvider client={makeQueryClient()}><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByText('statestore')).toBeInTheDocument())
    expect(screen.getByText('Recent workflow state store connections')).toBeInTheDocument()
    // Path shown for the auto (file-backed) row; the manual row has none.
    expect(screen.getByText('/x/a.yaml')).toBeInTheDocument()
    // The active row has no delete button; the non-active row does.
    expect(screen.queryByRole('button', { name: /delete statestore/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument()
  })

  it('explains durable dismissal when removing an auto-discovered connection', async () => {
    const autoInactive = [
      { id: 'a2', name: 'projstore', type: 'state.sqlite', source: 'auto', path: '/y/b.yaml', active: false, connection: 'b.db' },
    ]
    server.use(http.get('/api/statestores', () => HttpResponse.json(autoInactive)))
    render(<QueryProvider client={makeQueryClient()}><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByRole('button', { name: /delete projstore/i })).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: /delete projstore/i }))
    expect(
      screen.getByText(/stay hidden unless it becomes the active workflow state store again/i),
    ).toBeInTheDocument()
  })
})
