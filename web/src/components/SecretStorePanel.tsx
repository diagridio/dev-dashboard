import { Link } from 'react-router-dom'
import type { SecretStoreInfo } from '../types/resources'

export function SecretStorePanel({ info }: { info: SecretStoreInfo }) {
  const isEnv = info.type === 'secretstores.local.env'
  const noPrefix = isEnv && !info.prefix

  return (
    <div className="panel" style={{ marginBottom: 12 }}>
      <div className="ph">Secret store</div>
      <div className="kv">
        {!isEnv && (
          <>
            <div className="kk">Secrets file</div>
            <div className="vv mono">{info.file || '—'}</div>
          </>
        )}
        {isEnv && (
          <>
            <div className="kk">Prefix</div>
            <div className="vv mono">{info.prefix || '(none)'}</div>
          </>
        )}
        {info.initErr && (
          <>
            <div className="kk">Error</div>
            <div className="vv"><span className="field-err">{info.initErr}</span></div>
          </>
        )}
        {!isEnv && info.nestedSeparator && (
          <>
            <div className="kk">Nested separator</div>
            <div className="vv mono">{info.nestedSeparator}</div>
            <div className="kk">Multi-valued</div>
            <div className="vv">{info.multiValued ? 'Yes' : 'No'}</div>
          </>
        )}
        <div className="kk">Keys</div>
        <div className="vv" style={{ flexWrap: 'wrap', gap: 6 }}>
          {!isEnv && info.nestedSeparator && (
            <span style={{ width: '100%', color: 'var(--muted)', fontSize: 12 }}>
              {info.multiValued
                ? "Each top-level key is itself a secret; use secretKeyRef's key field to select one of its own keys."
                : `Nested JSON keys are flattened with \`${info.nestedSeparator}\` — reference the full path (e.g. \`redis${info.nestedSeparator}password\`), not the parent key.`}
            </span>
          )}
          {noPrefix ? (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>
              Set a prefix on this store to list its keys — without one, every environment
              variable would be listed.
            </span>
          ) : info.keys?.length ? (
            <>
              {info.keys.map((k) => <span key={k} className="chip mono">{k}</span>)}
              {info.keysCapped && (
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                  …and more (list capped at 200)
                </span>
              )}
            </>
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>No keys found.</span>
          )}
        </div>
        {isEnv && (
          <>
            <div className="kk">Source</div>
            <div className="vv" style={{ fontSize: 12, color: 'var(--muted)' }}>
              Read from the dashboard's own environment, which may differ from your app's.
              DAPR_* and APP_API_TOKEN are never readable.
            </div>
          </>
        )}
        <div className="kk">Referenced by</div>
        <div className="vv" style={{ flexWrap: 'wrap', gap: 6 }}>
          {info.usedBy?.length ? (
            info.usedBy.map((n) => (
              <Link key={n} className="appref link" to={`/components/${encodeURIComponent(n)}`}>{n}</Link>
            ))
          ) : (
            <span style={{ color: 'var(--muted)', fontSize: 12 }}>No components reference this store.</span>
          )}
        </div>
      </div>
    </div>
  )
}
