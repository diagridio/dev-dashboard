import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { copyText } from '../lib/clipboard'
import { State } from './State'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

const STORES = [
  {
    id: 's1',
    name: 'statestore',
    type: 'state.redis',
    source: 'auto',
    path: '/c/s.yaml',
    active: true,
    connection: 'localhost:6379',
  },
  {
    id: 's2',
    name: 'other',
    type: 'state.sqlite',
    source: 'manual',
    path: '',
    active: false,
    connection: '/tmp/x.db',
  },
]

const ITEM = {
  key: 'myapp||order-42',
  appId: 'myapp',
  logicalKey: 'order-42',
  kind: 'app' as const,
  preview: '{ "id": 42 }',
  encoding: 'text' as const,
  size: 1284,
  etag: '3',
  ttlExpiresAt: '2026-08-26T14:02:11Z',
}

// A durabletask-history-shaped blob: protobuf framing with readable strings.
const B64 = 'CgwI/LyM02FwaXNlcnZpY2UymQFEaWFnbm9zZVN1YnN5c3RlbUFjdGl2aXR5Gh8='

const B64_ITEM = {
  ...ITEM,
  key: 'apiservice||dapr.internal.default.apiservice.workflow||mission-001||history-00',
  logicalKey: 'dapr.internal.default.apiservice.workflow||mission-001||history-00',
  kind: 'workflow' as const,
  preview: B64,
  encoding: 'base64' as const,
}

function stubApi(overrides?: { items?: unknown[]; nextToken?: string }) {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(STORES)),
    http.get('/api/state/appids', () => HttpResponse.json(['myapp', 'other-app'])),
    http.get('/api/state', () =>
      HttpResponse.json({
        items: overrides?.items ?? [ITEM],
        nextToken: overrides?.nextToken ?? '',
      }),
    ),
  )
}

