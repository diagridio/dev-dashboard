import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse, delay } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Subscriptions } from './Subscriptions'

function renderAt(entry = '/subscriptions') {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: 0, staleTime: 0 } },
  })
  const router = createMemoryRouter(
    [
      { path: '/subscriptions', element: <Subscriptions /> },
      { path: '/apps/:appId', element: <div>app detail</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return { router, ...render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )}
}

describe('Subscriptions', () => {
  it('renders a row with topic, pub/sub, route, and app-id link', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [{ match: '', path: '/orders' }],
            type: 'programmatic',
          },
        ]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
    const row = within(link.closest('tr') as HTMLElement)
    expect(row.getByText('orders')).toBeInTheDocument()
    expect(row.getByText('pubsub')).toBeInTheDocument()
    expect(row.getByText('/orders')).toBeInTheDocument()
    // programmatic type badge is shown
    expect(row.getByText('programmatic')).toBeInTheDocument()
  })

  it('shows a rules badge when subscription has more than one rule', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [
              { match: 'event.type == "A"', path: '/orders/a' },
              { match: 'event.type == "B"', path: '/orders/b' },
            ],
          },
        ]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    expect(screen.getByText(/2 rules/i)).toBeInTheDocument()
  })

  it('renders dead-letter topic when present', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [{ match: '', path: '/orders' }],
            deadLetterTopic: 'orders-dlq',
          },
        ]),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    const row = within(link.closest('tr') as HTMLElement)
    expect(row.getByText('orders-dlq')).toBeInTheDocument()
  })

  it('does not render a Scopes column', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([{ appId: 'order', pubsubName: 'pubsub', topic: 'orders' }]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    expect(screen.queryByRole('columnheader', { name: /scopes/i })).not.toBeInTheDocument()
  })

  it('expands multi-rule subscriptions to show match/path', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [
              { match: 'event.type == "A"', path: '/orders/a' },
              { match: 'event.type == "B"', path: '/orders/b' },
            ],
          },
        ]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    const badge = screen.getByRole('button', { name: /2 rules/i })
    await userEvent.click(badge)
    expect(await screen.findByText('event.type == "A"')).toBeInTheDocument()
    expect(screen.getByText('/orders/b')).toBeInTheDocument()
  })

  it('shows friendly empty state when no subscriptions exist', async () => {
    server.use(
      http.get('/api/subscriptions', () => HttpResponse.json([])),
    )
    renderAt()
    await waitFor(() =>
      expect(screen.getByText(/no subscriptions/i)).toBeInTheDocument(),
    )
  })

  it('shows filter affordance when ?appId= is set and clears it on click', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [{ match: '', path: '/orders' }],
          },
        ]),
      ),
    )
    const { router } = renderAt('/subscriptions?appId=order')
    await screen.findByText(/filtered to order/i)
    const clearBtn = screen.getByRole('button', { name: /clear filter/i })
    await userEvent.click(clearBtn)
    await waitFor(() => expect(router.state.location.search).toBe(''))
  })

  it('shows filter badge during loading when ?appId= is set', async () => {
    server.use(
      http.get('/api/subscriptions', async () => {
        await delay(200)
        return HttpResponse.json([
          { appId: 'order', pubsubName: 'pubsub', topic: 'orders', rules: [{ match: '', path: '/orders' }] },
        ])
      }),
    )
    renderAt('/subscriptions?appId=order')
    // Badge should be present immediately (during loading)
    expect(screen.getByText(/filtered to order/i)).toBeInTheDocument()
    expect(screen.getByText(/loading/i)).toBeInTheDocument()
    // Wait for data to settle
    await screen.findByText('orders')
  })

  it('duplicate-app-id instances render distinct rows linking by instanceKey', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-1', pubsubName: 'kafka-pubsub', topic: 'orders' },
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-2', pubsubName: 'kafka-pubsub', topic: 'orders' },
        ]),
      ),
    )
    renderAt()
    const links = await screen.findAllByRole('link', { name: /daprmq-service/ })
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/apps/daprmq-host-1', '/apps/daprmq-host-2'])
  })
})
