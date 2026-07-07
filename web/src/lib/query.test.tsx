/**
 * Tests for makeQueryClient() — specifically that mutations use
 * networkMode: 'always' so they fail fast instead of queuing when
 * ConnectionProvider has flagged the backend offline via onlineManager.
 *
 * A paused mutation is silent and potentially dangerous: a "purge workflow"
 * action queued while the backend is down could execute minutes later on
 * recovery without the user expecting it.
 */
import { renderHook, waitFor, act } from '@testing-library/react'
import { describe, it, expect, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { onlineManager, useMutation } from '@tanstack/react-query'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from './query'

afterEach(() => {
  // ConnectionProvider mirrors state into the module-global onlineManager;
  // reset so a test that ended offline cannot leak into subsequent tests.
  onlineManager.setOnline(true)
})

describe('makeQueryClient mutations default', () => {
  it('fails fast (isError) instead of pausing (isPaused) when onlineManager is offline', async () => {
    // Arrange: backend reports an error on this endpoint.
    server.use(http.post('/api/whatever', () => new HttpResponse(null, { status: 500 })))

    // Build a client whose mutations default is under test — do NOT override
    // networkMode here; we want makeQueryClient()'s own default to apply.
    const client = makeQueryClient()
    function Wrapper({ children }: { children: ReactNode }) {
      return <QueryProvider client={client}>{children}</QueryProvider>
    }

    const { result } = renderHook(
      () =>
        useMutation({
          mutationFn: async () => {
            const res = await fetch('/api/whatever', { method: 'POST' })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            return res.json()
          },
        }),
      { wrapper: Wrapper },
    )

    // Simulate ConnectionProvider marking the backend offline and trigger the mutation.
    act(() => {
      onlineManager.setOnline(false)
      result.current.mutate({})
    })

    // With networkMode: 'always', the mutation should run immediately and
    // end in isError (the fetch throws), NOT sit in isPaused.
    await waitFor(
      () => {
        expect(result.current.isError).toBe(true)
      },
      { timeout: 3000 },
    )

    // Confirm it never entered isPaused.
    expect(result.current.isPaused).toBe(false)
  })

  it('does not pause mutations while offline — networkMode always is set on makeQueryClient', () => {
    // Structural assertion: verify that makeQueryClient bakes in the default
    // rather than relying on call-site overrides.
    const client = makeQueryClient()
    const defaults = client.getDefaultOptions()
    expect(defaults.mutations?.networkMode).toBe('always')
  })
})

// Sanity: the existing query default (retry: 1) is still present.
describe('makeQueryClient queries default', () => {
  it('keeps retry: 1 for queries', () => {
    const client = makeQueryClient()
    const defaults = client.getDefaultOptions()
    expect(defaults.queries?.retry).toBe(1)
  })
})
