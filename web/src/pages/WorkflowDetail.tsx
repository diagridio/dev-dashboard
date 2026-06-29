import { useState, useEffect, useRef } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkflow } from '../hooks/useWorkflows'
import { useRemoveWorkflows } from '../hooks/useWorkflowRemoval'
import { StatusPill } from '../components/StatusPill'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import { RefreshControl } from '../components/RefreshControl'
import { elapsed, elapsedTenths, formatOffset, formatDateTime } from '../lib/wallclock'
import { highlightJson } from '../lib/json-highlight'
import { useToast, type ToastHandle } from '../lib/toast'
import type { WorkflowStatus, WorkflowHistoryEvent } from '../types/workflow'
import { copyText } from '../lib/clipboard'
import { sortHistoryForDisplay, orderHistoryForDisplay, eventAnchorId, type HistoryOrder } from '../lib/eventOrder'
import { getHistoryOrder, setHistoryOrder } from '../lib/prefs'

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: WorkflowStatus[] = ['Completed', 'Failed', 'Terminated']

function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// ---------------------------------------------------------------------------
// Wall-clock hook: ticks every 1s while non-terminal
// ---------------------------------------------------------------------------

function useWallClock(
  createdAt: string | undefined,
  lastUpdatedAt: string | undefined,
  status: WorkflowStatus,
): string {
  const terminal = isTerminal(status)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    if (terminal) return
    if (!createdAt) return
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [terminal, createdAt])

  if (!createdAt) return ''

  if (terminal) {
    return elapsedTenths(createdAt, lastUpdatedAt ?? null)
  }

  void tick // ensure re-render
  return elapsedTenths(createdAt, null, Date.now())
}

// ---------------------------------------------------------------------------
// Last-updated "N ago" string — driven by actual query fetch time
// ---------------------------------------------------------------------------

function useLastRefreshed(dataUpdatedAt: number): string {
  const [, setTick] = useState(0)
  // Keep a ref to ensure we always re-render when dataUpdatedAt changes
  const prevRef = useRef(dataUpdatedAt)
  if (prevRef.current !== dataUpdatedAt) {
    prevRef.current = dataUpdatedAt
  }

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 5000)
    return () => clearInterval(id)
  }, [])

  const secsAgo = Math.floor((Date.now() - dataUpdatedAt) / 1000)
  if (secsAgo < 10) return 'updated just now'
  if (secsAgo < 60) return `updated ${secsAgo}s ago`
  const minsAgo = Math.floor(secsAgo / 60)
  return `updated ${minsAgo}m ago`
}

// ---------------------------------------------------------------------------
// Event type → node class mapping
// ---------------------------------------------------------------------------

function nodeClass(eventType: string): string {
  if (eventType === 'ExecutionStarted') return 'n-start'
  if (eventType === 'TaskScheduled') return 'n-sched'
  if (eventType === 'TaskCompleted') return 'n-done'
  if (eventType.endsWith('Failed') && !eventType.startsWith('Execution')) return 'n-fail'
  if (eventType.includes('Timer')) return 'n-timer'
  if (eventType === 'ExecutionCompleted') return 'n-end'
  if (eventType === 'ExecutionFailed' || eventType === 'ExecutionTerminated') return 'n-endfail'
  return 'n-start'
}

// ---------------------------------------------------------------------------
// History event row rendered as details/summary
// ---------------------------------------------------------------------------

