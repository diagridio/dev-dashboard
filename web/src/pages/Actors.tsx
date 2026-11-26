import { Fragment, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useActors } from '../hooks/useResources'
import { InvokeActorDialog } from '../components/InvokeActorDialog'
import { actorPath } from '../lib/actorRecents'
import { reentrancyLabel } from '../lib/actorFormat'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { Actor } from '../types/resources'

const rowKey = (a: Actor) => a.instanceKey || a.appId
const hostReady = (a: Actor) => a.placement === 'placement: connected' && a.hostReady


export function Actors() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appIdFilter = searchParams.get('appId') ?? undefined

  useDocumentTitle(appIdFilter ? `Actors — ${appIdFilter}` : 'Actors')

  const { data: actors, isLoading } = useActors(appIdFilter)
  const [invokeTarget, setInvokeTarget] = useState<Actor | null>(null)

  function clearFilter() {
    setSearchParams({})
  }

  const filterChip = appIdFilter ? (
    <span className="chip">
      filtered to {appIdFilter}
      <button
        aria-label="Clear filter"
        onClick={clearFilter}
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0, color: 'inherit', font: 'inherit', lineHeight: 1 }}
      >
        ×
      </button>
    </span>
  ) : null

  const header = (
    <div className="phead">
      <div>
        <h1>Actors</h1>
        <div className="sub">
          Active actor types across all hosts · from <span className="mono">/v1.0/metadata</span>
        </div>
        {filterChip}
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

  if (!actors || actors.length === 0) {
    return (
      <div className="page">
        {header}
        <p className="muted">No actors registered</p>
      </div>
    )
  }

  const activeActors = actors.reduce((sum, a) => sum + (a.count || 0), 0)
  const actorTypes = new Set(actors.map((a) => a.type)).size
  const hostingApps = new Set(actors.map(rowKey)).size
  const hosts = new Map<string, boolean>()
  for (const a of actors) hosts.set(rowKey(a), (hosts.get(rowKey(a)) ?? true) && hostReady(a))
  const notReady = [...hosts].filter(([, ok]) => !ok).map(([k]) => k)
  const readyCount = hosts.size - notReady.length
  const placementLed = notReady.length === 0 ? 'ok' : readyCount > 0 ? 'warn' : 'bad'
  const placementTitle =
    notReady.length === 0 ? 'All hosts connected to placement' : `Not ready: ${notReady.join(', ')}`

  return (
    <div className="page">
      {header}
      <div className="stats">
        <div className="stat">
          <div className="n">{activeActors}</div>
          <div className="l">Active actors</div>
        </div>
        <div className="stat">
          <div className="n">{actorTypes}</div>
          <div className="l">Actor types</div>
        </div>
        <div className="stat">
          <div className="n">{hostingApps}</div>
          <div className="l">Hosting apps</div>
        </div>
        <div className="stat" title={placementTitle}>
          <div className="n">
            <span className="health">
              <span className={`led ${placementLed}`} />
              <span className="tabnum" style={{ marginLeft: 6 }}>
                {readyCount}/{hosts.size}
              </span>
            </span>
          </div>
          <div className="l">Placement connected</div>
        </div>
      </div>
      <div className="card">
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>Host app</th>
                <th>Actor type</th>
                <th>Active</th>
                <th>
                  Idle
                  <br />
                  timeout
                </th>
                <th>Reentrancy</th>
                <th>Reminders</th>
                <th>Placement</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {actors.map((actor) => (
                <ActorRow
                  key={`${rowKey(actor)}/${actor.type}`}
                  actor={actor}
                  onInvoke={() => setInvokeTarget(actor)}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">
        Dapr Workflow runs on internal actor types (<span className="mono">workflow</span> /{' '}
        <span className="mono">activity</span>) — tagged <span className="tag-int">internal</span> and
        shown for completeness.
      </p>
      {invokeTarget && (
        <InvokeActorDialog
          open
          onClose={() => setInvokeTarget(null)}
          appKey={rowKey(invokeTarget)}
          appId={invokeTarget.appId}
          actorType={invokeTarget.type}
        />
      )}
    </div>
  )
}

function Dash({ reason }: { reason?: string }) {
  return (
    <span className="none" title={reason}>
      —
    </span>
  )
}

/** Renders a dotted name with a line-break opportunity after each dot, so long
 * internal actor types (dapr.internal.<ns>.<app>.workflow) wrap at the dots. */
function DotBreaks({ text }: { text: string }) {
  const parts = text.split('.')
  return (
    <>
      {parts.map((p, i) => (
        <Fragment key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              .<wbr />
            </>
          )}
        </Fragment>
      ))}
    </>
  )
}

function ActorRow({ actor, onInvoke }: { actor: Actor; onInvoke: () => void }) {
  const key = rowKey(actor)
  const cfg = actor.config
  const disabled = actor.runtimeStatus === 'DISABLED'
  return (
    <tr>
      <td className="b">
        <Link className="celllink" to={`/apps/${key}`}>
          {actor.appId}
          {key !== actor.appId && (
            <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({key})</span>
          )}
        </Link>
      </td>
      <td className="mono">
        <Link className="celllink" to={actorPath(key, actor.type)}>
          <DotBreaks text={actor.type} />
        </Link>
        {actor.internal && <span className="tag-int">internal</span>}
      </td>
      <td className="mono tabnum b">{actor.count}</td>
      <td className="mono tabnum">
        {cfg ? (
          cfg.idleTimeoutDefault ? `${cfg.idleTimeout} (default)` : cfg.idleTimeout
        ) : (
          <Dash reason={actor.configUnavailable?.reason} />
        )}
      </td>
      <td className="mono tabnum reent nowrap">
        {cfg ? reentrancyLabel(cfg.reentrancy) : <Dash reason={actor.configUnavailable?.reason} />}
      </td>
      <td className="mono tabnum">
        {actor.reminders !== undefined ? actor.reminders : <Dash reason={actor.remindersUnavailable?.reason} />}
      </td>
      <td>
        {disabled ? (
          <span className="muted">actors disabled</span>
        ) : actor.placement ? (
          <span className="health">
            <span className={`led ${hostReady(actor) ? 'ok' : 'bad'}`} />{' '}
            {hostReady(actor) ? 'connected' : 'not ready'}
          </span>
        ) : (
          <Dash />
        )}
      </td>
      <td className="nowrap">
        {!actor.internal && (
          <button type="button" className="btn ghost" onClick={onInvoke}>
            Invoke
          </button>
        )}
      </td>
    </tr>
  )
}
