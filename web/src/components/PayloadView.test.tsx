import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { PayloadView } from './PayloadView'

// sha256("{\"a\":1}")
async function sha(text: string) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join('')
}

function envelope(o: Record<string, unknown> = {}) {
  return JSON.stringify({
    $daprRef: { v: 1, store: 'blobs', key: 'k/1', size: 131072, sha256: 'a'.repeat(64), ...o },
  })
}

let fileCalls = 0
function mockApps(running: boolean) {
  server.use(
    http.get('/api/apps', () =>
      HttpResponse.json(running ? [{ appId: 'orders', instanceKey: 'orders-key', health: 'healthy', runtime: 'x' }] : []),
    ),
  )
}
function mockFile(body: string | (() => Response)) {
  fileCalls = 0
  server.use(
    http.get('/api/apps/:app/binarystore/:store/file', () => {
      fileCalls++
      return typeof body === 'string' ? new HttpResponse(body) : body()
    }),
  )
}

function renderView(value: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <PayloadView value={value} appId="orders" />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('PayloadView', () => {
  it('renders plain JSON highlighted without a card', () => {
    mockApps(true)
    const { container } = renderView('{"name":"x"}')
    expect(container.querySelector('pre.json')).not.toBeNull()
    expect(screen.queryByText('Stored in binary store')).toBeNull()
  })

  it('renders the reference card with an enabled Load button', async () => {
    mockApps(true)
    renderView(envelope())
    expect(screen.getByText('Stored in binary store')).toBeInTheDocument()
    expect(screen.getByText('blobs')).toBeInTheDocument()
    expect(screen.getByText('k/1')).toBeInTheDocument()
    expect(screen.getByText('128.0 KiB')).toHaveAttribute('title', '131072 bytes')
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load payload' })).toBeEnabled())
  })

  it('disables Load when the app is not running', async () => {
    mockApps(false)
    mockFile('x')
    renderView(envelope())
    expect(await screen.findByText('Start orders to load this payload')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load payload' })).toBeDisabled()
    expect(fileCalls).toBe(0)
  })

  it('disables Load for staged payloads', async () => {
    mockApps(true)
    mockFile('x')
    renderView(envelope({ stages: [{ n: 'gzip' }, { n: 'aes' }] }))
    expect(screen.getByText('staged payloads (gzip, aes) are not supported')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load payload' })).toBeDisabled()
    expect(fileCalls).toBe(0)
  })

  it('disables Load when declared size is over the limit', async () => {
    mockApps(true)
    mockFile('x')
    renderView(envelope({ size: 2097152 }))
    expect(screen.getByText('Payload is 2.0 MiB — too large to show here (limit 1 MiB)')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load payload' })).toBeDisabled()
    expect(fileCalls).toBe(0)
  })

  it('loads, verifies, hides and reloads from cache', async () => {
    const body = '{"a":1}'
    mockApps(true)
    mockFile(body)
    renderView(envelope({ size: body.length, sha256: await sha(body) }))
    const user = userEvent.setup()
    const load = await waitFor(() => {
      const b = screen.getByRole('button', { name: 'Load payload' })
      expect(b).toBeEnabled()
      return b
    })
    await user.click(load)
    expect(await screen.findByText('verified')).toBeInTheDocument()
    expect(document.querySelector('pre.json')).not.toBeNull()
    await user.click(screen.getByRole('button', { name: 'Hide' }))
    expect(screen.getByText('Stored in binary store')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Load payload' }))
    expect(await screen.findByText('verified')).toBeInTheDocument()
    expect(fileCalls).toBe(1)
  })

  it('shows hash mismatch and binary placeholder', async () => {
    mockApps(true)
    server.use(
      http.get('/api/apps/:app/binarystore/:store/file', () => new HttpResponse(new Uint8Array([0xff, 0xfe, 0x00]))),
    )
    renderView(envelope())
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load payload' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Load payload' }))
    expect(await screen.findByText('hash mismatch')).toBeInTheDocument()
    expect(screen.getByText('Binary payload (3 bytes) — not shown')).toBeInTheDocument()
  })

  it('shows server errors with Retry that refetches', async () => {
    mockApps(true)
    mockFile(() => HttpResponse.json({ error: 'file not found in payloads' }, { status: 404 }))
    renderView(envelope())
    const user = userEvent.setup()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Load payload' })).toBeEnabled())
    await user.click(screen.getByRole('button', { name: 'Load payload' }))
    expect(await screen.findByText('file not found in payloads')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(fileCalls).toBe(2))
  })

  it('shows invalid references as raw text with a note', () => {
    mockApps(true)
    const raw = JSON.stringify({ $daprRef: { v: 2, store: 's', key: 'k', size: 1, sha256: 'a'.repeat(64) } })
    const { container } = renderView(raw)
    expect(screen.getByText(/Invalid data reference:/)).toBeInTheDocument()
    expect(container.querySelector('pre.json')).not.toBeNull()
  })
})
