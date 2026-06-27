import { renderHook, waitFor } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { useNews } from './useNews'
import type { NewsResponse } from '../types/logs'

function makeWrapper() {
  const client = makeQueryClient()
  function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryProvider client={client}>{children}</QueryProvider>
  }
  return Wrapper
}

const mockNews: NewsResponse = {
  blog: { title: 'Hello Blog', url: 'https://example.com/blog' },
  report: null,
  webinar: { title: 'Hello Webinar', url: 'https://example.com/webinar' },
  event: null,
}

describe('useNews', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/news', () => HttpResponse.json(mockNews)),
    )
  })

  it('returns news data from /api/news', async () => {
    const { result } = renderHook(() => useNews(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data!.blog!.title).toBe('Hello Blog')
  })
})
