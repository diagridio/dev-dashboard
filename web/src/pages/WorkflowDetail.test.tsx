import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, beforeEach } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider, makeQueryClient } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { WorkflowDetail, EventRow } from './WorkflowDetail'
import type { WorkflowHistoryEvent } from '../types/workflow'
import type { ToastHandle } from '../lib/toast'

function renderDetail(client?: QueryClient, entry = '/workflows/order/abc') {
  // Always use a fresh client to avoid cross-test cache pollution
  const qc = client ?? makeQueryClient()
  const router = createMemoryRouter(
    [{ path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> }],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={qc}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('WorkflowDetail', () => {
  // Default: the workflow's app ("order") is currently running. Individual
  // tests override /api/apps to exercise the not-running path.
  beforeEach(() => {
    server.use(
      http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])),
    )
  })

  // -------------------------------------------------------------------------
  // Basic rendering
  // -------------------------------------------------------------------------
  it('renders header, input and history', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          input: '{"id":1}',
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
          ],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0))
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // App ID deeplink + breadcrumbs
  // -------------------------------------------------------------------------
  it('App ID in the metagrid links to the app detail page', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    const link = screen.getByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })

  it('App ID is plain text with a "not running" chip when the app is not running', async () => {
    server.use(
      // No running apps — "order" is not running.
      http.get('/api/apps', () => HttpResponse.json([])),
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    // The "not running" chip appears next to the App ID.
    await waitFor(() => expect(screen.getByText('not running')).toBeInTheDocument())
    // The App ID is NOT a link to the (non-existent) running app.
    expect(screen.queryByRole('link', { name: 'order' })).not.toBeInTheDocument()
    // The App ID value is still shown as text.
    expect(screen.getByText('order')).toBeInTheDocument()
  })

  it('breadcrumbs do not contain the appId segment', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    const { container } = renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    const crumbs = container.querySelector('.crumbs') as HTMLElement
    // appId 'order' must not appear as a crumb (instanceId 'abc' is the only cur segment)
    expect(crumbs.textContent).not.toContain('order')
    expect((crumbs.querySelector('.cur') as HTMLElement).textContent).toBe('abc')
  })

  // -------------------------------------------------------------------------
  // StatusPill + elapsed clock
  // -------------------------------------------------------------------------
  it('shows StatusPill with RUNNING and elapsed clock for a running workflow', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    // StatusPill has the correct pill class
    const pill = screen.getByText('RUNNING')
    expect(pill.className).toContain('s-run')
    // Elapsed clock is rendered
    const clock = screen.getByLabelText('elapsed time')
    expect(clock).toBeInTheDocument()
    expect(clock.className).toContain('clock')
    expect(clock.className).not.toContain('stopped')
  })

  it('shows .clock.stopped for a completed workflow', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:30Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())
    const clock = screen.getByLabelText('elapsed time')
    expect(clock.className).toContain('stopped')
  })

  it('clock renders in M:SS.t format (tenths of a second, no zero-padded minutes)', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00.000Z',
          lastUpdatedAt: '2026-06-26T10:00:30.500Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())
    const clock = screen.getByLabelText('elapsed time')
    // Should render "0:30.5" — M:SS.t format
    expect(clock.textContent).toMatch(/\d+:\d{2}\.\d/)
    expect(clock.textContent).toContain('0:30.5')
  })

  // -------------------------------------------------------------------------
  // Metagrid fields
  // -------------------------------------------------------------------------
  it('renders metagrid with instance ID, app ID, replays and events count', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc-full-instance-id',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 3,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'MyWorkflow' },
          ],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())

    // Instance ID label in metagrid
    expect(screen.getByText('Instance ID')).toBeInTheDocument()
    // App ID label
    expect(screen.getByText('App ID')).toBeInTheDocument()
    // Replays label + value
    expect(screen.getByText('Replays')).toBeInTheDocument()
    expect(screen.getByText('3')).toBeInTheDocument()
    // Events count
    expect(screen.getByText('Events')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
  })

  // -------------------------------------------------------------------------
  // Input / Output rendered as highlighted JSON (pre.json with token classes)
  // -------------------------------------------------------------------------
  it('renders input as pre.json with highlighted JSON token classes', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          input: '{"orderId":"ORD-1"}',
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())

    // pre.json element should be present
    const pres = document.querySelectorAll('pre.json')
    expect(pres.length).toBeGreaterThan(0)

    // Token classes should be present inside the pre
    const inputPre = pres[0]
    expect(inputPre.querySelector('.k')).not.toBeNull()
    expect(inputPre.querySelector('.s')).not.toBeNull()
  })

  it('renders output as pre.json with highlighted JSON when workflow is terminal', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:10Z',
          replayCount: 0,
          output: '{"result":"ok"}',
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())

    const pres = document.querySelectorAll('pre.json')
    // Should have output pre.json (no input pre since input is absent)
    expect(pres.length).toBeGreaterThan(0)
    const outputPre = pres[0]
    expect(outputPre.querySelector('.k')).not.toBeNull()
  })

  it('shows pendingout while workflow is running with no output', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())

    // .pendingout should be visible
    const pending = document.querySelector('.pendingout')
    expect(pending).not.toBeNull()
    expect(pending!.textContent).toContain('workflow running')
  })

  // -------------------------------------------------------------------------
  // Event timeline: details/summary expand
  // Reconciled for change #2 (static empty events) and #3 (Event ID label):
  // Both events in this fixture have input payloads, so they still render as
  // details.evd with carets. The sequence tag now reads "Event ID N" (change #3).
  // -------------------------------------------------------------------------
  it('renders event history as details.evd with summary and caret', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          input: '{"x":1}',
          history: [
            {
              sequenceId: 0,
              timestamp: '2026-06-26T10:00:00Z',
              type: 'ExecutionStarted',
              name: 'MyWorkflow',
              input: '{"x":1}',
            },
            {
              sequenceId: 1,
              timestamp: '2026-06-26T10:00:01Z',
              type: 'TaskScheduled',
              name: 'DoWork',
              input: '{"y":2}',
            },
          ],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('ExecutionStarted')).toBeInTheDocument())

    // Each event row with payload is a details.evd
    const detailEls = document.querySelectorAll('details.evd')
    expect(detailEls.length).toBe(2)

    // Each has a summary with a caret
    const summaries = document.querySelectorAll('details.evd summary')
    expect(summaries.length).toBe(2)
    expect(summaries[0].querySelector('.caret')).not.toBeNull()
    expect(summaries[0].querySelector('.evtype')!.textContent).toBe('ExecutionStarted')
    expect(summaries[0].querySelector('.evname')!.textContent).toBe('MyWorkflow')

    // evbody payload is rendered with pre.json + highlighted JSON
    const evBody = detailEls[0].querySelector('.evbody')
    expect(evBody).not.toBeNull()
    // Pre inside evbody must have class "json" so CSS color rules apply
    const bodyPre = evBody!.querySelector('pre')
    expect(bodyPre).not.toBeNull()
    expect(bodyPre).toHaveClass('json')
    expect(bodyPre!.querySelector('.k')).not.toBeNull()
  })

  it('timeline assigns correct .node n-* class per event type', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:05Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'MyWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Step1' },
            { sequenceId: 2, timestamp: '2026-06-26T10:00:02Z', type: 'TaskCompleted', name: 'Step1' },
            { sequenceId: 3, timestamp: '2026-06-26T10:00:03Z', type: 'TaskFailed', name: 'Step2' },
            { sequenceId: 4, timestamp: '2026-06-26T10:00:04Z', type: 'ExecutionCompleted', name: 'MyWorkflow' },
          ],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('ExecutionStarted')).toBeInTheDocument())

    // Reconciled for change #1 (event ordering):
    // ExecutionStarted is pinned FIRST, ExecutionCompleted is pinned LAST.
    // Middle events (TaskScheduled, TaskCompleted, TaskFailed) remain in timestamp order.
    // DOM order: ExecutionStarted, TaskScheduled, TaskCompleted, TaskFailed, ExecutionCompleted
    const nodes = document.querySelectorAll('.node')
    expect(nodes[0].className).toContain('n-start')
    expect(nodes[1].className).toContain('n-sched')
    expect(nodes[2].className).toContain('n-done')
    expect(nodes[3].className).toContain('n-fail')
    expect(nodes[4].className).toContain('n-end')
  })

  // -------------------------------------------------------------------------
  // Purge enabled only in terminal state
  // -------------------------------------------------------------------------
  it('Purge button is disabled while workflow is running', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())

    const purgeBtn = screen.getByText('Purge via Dapr API')
    expect((purgeBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('Purge button is enabled when workflow is in terminal state', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:10Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())

    const purgeBtn = screen.getByText('Purge via Dapr API')
    expect((purgeBtn as HTMLButtonElement).disabled).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Force delete opens dialog with force=true
  // -------------------------------------------------------------------------
  it('Force delete button opens dialog with force checkbox checked', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())

    // Dialog should not be visible yet
    expect(document.querySelector('[data-cy="confirm-remove"]')).toBeNull()

    // Click Force delete
    await userEvent.click(document.querySelector('[data-cy="wf-remove"]') as HTMLElement)

    // Dialog confirm button should now be in the DOM
    expect(document.querySelector('[data-cy="confirm-remove"]')).not.toBeNull()

    // Force checkbox should be checked (initialForce=true)
    const forceChk = document.querySelector('[data-cy="confirm-force"]') as HTMLInputElement
    expect(forceChk).not.toBeNull()
    expect(forceChk.checked).toBe(true)
  })

  it('Purge button opens dialog with force checkbox unchecked', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'MyWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:10Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())

    await userEvent.click(screen.getByText('Purge via Dapr API'))

    // Dialog should open
    expect(document.querySelector('[data-cy="confirm-remove"]')).not.toBeNull()

    // Force checkbox should NOT be checked (initialForce=false)
    const forceChk = document.querySelector('[data-cy="confirm-force"]') as HTMLInputElement
    expect(forceChk).not.toBeNull()
    expect(forceChk.checked).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Running→Completed transition: refetch replaces history with updated state
  // -------------------------------------------------------------------------
  it('Running→Completed: refetch replaces history with updated server state (all rows present)', async () => {
    // Phase 1: Running with 2 history events
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
          ],
        }),
      ),
    )
    const client = makeQueryClient()
    renderDetail(client)
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()

    // Phase 2: Same workflow now Completed with 3 events
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:05Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
            { sequenceId: 2, timestamp: '2026-06-26T10:00:05Z', type: 'ExecutionCompleted', name: 'OrderWorkflow' },
          ],
        }),
      ),
    )

    await act(async () => {
      await client.invalidateQueries({ queryKey: ['workflow', 'order', 'abc'] })
    })

    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()
    expect(screen.getByText('ExecutionCompleted')).toBeInTheDocument()
    expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0)
  })

  // -------------------------------------------------------------------------
  // wf-remove opens confirm-remove dialog (legacy test preserved)
  // -------------------------------------------------------------------------
  it('clicking wf-remove opens confirm-remove dialog', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getAllByText('OrderWorkflow').length).toBeGreaterThan(0))
    expect(document.querySelector('[data-cy="confirm-remove"]')).toBeNull()
    await userEvent.click(document.querySelector('[data-cy="wf-remove"]') as HTMLElement)
    expect(document.querySelector('[data-cy="confirm-remove"]')).not.toBeNull()
  })

  // -------------------------------------------------------------------------
  // Task 5: Full Instance ID in breadcrumb (no ellipsis truncation)
  // -------------------------------------------------------------------------
  const FULL_ID = 'eec84589-11a4-4b01-831c-dce363fae52d'

  function seedFullId() {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: FULL_ID,
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z',
          lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0,
          output: '"ok"',
          history: [
            { sequenceId: -1, type: 'OrchestratorStarted', timestamp: '2026-06-28T10:00:00.027Z' },
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
          ],
        }),
      ),
    )
  }

  it('renders the full Instance ID in the breadcrumb (no ellipsis)', async () => {
    seedFullId()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const cur = container.querySelector('.crumbs .cur') as HTMLElement
    expect(cur.textContent).toBe(FULL_ID)
    expect(cur.textContent).not.toContain('…')
  })

  it('event rows carry unique canonical-index ids (one per history row)', async () => {
    seedFullId() // 4 history rows
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const ids = Array.from(container.querySelectorAll('.timeline .ev')).map((el) => el.id)
    expect(ids).toHaveLength(4)
    // Every row has an id and they are all unique (no collisions).
    expect(ids.every((id) => /^event-\d+$/.test(id))).toBe(true)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('orders the event timeline ExecutionStarted-first, ExecutionCompleted-last', async () => {
    seedFullId()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const types = Array.from(container.querySelectorAll('.timeline .evtype')).map((n) => n.textContent)
    expect(types[0]).toBe('ExecutionStarted')
    expect(types[types.length - 1]).toBe('ExecutionCompleted')
  })

  // -------------------------------------------------------------------------
  // Metagrid "Last event" cell: reflects the sorted terminal event and uses
  // the "Event ID N" label (omitting the -1 sentinel), consistent with the
  // timeline — not the raw last array item formatted as "#N".
  // -------------------------------------------------------------------------
  it('Last event cell shows the sorted terminal event with an "Event ID" label (not #N)', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z',
          lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0,
          output: '"ok"',
          // ExecutionCompleted is the logical terminal event, but the raw
          // history ends with an OrchestratorStarted (seq -1) episode marker.
          history: [
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 2, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
            { sequenceId: -1, type: 'OrchestratorStarted', timestamp: '2026-06-28T10:00:01.005Z' },
          ],
        }),
      ),
    )
    renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    // Sorted display pins ExecutionCompleted last; label uses "Event ID 2".
    expect(screen.getByText('ExecutionCompleted · Event ID 2')).toBeInTheDocument()
    // Not the raw last array item (OrchestratorStarted / #-1) nor old #N format.
    expect(screen.queryByText(/#-1/)).toBeNull()
    expect(screen.queryByText(/OrchestratorStarted · /)).toBeNull()
  })

  it('Last event cell links to the newest event row anchor', async () => {
    seedFullId() // newest event is ExecutionCompleted
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const link = container.querySelector('.metagrid a.celllink[href^="#event-"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    // The link must resolve to a single, unique row that is the ExecutionCompleted event.
    const targetId = link.getAttribute('href')!.slice(1)
    const matches = container.querySelectorAll(`[id="${targetId}"]`)
    expect(matches.length).toBe(1)
    expect(matches[0].querySelector('.evtype')?.textContent).toBe('ExecutionCompleted')
  })

  // Regression: durabletask reuses EventId (sequenceId) across rows — ExecutionStarted/
  // ExecutionCompleted are -1, and the per-episode action counter restarts, so a
  // TaskScheduled and the terminal ExecutionCompleted can BOTH carry sequenceId 0.
  // The Last-event anchor must still target the unique ExecutionCompleted row, not the
  // first colliding element.
  it('Last event link targets a unique row even when sequenceIds collide', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z',
          lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0,
          output: '"ok"',
          history: [
            { sequenceId: -1, type: 'OrchestratorStarted', timestamp: '2026-06-28T10:00:00.027Z' },
            { sequenceId: -1, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 0, type: 'TaskScheduled', name: 'Charge', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: -1, type: 'TaskCompleted', output: '1', timestamp: '2026-06-28T10:00:00.500Z' },
            { sequenceId: 0, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
          ],
        }),
      ),
    )
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const link = container.querySelector('.metagrid a.celllink[href^="#event-"]') as HTMLAnchorElement
    expect(link).not.toBeNull()
    const targetId = link.getAttribute('href')!.slice(1)
    // Anchor id must be unique across all rows...
    expect(container.querySelectorAll(`[id="${targetId}"]`).length).toBe(1)
    // ...and must point at the ExecutionCompleted row, not the colliding TaskScheduled.
    const target = container.querySelector(`[id="${targetId}"]`)!
    expect(target.querySelector('.evtype')?.textContent).toBe('ExecutionCompleted')
  })

  it('links a SubOrchestrationCreated event to the child workflow detail', async () => {
    server.use(
      http.get('/api/workflows/order/parent-1', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'parent-1',
          name: 'ParentWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'ParentWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'SubOrchestrationCreated', name: 'ChildWorkflow', instanceId: 'child-9' },
          ],
        }),
      ),
    )
    renderDetail(undefined, '/workflows/order/parent-1')
    const link = await screen.findByRole('link', { name: /child-9/ })
    expect(link).toHaveAttribute('href', '/workflows/order/child-9')
  })

  it('child link includes ?store= when parent is rendered with a store param', async () => {
    server.use(
      http.get('/api/workflows/order/parent-1', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'parent-1',
          name: 'ParentWorkflow',
          status: 'Running',
          createdAt: '2026-06-26T10:00:00Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'ParentWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'SubOrchestrationCreated', name: 'ChildWorkflow', instanceId: 'child-9' },
          ],
        }),
      ),
    )
    renderDetail(undefined, '/workflows/order/parent-1?store=redis-auto')
    const link = await screen.findByRole('link', { name: /child-9/ })
    expect(link).toHaveAttribute('href', '/workflows/order/child-9?store=redis-auto')
  })
})

