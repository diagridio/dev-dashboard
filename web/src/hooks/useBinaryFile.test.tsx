import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import type { DaprRef } from '../lib/daprRef'
import { useBinaryFile, BinaryFileError } from './useBinaryFile'

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return function wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryProvider client={client}>
        <RefreshProvider>{children}</RefreshProvider>
      </QueryProvider>
    )
  }
}

const ref: DaprRef = {
  v: 1,
  store: 'blobs',
  key: 'workflow-payloads/a b/c',
  size: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
}

describe('useBinaryFile', () => {
  it('does not fetch while disabled', async () => {
    let calls = 0
    server.use(http.get('/api/apps/:app/binarystore/:store/file', () => { calls++; return new HttpResponse('x') }))
    renderHook(() => useBinaryFile('app1', ref, false), { wrapper: makeWrapper() })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })

  it('fetches once with the exact encoded URL and verifies the payload', async () => {
    const seen: string[] = []
    server.use(
      http.get('/api/apps/:app/binarystore/:store/file', ({ request }) => {
        seen.push(request.url)
        return new HttpResponse('hello', { headers: { 'Content-Type': 'application/octet-stream' } })
      }),
    )
    const { result } = renderHook(() => useBinaryFile('app 1', ref, true), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('/api/apps/app%201/binarystore/blobs/file?key=workflow-payloads%2Fa%20b%2Fc&size=5')
    expect(result.current.data).toEqual({ content: { kind: 'text', text: 'hello' }, integrity: 'verified' })
  })

  it('refetches when only the sha256 differs (hash is part of the cache key)', async () => {
    let calls = 0
    server.use(
      http.get('/api/apps/:app/binarystore/:store/file', () => {
        calls++
        return new HttpResponse('hello', { headers: { 'Content-Type': 'application/octet-stream' } })
      }),
    )
    const wrapper = makeWrapper()
    const other: DaprRef = { ...ref, sha256: 'f'.repeat(64) }
    const { result, rerender } = renderHook(({ r }) => useBinaryFile('app1', r, true), {
      wrapper,
      initialProps: { r: ref },
    })
    await waitFor(() => expect(result.current.data?.integrity).toBe('verified'))
    rerender({ r: other })
    await waitFor(() => expect(result.current.data?.integrity).toBe('mismatch'))
    expect(calls).toBe(2)
    rerender({ r: ref })
    await waitFor(() => expect(result.current.data?.integrity).toBe('verified'))
    expect(calls).toBe(2)
  })

  it('maps a 413 to BinaryFileError with status and size', async () => {
    server.use(
      http.get('/api/apps/:app/binarystore/:store/file', () =>
        HttpResponse.json({ error: 'too large', size: 2000000 }, { status: 413 }),
      ),
    )
    const { result } = renderHook(() => useBinaryFile('app1', ref, true), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    const err = result.current.error
    expect(err).toBeInstanceOf(BinaryFileError)
    expect(err?.status).toBe(413)
    expect(err?.size).toBe(2000000)
    expect(err?.message).toBe('too large')
  })

  it('uses a generic message for an unparseable error body', async () => {
    server.use(
      http.get('/api/apps/:app/binarystore/:store/file', () => new HttpResponse('boom', { status: 502 })),
    )
    const { result } = renderHook(() => useBinaryFile('app1', ref, true), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.status).toBe(502)
    expect(result.current.error?.message).toBe('request failed (502)')
  })
})
