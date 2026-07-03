import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useRemoveWorkflows } from './useWorkflowRemoval'

describe('useRemoveWorkflows', () => {
  it('posts bulk purge', async () => {
    server.use(http.post('/api/workflows/purge', async ({ request }) => {
      const body = await request.json() as { force: boolean; ids: { appId: string; instanceId: string }[] }
      expect(body.force).toBe(true)
      expect(body.ids).toHaveLength(1)
      return HttpResponse.json([{ instanceId: 'a', mechanism: 'force', ok: true }])
    }))
    const { result } = renderHook(() => useRemoveWorkflows(), { wrapper: ({ children }) => <QueryProvider>{children}</QueryProvider> })
    result.current.mutate({ ids: [{ appId: 'o', instanceId: 'a' }], force: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.[0].ok).toBe(true)
  })

  it('invalidates list, detail, stats and app-id queries on success', async () => {
    server.use(http.post('/api/workflows/purge', () =>
      HttpResponse.json([{ instanceId: 'a', mechanism: 'purge', ok: true }]),
    ))
    const client = makeQueryClient()
    const spy = vi.spyOn(client, 'invalidateQueries')
    const { result } = renderHook(() => useRemoveWorkflows(), {
      wrapper: ({ children }) => <QueryProvider client={client}>{children}</QueryProvider>,
    })
    result.current.mutate({ ids: [{ appId: 'o', instanceId: 'a' }], force: false })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    const keys = spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0])
    // Counts (stats) and the app filter (appids) go stale after removal too —
    // with auto-refresh paused they'd otherwise never catch up.
    expect(keys).toEqual(
      expect.arrayContaining(['workflows', 'workflow', 'workflow-stats', 'workflow-appids']),
    )
  })
})