function renderAt(entry = '/state') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/state', element: <State /> },
      { path: '/components/:name', element: <div>component page</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('State page', () => {
  beforeEach(() => window.localStorage.clear())

  it('renders a record row with key, app, preview, size, version and TTL', async () => {
    stubApi()
    renderAt()
    const cell = await screen.findByText('order-42')
    const row = within(cell.closest('tr') as HTMLElement)
    expect(row.getByText('myapp')).toBeInTheDocument()
    expect(row.getByText('{ "id": 42 }')).toBeInTheDocument()
    expect(row.getByText('1.3 KB')).toBeInTheDocument()
    expect(row.getByText('3')).toBeInTheDocument()
  })

  // The Size column is a fixed 78px, so no value may exceed 7 characters.
  it('keeps large sizes short enough for the fixed-width column', async () => {
    stubApi({ items: [{ ...ITEM, size: 200_000 }] })
    renderAt()
    expect(await screen.findByText('195 KB')).toBeInTheDocument()
  })

  it('lists the store selector and links to the selected store component', async () => {
    stubApi()
    renderAt()
    const select = await screen.findByTestId('store-select')
    expect(select).toHaveValue('s1')
    expect(within(select as HTMLElement).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('link', { name: /statestore component page/i })).toHaveAttribute(
      'href',
      '/components/statestore',
    )
  })

  it('sends the selected app as a query param', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.selectOptions(await screen.findByTestId('app-select'), 'other-app')
    await waitFor(() => expect(seen).toContain('appId=other-app'))
  })

  it('debounces the key search into the query', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.type(screen.getByLabelText('Search key'), 'order')
    await waitFor(() => expect(seen).toContain('search=order'), { timeout: 2000 })
  })

  it('requests internal keys only when the toggle is on', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(seen).not.toContain('includeInternal')
    await userEvent.click(screen.getByLabelText('Show internal keys'))
    await waitFor(() => expect(seen).toContain('includeInternal=true'))
  })

  // A store full of finished workflow apps must not offer a dropdown of
  // prefixes that all yield an empty table.
  it('scopes the app dropdown to the internal-keys toggle', async () => {
    const seen: string[] = []
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state', () => HttpResponse.json({ items: [ITEM] })),
      http.get('/api/state/appids', ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.search)
        return HttpResponse.json(
          url.searchParams.get('includeInternal') === 'true'
            ? ['myapp', 'workflow-only-app']
            : ['myapp'],
        )
      }),
    )
    renderAt()
    await screen.findByText('order-42')

    const appSelect = await screen.findByTestId('app-select')
    await waitFor(() => expect(within(appSelect).getAllByRole('option')).toHaveLength(2))
    expect(within(appSelect).queryByRole('option', { name: 'workflow-only-app' })).toBeNull()

    await userEvent.click(screen.getByLabelText('Show internal keys'))
    await waitFor(() =>
      expect(within(appSelect).queryByRole('option', { name: 'workflow-only-app' })).not.toBeNull(),
    )
    expect(seen.some((s) => s.includes('includeInternal=true'))).toBe(true)
  })

  // Decoding is only meaningful for base64 rows, so the control must not
  // clutter the filter bar of a store that has none.
  describe('base64 decoding', () => {
    it('hides the option when no record on the page is base64', async () => {
      stubApi()
      renderAt()
      await screen.findByText('order-42')
      expect(screen.queryByLabelText('Decode base64')).toBeNull()
    })

    it('offers the option and decodes only the base64 rows', async () => {
      stubApi({ items: [ITEM, B64_ITEM] })
      renderAt()
      await screen.findByText('order-42')

      const toggle = await screen.findByLabelText('Decode base64')
      expect(screen.getByText(B64)).toBeInTheDocument()

      await userEvent.click(toggle)
      await waitFor(() => expect(screen.queryByText(B64)).toBeNull())
      // Unique to the decoded value — "apiservice" alone also appears in the key.
      expect(screen.getByText(/DiagnoseSubsystemActivity/)).toBeInTheDocument()
      // The text row is untouched by decoding.
      expect(screen.getByText('{ "id": 42 }')).toBeInTheDocument()
    })

    it('leaves the raw base64 in place when it will not decode', async () => {
      stubApi({ items: [{ ...B64_ITEM, preview: '!!!!' }] })
      renderAt()
      await userEvent.click(await screen.findByLabelText('Decode base64'))
      expect(screen.getByText('!!!!')).toBeInTheDocument()
    })
  })

  it('marks a non-app record with its kind', async () => {
    stubApi({
      items: [
        {
          ...ITEM,
          key: 'myapp||MyActor||a1||balance',
          logicalKey: 'MyActor||a1||balance',
          kind: 'actor',
        },
      ],
    })
    renderAt()
    expect(await screen.findByText('actor')).toBeInTheDocument()
  })

  it('shows an em dash for a record with no version or TTL', async () => {
    stubApi({ items: [{ ...ITEM, etag: undefined, ttlExpiresAt: undefined }] })
    renderAt()
    const cell = await screen.findByText('order-42')
    const row = within(cell.closest('tr') as HTMLElement)
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('pages forward and back with the cursor token', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json(['myapp'])),
      http.get('/api/state', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        if (page === 'tok') {
          return HttpResponse.json({
            items: [{ ...ITEM, key: 'myapp||order-99', logicalKey: 'order-99' }],
          })
        }
        return HttpResponse.json({ items: [ITEM], nextToken: 'tok' })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(screen.getByText('1–1 loaded')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('order-99')
    expect(screen.getByText('2–2 loaded')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /prev/i }))
    await screen.findByText('order-42')
  })

  it('shows the empty state when the store has no matching records', async () => {
    stubApi({ items: [] })
    renderAt()
    expect(await screen.findByText('No state records found')).toBeInTheDocument()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('keeps the chrome usable and banners a 503 so another store can be picked', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json([])),
      http.get('/api/state', () =>
        HttpResponse.json({ error: 'this state store cannot be browsed' }, { status: 503 }),
      ),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent('cannot be browsed')
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
  })

  // Covers finding 5 of the whole-branch review: the design spec requires the
  // State page to append the secret issue to its error banner (the
  // StateStoreConnectionsPanel half already existed; the page never wired it
  // in), so a user whose selected store is secret-broken sees why, not just
  // a bare "state store unavailable".
  it('appends the selected store secretIssue to the load-error banner', async () => {
    server.use(
      http.get('/api/statestores', () =>
        HttpResponse.json([
          {
            ...STORES[0],
            secretIssue:
              'redisPassword unresolved (key-not-found): no such key: redis-secret',
          },
          STORES[1],
        ]),
      ),
      http.get('/api/state/appids', () => HttpResponse.json([])),
      http.get('/api/state', () =>
        HttpResponse.json({ error: 'this state store cannot be browsed' }, { status: 503 }),
      ),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent('cannot be browsed')
    expect(banner).toHaveTextContent(
      'redisPassword unresolved (key-not-found): no such key: redis-secret',
    )
  })

  it('guides the user when no state store is configured at all', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json([])))
    renderAt()
    expect(await screen.findByText('No state store detected')).toBeInTheDocument()
  })

  it('persists the selected store across mounts', async () => {
    stubApi()
    renderAt()
    await userEvent.selectOptions(await screen.findByTestId('store-select'), 's2')
    await waitFor(() => expect(window.localStorage.getItem('devdash.stateStore')).toBe('s2'))
  })
})

