import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useVersion, useUpdateCheck } from './useMeta'

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

describe('useUpdateCheck', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/update-check', () =>
        HttpResponse.json({
          current: 'v1.2.0',
          latest: 'v1.3.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
        }),
      ),
    )
  })

  it('returns update info from /api/update-check', async () => {
    const { result } = renderHook(() => useUpdateCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({
      current: 'v1.2.0',
      latest: 'v1.3.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
    })
  })
})
