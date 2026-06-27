import { useState, useEffect } from 'react'
import { useParams, Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkflow } from '../hooks/useWorkflows'
import { useRemoveWorkflows } from '../hooks/useWorkflowRemoval'
import { StatusPill } from '../components/StatusPill'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import { elapsed } from '../lib/wallclock'
import type { WorkflowStatus, WorkflowHistoryEvent } from '../types/workflow'
import { copyText } from '../lib/clipboard'

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: WorkflowStatus[] = ['Completed', 'Failed', 'Terminated']

function isTerminal(status: WorkflowStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

// ---------------------------------------------------------------------------
// Shared styles (mirror AppDetail.tsx)
// ---------------------------------------------------------------------------

const sectionStyle: React.CSSProperties = {
  marginBottom: 'var(--space-6)',
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-3)',
  paddingBottom: 'var(--space-2)',
  borderBottom: '1px solid var(--border)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--space-3)',
  padding: 'var(--space-2) 0',
  borderBottom: '1px solid var(--border-soft)',
}

const labelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  minWidth: 140,
  flexShrink: 0,
}

const valueStyle: React.CSSProperties = {
  color: 'var(--text)',
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle} className={mono ? 'mono' : undefined}>
        {value ?? '—'}
      </span>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Copyable value field
// ---------------------------------------------------------------------------

function CopyableValue({ value }: { value: string }) {
  return (
    <span
      className="mono"
      title="Click to copy"
      style={{ cursor: 'copy', wordBreak: 'break-all' }}
      onClick={() => copyText(value)}
    >
      {value}
    </span>
  )
}

// ---------------------------------------------------------------------------
// History event row (expandable input/output)
// ---------------------------------------------------------------------------

