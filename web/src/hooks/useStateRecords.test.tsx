import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useStateRecords, useStateRecord, useStateAppIds } from './useStateRecords'

// One client for the file, built outside the wrapper: a wrapper that constructs
// its own client per render would remount the provider on every state change
// and refetch forever.
const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryProvider client={client}>
      <RefreshProvider>{children}</RefreshProvider>
    </QueryProvider>
  )
}

describe('useStateRecords', () => {
  it('sends app, search, page, store and includeInternal as query params', async () => {
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [], nextToken: '' })
      }),
    )
    renderHook(
      () =>
        useStateRecords({
          appId: 'myapp',
          search: 'order',
          page: 'tok',
          store: 'store-1',
          includeInternal: true,
        }),
      { wrapper },
    )
    await waitFor(() => expect(seen).toContain('appId=myapp'))
    expect(seen).toContain('search=order')
    expect(seen).toContain('page=tok')
    expect(seen).toContain('store=store-1')
    expect(seen).toContain('includeInternal=true')
  })

  it('omits includeInternal when false', async () => {
    let seen = 'unset'
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [] })
      }),
    )
    renderHook(() => useStateRecords({ includeInternal: false }), { wrapper })
    await waitFor(() => expect(seen).not.toBe('unset'))
    expect(seen).not.toContain('includeInternal')
  })

  it('does not fetch while disabled', async () => {
    let calls = 0
    server.use(
      http.get('/api/state', () => {
        calls++
        return HttpResponse.json({ items: [] })
      }),
    )
    renderHook(() => useStateRecords({ enabled: false, search: 'never-fetched' }), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })
})

describe('useStateRecord', () => {
  it('encodes a key containing the || delimiter', async () => {
    let seen = ''
    server.use(
      http.get('/api/state/record', ({ request }) => {
        seen = new URL(request.url).searchParams.get('key') ?? ''
        return HttpResponse.json({
          key: seen,
          value: '{}',
          encoding: 'text',
          size: 2,
          truncated: false,
        })
      }),
    )
    const { result } = renderHook(() => useStateRecord('myapp||order-1', 'store-1', true), {
      wrapper,
    })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(seen).toBe('myapp||order-1')
  })

  it('stays idle until enabled', async () => {
    let calls = 0
    server.use(
      http.get('/api/state/record', () => {
        calls++
        return HttpResponse.json({ key: 'k', value: '', encoding: 'text', size: 0, truncated: false })
      }),
    )
    renderHook(() => useStateRecord('k', undefined, false), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })
})

describe('useStateAppIds', () => {
  it('fetches the store-scoped app id list', async () => {
    server.use(http.get('/api/state/appids', () => HttpResponse.json(['alpha', 'zeta'])))
    const { result } = renderHook(() => useStateAppIds({ store: 's1' }), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(['alpha', 'zeta']))
  })

  // The prefix list has to be scoped by the same filter as the table, or the
  // dropdown offers apps whose every record is hidden.
  it('sends includeInternal only when set, and keys the cache on it', async () => {
    const seen: string[] = []
    server.use(
      http.get('/api/state/appids', ({ request }) => {
        seen.push(new URL(request.url).search)
        return HttpResponse.json(['alpha'])
      }),
    )
    const { result } = renderHook(() => useStateAppIds({ store: 's9' }), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(seen[0]).not.toContain('includeInternal')

    const wide = renderHook(() => useStateAppIds({ store: 's9', includeInternal: true }), {
      wrapper,
    })
    await waitFor(() => expect(wide.result.current.data).toBeDefined())
    expect(seen.some((s) => s.includes('includeInternal=true'))).toBe(true)
    expect(seen.length).toBe(2)
  })
})
