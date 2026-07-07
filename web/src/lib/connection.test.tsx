import { render, screen, waitFor, act } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { onlineManager, type QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from './query'
import { RefreshProvider } from './refresh'
import { ConnectionProvider, useConnection, healthPollMs } from './connection'

function Probe() {
  const { online } = useConnection()
  return <div data-testid="conn-probe">{online ? 'online' : 'offline'}</div>
}

// retryDelay 0 keeps the fail-retry-fail cycle fast; the retry count (1)
// matches the production client, so "two consecutive failures" still holds.
function makeTestClient(): QueryClient {
  const client = makeQueryClient()
  client.setDefaultOptions({ queries: { retry: 1, retryDelay: 0 } })
  return client
}

function renderWithProviders(client: QueryClient) {
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <ConnectionProvider>
          <Probe />
        </ConnectionProvider>
      </RefreshProvider>
    </QueryProvider>,
  )
}

afterEach(() => {
  // ConnectionProvider mirrors state into the module-global onlineManager;
  // reset so a test that ended offline cannot leak into later tests.
  onlineManager.setOnline(true)
})

describe('healthPollMs', () => {
  it('follows the refresh interval when live', () => {
    expect(healthPollMs({ intervalMs: 3000, paused: false })).toBe(3000)
  })

  it('falls back to 30s when paused', () => {
    expect(healthPollMs({ intervalMs: 3000, paused: true })).toBe(30_000)
  })

  it('falls back to 30s when the interval is Off', () => {
    expect(healthPollMs({ intervalMs: 0, paused: false })).toBe(30_000)
  })
})

describe('ConnectionProvider', () => {
  it('is online initially (optimistic) and stays online while /api/health succeeds', async () => {
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok' })))
    const client = makeTestClient()
    renderWithProviders(client)
    // Before the first response settles the state is optimistic, not offline.
    expect(screen.getByTestId('conn-probe')).toHaveTextContent('online')
    await waitFor(() => expect(client.getQueryState(['health'])?.status).toBe('success'))
    expect(screen.getByTestId('conn-probe')).toHaveTextContent('online')
    expect(onlineManager.isOnline()).toBe(true)
  })

  it('flips offline after two consecutive failed checks (initial + retry)', async () => {
    let calls = 0
    server.use(
      http.get('/api/health', () => {
        calls++
        return new HttpResponse(null, { status: 500 })
      }),
    )
    renderWithProviders(makeTestClient())
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('offline'),
    )
    expect(calls).toBe(2)
    expect(onlineManager.isOnline()).toBe(false)
  })

  it('recovers to online on the next successful check', async () => {
    server.use(http.get('/api/health', () => new HttpResponse(null, { status: 500 })))
    const client = makeTestClient()
    renderWithProviders(client)
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('offline'),
    )

    // Later server.use handlers take precedence within a test.
    server.use(http.get('/api/health', () => HttpResponse.json({ status: 'ok' })))
    // Stand in for the next interval tick — force the health refetch now.
    await act(async () => {
      await client.refetchQueries({ queryKey: ['health'] })
    })
    await waitFor(() =>
      expect(screen.getByTestId('conn-probe')).toHaveTextContent('online'),
    )
    expect(onlineManager.isOnline()).toBe(true)
  })
})
