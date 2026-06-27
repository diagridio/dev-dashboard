import { useEffect } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSubscriptions } from '../hooks/useResources'

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

const rulesBadgeStyle: React.CSSProperties = {
  display: 'inline-block',
  marginLeft: 'var(--space-2)',
  padding: '1px 6px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: 'calc(var(--font) - 1px)',
  color: 'var(--text-muted)',
  verticalAlign: 'middle',
}

export function Subscriptions() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appIdFilter = searchParams.get('appId') ?? undefined

  useEffect(() => {
    document.title = appIdFilter ? `Subscriptions — ${appIdFilter}` : 'Subscriptions'
  }, [appIdFilter])

  const { data: subscriptions, isLoading } = useSubscriptions(appIdFilter)

  function clearFilter() {
    setSearchParams({})
  }

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
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

  if (!subscriptions || subscriptions.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        {filterBadge}
        <p style={{ color: 'var(--text-muted)' }}>No subscriptions</p>
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
              <th style={thStyle}>Pub/Sub</th>
              <th style={thStyle}>Topic</th>
              <th style={thStyle}>Route(s)</th>
              <th style={thStyle}>Dead-letter</th>
              <th style={thStyle}>Type</th>
            </tr>
          </thead>
          <tbody>
            {subscriptions.map((sub) => {
              const rules = sub.rules ?? []
              const firstPath = rules[0]?.path
              const hasMultipleRules = rules.length > 1

              return (
                <tr key={`${sub.appId}/${sub.pubsubName}/${sub.topic}`}>
                  <td style={tdStyle}>
                    <Link className="mono" to={`/apps/${sub.appId}`}>
                      {sub.appId}
                    </Link>
                  </td>
                  <td style={tdStyle} className="mono">
                    {sub.pubsubName}
                  </td>
                  <td style={tdStyle} className="mono">
                    {sub.topic}
                  </td>
                  <td style={tdStyle} className="mono">
                    {firstPath ?? '—'}
                    {hasMultipleRules && (
                      <span style={rulesBadgeStyle}>
                        {rules.length} rules
                      </span>
                    )}
                  </td>
                  <td style={tdStyle} className="mono">
                    {sub.deadLetterTopic ?? '—'}
                  </td>
                  <td style={tdStyle}>
                    {sub.type ?? '—'}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