describe('WorkflowDetail — store threading', () => {
  beforeEach(() => {
    server.use(http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])))
  })

  it('forwards ?store=<id> to the workflow fetch', async () => {
    let capturedStore: string | null = null
    server.use(
      http.get('/api/workflows/order/abc', ({ request }) => {
        capturedStore = new URL(request.url).searchParams.get('store')
        return HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-26T10:00:00Z', replayCount: 0, history: [],
        })
      }),
    )
    renderDetail(undefined, '/workflows/order/abc?store=statestore-b')
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    expect(capturedStore).toBe('statestore-b')
  })

  it('the copy-link button copies a URL including the store param', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-26T10:00:00Z', replayCount: 0, history: [],
        }),
      ),
    )
    let copied = ''
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: (t: string) => { copied = t; return Promise.resolve() } },
      configurable: true,
    })
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true })
    renderDetail(undefined, '/workflows/order/abc?store=statestore-b')
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /copy link to this workflow/i }))
    expect(copied).toContain('store=statestore-b')
  })
})

// ---------------------------------------------------------------------------
// EventRow unit tests (added to test static/expandable rendering and Event ID label)
// ---------------------------------------------------------------------------

const createdAt = '2026-06-28T10:00:00.000Z'

const stubToast: ToastHandle = { show: () => {} }

