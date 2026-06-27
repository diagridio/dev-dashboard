import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useWorkflows } from './useWorkflows'

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
