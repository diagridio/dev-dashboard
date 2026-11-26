import { describe, it, expect } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { http, HttpResponse } from 'msw'
import type { ReactNode } from 'react'
import { server } from '../test/setup'
import { useInvokeActor, useDeleteReminder } from './useActors'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useInvokeActor', () => {
  it('POSTs to the encoded invoke URL and returns the result', async () => {
    let body: unknown
    server.use(
      http.post('*/api/actors/a/T/x%2Fy/invoke', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ status: 200, durationMs: 3, contentType: 'application/json', body: '{"ok":1}' })
      }),
    )
    const { result } = renderHook(() => useInvokeActor('a', 'T'), { wrapper })
    let res
    await act(async () => {
      res = await result.current.mutateAsync({ id: 'x/y', method: 'Get', verb: 'POST', body: '{}' })
    })
    expect(res).toMatchObject({ status: 200, body: '{"ok":1}' })
    expect(body).toEqual({ method: 'Get', verb: 'POST', body: '{}' })
  })

  it('surfaces the server error message', async () => {
    server.use(http.post('*/api/actors/a/T/1/invoke', () => HttpResponse.json({ error: 'internal actor' }, { status: 400 })))
    const { result } = renderHook(() => useInvokeActor('a', 'T'), { wrapper })
    act(() => result.current.mutate({ id: '1', method: 'm', verb: 'GET', body: '' }))
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('internal actor')
  })
})

describe('useDeleteReminder', () => {
  it('DELETEs the reminder by name', async () => {
    let hit = false
    server.use(
      http.delete('*/api/actors/a/T/1/reminders/r%201', () => {
        hit = true
        return new HttpResponse(null, { status: 204 })
      }),
    )
    const { result } = renderHook(() => useDeleteReminder('a', 'T', '1'), { wrapper })
    await act(async () => {
      await result.current.mutateAsync('r 1')
    })
    expect(hit).toBe(true)
  })
})
