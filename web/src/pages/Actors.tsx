import { Link, useSearchParams } from 'react-router-dom'
import { useActors } from '../hooks/useResources'
import { useDocumentTitle } from '../lib/useDocumentTitle'

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

export function Actors() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appIdFilter = searchParams.get('appId') ?? undefined

  useDocumentTitle(appIdFilter ? `Actors — ${appIdFilter}` : 'Actors')

  const { data: actors, isLoading } = useActors(appIdFilter)

  function clearFilter() {
    setSearchParams({})
  }

  const filterBadge = appIdFilter ? (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 'var(--space-2)',
        marginBottom: 'var(--space-3)',
        padding: '2px 10px',
        borderRadius: 10,
        border: '1px solid var(--border)',
        background: 'var(--surface)',
        fontSize: 'var(--font)',
        color: 'var(--text-muted)',
      }}
    >
      filtered to {appIdFilter}
      <button
        aria-label="Clear filter"
        onClick={clearFilter}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          padding: 0,
          color: 'var(--text-muted)',
          fontSize: 'var(--font)',
          lineHeight: 1,
        }}
      >
        ✕
      </button>
    </div>
  ) : null

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        {filterBadge}
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (!actors || actors.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        {filterBadge}
        <p style={{ color: 'var(--text-muted)' }}>No actors registered</p>
      </div>
    )
  }

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {filterBadge}
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>App</th>
              <th style={thStyle}>Actor type</th>
              <th style={thStyle}>Active count</th>
              <th style={thStyle}>Placement</th>
            </tr>
          </thead>
          <tbody>
            {actors.map((actor) => (
              <tr key={`${actor.appId}/${actor.type}`}>
                <td style={tdStyle}>
                  <Link className="mono" to={`/apps/${actor.appId}`}>
                    {actor.appId}
                  </Link>
                </td>
                <td style={tdStyle}>{actor.type}</td>
                <td style={tdStyle} className="mono">
                  {actor.count}
                </td>
                <td style={tdStyle} className="mono">
                  {actor.placement ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
