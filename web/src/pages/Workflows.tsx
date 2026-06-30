import { useState, useEffect, useRef, useMemo } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { useWorkflows, useWorkflowStats, useStateStores, useWorkflowAppIds } from '../hooks/useWorkflows'
import { useApps } from '../hooks/useApps'
import { useRemoveWorkflows } from '../hooks/useWorkflowRemoval'
import { StatusPill } from '../components/StatusPill'
import { ConfirmRemoveDialog } from '../components/ConfirmRemoveDialog'
import { dedupeWorkflows } from '../lib/dedupeWorkflows'
import type { StateStore, WorkflowStatus, WorkflowSummary } from '../types/workflow'

const ALL_STATUSES: WorkflowStatus[] = ['Running', 'Completed', 'Failed', 'Terminated', 'Suspended']

const STORE_KEY = 'devdash.workflowStore'

/** Format a UTC ISO string as a short local time HH:MM:SS */
function formatCreated(createdAt?: string): string {
  if (!createdAt) return '—'
  const d = new Date(createdAt)
  return d.toLocaleTimeString()
}

/** Compute a human-readable duration between two dates (or from createdAt to now if no end). */
function formatDuration(createdAt?: string, endAt?: string): string {
  if (!createdAt) return '—'
  const start = new Date(createdAt).getTime()
  const end = endAt ? new Date(endAt).getTime() : Date.now()
  const ms = end - start
  if (ms < 0) return '—'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec}s`
  const min = Math.floor(sec / 60)
  const remSec = sec % 60
  if (min < 60) return remSec > 0 ? `${min}m ${remSec}s` : `${min}m`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return remMin > 0 ? `${hr}h ${remMin}m` : `${hr}h`
}

/** Terminal statuses — no live duration needed */
const TERMINAL_STATUSES: WorkflowStatus[] = ['Completed', 'Failed', 'Terminated']

export function Workflows() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  // Initialize filter state from URL on mount
  const urlStatus = searchParams.get('status') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const urlPage = searchParams.get('page') ?? undefined
  const urlApp = searchParams.get('app') ?? ''

  // Single-status filter (one of ALL_STATUSES or '' for All)
  const [activeStatus, setActiveStatus] = useState<WorkflowStatus | ''>(
    urlStatus as WorkflowStatus | '',
  )
  const [selectedApp, setSelectedApp] = useState<string>(urlApp)
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch)
  const [page, setPage] = useState<string | undefined>(urlPage)
  // History of visited pages for backward navigation. The API only returns a
  // forward nextToken, so to support Prev we stack the (token, offset) of each
  // page we leave. Empty = on the first page.
  const [history, setHistory] = useState<{ token: string | undefined; offset: number }[]>([])
  // Number of items loaded before the current page — drives the "X–Y loaded" range.
  const [pageOffset, setPageOffset] = useState(0)

  // Reset paging to the first page (used whenever a filter/store changes).
  function resetPaging() {
    setPage(undefined)
    setHistory([])
    setPageOffset(0)
  }

  // Dialog open state + removal hook
  const [confirmDialogOpen, setConfirmDialogOpen] = useState(false)
  const [dialogInitialForce, setDialogInitialForce] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removeStatus, setRemoveStatus] = useState<{ ok: number; failed: number } | null>(null)
  const { mutate: removeWorkflows } = useRemoveWorkflows()

  // Running apps — used to flag workflow rows whose app-id is not currently running.
  const { data: appsData } = useApps()
  const appsLoaded = appsData !== undefined
  const runningAppIds = useMemo(
    () => new Set((appsData ?? []).map((a) => a.appId)),
    [appsData],
  )

  // State stores. The user can pick any listed store; the choice (a store id)
  // is threaded into the workflow list/stats/detail and persisted across reloads.
  const { data: storeList } = useStateStores()
  const storesResolved = storeList !== undefined
  const noStores = storesResolved && storeList.length === 0
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]

  // selectedStore is a store id (null = not yet determined; waits for storeList).
  // Initialize from localStorage when that id is still in the list, else the
  // active store's id. A stale persisted id falls back to active.
  // Using null-sentinel avoids a double-fetch: the workflow query is disabled
  // until selectedStore is resolved.
  const [selectedStore, setSelectedStore] = useState<string | null>(null)
  useEffect(() => {
    if (!storeList || storeList.length === 0) return
    if (selectedStore !== null && storeList.some((s) => s.id === selectedStore)) return
    const persisted = window.localStorage.getItem(STORE_KEY)
    const fromPersisted = persisted && storeList.some((s) => s.id === persisted) ? persisted : undefined
    const fallback = activeStore?.id ?? storeList[0].id
    setSelectedStore(fromPersisted ?? fallback)
  }, [storeList, activeStore, selectedStore])

  // The currently-selected store object (for the component link + labels).
  const selectedStoreObj = useMemo(
    () => storeList?.find((s) => s.id === selectedStore),
    [storeList, selectedStore],
  )

  // Option label: "name — type · connection", with a short type (state.redis → redis).
  function storeOptionLabel(s: StateStore): string {
    const typeShort = s.type.split('.').pop() ?? s.type
    const head = `${s.name} — ${s.connection ? `${typeShort} · ${s.connection}` : typeShort}`
    return s.active ? `${head} (active)` : head
  }

  function onStoreChange(id: string) {
    setSelectedStore(id)
    window.localStorage.setItem(STORE_KEY, id)
    // A different store has different apps — reset the app filter to "All apps".
    setSelectedApp('')
    resetPaging()
  }

  // Build the detail-page path for a row, carrying the selected store id so the
  // detail page reads from the same store.
  function detailPath(appId: string, instanceId: string): string {
    const base = `/workflows/${appId}/${instanceId}`
    return selectedStore ? `${base}?store=${encodeURIComponent(selectedStore)}` : base
  }

  // Active app-id = the running app that loaded the active store. Used to default
  // the dropdown to the most relevant workflows on first load.
  const activeAppId = useMemo(() => {
    if (!activeStore) return undefined
    const matched = (appsData ?? [])
      .filter((a) => a.components?.some((c) => c.name === activeStore.name))
      .map((a) => a.appId)
      .sort()
    return matched[0]
  }, [appsData, activeStore])

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
    if (activeStatus) params.status = activeStatus
    if (debouncedSearch) params.search = debouncedSearch
    if (page) params.page = page
    if (selectedApp) params.app = selectedApp
    setSearchParams(params, { replace: true })
  }, [activeStatus, debouncedSearch, page, selectedApp, setSearchParams])

  const { data, isLoading, isError, error } = useWorkflows({
    status: activeStatus ? [activeStatus] : undefined,
    search: debouncedSearch || undefined,
    page,
    appId: selectedApp || undefined,
    store: selectedStore ?? undefined,
    enabled: selectedStore !== null,
  })

  const { data: stats } = useWorkflowStats({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
    store: selectedStore ?? undefined,
    enabled: selectedStore !== null,
  })

  // Null-safe guard + de-duplicate by appId/instanceId (safety net against duplicate rows)
  const items = useMemo<WorkflowSummary[]>(() => dedupeWorkflows(data?.items ?? []), [data?.items])

  // App IDs for the filter dropdown come from the store (every app-id with
  // workflow data), not the current page of rows — so applying the filter never
  // collapses the option list to just the selected app.
  const { data: storeAppIds } = useWorkflowAppIds({
    store: selectedStore ?? undefined,
    enabled: selectedStore !== null,
  })
  const appIds = useMemo(() => storeAppIds ?? [], [storeAppIds])

  // One-time default: prefer the active app-id when it has workflows, else leave
  // "All apps". A ?app= URL param always wins. Never overrides a later manual change.
  const defaultAppliedRef = useRef(false)
  useEffect(() => {
    if (defaultAppliedRef.current) return
    if (urlApp !== '') {
      defaultAppliedRef.current = true
      return
    }
    // Wait until the store is determined, the store's app-id list, the apps
    // list, and the store list are all available before deciding.
    if (selectedStore === null || storeAppIds === undefined || appsData === undefined || storeList === undefined) return
    if (activeAppId && appIds.includes(activeAppId)) {
      setSelectedApp(activeAppId)
    }
    defaultAppliedRef.current = true
  }, [urlApp, selectedStore, storeAppIds, appsData, storeList, activeAppId, appIds])

  function setStatus(s: WorkflowStatus | '') {
    setActiveStatus(s)
    resetPaging()
  }

  function toggleRow(key: string, e: React.MouseEvent) {
    e.stopPropagation()
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(e: React.MouseEvent) {
    e.stopPropagation()
    if (selected.size === items.length && items.length > 0) {
      setSelected(new Set())
    } else {
      setSelected(new Set(items.map((w) => `${w.appId}/${w.instanceId}`)))
    }
  }

  function onBulkPurge() {
    setRemoveStatus(null)
    setDialogInitialForce(false)
    setConfirmDialogOpen(true)
  }

  function onBulkForceDelete() {
    setRemoveStatus(null)
    setDialogInitialForce(true)
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

  const allSelected = selected.size === items.length && items.length > 0

  // --- Error states ---

  // No-store guidance block — shared between the empty-list case and the 503 no-store case.
  const noStoreGuidance = (
    <div className="page">
      <p style={{ color: 'var(--fail-fg)', fontWeight: 600 }}>No state store detected</p>
      <p style={{ color: 'var(--muted)', marginTop: 8 }}>
        Dapr requires a state store to persist workflow state. Configure one with the{' '}
        <span className="mono">--statestore</span> flag or add a state store component.
      </p>
    </div>
  )

  if (noStores) return noStoreGuidance

  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      const isNoStore = errStr.includes('no state store detected')
      if (isNoStore) return noStoreGuidance
      // The server message follows the "API error 503: <message> for <path>" shape.
      // Fall back to a generic message if the separator isn't present.
      const extracted = errStr.replace(/^.*?503[:\s]+/, '').replace(/\s*for\s+\/\S*$/, '').trim()
      const serverMsg = extracted && extracted !== errStr ? extracted : 'state store unavailable'
      return (
        <div className="page">
          <p style={{ color: 'var(--fail-fg)', fontWeight: 600 }}>
            {serverMsg}
          </p>
        </div>
      )
    }
    return (
      <div className="page">
        <p style={{ color: 'var(--fail-fg)' }}>Error loading workflows: {errStr}</p>
      </div>
    )
  }

  return (
    <div className="page">
      {/* Page header */}
      <div className="phead">
        <div>
          <h1>Workflow executions</h1>
          <div className="sub">
            {appIds.length > 0
              ? `Across ${appIds.length} app${appIds.length !== 1 ? 's' : ''} · newest first`
              : 'Newest first'}
          </div>
        </div>
        <div className="ctrlset">
          {storeList && storeList.length > 0 ? (
            <>
              <span className="led" />
              <select
                className="select"
                data-testid="store-select"
                aria-label="Switch state store"
                value={selectedStore ?? ''}
                onChange={(e) => onStoreChange(e.target.value)}
              >
                {storeList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {storeOptionLabel(s)}
                  </option>
                ))}
              </select>
              {selectedStoreObj && (
                <Link
                  className="chip"
                  to={`/components/${selectedStoreObj.name}`}
                  aria-label={`Open the ${selectedStoreObj.name} component page`}
                  title={`Open the ${selectedStoreObj.name} component page`}
                >
                  component
                </Link>
              )}
            </>
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
        </div>
      </div>

      {/* Remove status banner */}
      {removeStatus && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: removeStatus.failed > 0 ? 'var(--fail-fg)' : 'var(--accent2)',
            fontSize: 13,
          }}
        >
          Removed {removeStatus.ok} workflow{removeStatus.ok !== 1 ? 's' : ''}
          {removeStatus.failed > 0 ? `, ${removeStatus.failed} failed` : ''}.{' '}
          <button
            onClick={() => setRemoveStatus(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: 'inherit',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="filters">
        <div className="segs" role="group" aria-label="Status filter">
          <button
            aria-pressed={activeStatus === ''}
            onClick={() => setStatus('')}
          >
            All <span className="n">{stats?.total ?? 0}</span>
          </button>
          {ALL_STATUSES.map((s) => (
            <button
              key={s}
              aria-pressed={activeStatus === s}
              onClick={() => setStatus(s)}
            >
              {s} <span className="n">{stats?.counts[s] ?? 0}</span>
            </button>
          ))}
        </div>

        {/* App filter */}
        <select
          className="select"
          data-cy="app-select"
          data-testid="app-select"
          aria-label="Filter by app"
          value={selectedApp}
          onChange={(e) => {
            setSelectedApp(e.target.value)
            resetPaging()
          }}
        >
          <option value="">All apps</option>
          {selectedApp && !appIds.includes(selectedApp) && (
            <option key={selectedApp} value={selectedApp}>
              {selectedApp}
              {appsLoaded && !runningAppIds.has(selectedApp) ? ' (not running)' : ''}
            </option>
          )}
          {appIds.map((id) => (
            <option key={id} value={id}>
              {id}
              {appsLoaded && !runningAppIds.has(id) ? ' (not running)' : ''}
            </option>
          ))}
        </select>

        {/* Search */}
        <label className="search">
          🔍
          <input
            placeholder="Search workflow name or instance id…"
            aria-label="Search"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value)
              resetPaging()
            }}
          />
        </label>
      </div>

      {/* Main card */}
      <div className="card">
        {/* Selection bar — shown only when rows selected */}
        {selected.size > 0 && (
          <div className="selbar">
            <span
              className="cbx on"
              role="checkbox"
              aria-checked={allSelected}
              aria-label="Deselect all"
              tabIndex={0}
              onClick={toggleAll}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleAll(e as unknown as React.MouseEvent) } }}
            />
            <span className="cnt">{selected.size} selected</span>
            <span className="grow" />
            <button
              className="btn ghost"
              title="Uses Dapr purge API for terminal-state workflows"
              onClick={onBulkPurge}
            >
              Purge via Dapr API
            </button>
            <button
              className="btn danger"
              data-cy="bulk-remove"
              title="Direct state-store deletion — for stuck/running or no sidecar"
              onClick={onBulkForceDelete}
            >
              Force delete…
            </button>
          </div>
        )}

        {/* Table */}
        <div className="tablewrap">
          {(isLoading || (!noStores && selectedStore === null)) ? (
            <p style={{ padding: 20, color: 'var(--muted)' }}>Loading…</p>
          ) : items.length === 0 ? (
            <p style={{ padding: 20, color: 'var(--muted)' }}>No workflows found</p>
          ) : (
            <table className="wf">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>
                    <span
                      className={allSelected ? 'cbx on' : 'cbx'}
                      role="checkbox"
                      aria-checked={allSelected}
                      aria-label="Select all"
                      tabIndex={0}
                      onClick={toggleAll}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleAll(e as unknown as React.MouseEvent)
                        }
                      }}
                    />
                  </th>
                  <th>Status</th>
                  <th>Workflow</th>
                  <th>Instance ID</th>
                  <th>App</th>
                  <th>Created</th>
                  <th>Duration</th>
                  <th>Last event</th>
                  <th style={{ width: 34 }} />
                </tr>
              </thead>
              <tbody>
                {items.map((wf) => {
                  const rowKey = `${wf.appId}/${wf.instanceId}`
                  const isTerminal = TERMINAL_STATUSES.includes(wf.status)
                  const duration = formatDuration(
                    wf.createdAt,
                    isTerminal ? wf.lastUpdatedAt : undefined,
                  )
                  const lastEventText = wf.lastUpdatedAt
                    ? new Date(wf.lastUpdatedAt).toLocaleTimeString()
                    : '—'
                  const isFailed = wf.status === 'Failed'

                  return (
                    <tr
                      key={rowKey}
                      className={selected.has(rowKey) ? 'sel' : undefined}
                      onClick={() => navigate(detailPath(wf.appId, wf.instanceId))}
                    >
                      <td>
                        <span
                          className={selected.has(rowKey) ? 'cbx on' : 'cbx'}
                          role="checkbox"
                          aria-checked={selected.has(rowKey)}
                          aria-label={`Select ${wf.instanceId}`}
                          tabIndex={0}
                          onClick={(e) => toggleRow(rowKey, e)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              toggleRow(rowKey, e as unknown as React.MouseEvent)
                            }
                          }}
                        />
                      </td>
                      <td>
                        <StatusPill status={wf.status} />
                      </td>
                      <td className="wfname">{wf.name}</td>
                      <td className="iid">
                        <Link
                          className="celllink"
                          to={detailPath(wf.appId, wf.instanceId)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {wf.instanceId}
                        </Link>
                      </td>
                      <td>
                        {wf.appId}
                        {appsLoaded && !runningAppIds.has(wf.appId) && (
                          <span className="typechip" style={{ marginLeft: '6px' }}>
                            not running
                          </span>
                        )}
                      </td>
                      <td className="muted mono tabnum">{formatCreated(wf.createdAt)}</td>
                      <td className="mono tabnum">{duration}</td>
                      <td className={`muted mono tabnum${isFailed ? ' err' : ''}`}>{lastEventText}</td>
                      <td className="kebab">⋯</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* Pager */}
        <div className="pager">
          <span className="mono">
            {items.length > 0
              ? `${pageOffset + 1}–${pageOffset + items.length} loaded`
              : 'No results'}
          </span>
          <div className="pgbtns">
            <button
              disabled={history.length === 0}
              onClick={() => {
                if (history.length === 0) return
                const prev = history[history.length - 1]
                setPage(prev.token)
                setPageOffset(prev.offset)
                setHistory((h) => h.slice(0, -1))
              }}
            >
              ← Prev
            </button>
            <button
              disabled={!data?.nextToken}
              onClick={() => {
                if (!data?.nextToken) return
                setHistory((h) => [...h, { token: page, offset: pageOffset }])
                setPageOffset((o) => o + items.length)
                setPage(data.nextToken)
              }}
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      <p className="hint">Tip — click any row to open its execution detail. Toggle ◐ Theme to preview light/dark.</p>

      <ConfirmRemoveDialog
        open={confirmDialogOpen}
        targets={dialogTargets}
        onConfirm={onConfirmRemove}
        onCancel={() => setConfirmDialogOpen(false)}
        initialForce={dialogInitialForce}
      />
    </div>
  )
}
