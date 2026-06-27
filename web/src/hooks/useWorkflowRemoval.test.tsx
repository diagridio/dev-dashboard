import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
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
})
