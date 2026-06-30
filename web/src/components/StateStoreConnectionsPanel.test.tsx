import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { StateStoreConnectionsPanel } from './StateStoreConnectionsPanel'

const stores = [
  { id: 'a1', name: 'statestore', type: 'state.redis', source: 'auto', path: '/x/a.yaml', active: true, connection: 'localhost:6379' },
  { id: 'm1', name: 'orders-pg', type: 'state.postgresql', source: 'manual', path: '', active: false, connection: 'host=db' },
]

describe('StateStoreConnectionsPanel', () => {
  it('shows auto rows read-only and manual rows with actions', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json(stores)))
    render(<QueryProvider><StateStoreConnectionsPanel /></QueryProvider>)

    await waitFor(() => expect(screen.getByText('statestore')).toBeInTheDocument())
    expect(screen.getByText('orders-pg')).toBeInTheDocument()
    // ACTIVE badge on the active auto store.
    expect(screen.getByText(/active/i)).toBeInTheDocument()
    // Manual row has edit + delete; auto row does not.
    expect(screen.getByRole('button', { name: /edit orders-pg/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /delete orders-pg/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /edit statestore/i })).not.toBeInTheDocument()
    // Add button present.
    expect(screen.getByRole('button', { name: /add connection/i })).toBeInTheDocument()
  })
})
