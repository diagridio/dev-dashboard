import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { useStoreMutations } from './useStoreMutations'

function Probe() {
  const { addStore } = useStoreMutations()
  return (
    <div>
      <button onClick={() => addStore.mutateAsync({ name: 'r', type: 'state.redis', metadata: { redisHost: 'h' } }).catch((e) => {
        document.title = (e as Error).message
      })}>add</button>
      <span data-testid="status">{addStore.isSuccess ? 'ok' : addStore.isError ? 'err' : 'idle'}</span>
    </div>
  )
}

describe('useStoreMutations', () => {
  it('posts a new store and reports success', async () => {
    let received: unknown = null
    server.use(http.post('/api/statestores', async ({ request }) => {
      received = await request.json()
      return HttpResponse.json({ name: 'r' }, { status: 201 })
    }))
    render(<QueryProvider><Probe /></QueryProvider>)
    screen.getByText('add').click()
    await waitFor(() => expect(screen.getByTestId('status')).toHaveTextContent('ok'))
    expect(received).toEqual({ name: 'r', type: 'state.redis', metadata: { redisHost: 'h' } })
  })

  it('surfaces the server error message on failure', async () => {
    server.use(http.post('/api/statestores', () =>
      HttpResponse.json({ error: 'a connection named "r" already exists' }, { status: 400 })))
    render(<QueryProvider><Probe /></QueryProvider>)
    screen.getByText('add').click()
    await waitFor(() => expect(document.title).toBe('a connection named "r" already exists'))
  })
})
