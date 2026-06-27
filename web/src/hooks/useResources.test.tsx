import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useActors } from './useResources'

function Probe({ appId }: { appId?: string }) {
  const { data } = useActors(appId)
  return <div>{data?.map((a) => <span key={a.appId + a.type}>{a.type}</span>)}</div>
}

describe('useActors', () => {
  it('lists actors and passes appId filter', async () => {
    server.use(http.get('/api/actors', ({ request }) => {
      expect(new URL(request.url).searchParams.get('appId')).toBe('order')
      return HttpResponse.json([{ appId: 'order', type: 'OrderActor', count: 2 }])
    }))
    render(<QueryProvider><RefreshProvider><Probe appId="order" /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('OrderActor')).toBeInTheDocument())
  })
})