describe('State page record creation', () => {
  beforeEach(() => window.localStorage.clear())

  it('opens a dialog prefilled with the app filter and the store prefixes', async () => {
    stubApi()
    renderAt('/state?app=myapp')
    await screen.findByText('order-42')

    await userEvent.click(screen.getByRole('button', { name: /new record/i }))

    expect(await screen.findByLabelText(/app id/i)).toHaveValue('myapp')
    const listId = screen.getByLabelText(/app id/i).getAttribute('list')
    const suggested = Array.from(
      document.getElementById(listId as string)?.querySelectorAll('option') ?? [],
    ).map((o) => o.value)
    expect(suggested).toEqual(['myapp', 'other-app'])
  })

  it('writes to the selected store and refreshes the table', async () => {
    let body: unknown
    let url = ''
    let created = false
    const NEW_ITEM = { ...ITEM, key: 'myapp||cart-1', logicalKey: 'cart-1', preview: 'hello' }
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json(['myapp'])),
      http.get('/api/state', () =>
        HttpResponse.json({ items: created ? [ITEM, NEW_ITEM] : [ITEM], nextToken: '' }),
      ),
      http.post('/api/state/record', async ({ request }) => {
        url = request.url
        body = await request.json()
        created = true
        return HttpResponse.json({ key: 'myapp||cart-1' }, { status: 201 })
      }),
    )
    renderAt()
    await screen.findByText('order-42')

    await userEvent.click(screen.getByRole('button', { name: /new record/i }))
    await userEvent.type(screen.getByLabelText(/app id/i), 'myapp')
    await userEvent.type(screen.getByLabelText(/^key/i), 'cart-1')
    await userEvent.type(screen.getByLabelText(/^value/i), 'hello')
    await userEvent.click(screen.getByRole('button', { name: /^save$/i }))

    expect(await screen.findByText(/created/i)).toBeInTheDocument()
    expect(url).toContain('store=s1')
    expect(body).toEqual({ appId: 'myapp', key: 'cart-1', value: 'hello', overwrite: false })

    await userEvent.click(screen.getByRole('button', { name: /close/i }))
    // The listing is invalidated by the write, so the new row arrives without a
    // manual refresh.
    expect(await screen.findByText('cart-1')).toBeInTheDocument()
  })

  it('cannot be started while the store is unreadable', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json([])),
      http.get('/api/state', () =>
        HttpResponse.json({ error: 'could not connect to state store' }, { status: 503 }),
      ),
    )
    renderAt()
    await screen.findByTestId('load-error-banner')
    expect(screen.getByRole('button', { name: /new record/i })).toBeDisabled()
  })
})

