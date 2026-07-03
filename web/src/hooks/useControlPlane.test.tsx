import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { RefreshProvider } from '../lib/refresh'
import { useControlPlane } from './useControlPlane'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return (
    <QueryClientProvider client={qc}>
      <RefreshProvider>{children}</RefreshProvider>
    </QueryClientProvider>
  )
}

describe('useControlPlane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ runtime: 'docker', available: true, services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('fetches the control plane list', async () => {
    const { result } = renderHook(() => useControlPlane(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.services[0].name).toBe('dapr_scheduler')
  })
})
