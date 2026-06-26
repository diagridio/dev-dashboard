import { useState, useEffect, useRef } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useWorkflows } from '../hooks/useWorkflows'
import { useRemoveWorkflows } from '../hooks/useWorkflowRemoval'
import { StatusPill } from '../components/StatusPill'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import type { WorkflowStatus, WorkflowSummary } from '../types/workflow'

const ALL_STATUSES: WorkflowStatus[] = ['Pending', 'Running', 'Completed', 'Failed', 'Terminated', 'Suspended']

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--font)',
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border-soft)',
  whiteSpace: 'nowrap',
}

function formatAge(createdAt?: string): string {
  if (!createdAt) return '—'
  const diffMs = Date.now() - new Date(createdAt).getTime()
  const diffSec = Math.floor(diffMs / 1000)
  if (diffSec < 60) return `${diffSec}s`
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h`
  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}d`
}

function formatCreated(createdAt?: string): string {
  if (!createdAt) return '—'
  const d = new Date(createdAt)
  return d.toLocaleString()
}

export function Workflows() {
  const [searchParams, setSearchParams] = useSearchParams()

  // Initialize filter state from URL on mount
  const urlStatus = searchParams.get('status')
  const urlSearch = searchParams.get('search') ?? ''
  const urlPage = searchParams.get('page') ?? undefined

  const [selectedStatuses, setSelectedStatuses] = useState<WorkflowStatus[]>(
    urlStatus ? (urlStatus.split(',') as WorkflowStatus[]) : [],
  )
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch)
  const [page, setPage] = useState<string | undefined>(urlPage)

  // Task-18: dialog open state + removal hook
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removeStatus, setRemoveStatus] = useState<{ ok: number; failed: number } | null>(null)
  const { mutate: removeWorkflows } = useRemoveWorkflows()

  // Debounce search input ~250ms
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => {
      setDebouncedSearch(searchInput)
    }, 250)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [searchInput])

  // Mirror filter state to URL
  useEffect(() => {
    const params: Record<string, string> = {}
    if (selectedStatuses.length > 0) params.status = selectedStatuses.join(',')
    if (debouncedSearch) params.search = debouncedSearch
    if (page) params.page = page
    setSearchParams(params, { replace: true })
  }, [selectedStatuses, debouncedSearch, page, setSearchParams])

  const { data, isLoading, isError, error } = useWorkflows({
    status: selectedStatuses.length > 0 ? selectedStatuses : undefined,
    search: debouncedSearch || undefined,
    page,
  })

  // Null-safe guard: the API may return {"items": null} for empty results
  const items: WorkflowSummary[] = data?.items ?? []

  function toggleStatus(status: WorkflowStatus) {
    setSelectedStatuses((prev) =>
      prev.includes(status) ? prev.filter((s) => s !== status) : [...prev, status],
    )
    setPage(undefined)
  }

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll() {
    if (selected.size === items.length && items.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map((w) => `${w.appId}/${w.instanceId}`)))
    }
  }

  function onBulkRemove() {
    setRemoveStatus(null)
    setConfirmDialogOpen(true)
  }

  function onConfirmRemove(force: boolean) {
    const ids = Array.from(selected).map((key) => {
      const [appId, instanceId] = key.split('/')
      return { appId, instanceId }
    })
    removeWorkflows(
      { ids, force },
      {
        onSuccess: (results) => {
          const ok = results.filter((r) => r.ok).length
          const failed = results.filter((r) => !r.ok).length
          setRemoveStatus({ ok, failed })
          setSelected(new Set())
          setConfirmDialogOpen(false)
        },
        onError: () => {
          setConfirmDialogOpen(false)
        },
      },
    )
  }

  // Build targets for the dialog from selected keys + items array
  const dialogTargets = Array.from(selected).map((key) => {
    const [appId, instanceId] = key.split('/')
    const item = items.find((w) => w.appId === appId && w.instanceId === instanceId)
    return { appId, instanceId, status: item?.status }
  })

  // --- States ---

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      return (
        <div style={{ padding: 'var(--space-4)' }}>
          <p style={{ color: 'var(--bad)', fontWeight: 600 }}>No state store detected</p>
          <p style={{ color: 'var(--text-muted)', marginTop: 'var(--space-2)' }}>
            Dapr requires a state store to persist workflow state. Configure one with the{' '}
            <span className="mono">--statestore</span> flag or add a state store component.
          </p>
        </div>
      )
    }
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--bad)' }}>Error loading workflows: {errStr}</p>
      </div>
    )
  }

  // --- Toolbar ---

  const toolbar = (
    <div
      style={{
        display: 'flex',
        gap: 'var(--space-3)',
        alignItems: 'center',
        flexWrap: 'wrap',
        marginBottom: 'var(--space-3)',
      }}
    >
      <input
        type="search"
        placeholder="Search workflows…"
        value={searchInput}
        onChange={(e) => {
          setSearchInput(e.target.value)
          setPage(undefined)
        }}
        style={{
          padding: 'var(--space-2) var(--space-3)',
          border: '1px solid var(--border)',
          borderRadius: 4,
          background: 'var(--surface)',
          color: 'var(--text)',
          fontSize: 'var(--font)',
          minWidth: 200,
        }}
      />
      <div style={{ display: 'flex', gap: 'var(--space-1)', flexWrap: 'wrap' }}>
        {ALL_STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            style={{
              padding: '2px 8px',
              borderRadius: 10,
              fontSize: 12,
              fontWeight: 600,
              cursor: 'pointer',
              border: '1px solid var(--border)',
              background: selectedStatuses.includes(s) ? 'var(--accent)' : 'var(--surface)',
              color: selectedStatuses.includes(s) ? 'var(--accent-fg)' : 'var(--text-muted)',
            }}
          >
            {s}
          </button>
        ))}
      </div>
      <button
        data-cy="bulk-remove"
        disabled={selected.size === 0}
        onClick={onBulkRemove}
        style={{
          marginLeft: 'auto',
          padding: 'var(--space-2) var(--space-3)',
          borderRadius: 4,
          border: '1px solid var(--border)',
          background: selected.size > 0 ? 'var(--bad)' : 'var(--surface)',
          color: selected.size > 0 ? '#fff' : 'var(--text-faint)',
          cursor: selected.size > 0 ? 'pointer' : 'default',
          fontSize: 'var(--font)',
          fontWeight: 500,
        }}
      >
        Remove selected ({selected.size})
      </button>
    </div>
  )

  if (items.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        {toolbar}
        <p style={{ color: 'var(--text-muted)' }}>No workflows found</p>
        <ConfirmRemoveDialog
          open={confirmDialogOpen}
          targets={dialogTargets}
          onConfirm={onConfirmRemove}
          onCancel={() => setConfirmDialogOpen(false)}
        />
      </div>
    )
  }

  const allSelected = selected.size === items.length && items.length > 0

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {removeStatus && (
        <div
          style={{
            marginBottom: 'var(--space-3)',
            padding: 'var(--space-2) var(--space-3)',
            borderRadius: 4,
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            color: removeStatus.failed > 0 ? 'var(--bad)' : 'var(--good)',
            fontSize: 'var(--font)',
          }}
        >
          Removed {removeStatus.ok} workflow{removeStatus.ok !== 1 ? 's' : ''}
          {removeStatus.failed > 0 ? `, ${removeStatus.failed} failed` : ''}.{' '}
          <button
            onClick={() => setRemoveStatus(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'inherit', fontSize: 'inherit', textDecoration: 'underline', padding: 0 }}
          >
            Dismiss
          </button>
        </div>
      )}
      {toolbar}
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th style={thStyle}>Status</th>
              <th style={thStyle}>Instance ID</th>
              <th style={thStyle}>Name</th>
              <th style={thStyle}>App</th>
              <th style={thStyle}>Created</th>
              <th style={thStyle}>Age</th>
            </tr>
          </thead>
          <tbody>
            {items.map((wf) => {
              const rowKey = `${wf.appId}/${wf.instanceId}`
              return (
                <tr key={rowKey}>
                  <td style={tdStyle}>
                    <input
                      type="checkbox"
                      checked={selected.has(rowKey)}
                      onChange={() => toggleRow(rowKey)}
                      aria-label={`Select ${wf.instanceId}`}
                    />
                  </td>
                  <td style={tdStyle}>
                    <StatusPill status={wf.status} />
                  </td>
                  <td style={tdStyle}>
                    <Link className="mono" to={`/workflows/${wf.appId}/${wf.instanceId}`}>
                      {wf.instanceId}
                    </Link>
                  </td>
                  <td style={tdStyle}>{wf.name}</td>
                  <td style={tdStyle} className="mono">
                    {wf.appId}
                  </td>
                  <td style={tdStyle}>{formatCreated(wf.createdAt)}</td>
                  <td style={tdStyle}>{formatAge(wf.createdAt)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {data?.nextToken && (
        <div style={{ marginTop: 'var(--space-3)' }}>
          <button
            onClick={() => setPage(data.nextToken)}
            style={{
              padding: 'var(--space-2) var(--space-4)',
              borderRadius: 4,
              border: '1px solid var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
              cursor: 'pointer',
              fontSize: 'var(--font)',
            }}
          >
            Load more
          </button>
        </div>
      )}
      <ConfirmRemoveDialog
        open={confirmDialogOpen}
        targets={dialogTargets}
        onConfirm={onConfirmRemove}
        onCancel={() => setConfirmDialogOpen(false)}
      />
    </div>
  )
}
