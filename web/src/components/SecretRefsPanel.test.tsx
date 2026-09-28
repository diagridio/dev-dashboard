import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SecretRefsPanel } from './SecretRefsPanel'
import type { SecretRefStatus } from '../types/resources'

const resolved: SecretRefStatus = {
  field: 'redisPassword', kind: 'secretKeyRef', store: 'localsecretstore',
  name: 'redis:password', status: 'resolved', detail: 'secrets file /tmp/secrets.json',
}
const missing: SecretRefStatus = {
  field: 'apiKey', kind: 'secretKeyRef', store: 'localsecretstore',
  name: 'absent', status: 'key-not-found', detail: 'secrets file /tmp/secrets.json',
}

// SecretRefsPanel's header links to the secret store's own component page
// (<Link>), so every render needs a router context.
function renderPanel(refs: SecretRefStatus[]) {
  return render(
    <MemoryRouter>
      <SecretRefsPanel resourceId="abc" refs={refs} />
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ value: 's3cr3t' }), { status: 200 })))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  delete window.__DASH_CAPABILITIES__
})

describe('SecretRefsPanel', () => {
  it('masks resolved values and names the store', () => {
    renderPanel([resolved])
    expect(screen.getByText('redisPassword')).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    // The store name appears twice by design: once as the header's link to the
    // store's own component page, once in the row's "store → key" reference.
    const link = screen.getByRole('link', { name: 'localsecretstore' })
    expect(link).toHaveAttribute('href', '/components/localsecretstore')
    expect(screen.getAllByText(/localsecretstore/).length).toBe(2)
    expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument()
  })

  it('shows an env-backed ref without a status pill or reveal', () => {
    const { container } = renderPanel([{
      field: 'connectionString', kind: 'secretKeyRef', store: 'secretstore',
      name: 'POSTGRESQLCONNECTION', status: 'not-checked',
      detail: "read by daprd from its own environment, which the dashboard can't see",
    }])
    expect(screen.getByText('connectionString')).toBeInTheDocument()
    expect(screen.getByText('secretstore → POSTGRESQLCONNECTION')).toBeInTheDocument()
    expect(screen.getByText(/read by daprd from its own environment/)).toBeInTheDocument()
    expect(container.querySelector('[data-cy="secret-status-pill"]')).toBeNull()
    expect(screen.queryByText(/not checked/i)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
    expect(screen.queryByText('••••••••')).not.toBeInTheDocument()
  })

  it('shows the failure detail for an unresolved ref', () => {
    renderPanel([missing])
    expect(screen.getByText('KEY NOT FOUND')).toBeInTheDocument()
    expect(screen.getByText(/secrets file \/tmp\/secrets.json/)).toBeInTheDocument()
  })

  it('reveals a value on demand and re-masks it after 30 seconds', async () => {
    // shouldAdvanceTime: true lets waitFor's real-time polling loop keep ticking
    // under fake timers (this repo has no `jest` global for @testing-library/dom's
    // fake-timer auto-detection, so a bare vi.useFakeTimers() deadlocks waitFor).
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderPanel([resolved])

    await user.click(screen.getByRole('button', { name: /reveal redisPassword/i }))
    await waitFor(() => expect(screen.getByText('s3cr3t')).toBeInTheDocument())

    vi.advanceTimersByTime(30_000)
    await waitFor(() => expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument())
    expect(screen.getByText('••••••••')).toBeInTheDocument()
  })

  it('offers no reveal control for an unresolved ref', () => {
    renderPanel([missing])
    expect(screen.queryByRole('button', { name: /reveal/i })).not.toBeInTheDocument()
  })

  it('disables reveal when the server has it switched off', () => {
    // NOTE: the brief's original test used vi.stubGlobal('window', Object.assign(window, {...})),
    // but that MUTATES the real window object, so vi.unstubAllGlobals() cannot undo it and the
    // flag would leak into later tests in this file. Assigning the property directly (and
    // deleting it in afterEach above) gets the same effect without the leak.
    window.__DASH_CAPABILITIES__ = { lifecycle: true, controlPlane: true, logs: true, workflows: true, secretReveal: false }
    renderPanel([resolved])
    expect(screen.getByRole('button', { name: /reveal redisPassword/i })).toBeDisabled()
  })

  it('shows an inline error and no value when reveal comes back 403 (served off-host)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 })))
    const user = userEvent.setup()
    renderPanel([resolved])

    await user.click(screen.getByRole('button', { name: /reveal redisPassword/i }))

    await waitFor(() => expect(screen.getByText(/could not reveal/i)).toBeInTheDocument())
    expect(screen.getByText(/off-host/i)).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument()
  })

  it('shows an inline error and no value when reveal comes back 404 (stale resolution)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 })))
    const user = userEvent.setup()
    renderPanel([resolved])

    await user.click(screen.getByRole('button', { name: /reveal redisPassword/i }))

    await waitFor(() => expect(screen.getByText(/could not reveal/i)).toBeInTheDocument())
    expect(screen.getByText(/no resolved value/i)).toBeInTheDocument()
    expect(screen.getByText('••••••••')).toBeInTheDocument()
    expect(screen.queryByText('s3cr3t')).not.toBeInTheDocument()
  })
})
