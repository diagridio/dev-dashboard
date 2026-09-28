import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useStateStores } from '../hooks/useWorkflows'
import {
  useDeleteStateRecords,
  useStateAppIds,
  useStateRecord,
  useStateRecords,
} from '../hooks/useStateRecords'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { DateTimeCell } from '../components/DateTimeCell'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { NewStateRecordDialog } from '../components/NewStateRecordDialog'
import { dedupeStores } from '../lib/dedupeStores'
import { highlightJson } from '../lib/json-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { decodeBase64Preview } from '../lib/base64'
import type { StateStore } from '../types/workflow'
import type { StateItem } from '../types/state'

const STORE_KEY = 'devdash.stateStore'

/**
 * Humanize a byte count for the Size column. One decimal below 100 and none
 * above it, so the widest possible result ("1023 KB") is 7 characters and the
 * fixed-width column never wraps.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${round(kb)} KB`
  return `${round(kb / 1024)} MB`
}

function round(n: number): string {
  return n < 100 ? n.toFixed(1) : n.toFixed(0)
}

/**
 * The Value cell's text. Only base64 rows are affected by the decode toggle,
 * and a preview that will not decode keeps its raw base64 rather than emptying
 * the cell.
 */
function cellValue(rec: StateItem, decode: boolean): string {
  if (!decode || rec.encoding !== 'base64') return rec.preview
  return decodeBase64Preview(rec.preview) ?? rec.preview
}

/**
 * The expanded row's body: the full value plus the metadata the table
 * abbreviates. The value is fetched only while this is mounted.
 */
function RecordPanel({
  recordKey,
  store,
  decode,
}: {
  recordKey: string
  store?: string
  decode: boolean
}) {
  const { data, isLoading, isError } = useStateRecord(recordKey, store)
  const { toast, toastNode } = useToast()

  if (isLoading) {
    return (
      <p className="muted" style={{ padding: 12 }}>
        Loading…
      </p>
    )
  }
  if (isError || !data) {
    return (
      <p className="muted" style={{ padding: 12 }}>
        Couldn't load this value.
      </p>
    )
  }
  // Null when decoding is off, the value is already text, or the bytes yield
  // nothing printable — in every case the raw value is what gets rendered.
  const decoded = decode && data.encoding === 'base64' ? decodeBase64Preview(data.value) : null

  return (
    <div className="panel" data-testid="record-panel">
      {/* .panel > .ph already lays out a header row and pushes .copybtn right. */}
      <div className="ph">
        <span className="mono" style={{ minWidth: 0, wordBreak: 'break-all' }}>
          {data.key}
        </span>
        {/* Copy is always the stored value: the decoded rendering is lossy,
            so copying it would hand over bytes that were never in the store. */}
        <button
          type="button"
          className="copybtn"
          title={decoded ? 'Copy the raw base64, not the decoded rendering' : undefined}
          onClick={() => {
            copyText(data.value)
            toast.show(decoded ? 'Raw value copied' : 'Value copied')
          }}
        >
          {decoded ? '⧉ Copy raw' : '⧉ Copy'}
        </button>
      </div>
      <div style={{ padding: 12 }}>
        <pre className="json" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
          {highlightJson(decoded ?? data.value)}
        </pre>
        <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
          {formatSize(data.size)} · version {data.etag || <span className="faint">—</span>} ·{' '}
          {data.encoding}
          {decoded ? ' · decoded, unprintable bytes shown as ·' : ''}
          {data.contentType ? ` · ${data.contentType}` : ''}
          {data.truncated ? ' · truncated at 1 MB' : ''}
        </div>
      </div>
      {toastNode}
    </div>
  )
}

