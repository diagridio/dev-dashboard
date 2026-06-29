import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useWorkflows, useWorkflowStats } from './useWorkflows'

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
