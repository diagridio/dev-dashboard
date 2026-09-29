import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse, delay } from 'msw'
import { setupServer } from 'msw/node'
import { fetchJSON } from './api'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchJSON error enrichment', () => {
  it('includes the response body error message and keeps the status prefix and path suffix', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'could not connect to state store "statestore" (localhost:16379)' }, { status: 503 }),
      ),
    )
    await expect(fetchJSON('/workflows')).rejects.toThrowError(
      /API error 503.*could not connect to state store.*localhost:16379.*for \/workflows/,
    )
  })

  it('still throws the status prefix when the body has no error field', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.text('boom', { status: 500 })))
    await expect(fetchJSON('/workflows')).rejects.toThrowError(/API error 500 for \/workflows/)
  })
})

describe('fetchJSON abort', () => {
  it('forwards the AbortSignal so an aborted request rejects', async () => {
    server.use(
      http.get('/api/workflows', async () => {
        await delay(200)
        return HttpResponse.json({ items: [] })
      }),
    )
    const ctrl = new AbortController()
    const p = fetchJSON('/workflows', { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow()
  })
})
