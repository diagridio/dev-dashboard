import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useVersion, useHealth } from './useMeta'

// Wrap hooks in a fresh QueryProvider each test to avoid cross-test cache contamination
function makeWrapper() {
  const client = makeQueryClient()
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryProvider client={client}>{children}</QueryProvider>
  }
  return Wrapper
}

describe('useVersion', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/version', () =>
        HttpResponse.json({ version: '1.2.3', commit: 'abc123', date: '2024-01-01' }),
      ),
    )
  })

  it('returns version info from /api/version', async () => {
    const { result } = renderHook(() => useVersion(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({
      version: '1.2.3',
      commit: 'abc123',
      date: '2024-01-01',
    })
  })

  it('starts in a pending state', () => {
    const { result } = renderHook(() => useVersion(), { wrapper: makeWrapper() })
    expect(result.current.isPending).toBe(true)
  })
})

describe('useHealth', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/health', () =>
        HttpResponse.json({ status: 'ok' }),
      ),
    )
  })

  it('returns health status from /api/health', async () => {
    const { result } = renderHook(() => useHealth(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({ status: 'ok' })
  })
})
