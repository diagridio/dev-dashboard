import { useState, useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkflow } from '../hooks/useWorkflows'
import { useApps } from '../hooks/useApps'
import { useRemoveWorkflows } from '../hooks/useWorkflowRemoval'
import { StatusPill } from '../components/StatusPill'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import { elapsed, elapsedTenths, formatOffset, formatDateTime, formatDuration } from '../lib/wallclock'
import { highlightJson } from '../lib/json-highlight'
import { useToast, type ToastHandle } from '../lib/toast'
import type { WorkflowStatus, WorkflowHistoryEvent } from '../types/workflow'
import { copyText } from '../lib/clipboard'
import { sortHistoryForDisplay, orderHistoryForDisplay, eventAnchorId, type HistoryOrder } from '../lib/eventOrder'
import { buildPairIndex, type PairInfo } from '../lib/pairing'
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
// Event type → node class mapping
// ---------------------------------------------------------------------------

function nodeClass(eventType: string): string {
  if (eventType === 'ExecutionStarted') return 'n-start'
  if (eventType === 'TaskScheduled') return 'n-sched'
  if (eventType === 'TaskCompleted') return 'n-done'
  if (eventType.endsWith('Failed') && !eventType.startsWith('Execution')) return 'n-fail'
  if (eventType.includes('Timer')) return 'n-timer'
  if (eventType === 'SubOrchestrationCompleted') return 'n-done'
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
  appId,
  store,
  pair,
  pairHovered,
  onPairHover,
  pairSelected,
  isActive,
  onToggleSelect,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
  anchorId: string
  appId: string
  store?: string
  pair?: PairInfo | null
  pairHovered?: boolean
  onPairHover?: (pairId: number | null) => void
  pairSelected?: boolean
  isActive?: boolean
  onToggleSelect?: () => void
}) {
  const offset = formatOffset(createdAt, event.timestamp)
  const dateTime = formatDateTime(event.timestamp) ?? ''
  const nCls = nodeClass(event.type)

  // sequenceId -1 is durabletask's sentinel for OrchestratorStarted (replay) events —
  // not a user-facing event index, so it gets no Event ID tag.
  const eventIdTag = event.sequenceId >= 0 ? `Event ID ${event.sequenceId}` : null

  const pairChip = (() => {
    if (!pair) return null
    const enter = () => onPairHover?.(pair.pairId)
    const leave = () => onPairHover?.(null)
    if (pair.partnerIndex === null) {
      // Running (start with no completion yet) or orphan completion.
      const arrow = pair.role === 'end' ? ' ↑' : ''
      return (
        <span
          className="pairchip pending"
          title={pair.role === 'start' ? 'Awaiting result' : 'No matching scheduled event'}
          onMouseEnter={enter}
          onMouseLeave={leave}
        >
          #{pair.pairId}{arrow}
        </span>
      )
    }
    const href = `#${eventAnchorId(pair.partnerIndex)}`
    if (pair.role === 'start') {
      return (
        <a className="pairchip" href={href} aria-label="Jump to result" title="Jump to result" onClick={(e) => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
          #{pair.pairId} ↓
        </a>
      )
    }
    const dur = pair.durationMs !== null ? formatDuration(pair.durationMs) : ''
    return (
      <a className="pairchip" href={href} aria-label="Jump to scheduled" title="Jump to scheduled" onClick={(e) => e.stopPropagation()} onMouseEnter={enter} onMouseLeave={leave}>
        #{pair.pairId} ↑{dur ? ` ${dur}` : ''}
      </a>
    )
  })()

  // The column-4 tag cell: the pair chip when paired, else the plain Event ID tag.
  const tagCell =
    pairChip !== null ? (
      <span className="evtag">{pairChip}</span>
    ) : eventIdTag ? (
      <span className="evtag">{eventIdTag}</span>
    ) : null

  const hasDetails = !!(event.input || event.output)

  const selectable = !!pair
  const onHeaderClick = (e: ReactMouseEvent) => {
    e.preventDefault() // suppress native <details> toggle; selection drives expansion
    onToggleSelect?.()
  }

  const copyAnchorLink = () => {
    const { origin, pathname } = window.location
    copyText(`${origin}${pathname}#${anchorId}`)
    toast.show('Link copied')
  }

  return (
    <div id={anchorId} className={`ev${isNewest ? ' reveal' : ''}${pairHovered ? ' pair-hover' : ''}${pairSelected ? ' pair-selected' : ''}`}>
      <div className="t">
        <span className="off">{offset}</span>
        <span className="dt">{dateTime}</span>
      </div>
      <div className="rail">
        <span className={`node ${nCls}`} />
      </div>
      <div className="c">
        {hasDetails ? (
          <details className="evd" {...(selectable ? { open: !!isActive } : {})}>
            <summary onClick={selectable ? onHeaderClick : undefined}>
              <span className="caret">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {tagCell}
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.preventDefault() // don't toggle the <details>
                  e.stopPropagation() // don't trigger row selection
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
          <div className={`evd evstatic${selectable ? ' selectable' : ''}`}>
            <div className="evstatic-head" onClick={selectable ? () => onToggleSelect?.() : undefined}>
              <span className="caretspace" aria-hidden="true">▸</span>
              <span className="evtype">{event.type}</span>
              <div className="evnamecell">
                {event.name && <span className="evname">{event.name}</span>}
                {/* Child instance link. The event carries no appId, so we assume the
                    parent's app (correct for same-app sub-orchestrations). */}
                {event.type === 'SubOrchestrationCreated' && event.instanceId && (
                  <Link
                    className="evchildlink"
                    to={`/workflows/${appId}/${event.instanceId}${store ? `?store=${encodeURIComponent(store)}` : ''}`}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {event.instanceId}
                  </Link>
                )}
              </div>
              {tagCell}
              <button
                className="evanchor"
                aria-label="Copy link to this event"
                title="Copy link to this event"
                onClick={(e) => {
                  e.stopPropagation() // don't trigger row selection
                  copyAnchorLink()
                }}
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
  const { data: execution, isLoading, isError } = useWorkflow(appId ?? '', instanceId ?? '', store)
  const navigate = useNavigate()
  const { mutate: removeWorkflows } = useRemoveWorkflows()

  // Running apps — the App ID links to its app page only when that app is
  // currently running; otherwise the link would point at a non-existent app.
  const { data: appsData } = useApps()
  const appsLoaded = appsData !== undefined
  const runningAppIds = useMemo(
    () => new Set((appsData ?? []).map((a) => a.appId)),
    [appsData],
  )

  // Confirm-remove dialog state: open + which mode (force vs purge)
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
  const [removeForce, setRemoveForce] = useState(false)

  const [order, setOrder] = useState<HistoryOrder>(() => getHistoryOrder())
  const [hoveredPair, setHoveredPair] = useState<number | null>(null)
  const [selection, setSelection] = useState<{ pairId: number; index: number } | null>(null)
  const lastAutoSelectedHash = useRef<string>('')

  useEffect(() => {
    setHistoryOrder(order)
  }, [order])

  const { toast, toastNode } = useToast()

  const wallclock = useWallClock(
    execution?.createdAt,
    execution?.lastUpdatedAt,
    execution?.status ?? 'Pending',
  )

  // Memoize the two derived maps so they are only recomputed when history changes,
  // not on every render (e.g. order toggle, hover state). Must be before early returns
  // to satisfy the Rules of Hooks.
  const _history = execution?.history ?? []
  const { canonicalIndex, pairIndex } = useMemo(() => {
    const ascending = sortHistoryForDisplay(_history)
    const ci = new Map<WorkflowHistoryEvent, number>()
    ascending.forEach((e, i) => ci.set(e, i))
    return { canonicalIndex: ci, pairIndex: buildPairIndex(ascending) }
  }, [_history])

  // Scroll to and pulse the row referenced by the URL hash (e.g. #event-2), both
  // on mount and on in-page anchor clicks. If the target is part of a pair, also
  // select it (highlight both rows) and mark it active so its body expands.
  useEffect(() => {
    let pulseTimer: number | undefined
    function jumpToHash() {
      const id = window.location.hash.slice(1)
      if (!id) {
        // Hash cleared — allow a later return to the same anchor to jump again.
        lastAutoSelectedHash.current = ''
        return
      }
      // Only act on genuine navigation to a new hash — not on effect re-runs
      // from polling (pairIndex changes as a running workflow's history grows),
      // which would otherwise yank the viewport back to the anchor and
      // re-assert a selection the user dismissed.
      if (id === lastAutoSelectedHash.current) return
      const el = document.getElementById(id)
      if (!el) return
      lastAutoSelectedHash.current = id
      try {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' })
      } catch {
        // jsdom / unsupported environments: scrolling is non-essential
      }
      el.classList.add('target-pulse')
      pulseTimer = window.setTimeout(() => el.classList.remove('target-pulse'), 1500)
      // The anchor id encodes the canonical index, which is how pairIndex is keyed.
      const m = id.match(/^event-(\d+)$/)
      if (m) {
        const idx = Number(m[1])
        const p = pairIndex.get(idx)
        if (p) setSelection({ pairId: p.pairId, index: idx })
      }
    }
    jumpToHash()
    window.addEventListener('hashchange', jumpToHash)
    return () => {
      window.removeEventListener('hashchange', jumpToHash)
      if (pulseTimer !== undefined) window.clearTimeout(pulseTimer)
    }
  }, [pairIndex])

  const copyWorkflowLink = () => {
    const { origin, pathname } = window.location
    const qs = store ? `?store=${encodeURIComponent(store)}` : ''
    copyText(`${origin}${pathname}${qs}`)
    toast.show('Link copied')
  }

  const togglePairSelection = (pairId: number, index: number) =>
    setSelection((cur) => (cur && cur.pairId === pairId && cur.index === index ? null : { pairId, index }))

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
      ? eventAnchorId(canonicalIndex.get(lastEvent) ?? orderedHistory.length - 1)
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
            aria-label="Copy link to this workflow"
            title="Copy link to this workflow"
            onClick={copyWorkflowLink}
          >
            ⧉ Copy link
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
            {appsLoaded && !runningAppIds.has(execution.appId) ? (
              <>
                {execution.appId}
                <span className="typechip" style={{ marginLeft: '6px' }}>
                  not running
                </span>
              </>
            ) : (
              <Link className="celllink" to={`/apps/${execution.appId}`}>
                {execution.appId}
              </Link>
            )}
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
          {displayHistory.map((event, idx) => {
            const ci = canonicalIndex.get(event) ?? idx
            const pair = pairIndex.get(ci) ?? null
            return (
              <EventRow
                key={ci}
                event={event}
                createdAt={execution.createdAt}
                isNewest={event === newestEvent}
                toast={toast}
                anchorId={eventAnchorId(ci)}
                appId={appId ?? ''}
                store={store}
                pair={pair}
                pairHovered={pair !== null && pair.pairId === hoveredPair}
                onPairHover={setHoveredPair}
                pairSelected={pair !== null && selection !== null && pair.pairId === selection.pairId}
                isActive={selection !== null && selection.index === ci}
                onToggleSelect={pair !== null ? () => togglePairSelection(pair.pairId, ci) : undefined}
              />
            )
          })}
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