export function EventRow({
  event,
  createdAt,
  isNewest,
  toast,
  anchorId,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
  anchorId: string
}) {
  const offset = formatOffset(createdAt, event.timestamp)
  const dateTime = formatDateTime(event.timestamp) ?? ''
  const nCls = nodeClass(event.type)

  // sequenceId -1 is durabletask's sentinel for OrchestratorStarted (replay) events —
  // not a user-facing event index, so it gets no Event ID tag.
  const eventIdTag = event.sequenceId >= 0 ? `Event ID ${event.sequenceId}` : null

  const hasDetails = !!(event.input || event.output)

  const copyAnchorLink = () => {
    const { origin, pathname } = window.location
    copyText(`${origin}${pathname}#${anchorId}`)
    toast.show('Link copied')
  }

  return (
    <div id={anchorId} className={`ev${isNewest ? ' reveal' : ''}`}>
      <div className="t">
        <span className="off">{offset}</span>
        <span className="dt">{dateTime}</span>
      </div>
      <div className="rail">
        <span className={`node ${nCls}`} />
      </div>
      <div className="c">
        {hasDetails ? (
          <details className="evd">
            <summary>
              <span className="caret">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.preventDefault() // don't toggle the <details>
                  copyAnchorLink()
                }}
              >
                #
              </button>
            </summary>
            <div className="evbody">
              {event.input && (
                <div>
                  <div className="lblrow">
                    <span className="lbl">Input</span>
                    <button
                      className="copybtn"
                      onClick={() => {
                        copyText(event.input ?? '')
                        toast.show('Input copied')
                      }}
                    >
                      ⧉ Copy
                    </button>
                  </div>
                  <pre className="json">{highlightJson(event.input)}</pre>
                </div>
              )}
              {event.output && (
                <div>
                  <div className="lblrow">
                    <span className="lbl">Output</span>
                    <button
                      className="copybtn"
                      onClick={() => {
                        copyText(event.output ?? '')
                        toast.show('Output copied')
                      }}
                    >
                      ⧉ Copy
                    </button>
                  </div>
                  <pre className="json">{highlightJson(event.output)}</pre>
                </div>
              )}
            </div>
          </details>
        ) : (
          <div className="evd evstatic">
            <div className="evstatic-head">
              <span className="caretspace" aria-hidden="true">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={copyAnchorLink}
              >
                #
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function WorkflowDetail() {
  const { appId, instanceId } = useParams<{ appId: string; instanceId: string }>()
  const [searchParams] = useSearchParams()
  const store = searchParams.get('store') ?? undefined
  const { data: execution, isLoading, isError, dataUpdatedAt } = useWorkflow(appId ?? '', instanceId ?? '', store)
  const navigate = useNavigate()
  const { mutate: removeWorkflows } = useRemoveWorkflows()

  // Confirm-remove dialog state: open + which mode (force vs purge)
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [removeForce, setRemoveForce] = useState(false)

  const [order, setOrder] = useState<HistoryOrder>(() => getHistoryOrder())

  useEffect(() => {
    setHistoryOrder(order)
  }, [order])

  // Scroll to and pulse the row referenced by the URL hash (e.g. #event-2),
  // both on mount and whenever the hash changes via an in-page anchor click.
  useEffect(() => {
    function jumpToHash() {
      const id = window.location.hash.slice(1)
      if (!id) return
      const el = document.getElementById(id)
      if (!el) return
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        // jsdom / unsupported environments: scrolling is non-essential
      }
      el.classList.add('target-pulse')
      window.setTimeout(() => el.classList.remove('target-pulse'), 1500)
    }
    jumpToHash()
    window.addEventListener('hashchange', jumpToHash)
    return () => window.removeEventListener('hashchange', jumpToHash)
  }, [execution])

  const { toast, toastNode } = useToast()

  const wallclock = useWallClock(
    execution?.createdAt,
    execution?.lastUpdatedAt,
    execution?.status ?? 'Pending',
  )

  const lastRefreshed = useLastRefreshed(dataUpdatedAt)

  if (isLoading) {
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    )
  }

  if (isError || !execution) {
    return (
      <div className="page">
        <p className="err">Workflow not found or failed to load.</p>
      </div>
    )
  }

  function openPurge() {
    setRemoveForce(false)
    setRemoveDialogOpen(true)
  }

  function openForceDelete() {
    setRemoveForce(true)
    setRemoveDialogOpen(true)
  }

  function onConfirmRemove(force: boolean) {
    removeWorkflows(
      { ids: [{ appId: appId ?? '', instanceId: instanceId ?? '' }], force, store },
      {
        onSuccess: () => {
          setRemoveDialogOpen(false)
          navigate('/workflows' + (store ? `?store=${encodeURIComponent(store)}` : ''))
        },
        onError: () => {
          setRemoveDialogOpen(false)
        },
      },
    )
  }

  const history = execution.history ?? []
  const orderedHistory = sortHistoryForDisplay(history) // canonical ascending — used for derived data
  const displayHistory = orderHistoryForDisplay(history, order) // what the timeline renders
  // Reference→canonical-index map so each row resolves the same id regardless of display order.
  const canonicalIndex = new Map<WorkflowHistoryEvent, number>()
  orderedHistory.forEach((e, i) => canonicalIndex.set(e, i))
  const newestEvent =
    orderedHistory.length > 0 ? orderedHistory[orderedHistory.length - 1] : undefined
  const terminal = isTerminal(execution.status)

  // Metagrid helpers
  const fmt = (ts: string | undefined) => formatDateTime(ts)

  const duration =
    execution.createdAt && execution.lastUpdatedAt && terminal
      ? elapsed(execution.createdAt, execution.lastUpdatedAt)
      : execution.createdAt
      ? elapsed(execution.createdAt, null, Date.now())
      : undefined

  const lastEvent =
    orderedHistory.length > 0 ? orderedHistory[orderedHistory.length - 1] : undefined
  const lastEventLabel = lastEvent
    ? `${lastEvent.type}${lastEvent.name ? ` · ${lastEvent.name}` : ''}${
        lastEvent.sequenceId >= 0 ? ` · Event ID ${lastEvent.sequenceId}` : ''
      }`
    : undefined
  const lastEventAnchor =
    lastEvent !== undefined
      ? eventAnchorId(lastEvent, canonicalIndex.get(lastEvent) ?? orderedHistory.length - 1)
      : undefined

  const hasOutput = !!execution.output
  const isRunning = !terminal

  return (
    <div className="page">
      {/* ------------------------------------------------------------------ */}
      {/* Breadcrumbs                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="crumbs">
        <Link to="/workflows">Workflows</Link>
        <span className="sep">/</span>
        <span className="cur">{execution.instanceId}</span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Page header                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="dhead">
        <div className="dtitle">
          <StatusPill status={execution.status} />
          <h1>{execution.name}</h1>
          {wallclock && (
            <span
              className={`clock${terminal ? ' stopped' : ''}`}
              title="Wall-clock since the workflow was scheduled"
              aria-label="elapsed time"
            >
              <span className="lbl2">{terminal ? 'total' : 'elapsed'}</span>
              {' '}
              {wallclock}
            </span>
          )}
        </div>
        <div className="dactions">
          <button className="btn ghost" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <button
            className="btn ghost"
            onClick={openPurge}
            disabled={!terminal}
            title={terminal ? undefined : 'Available once the workflow reaches a terminal state'}
            data-cy="wf-purge"
          >
            Purge via Dapr API
          </button>
          <button
            className="btn danger"
            onClick={openForceDelete}
            data-cy="wf-remove"
          >
            Force delete…
          </button>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Refresh bar                                                          */}
      {/* ------------------------------------------------------------------ */}
      <div className="refreshbar">
        <RefreshControl />
        <span className="sp" />
        <span className="mono faint">{lastRefreshed}</span>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Meta grid                                                            */}
      {/* ------------------------------------------------------------------ */}
      <div className="metagrid">
        <div className="m span2">
          <div className="k">Instance ID</div>
          <div className="v mono">
            {execution.instanceId}{' '}
            <button
              className="copybtn"
              onClick={() => {
                copyText(execution.instanceId)
                toast.show('Instance ID copied')
              }}
            >
              ⧉ Copy
            </button>
          </div>
        </div>
        <div className="m span2">
          <div className="k">App ID</div>
          <div className="v">
            <Link className="celllink" to={`/apps/${execution.appId}`}>
              {execution.appId}
            </Link>
          </div>
        </div>
        <div className="m">
          <div className="k">Created</div>
          <div className="v mono">
            {fmt(execution.createdAt) ?? <span className="faint">—</span>}
          </div>
        </div>
        <div className="m">
          <div className="k">Ended</div>
          <div className="v mono">
            {terminal && execution.lastUpdatedAt
              ? fmt(execution.lastUpdatedAt)
              : <span className="faint">—</span>}
          </div>
        </div>
        <div className="m">
          <div className="k">Duration</div>
          <div className="v mono">
            {duration ?? <span className="faint">—</span>}
          </div>
        </div>
        <div className="m">
          <div className="k">Last updated</div>
          <div className="v mono">
            {fmt(execution.lastUpdatedAt) ?? <span className="faint">—</span>}
          </div>
        </div>
        <div className="m">
          <div className="k">Replays</div>
          <div className="v mono">{execution.replayCount}</div>
        </div>
        <div className="m">
          <div className="k">Events</div>
          <div className="v mono">{history.length}</div>
        </div>
        <div className="m span2">
          <div className="k">Last event</div>
          <div className="v mono">
            {lastEventLabel && lastEventAnchor ? (
              <a className="celllink" href={`#${lastEventAnchor}`}>
                {lastEventLabel}
              </a>
            ) : (
              <span className="faint">awaiting first event…</span>
            )}
          </div>
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Input / Output panels                                                */}
      {/* ------------------------------------------------------------------ */}
      <div className="io">
        {/* Input */}
        <div className="panel">
          <div className="ph">
            <span className="tagdot" style={{ background: 'var(--accent2)' }} />
            {' '}Input{' '}
            <button
              className="copybtn"
              onClick={() => {
                copyText(execution.input ?? '')
                toast.show('Input copied')
              }}
            >
              ⧉ Copy
            </button>
          </div>
          {execution.input ? (
            <pre className="json">{highlightJson(execution.input)}</pre>
          ) : (
            <span className="faint">—</span>
          )}
        </div>

        {/* Output */}
        <div className="panel">
          <div className="ph">
            <span className="tagdot" style={{ background: 'var(--fail-fg)' }} />
            {' '}Output{' '}
            <button
              className="copybtn"
              onClick={() => {
                copyText(execution.output ?? '')
                toast.show('Output copied')
              }}
            >
              ⧉ Copy
            </button>
          </div>
          {isRunning && !hasOutput ? (
            <div className="pendingout">
              <span
                className="beat"
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: '50%',
                  background: 'var(--run-fg)',
                  display: 'inline-block',
                }}
              />
              {' '}workflow running — no output yet
            </div>
          ) : (
            execution.output
              ? <pre className="json">{highlightJson(execution.output)}</pre>
              : <span className="faint">—</span>
          )}
        </div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Custom status panel (only when set)                                  */}
      {/* ------------------------------------------------------------------ */}
      {execution.customStatus && (
        <div className="panel" id="d-custom" style={{ marginBottom: 22 }}>
          <div className="ph">
            <span className="tagdot" style={{ background: 'var(--susp-fg)' }} />
            {' '}Custom status{' '}
            <span className="faint" style={{ textTransform: 'none', letterSpacing: 0, fontSize: 11 }}>
              — shown only when the workflow sets it via <span className="mono">ctx.SetCustomStatus()</span>
            </span>
            <button
              className="copybtn"
              onClick={() => {
                copyText(execution.customStatus ?? '')
                toast.show('Custom status copied')
              }}
            >
              ⧉ Copy
            </button>
          </div>
          <pre className="json">{highlightJson(execution.customStatus)}</pre>
        </div>
      )}

      {/* ------------------------------------------------------------------ */}
      {/* Event history timeline                                               */}
      {/* ------------------------------------------------------------------ */}
      <h2 className="sech">
        Event history{' '}
        <span className="meta">
          {terminal ? `${history.length} events` : 'live — populating as the run progresses'}
        </span>
        {history.length > 0 && (
          <button
            className="tbtn ordbtn"
            data-cy="history-order"
            aria-label={order === 'asc' ? 'Show newest first' : 'Show oldest first'}
            aria-pressed={order === 'desc'}
            onClick={() => setOrder((o) => (o === 'asc' ? 'desc' : 'asc'))}
          >
            {order === 'asc' ? 'Oldest first' : 'Newest first'}
          </button>
        )}
      </h2>

      {history.length === 0 ? (
        <p className="hint">No history events.</p>
      ) : (
        <div className="timeline">
          {displayHistory.map((event, idx) => (
            <EventRow
              key={idx}
              event={event}
              createdAt={execution.createdAt}
              isNewest={event === newestEvent}
              toast={toast}
              anchorId={eventAnchorId(event, canonicalIndex.get(event) ?? idx)}
            />
          ))}
        </div>
      )}

      <p className="hint">Back to the list to see the overview, filters, and bulk purge.</p>

      <ConfirmRemoveDialog
        open={removeDialogOpen}
        targets={[{ appId: appId ?? '', instanceId: instanceId ?? '', status: execution.status }]}
        onConfirm={onConfirmRemove}
        onCancel={() => setRemoveDialogOpen(false)}
        initialForce={removeForce}
      />

      {toastNode}
    </div>
  )
}