describe('State page row expansion', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.clearAllMocks()
  })

  const RECORD = {
    key: 'myapp||order-42',
    appId: 'myapp',
    logicalKey: 'order-42',
    kind: 'app' as const,
    value: '{"id":42,"total":19.99}',
    encoding: 'text' as const,
    size: 23,
    truncated: false,
    etag: '3',
  }

  it('fetches and shows the full value when a row is clicked', async () => {
    stubApi()
    let calls = 0
    server.use(
      http.get('/api/state/record', ({ request }) => {
        calls++
        expect(new URL(request.url).searchParams.get('key')).toBe('myapp||order-42')
        return HttpResponse.json(RECORD)
      }),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toHaveTextContent('"total"')
    // The full key, which the table abbreviates, is shown in the panel.
    expect(screen.getByTestId('record-panel')).toHaveTextContent('myapp||order-42')
    expect(calls).toBe(1)
  })

  it('does not fetch any value before a row is expanded', async () => {
    stubApi()
    let calls = 0
    server.use(
      http.get('/api/state/record', () => {
        calls++
        return HttpResponse.json(RECORD)
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(calls).toBe(0)
  })

  it('collapses on a second click and expands only one row at a time', async () => {
    stubApi({
      items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }],
    })
    server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
    renderAt()

    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByText('order-43'))
    await waitFor(() => expect(screen.getAllByTestId('record-panel')).toHaveLength(1))

    await userEvent.click(screen.getByText('order-43'))
    await waitFor(() => expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument())
  })

  it('flags a truncated value', async () => {
    stubApi()
    server.use(
      http.get('/api/state/record', () =>
        HttpResponse.json({ ...RECORD, truncated: true, size: 5_000_000 }),
      ),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByText(/truncated/i)).toBeInTheDocument()
  })

  it('reports a value that could not be loaded without breaking the table', async () => {
    stubApi()
    server.use(
      http.get('/api/state/record', () =>
        HttpResponse.json({ error: 'record not found' }, { status: 404 }),
      ),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByText(/couldn't load this value/i)).toBeInTheDocument()
    expect(screen.getByText('order-42')).toBeInTheDocument()
  })

  it('copies the full value through the shared clipboard helper and toasts', async () => {
    stubApi()
    server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    await screen.findByTestId('record-panel')

    await userEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(copyText).toHaveBeenCalledWith(RECORD.value)
    expect(await screen.findByText('Value copied')).toBeInTheDocument()
  })

  describe('base64 values', () => {
    const B64_RECORD = {
      ...RECORD,
      key: B64_ITEM.key,
      logicalKey: B64_ITEM.logicalKey,
      kind: 'workflow' as const,
      value: B64,
      encoding: 'base64' as const,
    }

    // highlightJson splits its output across spans, so the panel's value is
    // asserted on concatenated textContent rather than a single text node.
    async function expandB64Row() {
      stubApi({ items: [B64_ITEM] })
      server.use(http.get('/api/state/record', () => HttpResponse.json(B64_RECORD)))
      renderAt()
      await userEvent.click(await screen.findByText(B64_ITEM.logicalKey))
      return screen.findByTestId('record-panel')
    }

    const toggle = () => screen.findByLabelText('Decode base64')

    it('shows the raw value until the decode option is on', async () => {
      const panel = await expandB64Row()
      expect(panel).toHaveTextContent(B64)

      await userEvent.click(await toggle())
      await waitFor(() => expect(panel).not.toHaveTextContent(B64))
      expect(panel).toHaveTextContent('DiagnoseSubsystemActivity')
    })

    it('keeps the row expanded when the decode option is toggled', async () => {
      await expandB64Row()
      await userEvent.click(await toggle())
      expect(await screen.findByTestId('record-panel')).toBeInTheDocument()
    })

    // The decoded rendering is lossy — unprintable bytes became placeholders —
    // so copying it would hand over something that is not the stored value.
    it('copies the raw value even while the decoded view is shown', async () => {
      const panel = await expandB64Row()
      await userEvent.click(await toggle())

      await userEvent.click(within(panel).getByRole('button', { name: /copy raw/i }))
      expect(copyText).toHaveBeenCalledWith(B64)
    })

    it('notes the decoding in the panel metadata', async () => {
      const panel = await expandB64Row()
      await userEvent.click(await toggle())
      await waitFor(() => expect(panel).toHaveTextContent(/decoded/i))
    })

    it('leaves a text value alone when the decode option is on', async () => {
      stubApi({ items: [ITEM, B64_ITEM] })
      server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
      renderAt()
      await screen.findByText('order-42')
      await userEvent.click(await toggle())
      await userEvent.click(screen.getByText('order-42'))

      const panel = await screen.findByTestId('record-panel')
      expect(panel).toHaveTextContent('"total"')
      expect(panel).not.toHaveTextContent(/decoded/i)
      expect(within(panel).getByRole('button', { name: '⧉ Copy' })).toBeInTheDocument()
    })
  })

  it('collapses the expanded row when a filter changes', async () => {
    stubApi()
    server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Show internal keys'))
    await waitFor(() => expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument())
  })
})

describe('State page deletion', () => {
  beforeEach(() => window.localStorage.clear())

  // ConfirmDialog marks its confirm button with data-cy, not data-testid, so
  // the suite reaches it the same way the Workflows tests do.
  const confirmButton = () =>
    document.querySelector('[data-cy="confirm-delete-state"]') as HTMLElement

  it('selects rows and posts the selected keys', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    let body: unknown = null
    server.use(
      http.post('/api/state/delete', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json([
          { key: 'myapp||order-42', ok: true },
          { key: 'myapp||order-43', ok: true },
        ])
      }),
    )
    renderAt()
    await screen.findByText('order-42')

    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByLabelText('Select myapp||order-43'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await waitFor(() => expect(confirmButton()).toBeInTheDocument())
    await userEvent.click(confirmButton())

    await waitFor(() => expect(body).toEqual({ keys: ['myapp||order-42', 'myapp||order-43'] }))
    expect(await screen.findByText(/deleted 2 records/i)).toBeInTheDocument()
  })

  it('select-all toggles every row on the page', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select all'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Select all'))
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  it('reports a partial failure', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    server.use(
      http.post('/api/state/delete', () =>
        HttpResponse.json([
          { key: 'myapp||order-42', ok: true },
          { key: 'myapp||order-43', ok: false, error: 'boom' },
        ]),
      ),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select all'))
    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await waitFor(() => expect(confirmButton()).toBeInTheDocument())
    await userEvent.click(confirmButton())
    expect(await screen.findByText(/deleted 1 record, 1 failed/i)).toBeInTheDocument()
  })

  it('cancelling the dialog deletes nothing', async () => {
    stubApi()
    let called = false
    server.use(
      http.post('/api/state/delete', () => {
        called = true
        return HttpResponse.json([])
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(called).toBe(false)
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('clicking a checkbox does not expand the row', async () => {
    stubApi()
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument()
  })

  it('clears the selection when the page changes', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json(['myapp'])),
      http.get('/api/state', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        if (page === 'tok') {
          return HttpResponse.json({ items: [{ ...ITEM, key: 'myapp||o99', logicalKey: 'o99' }] })
        }
        return HttpResponse.json({ items: [ITEM], nextToken: 'tok' })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('o99')
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })
})