function HistoryRow({
  event,
  expanded,
  onToggle,
}: {
  event: WorkflowHistoryEvent
  expanded: boolean
  onToggle: () => void
}) {
  const hasDetails = !!(event.input || event.output)

  return (
    <div
      style={{
        borderBottom: '1px solid var(--border-soft)',
        padding: 'var(--space-2) 0',
      }}
    >
      <div
        style={{
          display: 'flex',
          gap: 'var(--space-3)',
          alignItems: 'center',
          cursor: hasDetails ? 'pointer' : 'default',
        }}
        onClick={hasDetails ? onToggle : undefined}
      >
        <span style={{ color: 'var(--text-muted)', minWidth: 32, fontSize: 12 }}>
          {event.sequenceId}
        </span>
        <span style={{ color: 'var(--text)', fontWeight: 500, minWidth: 160 }}>
          {event.type}
        </span>
        <span style={{ color: 'var(--text-muted)', flex: 1 }}>
          {event.name ?? ''}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
          {event.timestamp ? new Date(event.timestamp).toLocaleString() : '—'}
        </span>
        {hasDetails && (
          <span
            aria-hidden="true"
            style={{
              color: 'var(--text-faint)',
              fontSize: 12,
              userSelect: 'none',
            }}
          >
            {expanded ? '▲' : '▼'}
          </span>
        )}
      </div>
      {expanded && hasDetails && (
        <div style={{ paddingLeft: 'var(--space-6)', paddingTop: 'var(--space-2)' }}>
          {event.input && (
            <div style={{ marginBottom: 'var(--space-2)' }}>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginRight: 'var(--space-2)' }}>
                input
              </span>
              <CopyableValue value={event.input} />
            </div>
          )}
          {event.output && (
            <div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12, marginRight: 'var(--space-2)' }}>
                output
              </span>
              <CopyableValue value={event.output} />
            </div>
          )}
        </div>
      )}
    </div>
  )
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

    // Check prefers-reduced-motion; we still update the numeric value but skip
    // any animation (CSS animations are suppressed by the media query in CSS).
    // The interval still runs so the number stays live.
    const id = setInterval(() => setTick((n) => n + 1), 1000)
    return () => clearInterval(id)
  }, [terminal, createdAt])

  if (!createdAt) return ''

  if (terminal) {
    // Freeze at total duration (use lastUpdatedAt as end time if available)
    return elapsed(createdAt, lastUpdatedAt ?? null)
  }

  // Live: update every tick
  void tick // ensure re-render
  return elapsed(createdAt, null, Date.now())
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

  // Expanded history rows keyed by sequenceId
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set())

  // Task-18: confirm-remove dialog open state
  const [removeDialogOpen, setRemoveDialogOpen] = useState(false)

  const wallclock = useWallClock(
    execution?.createdAt,
    execution?.lastUpdatedAt,
    execution?.status ?? 'Pending',
  )

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (isError || !execution) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--bad)' }}>Workflow not found or failed to load.</p>
      </div>
    )
  }

  function toggleRow(sequenceId: number) {
    setExpandedRows((prev) => {
      const next = new Set(prev)
      if (next.has(sequenceId)) next.delete(sequenceId)
      else next.add(sequenceId)
      return next
    })
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

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {/* ----------------------------------------------------------------- */}
      {/* Header                                                             */}
      {/* ----------------------------------------------------------------- */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
            marginBottom: 'var(--space-2)',
            flexWrap: 'wrap',
          }}
        >
          <h1
            className="mono"
            title="Click to copy"
            style={{ margin: 0, fontSize: 20, fontWeight: 700, color: 'var(--text)', cursor: 'copy' }}
            onClick={() => copyText(execution.instanceId)}
          >
            {execution.instanceId}
          </h1>
          <StatusPill status={execution.status} />
          {wallclock && (
            <span
              className="mono"
              aria-label="elapsed time"
              style={{ fontSize: 13, color: 'var(--text-muted)' }}
            >
              {wallclock}
            </span>
          )}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 'var(--space-4)',
            alignItems: 'center',
            fontSize: 14,
            color: 'var(--text-muted)',
          }}
        >
          <span>{execution.name}</span>
          <Link to={`/apps/${execution.appId}`} style={{ color: 'var(--accent)' }}>
            {execution.appId}
          </Link>
        </div>
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Summary section                                                    */}
      {/* ----------------------------------------------------------------- */}
      <div style={sectionStyle}>
        <div style={sectionHeadingStyle}>Summary</div>
        <Field
          label="Created"
          value={execution.createdAt ? new Date(execution.createdAt).toLocaleString() : '—'}
        />
        <Field
          label="Last updated"
          value={execution.lastUpdatedAt ? new Date(execution.lastUpdatedAt).toLocaleString() : '—'}
        />
        <Field label="Replay count" value={String(execution.replayCount)} mono />
        {execution.failureDetails && (
          <Field
            label="Failure"
            value={
              execution.failureDetails.errorType
                ? `${execution.failureDetails.errorType}: ${execution.failureDetails.message ?? ''}`
                : execution.failureDetails.message ?? '—'
            }
          />
        )}
      </div>

      {/* ----------------------------------------------------------------- */}
      {/* Payload section (only shown when present)                          */}
      {/* ----------------------------------------------------------------- */}
      {(execution.input || execution.output || execution.customStatus) && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>Payload</div>
          {execution.input && (
            <Field
              label="Input"
              value={<CopyableValue value={execution.input} />}
            />
          )}
          {execution.output && (
            <Field
              label="Output"
              value={<CopyableValue value={execution.output} />}
            />
          )}
          {execution.customStatus && (
            <Field
              label="Custom status"
              value={<CopyableValue value={execution.customStatus} />}
            />
          )}
        </div>
      )}

      {/* ----------------------------------------------------------------- */}
      {/* History timeline                                                   */}
      {/* Note: v1 renders the list directly. Virtualization for very long   */}
      {/* histories is deferred to Plan-5 (performance follow-up).           */}
      {/* ----------------------------------------------------------------- */}
      <div style={sectionStyle}>
        <div
          style={{
            ...sectionHeadingStyle,
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span>History ({history.length})</span>
          <button
            data-cy="wf-remove"
            onClick={() => setRemoveDialogOpen(true)}
            style={{
              padding: '2px 10px',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--bad)',
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            Remove
          </button>
        </div>
        {history.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: 13 }}>No history events.</p>
        ) : (
          history.map((event) => (
            <HistoryRow
              key={event.sequenceId}
              event={event}
              expanded={expandedRows.has(event.sequenceId)}
              onToggle={() => toggleRow(event.sequenceId)}
            />
          ))
        )}
      </div>
      <ConfirmRemoveDialog
        open={removeDialogOpen}
        targets={[{ appId: appId ?? '', instanceId: instanceId ?? '', status: execution.status }]}
        onConfirm={onConfirmRemove}
        onCancel={() => setRemoveDialogOpen(false)}
      />
    </div>
  )
}