function row(event: WorkflowHistoryEvent) {
  return render(
    <EventRow event={event} createdAt={createdAt} isNewest={false} toast={stubToast} anchorId="event-test" appId="order" />,
  )
}

describe('EventRow', () => {
  it('labels a real event with output as "Event ID N" and is expandable', () => {
    const { container } = row({
      type: 'ExecutionCompleted',
      sequenceId: 2,
      timestamp: '2026-06-28T10:00:01.000Z',
      output: '"ok"',
    })
    expect(screen.getByText('Event ID 2')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })

  it('renders an empty OrchestratorStarted event as static (no details, no caret, no Event ID)', () => {
    const { container } = row({
      type: 'OrchestratorStarted',
      sequenceId: -1,
      timestamp: '2026-06-28T10:00:00.027Z',
    })
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('.caret')).toBeNull()
    expect(screen.queryByText(/Event ID/)).toBeNull()
    expect(screen.getByText('OrchestratorStarted')).toBeInTheDocument()
    // Caret-width spacer keeps the event name aligned with expandable rows,
    // without introducing a real caret.
    expect(container.querySelector('.caretspace')).not.toBeNull()
    expect(container.querySelector('.caret')).toBeNull()
  })

  it('sets the row id from anchorId and shows a copy-link button', () => {
    const { container } = render(
      <EventRow
        event={{ type: 'ExecutionCompleted', sequenceId: 2, timestamp: '2026-06-28T10:00:01.000Z', output: '"ok"' }}
        createdAt={createdAt}
        isNewest={false}
        toast={stubToast}
        anchorId="event-2"
        appId="order"
      />,
    )
    expect(container.querySelector('#event-2')).not.toBeNull()
    expect(container.querySelector('.evanchor')).not.toBeNull()
  })

  it('shows "Event ID 0" for ExecutionStarted with input (expandable)', () => {
    const { container } = row({
      type: 'ExecutionStarted',
      sequenceId: 0,
      timestamp: createdAt,
      name: 'OrderWorkflow',
      input: '{}',
    })
    expect(screen.getByText('Event ID 0')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })

  it('renders the offset and a localized date-time in the timestamp column', () => {
    const ts = '2026-06-28T10:00:05.600Z'
    const { container } = row({
      type: 'ExecutionCompleted',
      sequenceId: 2,
      timestamp: ts,
      output: '"ok"',
    })
    expect(container.querySelector('.t .off')?.textContent).toBe('+5.60s')
    const d = new Date(ts)
    expect(container.querySelector('.t .dt')?.textContent).toBe(
      `${d.toLocaleDateString()} - ${d.toLocaleTimeString()}`,
    )
  })
})

describe('WorkflowDetail — pair selection', () => {
  beforeEach(() => {
    server.use(http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])))
  })

  function seedPair() {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Completed',
          createdAt: '2026-06-28T10:00:00.000Z', lastUpdatedAt: '2026-06-28T10:00:01.000Z',
          replayCount: 0, output: '"ok"',
          history: [
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', input: '{"amt":5}', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'TaskCompleted', scheduledId: 1, output: '"charged"', timestamp: '2026-06-28T10:00:00.440Z' },
            { sequenceId: 3, type: 'ExecutionCompleted', output: '"ok"', timestamp: '2026-06-28T10:00:01.000Z' },
          ],
        }),
      ),
    )
  }

  function rowByType(container: HTMLElement, type: string): HTMLElement {
    const row = Array.from(container.querySelectorAll('.timeline .ev')).find(
      (el) => el.querySelector('.evtype')?.textContent === type,
    )
    if (!row) throw new Error(`row ${type} not found`)
    return row as HTMLElement
  }

  it('clicking a paired row selects the pair (both highlighted) and expands the clicked row', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    const scheduled = rowByType(container, 'TaskScheduled')
    await userEvent.click(scheduled.querySelector('summary') as HTMLElement)

    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')
    expect((rowByType(container, 'TaskScheduled').querySelector('details') as HTMLDetailsElement).open).toBe(true)
    // partner highlighted but not expanded
    expect((rowByType(container, 'TaskCompleted').querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('clicking the selected row again clears the selection and collapses it', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    const summary = () => rowByType(container, 'TaskScheduled').querySelector('summary') as HTMLElement

    await userEvent.click(summary())
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    await userEvent.click(summary())
    expect(rowByType(container, 'TaskScheduled').className).not.toContain('pair-selected')
    expect(rowByType(container, 'TaskCompleted').className).not.toContain('pair-selected')
    expect((rowByType(container, 'TaskScheduled').querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('clicking an unpaired row does not select anything', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })
    await userEvent.click(rowByType(container, 'ExecutionStarted').querySelector('summary') as HTMLElement)
    expect(container.querySelector('.ev.pair-selected')).toBeNull()
  })

  it('clicking the inactive partner moves selection to it (does not clear)', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    // Select TaskScheduled (canonical index 1)
    await userEvent.click(rowByType(container, 'TaskScheduled').querySelector('summary') as HTMLElement)
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')

    // Click TaskCompleted (same pair, different index) — should MOVE selection, not clear
    await userEvent.click(rowByType(container, 'TaskCompleted').querySelector('summary') as HTMLElement)
    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    // Active row moved: TaskCompleted now open, TaskScheduled collapsed
    expect((rowByType(container, 'TaskCompleted').querySelector('details') as HTMLDetailsElement).open).toBe(true)
    expect((rowByType(container, 'TaskScheduled').querySelector('details') as HTMLDetailsElement).open).toBe(false)
  })

  it('navigating via hash to a paired event selects the pair and expands the target', async () => {
    seedPair()
    const { container } = renderDetail()
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    // TaskCompleted is canonical index 2 -> anchor event-2.
    await act(async () => {
      window.location.hash = '#event-2'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })

    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')
    expect(rowByType(container, 'TaskScheduled').className).toContain('pair-selected')
    expect((rowByType(container, 'TaskCompleted').querySelector('details') as HTMLDetailsElement).open).toBe(true)

    // reset hash so it doesn't leak into other tests
    await act(async () => { window.location.hash = '' })
  })

  it('does not re-select on refetch after a manual deselect (running workflow)', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-28T10:00:00.000Z', replayCount: 0,
          history: [
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', input: '{"amt":5}', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'TaskCompleted', scheduledId: 1, output: '"charged"', timestamp: '2026-06-28T10:00:00.440Z' },
          ],
        }),
      ),
    )
    const client = makeQueryClient()
    const { container } = renderDetail(client)
    await screen.findByRole('heading', { name: 'OrderWorkflow' })

    // Navigate via hash to TaskCompleted (canonical index 2) -> selects the pair.
    await act(async () => {
      window.location.hash = '#event-2'
      window.dispatchEvent(new HashChangeEvent('hashchange'))
    })
    expect(rowByType(container, 'TaskCompleted').className).toContain('pair-selected')

    // Manually deselect by clicking the active row.
    await userEvent.click(rowByType(container, 'TaskCompleted').querySelector('summary') as HTMLElement)
    expect(container.querySelector('.ev.pair-selected')).toBeNull()

    // A poll arrives with grown history; the hash still points at #event-2.
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-28T10:00:00.000Z', replayCount: 0,
          history: [
            { sequenceId: 0, type: 'ExecutionStarted', name: 'OrderWorkflow', input: '{}', timestamp: '2026-06-28T10:00:00.000Z' },
            { sequenceId: 1, type: 'TaskScheduled', name: 'Charge', input: '{"amt":5}', timestamp: '2026-06-28T10:00:00.100Z' },
            { sequenceId: 2, type: 'TaskCompleted', scheduledId: 1, output: '"charged"', timestamp: '2026-06-28T10:00:00.440Z' },
            { sequenceId: 3, type: 'TimerCreated', timestamp: '2026-06-28T10:00:00.900Z' },
          ],
        }),
      ),
    )
    await act(async () => { await client.invalidateQueries({ queryKey: ['workflow', 'order', 'abc'] }) })
    // Wait for the refetch to complete and the new event to appear in the DOM.
    await waitFor(() => {
      const rows = Array.from(container.querySelectorAll('.timeline .ev'))
      const timerRow = rows.find(el => el.querySelector('.evtype')?.textContent === 'TimerCreated')
      expect(timerRow).toBeTruthy()
    })

    // Selection must remain cleared — the poll must not re-assert the dismissed selection.
    expect(container.querySelector('.ev.pair-selected')).toBeNull()

    await act(async () => { window.location.hash = '' })
  })
})
