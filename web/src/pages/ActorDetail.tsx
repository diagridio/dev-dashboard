import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ConfirmDialog } from '../components/ConfirmDialog'
import { InvokeActorDialog } from '../components/InvokeActorDialog'
import { useActorDetail, useDeleteReminder } from '../hooks/useActors'
import { useStateRecord } from '../hooks/useStateRecords'
import { actorStateKey, isInternalActorType } from '../lib/actorFormat'
import { actorPath, rememberId } from '../lib/actorRecents'
import { getCapabilities } from '../lib/capabilities'
import { formatBytes } from '../lib/formatBytes'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { Scheduled } from '../types/actors'
import type { StateItem } from '../types/state'

export function ActorDetail() {
  const { appId: appKey = '', actorType = '', actorId = '' } = useParams()
  const [invokeOpen, setInvokeOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string | null>(null)
  const internal = isInternalActorType(actorType)
  const stateEnabled = getCapabilities().state !== false
  useDocumentTitle(`${actorType}/${actorId} — Actors`)

  const { data, isLoading, error } = useActorDetail(appKey, actorType, actorId)
  const del = useDeleteReminder(appKey, actorType, actorId)
  const loaded = data !== undefined

  // An opened actor counts as recent, alongside invoked ones.
  useEffect(() => {
    if (loaded) rememberId(appKey, actorType, actorId)
  }, [loaded, appKey, actorType, actorId])

  const header = (
    <div className="phead">
      <div>
        <h1 className="mono">{actorId}</h1>
        <div className="sub">
          <Link className="celllink" to="/actors">Actors</Link> ·{' '}
          <Link className="celllink" to={actorPath(appKey, actorType)}>{actorType}</Link> · hosted by{' '}
          <Link className="celllink" to={`/apps/${encodeURIComponent(appKey)}`}>{data?.appId ?? appKey}</Link>
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <Link className="btn ghost" to={`/logs?app=${encodeURIComponent(data?.appId ?? appKey)}&source=app`}>
          View logs
        </Link>
        {!internal && (
          <button type="button" className="btn ghost" onClick={() => setInvokeOpen(true)}>Invoke</button>
        )}
      </div>
    </div>
  )

  if (isLoading) {
    return (
      <div className="page">
        {header}
        <p className="muted">Loading…</p>
      </div>
    )
  }
  if (error || !data) {
    return (
      <div className="page">
        {header}
        <p className="muted">{error ? error.message : 'Actor not found'}</p>
      </div>
    )
  }

  function confirmDelete() {
    const name = pendingDelete
    if (name === null) return
    del.mutate(name, { onSettled: () => setPendingDelete(null) })
  }

  return (
    <div className="page">
      {header}

      <h2 className="sec-title">State</h2>
      {data.stateUnavailable ? (
        <p className="muted">
          {data.stateUnavailable.reason}
          {stateEnabled && (
            <>
              {' '}
              <Link className="celllink" to="/state">Open State</Link>
            </>
          )}
        </p>
      ) : (
        <>
          {data.stateTruncated && (
            <p className="hint">Only part of the state store was scanned; this actor may have more keys.</p>
          )}
          <div className="card">
            <div className="tablewrap">
              <table className="t">
                <thead>
                  <tr>
                    <th>Key</th>
                    <th>Preview</th>
                    <th>Size</th>
                  </tr>
                </thead>
                <tbody>
                  {data.state.length === 0 && (
                    <tr>
                      <td colSpan={3} className="muted">No state</td>
                    </tr>
                  )}
                  {data.state.map((item) => (
                    <StateRow key={item.key} item={item} type={actorType} id={actorId} store={data.storeId} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <h2 className="sec-title">Reminders</h2>
      {data.remindersUnavailable ? (
        <p className="muted">{data.remindersUnavailable.reason}</p>
      ) : (
        <ScheduledTable
          rows={data.reminders}
          empty="No reminders"
          onDelete={internal ? undefined : (name) => setPendingDelete(name)}
        />
      )}
      {del.error && <p className="field-err">{del.error.message}</p>}

      <h2 className="sec-title">Timers</h2>
      {data.timersUnavailable ? (
        <p className="muted">{data.timersUnavailable.reason}</p>
      ) : (
        <ScheduledTable rows={data.timers} empty="No timers" />
      )}

      <InvokeActorDialog
        open={invokeOpen}
        onClose={() => setInvokeOpen(false)}
        appKey={appKey}
        appId={data.appId}
        actorType={actorType}
        actorId={actorId}
      />
      <ConfirmDialog
        open={pendingDelete !== null}
        title={`Delete reminder ${pendingDelete ?? ''}?`}
        confirmLabel="Confirm"
        busy={del.isPending}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  )
}

function StateRow({ item, type, id, store }: { item: StateItem; type: string; id: string; store?: string }) {
  const [open, setOpen] = useState(false)
  const rec = useStateRecord(item.key, store, open)
  return (
    <>
      <tr
        className={open ? 'sel' : undefined}
        style={{ cursor: 'pointer' }}
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((o) => !o)
          }
        }}
      >
        <td className="mono b">
          <span aria-hidden="true" style={{ marginRight: 6 }}>
            {open ? '▾' : '▸'}
          </span>
          {actorStateKey(item.logicalKey, type, id)}
        </td>
        <td className="mono">{item.preview}</td>
        <td className="mono tabnum">{formatBytes(item.size)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={3} style={{ background: 'var(--surface)' }}>
            {rec.isLoading && <span className="muted">Loading…</span>}
            {rec.error && <span className="muted">{rec.error.message}</span>}
            {rec.data && (
              <pre className="mono" style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                {rec.data.value}
              </pre>
            )}
          </td>
        </tr>
      )}
    </>
  )
}

function ScheduledTable({
  rows,
  empty,
  onDelete,
}: {
  rows: Scheduled[]
  empty: string
  onDelete?: (name: string) => void
}) {
  // Reminders and timers share one fixed column layout (table.sched + colgroup) so the two
  // tables line up. Reminders have no callback and timers have no Delete; those cells stay empty.
  return (
    <div className="card">
      <div className="tablewrap">
        <table className="t sched">
          <colgroup>
            <col className="c-name" />
            <col className="c-due" />
            <col className="c-period" />
            <col className="c-ttl" />
            <col className="c-cb" />
            <col className="c-data" />
            <col className="c-act" />
          </colgroup>
          <thead>
            <tr>
              <th>Name</th>
              <th>Due time</th>
              <th>Period</th>
              <th>TTL</th>
              <th>Callback</th>
              <th>Data</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">{empty}</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr key={r.name}>
                <td className="mono b">{r.name}</td>
                <td className="mono tabnum">{r.dueTime || '—'}</td>
                <td className="mono tabnum">{r.period || '—'}</td>
                <td className="mono tabnum">{r.ttl || '—'}</td>
                <td className="mono">{r.callback || '—'}</td>
                <td className="mono wrapany">
                  {r.data ? r.data : '—'}
                  {r.data && r.dataEncoding === 'base64' && <span className="chip">base64</span>}
                </td>
                <td>
                  {onDelete && (
                    <button type="button" className="btn ghost" onClick={() => onDelete(r.name)}>
                      Delete
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