export function State() {
  const [searchParams, setSearchParams] = useSearchParams()
  useDocumentTitle('State')

  const urlApp = searchParams.get('app') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const urlPage = searchParams.get('page') ?? undefined

  const [selectedApp, setSelectedApp] = useState(urlApp)
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch)
  const [includeInternal, setIncludeInternal] = useState(false)
  const [decodeBase64, setDecodeBase64] = useState(false)
  const [page, setPage] = useState<string | undefined>(urlPage)
  // The API returns only a forward cursor, so Prev is served by stacking the
  // (token, offset) of each page we leave. Empty = on the first page.
  const [history, setHistory] = useState<{ token: string | undefined; offset: number }[]>([])
  const [pageOffset, setPageOffset] = useState(0)
  // Full key of the expanded row, or null. One row at a time: the panel is
  // tall, and two open panels make the table unreadable.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)
  const [deleteStatus, setDeleteStatus] = useState<{ ok: number; failed: number } | null>(null)
  const { mutate: deleteRecords } = useDeleteStateRecords()

  function resetPaging() {
    setPage(undefined)
    setHistory([])
    setPageOffset(0)
    // The expanded row may not exist under the new filter/store/page.
    setExpandedKey(null)
    // Selection is scoped to the visible page, and the selected keys may not
    // exist under a new filter.
    setSelected(new Set())
  }

  // Stores. The dropdown collapses entries that differ only by file path, since
  // they read identical data; the choice is a store id, persisted across reloads.
  const { data: storeList } = useStateStores()
  const storesResolved = storeList !== undefined
  const noStores = storesResolved && storeList.length === 0
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]
  const displayStores = useMemo(() => dedupeStores(storeList ?? []), [storeList])

  // null = not yet determined; the list query stays disabled until it resolves,
  // which avoids a double-fetch on mount.
  const [selectedStore, setSelectedStore] = useState<string | null>(null)
  useEffect(() => {
    if (!displayStores || displayStores.length === 0) return
    if (selectedStore !== null && displayStores.some((s) => s.id === selectedStore)) return
    const persisted = window.localStorage.getItem(STORE_KEY)
    const fromPersisted =
      persisted && displayStores.some((s) => s.id === persisted) ? persisted : undefined
    setSelectedStore(fromPersisted ?? activeStore?.id ?? displayStores[0].id)
  }, [displayStores, activeStore, selectedStore])

  const selectedStoreObj = useMemo(
    () => storeList?.find((s) => s.id === selectedStore),
    [storeList, selectedStore],
  )

  function storeOptionLabel(s: StateStore): string {
    const typeShort = s.type.split('.').pop() ?? s.type
    const head = `${s.name} — ${s.connection ? `${typeShort} · ${s.connection}` : typeShort}`
    return s.active ? `${head} (active)` : head
  }

  function onStoreChange(id: string) {
    setSelectedStore(id)
    window.localStorage.setItem(STORE_KEY, id)
    // A different store has different prefixes — reset the app filter.
    setSelectedApp('')
    resetPaging()
  }

  // Debounce search ~250ms so typing does not fire a request per keystroke.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedSearch(searchInput), 250)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [searchInput])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (selectedApp) params.app = selectedApp
    if (debouncedSearch) params.search = debouncedSearch
    if (page) params.page = page
    setSearchParams(params, { replace: true })
  }, [selectedApp, debouncedSearch, page, setSearchParams])

  const { data, isLoading, isError, error } = useStateRecords({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
    page,
    store: selectedStore ?? undefined,
    includeInternal,
    enabled: selectedStore !== null,
  })

  const { data: storeAppIds } = useStateAppIds({
    store: selectedStore ?? undefined,
    includeInternal,
    enabled: selectedStore !== null,
  })
  const appIds = useMemo(() => storeAppIds ?? [], [storeAppIds])

  // On error, treat the page as empty so the pager reads "No results" and no
  // row-derived UI acts on stale data TanStack Query may have retained.
  const items = useMemo<StateItem[]>(
    () => (isError ? [] : (data?.items ?? [])),
    [isError, data?.items],
  )

  function toggleRow(key: string, e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation() // never expand the row from the checkbox
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation()
    if (selected.size === items.length && items.length > 0) setSelected(new Set())
    else setSelected(new Set(items.map((r) => r.key)))
  }

  function onConfirmDelete() {
    deleteRecords(
      { keys: Array.from(selected), store: selectedStore ?? undefined },
      {
        onSuccess: (results) => {
          setDeleteStatus({
            ok: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
          })
          setSelected(new Set())
          setConfirmOpen(false)
        },
        onError: () => setConfirmOpen(false),
      },
    )
  }

  const allSelected = selected.size === items.length && items.length > 0
  const selectedKeys = Array.from(selected)
  // Decoding is meaningless without a base64 row, so the control only appears
  // when the current page actually has one.
  const hasBase64 = items.some((r) => r.encoding === 'base64')

  if (noStores) {
    return (
      <div className="page">
        <p className="err b">No state store detected</p>
        <p className="muted" style={{ marginTop: 8 }}>
          Configure one with the <span className="mono">--statestore</span> flag or add a state
          store component.
        </p>
      </div>
    )
  }

  // Any load error degrades gracefully: the chrome stays usable so the user can
  // switch to a reachable store.
  let loadError: string | null = null
  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      const extracted = errStr
        .replace(/^.*?503[:\s]+/, '')
        .replace(/\s*for\s+\/\S*$/, '')
        .trim()
      loadError = extracted && extracted !== errStr ? extracted : 'state store unavailable'
    } else {
      loadError = `Error loading state records: ${errStr}`
    }
  }

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>State records</h1>
          <div className="sub">
            {appIds.length > 0
              ? `Across ${appIds.length} prefix${appIds.length !== 1 ? 'es' : ''}`
              : 'Browse, add and delete records'}
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
                {displayStores.map((s) => (
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
              {/* A store we cannot read is a store we should not write to: the
                  key it would refuse or clobber is unknowable from here. */}
              <button
                type="button"
                className="btn primary"
                disabled={selectedStore === null || isError}
                onClick={() => setCreateOpen(true)}
              >
                + New record
              </button>
            </>
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
        </div>
      </div>

      {loadError && (
        <div className="banner danger" data-testid="load-error-banner">
          {loadError} — Select another state store or check the connection.
          {selectedStoreObj?.secretIssue && ` ${selectedStoreObj.secretIssue}`}
        </div>
      )}

      {deleteStatus && (
        <div className={deleteStatus.failed > 0 ? 'banner danger' : 'banner ok'}>
          Deleted {deleteStatus.ok} record{deleteStatus.ok !== 1 ? 's' : ''}
          {deleteStatus.failed > 0 ? `, ${deleteStatus.failed} failed` : ''}.{' '}
          <button className="banner-dismiss" onClick={() => setDeleteStatus(null)}>
            Dismiss
          </button>
        </div>
      )}

      <div className="filters">
        <select
          className="select"
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
            <option value={selectedApp}>{selectedApp}</option>
          )}
          {appIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <label className="search">
          🔍
          <input
            placeholder="Search key…"
            aria-label="Search key"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value)
              resetPaging()
            }}
          />
        </label>

        <label className="childtoggle">
          <input
            type="checkbox"
            aria-label="Show internal keys"
            checked={includeInternal}
            onChange={(e) => {
              setIncludeInternal(e.target.checked)
              resetPaging()
            }}
          />
          Show internal keys
        </label>

        {hasBase64 && (
          <label className="childtoggle">
            <input
              type="checkbox"
              aria-label="Decode base64"
              checked={decodeBase64}
              onChange={(e) => setDecodeBase64(e.target.checked)}
            />
            Decode base64
          </label>
        )}
      </div>

      <div className="card">
        {selected.size > 0 && !isError && (
          <div className="selbar">
            <span className="cnt">{selected.size} selected</span>
            <span className="grow" />
            <button
              className="btn danger"
              data-cy="bulk-delete"
              onClick={() => {
                setDeleteStatus(null)
                setConfirmOpen(true)
              }}
            >
              Delete…
            </button>
          </div>
        )}
        <div className="tablewrap">
          {isLoading || (!noStores && selectedStore === null) ? (
            <p className="muted" style={{ padding: 20 }}>
              Loading…
            </p>
          ) : isError ? (
            <p className="muted" style={{ padding: 20 }}>
              Couldn't load state records from this store.
            </p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ padding: 20 }}>
              No state records found
            </p>
          ) : (
            <table className="wf statetbl">
              <thead>
                <tr>
                  <th className="c-sel">
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
                          toggleAll(e)
                        }
                      }}
                    />
                  </th>
                  <th className="c-key">Key</th>
                  <th className="c-app">App</th>
                  <th className="c-val">Value</th>
                  <th className="c-size">Size</th>
                  <th className="c-ver">Version</th>
                  <th className="c-ttl">TTL</th>
                </tr>
              </thead>
              <tbody>
                {items.map((rec) => {
                  const expanded = expandedKey === rec.key
                  return (
                    <Fragment key={rec.key}>
                      <tr
                        className={expanded ? 'sel' : undefined}
                        onClick={() => setExpandedKey(expanded ? null : rec.key)}
                      >
                        <td>
                          <span
                            className={selected.has(rec.key) ? 'cbx on' : 'cbx'}
                            role="checkbox"
                            aria-checked={selected.has(rec.key)}
                            aria-label={`Select ${rec.key}`}
                            tabIndex={0}
                            onClick={(e) => toggleRow(rec.key, e)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleRow(rec.key, e)
                              }
                            }}
                          />
                        </td>
                        <td className="iid mono wrapany">
                          <span aria-hidden="true" style={{ marginRight: 6 }}>
                            {expanded ? '▾' : '▸'}
                          </span>
                          {rec.logicalKey}
                          {rec.kind !== 'app' && (
                            <span className="typechip" style={{ marginLeft: 6 }}>
                              {rec.kind}
                            </span>
                          )}
                        </td>
                        <td>{rec.appId || <span className="faint">—</span>}</td>
                        <td className="mono wrapany">
                          {cellValue(rec, decodeBase64)}
                          {rec.encoding === 'base64' && (
                            <span className="typechip" style={{ marginLeft: 6 }}>
                              base64
                            </span>
                          )}
                        </td>
                        <td className="mono tabnum">{formatSize(rec.size)}</td>
                        <td
                          className="mono tabnum"
                          title="Backend revision counter (etag) — it changes on every write, but is not a timestamp"
                        >
                          {rec.etag || <span className="faint">—</span>}
                        </td>
                        <td className="muted mono tabnum dt">
                          <DateTimeCell ts={rec.ttlExpiresAt} />
                        </td>
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--surface)' }}>
                            <RecordPanel
                              recordKey={rec.key}
                              store={selectedStore ?? undefined}
                              decode={decodeBase64}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

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
                setExpandedKey(null)
                setSelected(new Set())
              }}
            >
              ← Prev
            </button>
            <button
              disabled={isError || !data?.nextToken}
              onClick={() => {
                if (!data?.nextToken) return
                setHistory((h) => [...h, { token: page, offset: pageOffset }])
                setPageOffset((o) => o + items.length)
                setPage(data.nextToken)
                setExpandedKey(null)
                setSelected(new Set())
              }}
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      <p className="hint">
        Tip — a new record is stored under the key <span className="mono">&lt;app-id&gt;||&lt;key&gt;</span>,
        the same shape Dapr writes. Use “Show internal keys” to reveal workflow history and actor
        state.
      </p>

      <NewStateRecordDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        store={selectedStore ?? undefined}
        appIds={appIds}
        defaultAppId={selectedApp || undefined}
      />

      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${selected.size} record${selected.size !== 1 ? 's' : ''}?`}
        confirmLabel="Delete"
        confirmDataCy="confirm-delete-state"
        onConfirm={onConfirmDelete}
        onCancel={() => setConfirmOpen(false)}
      >
        <p className="muted">
          These records will be removed from the state store immediately. This cannot be undone.
        </p>
        <ul className="mono" style={{ fontSize: 12, marginTop: 8 }}>
          {selectedKeys.slice(0, 5).map((k) => (
            <li key={k} style={{ wordBreak: 'break-all' }}>
              {k}
            </li>
          ))}
          {selectedKeys.length > 5 && (
            <li className="muted">…and {selectedKeys.length - 5} more</li>
          )}
        </ul>
      </ConfirmDialog>
    </div>
  )
}
