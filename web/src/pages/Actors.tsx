import { Link, useSearchParams } from 'react-router-dom'
import { useActors } from '../hooks/useResources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { LiveIndicator } from '../components/LiveIndicator'
import type { Actor } from '../types/resources'

const INTERNAL_PREFIX = 'dapr.internal'

export function Actors() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appIdFilter = searchParams.get('appId') ?? undefined

  useDocumentTitle(appIdFilter ? `Actors — ${appIdFilter}` : 'Actors')

  const { data: actors, isLoading } = useActors(appIdFilter)

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
      <LiveIndicator />
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
  const hostingApps = new Set(actors.map((a) => a.appId)).size

  return (
    <div className="page">
      {header}
      <div className="stats">
        <div className="stat">
          {/* ​ (zero-width space) prevents DOM textContent collision with table cell values in tests */}
          <div className="n mint">{activeActors}{'​'}</div>
          <div className="l">Active actors</div>
        </div>
        <div className="stat">
          <div className="n">{actorTypes}{'​'}</div>
          <div className="l">Actor types</div>
        </div>
        <div className="stat">
          <div className="n">{hostingApps}{'​'}</div>
          <div className="l">Hosting apps</div>
        </div>
        <div className="stat">
          <div className="n">
            <span className="health">
              <span className="led ok" />
            </span>
          </div>
          <div className="l">Placement</div>
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
                <th>Idle timeout</th>
                <th>Reminders</th>
                <th>Placement</th>
              </tr>
            </thead>
            <tbody>
              {actors.map((actor) => (
                <ActorRow key={`${actor.appId}/${actor.type}`} actor={actor} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">
        Dapr Workflow runs on internal actor types (<span className="mono">workflow</span> /{' '}
        <span className="mono">activity</span>) — tagged with the{' '}
        <span className="tag-int" aria-label="internal">int</span> badge and shown for completeness.
      </p>
    </div>
  )
}

function ActorRow({ actor }: { actor: Actor }) {
  const isInternal = actor.type.toLowerCase().includes(INTERNAL_PREFIX)
  return (
    <tr>
      <td className="b">
        <Link to={`/apps/${actor.appId}`}>{actor.appId}</Link>
      </td>
      <td className="mono">
        {actor.type}
        {isInternal && <span className="tag-int">internal</span>}
      </td>
      <td className="mono tabnum b">{actor.count}</td>
      <td className="mono faint">—</td>
      <td className="mono faint">—</td>
      <td>
        {actor.placement ? (
          <span className="health">
            <span className="led ok" /> connected
          </span>
        ) : (
          <span className="none">—</span>
        )}
      </td>
    </tr>
  )
}
