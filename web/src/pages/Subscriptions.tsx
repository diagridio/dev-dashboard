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
                <th>Dead-letter topic</th>
                <th>Scopes</th>
              </tr>
            </thead>
            <tbody>
              {subscriptions.map((sub) => (
                <SubscriptionRow key={`${sub.appId}/${sub.pubsubName}/${sub.topic}`} sub={sub} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">
        Topics with routing rules show a <span className="rulebadge">rules</span> badge — open a row in the real app to inspect match expressions.
      </p>
    </div>
  )
}

function SubscriptionRow({ sub }: { sub: Subscription }) {
  const rules = sub.rules ?? []
  const firstPath = rules[0]?.path
  const hasMultipleRules = rules.length > 1
  const scopes = sub.scopes ?? []

  return (
    <tr>
      <td className="b">
        <Link to={`/apps/${sub.appId}`}>{sub.appId}</Link>
      </td>
      <td className="mono">{sub.pubsubName}</td>
      <td className="mono">{sub.topic}</td>
      <td>
        {firstPath ? <span className="route">{firstPath}</span> : <span className="none">—</span>}
        {hasMultipleRules && <span className="rulebadge">{rules.length} rules</span>}
      </td>
      <td>
        {sub.deadLetterTopic ? (
          <span className="dlq">{sub.deadLetterTopic}</span>
        ) : (
          <span className="none">—</span>
        )}
      </td>
      <td>
        {scopes.length > 0 ? (
          scopes.map((s) => <span key={s} className="appref">{s}</span>)
        ) : (
          <span className="none">—</span>
        )}
      </td>
    </tr>
  )
}
