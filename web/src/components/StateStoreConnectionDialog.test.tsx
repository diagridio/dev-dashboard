import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { StateStoreConnectionDialog } from './StateStoreConnectionDialog'

const catalog = {
  schemaVersion: 'v1', date: '2026', components: [
    { type: 'state', name: 'redis', version: 'v1', title: 'Redis', status: 'stable',
      metadata: [{ name: 'redisHost', required: true, type: 'string' }, { name: 'redisPassword', sensitive: true, type: 'string' }] },
  ],
}

function setup(ui: React.ReactNode) {
  return render(<QueryProvider>{ui}</QueryProvider>)
}

describe('StateStoreConnectionDialog', () => {
  it('disables Save until required fields are filled, then POSTs', async () => {
    server.use(http.get('/api/metadata/components', () => HttpResponse.json(catalog)))
    let posted: any = null
    server.use(http.post('/api/statestores', async ({ request }) => {
      posted = await request.json()
      return HttpResponse.json({ name: 'orders' }, { status: 201 })
    }))

    setup(<StateStoreConnectionDialog open onClose={() => {}} />)

    // Wait for catalog → required field present.
    await waitFor(() => expect(screen.getByLabelText('redisHost')).toBeInTheDocument())

    const save = screen.getByRole('button', { name: /save/i })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'orders' } })
    fireEvent.change(screen.getByLabelText('redisHost'), { target: { value: 'localhost:6379' } })
    expect(save).toBeEnabled()

    fireEvent.click(save)
    await waitFor(() => expect(posted).not.toBeNull())
    expect(posted).toEqual({
      name: 'orders',
      type: 'state.redis',
      metadata: { redisHost: 'localhost:6379', actorStateStore: 'true' },
    })
  })
})
