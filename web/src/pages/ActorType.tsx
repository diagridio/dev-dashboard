import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { InvokeActorDialog } from '../components/InvokeActorDialog'
import { useActorType } from '../hooks/useActors'
import { actorPath, recentIds } from '../lib/actorRecents'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { ActorID } from '../types/actors'
import { reentrancyLabel } from '../lib/actorFormat'

export function ActorType() {
  const { appId: appKey = '', actorType = '' } = useParams()
  const [search, setSearch] = useState('')
  const [invokeOpen, setInvokeOpen] = useState(false)
  useDocumentTitle(`${actorType} — Actors`)

  const { data, isLoading, error } = useActorType(appKey, actorType)

  const header = (
    <div className="phead">
      <div>
        <h1 className="mono">{actorType}</h1>
        <div className="sub">
          <Link className="celllink" to="/actors">Actors</Link> · hosted by{' '}
          <Link className="celllink" to={`/apps/${encodeURIComponent(appKey)}`}>{data?.appId ?? appKey}</Link>
        </div>
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
        <p className="muted">{error ? error.message : 'Actor type not found'}</p>
      </div>
    )
  }

  const listed = new Set(data.ids.map((i) => i.id))
  const rows: (ActorID & { recent?: boolean })[] = [
    ...data.ids,
    ...recentIds(appKey, actorType)
      .filter((id) => !listed.has(id))
      .map((id) => ({ id, stateKeys: -1, reminders: -1, sources: ['recent'], recent: true })),
  ]
  const cfg = data.config
  const cfgReason = data.configUnavailable?.reason

  const query = search.trim()
  // Dapr can't list every actor, so when nothing listed matches, the typed ID can still be opened.
  const shown = query ? rows.filter((r) => r.id.toLowerCase().includes(query.toLowerCase())) : rows

  return (
    <div className="page">
      {header}
      <div className="stats">
        <div className="stat">
          <div className="n">{data.count}</div>
          <div className="l">Active actors</div>
        </div>
        <div className="stat" title={cfg ? undefined : cfgReason}>
          <div className="n">
            {cfg ? (cfg.idleTimeoutDefault ? `${cfg.idleTimeout} (default)` : cfg.idleTimeout) : '—'}
          </div>
          <div className="l">Idle timeout</div>
        </div>
        <div className="stat" title={cfg ? undefined : cfgReason}>
          <div className="n">{cfg ? reentrancyLabel(cfg.reentrancy) : '—'}</div>
          <div className="l">Reentrancy</div>
        </div>
        <div className="stat" title={data.reminders === undefined ? data.remindersUnavailable?.reason : undefined}>
          <div className="n">{data.reminders ?? '—'}</div>
          <div className="l">Reminders</div>
        </div>
      </div>
      <p className="hint">
        Dapr doesn&apos;t list active actor IDs. This list shows actors with state or reminders.
      </p>
      <div className="filters">
        <label className="search">
          🔍
          <input
            placeholder="Search actor ID…"
            aria-label="Search actor ID"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {!data.internal && (
          <button type="button" className="btn ghost" onClick={() => setInvokeOpen(true)}>
            Invoke
          </button>
        )}
      </div>
      {data.stateUnavailable && (
        <p className="muted">
          {data.stateUnavailable.reason} <Link className="celllink" to="/state">Open State</Link>
        </p>
      )}
      {data.truncated && (
        <p className="muted">
          Showing the first {data.ids.length} actors found in state. Search for an ID to open one that isn&apos;t listed.
        </p>
      )}
      <div className="card">
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>Actor ID</th>
                <th>State keys</th>
                <th>Reminders</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">{query ? 'No listed actor IDs match' : 'No actors found'}</td>
                </tr>
              )}
              {query && shown.length === 0 && (
                <tr>
                  <td colSpan={4}>
                    <Link className="celllink mono" to={actorPath(appKey, actorType, query)}>
                      Open actor {query}
                    </Link>
                  </td>
                </tr>
              )}
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="mono b">
                    <Link className="celllink" to={actorPath(appKey, actorType, r.id)}>{r.id}</Link>
                  </td>
                  <td className="mono tabnum">{r.stateKeys >= 0 ? r.stateKeys : <Dash />}</td>
                  <td className="mono tabnum">{r.reminders >= 0 ? r.reminders : <Dash />}</td>
                  <td>
                    {r.sources.map((s) => (
                      <span key={s} className="chip">{s}</span>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {!data.internal && (
        <InvokeActorDialog
          open={invokeOpen}
          onClose={() => setInvokeOpen(false)}
          appKey={appKey}
          appId={data.appId}
          actorType={actorType}
          suggestedIds={data.ids.map((i) => i.id)}
        />
      )}
    </div>
  )
}

function Dash() {
  return (
    <span className="none" title="not listed in state or reminders">
      —
    </span>
  )
}
