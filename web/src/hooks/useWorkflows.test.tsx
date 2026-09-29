import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse, delay } from 'msw'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useWorkflows, useWorkflowStats, STATS_MIN_REFETCH_MS } from './useWorkflows'

function Probe() {
  const { data } = useWorkflows({ status: ['Running'], search: 'ab' })
  return <div>{data?.items.map((w) => <span key={w.instanceId}>{w.instanceId}</span>)}</div>
}

function ProbeWithStore() {
  const { data } = useWorkflows({ status: ['Running'], store: 'postgres' })
  return <div>{data?.items.map((w) => <span key={w.instanceId}>{w.instanceId}</span>)}</div>
}

describe('useWorkflows', () => {
  it('lists workflows with filter params', async () => {
    server.use(http.get('/api/workflows', ({ request }) => {
      const url = new URL(request.url)
      expect(url.searchParams.get('status')).toBe('Running')
      expect(url.searchParams.get('search')).toBe('ab')
      return HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'W', status: 'Running' }] })
    }))
    render(<QueryProvider><RefreshProvider><Probe /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('abc')).toBeInTheDocument())
  })

  it('passes store param in the request query string', async () => {
    let capturedStore: string | null = null
    server.use(http.get('/api/workflows', ({ request }) => {
      const url = new URL(request.url)
      capturedStore = url.searchParams.get('store')
      return HttpResponse.json({ items: [{ appId: 'order', instanceId: 'xyz', name: 'W', status: 'Running' }] })
    }))
    render(<QueryProvider><RefreshProvider><ProbeWithStore /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('xyz')).toBeInTheDocument())
    expect(capturedStore).toBe('postgres')
  })
})

function StatsProbe() {
  const { data } = useWorkflowStats({ appId: 'order', search: 'ab' })
  return <div>total:{data?.total ?? '-'} running:{data?.counts.Running ?? '-'}</div>
}

describe('useWorkflowStats', () => {
  it('requests /workflows/stats with appId and search but no status', async () => {
    server.use(http.get('/api/workflows/stats', ({ request }) => {
      const url = new URL(request.url)
      expect(url.searchParams.get('appId')).toBe('order')
      expect(url.searchParams.get('search')).toBe('ab')
      expect(url.searchParams.get('status')).toBeNull()
      return HttpResponse.json({ counts: { Running: 2, Completed: 1 }, total: 3 })
    }))
    render(<QueryProvider><RefreshProvider><StatsProbe /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('total:3 running:2')).toBeInTheDocument())
  })
})

function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
}

function ListProbe({ store, search }: { store: string; search?: string }) {
  const { data, isPlaceholderData } = useWorkflows({ store, search })
  return (
    <div>
      {data?.items.map((w) => <span key={w.instanceId}>{w.instanceId}</span>)}
      {isPlaceholderData && <span>placeholder</span>}
    </div>
  )
}

describe('useWorkflows loading behaviour', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes an AbortSignal to fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    render(<QueryProvider client={freshClient()}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const init = spy.mock.calls[0][1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps previous rows while a new filter loads in the same store', async () => {
    server.use(http.get('/api/workflows', async ({ request }) => {
      const search = new URL(request.url).searchParams.get('search')
      if (search === 'b') {
        await delay(150)
        return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'row-b', name: 'W', status: 'Running' }] })
      }
      return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'row-a', name: 'W', status: 'Running' }] })
    }))
    const client = freshClient()
    const { rerender } = render(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await screen.findByText('row-a')
    rerender(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" search="b" /></RefreshProvider></QueryProvider>)
    expect(screen.getByText('row-a')).toBeInTheDocument()
    expect(screen.getByText('placeholder')).toBeInTheDocument()
    await screen.findByText('row-b')
    expect(screen.queryByText('placeholder')).not.toBeInTheDocument()
  })

  it('never shows the previous store rows after a store switch', async () => {
    server.use(http.get('/api/workflows', async ({ request }) => {
      const store = new URL(request.url).searchParams.get('store')
      if (store === 's2') {
        await delay(150)
        return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'from-s2', name: 'W', status: 'Running' }] })
      }
      return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'from-s1', name: 'W', status: 'Running' }] })
    }))
    const client = freshClient()
    const { rerender } = render(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await screen.findByText('from-s1')
    rerender(<QueryProvider client={client}><RefreshProvider><ListProbe store="s2" /></RefreshProvider></QueryProvider>)
    expect(screen.queryByText('from-s1')).not.toBeInTheDocument()
    await screen.findByText('from-s2')
  })
})

describe('useWorkflowStats cadence', () => {
  it('exports a 10s floor for stats polling', () => {
    expect(STATS_MIN_REFETCH_MS).toBe(10_000)
  })
})
