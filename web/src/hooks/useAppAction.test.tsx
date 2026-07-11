import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { useAppAction, useAppForget } from './useAppAction'

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryProvider client={makeQueryClient()}>{children}</QueryProvider>
}

describe('useAppAction', () => {
  it('POSTs to the lifecycle endpoint and resolves', async () => {
    let hit = ''
    server.use(
      http.post('/api/apps/orders/daprd/stop', () => {
        hit = 'orders/daprd/stop'
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const { result } = renderHook(() => useAppAction('orders'), { wrapper })
    result.current.mutate({ target: 'daprd', action: 'stop' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hit).toBe('orders/daprd/stop')
  })

  it('surfaces the API error body as the Error message', async () => {
    server.use(
      http.post('/api/apps/orders/app/start', () =>
        HttpResponse.json({ error: 'no captured command' }, { status: 400 }),
      ),
    )
    const { result } = renderHook(() => useAppAction('orders'), { wrapper })
    result.current.mutate({ target: 'app', action: 'start' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('no captured command')
  })
})

describe('useAppForget', () => {
  it('DELETEs the app entry and resolves', async () => {
    let hit = false
    server.use(
      http.delete('/api/apps/orders', () => {
        hit = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { result } = renderHook(() => useAppForget('orders'), { wrapper })
    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hit).toBe(true)
  })

  it('surfaces the API error body as the Error message', async () => {
    server.use(
      http.delete('/api/apps/orders', () =>
        HttpResponse.json({ error: 'no remembered stopped instance for this app' }, { status: 404 }),
      ),
    )
    const { result } = renderHook(() => useAppForget('orders'), { wrapper })
    result.current.mutate()
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('no remembered stopped instance for this app')
  })
})
