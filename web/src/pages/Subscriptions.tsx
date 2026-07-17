import { useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useSubscriptions } from '../hooks/useResources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { Subscription } from '../types/resources'

export function Subscriptions() {
  const [searchParams, setSearchParams] = useSearchParams()
  const appIdFilter = searchParams.get('appId') ?? undefined

  useDocumentTitle(appIdFilter ? `Subscriptions — ${appIdFilter}` : 'Subscriptions')

  const { data: subscriptions, isLoading } = useSubscriptions(appIdFilter)

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
        <h1>Subscriptions</h1>
        <div className="sub">
          Pub/Sub subscriptions across all running apps · from <span className="mono">/v1.0/metadata</span>
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

  if (!subscriptions || subscriptions.length === 0) {
    return (
      <div className="page">
        {header}
        <p className="muted">No subscriptions</p>
      </div>
    )
  }

  return (
    <div className="page">
      {header}
      <div className="card">
        <div className="tablewrap">
          <table className="t">
            <thead>
              <tr>
                <th>App</th>
                <th>Pub/Sub</th>
                <th>Topic</th>
                <th>Route(s)</th>
                <th>Type</th>
                <th>Dead-letter topic</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <SubscriptionRow key={`${sub.instanceKey ?? sub.appId}/${sub.pubsubName}/${sub.topic}`} sub={sub} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">
        Topics with routing rules show a <span className="rulebadge">rules</span> badge — click it to inspect match expressions.
      </p>
    </div>
  )
}

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const [expanded, setExpanded] = useState(false)
  const rules = sub.rules ?? []
  const firstPath = rules[0]?.path
  const hasMultipleRules = rules.length > 1
  const key = sub.instanceKey ?? sub.appId

  return (
    <>
      <tr>
        <td className="b">
          <Link to={`/apps/${key}`}>
            {sub.appId}
            {key !== sub.appId && (
              <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({key})</span>
            )}
          </Link>
        </td>
        <td className="mono">{sub.pubsubName}</td>
        <td className="mono">{sub.topic}</td>
        <td>
          {firstPath ? <span className="route">{firstPath}</span> : <span className="none">—</span>}
          {hasMultipleRules && (
            <button
              type="button"
              className="rulebadge"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {rules.length} rules
            </button>
          )}
        </td>
        <td>{sub.type ? <span className="badge">{sub.type}</span> : <span className="none">—</span>}</td>
        <td>
          {sub.deadLetterTopic ? (
            <span className="dlq">{sub.deadLetterTopic}</span>
          ) : (
            <span className="none">—</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="subrules">
          <td colSpan={6}>
            <ul className="rulelist">
              {rules.map((r, i) => (
                <li key={i}>
                  <span className="mono">{r.match || '(default)'}</span>
                  {' → '}
                  <span className="route">{r.path}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}
