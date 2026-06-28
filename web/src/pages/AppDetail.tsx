import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../hooks/useApps'
import type { AppDetail as AppDetailType, HealthStatus } from '../types/api'
import { copyText } from '../lib/clipboard'

// ---------- helpers ----------

function ledClass(health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'ok'
    case 'starting':
      return 'warn'
    case 'unhealthy':
      return 'bad'
    default:
      return 'warn'
  }
}

function runtimeSwatch(runtime: string): string {
  const r = runtime.toLowerCase()
  if (r.includes('go')) return '#00ADD8'
  if (r.includes('python') || r.includes('py')) return '#3776AB'
  if (r.includes('node') || r.includes('js')) return '#539E43'
  if (r.includes('.net') || r.includes('dotnet')) return '#8330FF'
  return 'var(--faint)'
}

// ---------- tiny toast ----------

function useToast() {
  const [msg, setMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const show = useCallback((text: string) => {
    setMsg(text)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setMsg(null), 1400)
  }, [])
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])
  return { msg, show }
}

function Toast({ msg }: { msg: string | null }) {
  return (
    <div className={`toast${msg ? ' show' : ''}`} aria-live="polite">
      <span className="d" />
      <span className="tx">{msg ?? ''}</span>
    </div>
  )
}

// ---------- content ----------

function AppDetailContent({ app }: { app: AppDetailType }) {
  const navigate = useNavigate()
  const { msg, show } = useToast()

  const copyPath = (path: string) => {
    copyText(path)
    show('Path copied')
  }

  const appPidDisplay = !app.metadataOk ? 'unknown' : app.appPid ? String(app.appPid) : '—'

  return (
    <div className="page">
      {/* Breadcrumbs */}
      <div className="crumbs">
        <Link to="/apps">Applications</Link>
        <span className="sep">/</span>
        <span className="cur">{app.appId}</span>
      </div>

      {/* Page header */}
      <div className="phead">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h1>{app.appId}</h1>
          <span className="health">
            <span className={`led ${ledClass(app.health)}`} /> {app.health}
          </span>
          <span className="lang">
            <span className="sw" style={{ background: runtimeSwatch(app.runtime) }} />
            {app.runtime}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tbtn" onClick={() => navigate('/apps')}>← Back</button>
          <Link className="tbtn" to={`/logs?app=${app.appId}&source=daprd`}>View logs</Link>
        </div>
      </div>

      {/* Metadata unavailable note */}
      {!app.metadataOk && (
        <div className="hint">
          metadata unavailable — showing process-scan data only
        </div>
      )}

      {/* Two-column: Application + Dapr sidecar */}
      <div className="twocol">
        {/* Application panel */}
        <div className="panel">
          <div className="ph">
            <span className="ic" style={{ background: 'var(--surface-2)', color: 'var(--accent2)' }}>A</span>
            Application
          </div>
          <div className="kv">
            <div className="kk">Runtime</div>
            <div className="vv">{app.runtime || <span className="faint">—</span>}</div>

            <div className="kk">App port</div>
            <div className="vv mono">{app.appPort || <span className="faint">—</span>}</div>

            <div className="kk">App protocol</div>
            <div className="vv mono"><span className="faint">—</span></div>

            <div className="kk">App PID</div>
            <div className="vv mono">{appPidDisplay}</div>

            <div className="kk">CLI PID</div>
            <div className="vv mono">{app.cliPid || <span className="faint">—</span>}</div>

            <div className="kk">Command</div>
            <div className="vv mono">{app.command || <span className="faint">—</span>}</div>
          </div>
        </div>

        {/* Dapr sidecar panel */}
        <div className="panel">
          <div className="ph">
            <span className="ic" style={{ background: 'var(--dapr)', color: '#fff' }}>d</span>
            Dapr sidecar (daprd)
          </div>
          <div className="kv">
            <div className="kk">Runtime ver.</div>
            <div className="vv mono">{app.runtimeVersion || <span className="faint">—</span>}</div>

            <div className="kk">HTTP port</div>
            <div className="vv mono">{app.httpPort || <span className="faint">—</span>}</div>

            <div className="kk">gRPC port</div>
            <div className="vv mono">{app.grpcPort || <span className="faint">—</span>}</div>

            <div className="kk">Metrics port</div>
            <div className="vv mono"><span className="faint">—</span></div>

            <div className="kk">daprd PID</div>
            <div className="vv mono">{app.daprdPid || <span className="faint">—</span>}</div>

            <div className="kk">Placement</div>
            <div className="vv">
              {app.placement ? (
                <span className="health">
                  <span className="led ok" /> connected
                </span>
              ) : (
                <span className="faint">—</span>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Paths panel */}
      <div className="panel paths">
        <div className="ph">
          Paths <span className="faint" style={{ fontWeight: 400, fontSize: 11 }}>— click any path to copy</span>
        </div>
        <div className="kv">
          <div className="kk">Resources</div>
          <div className="vv mono">
            {app.resourcePaths && app.resourcePaths.length > 0 ? (
              app.resourcePaths.map((p, i) => (
                <span
                  key={i}
                  data-cy="copy-path"
                  title="Click to copy"
                  style={{ display: 'block' }}
                  onClick={() => copyPath(p)}
                >
                  {p}
                </span>
              ))
            ) : (
              <span className="faint">—</span>
            )}
          </div>

          <div className="kk">Config</div>
          <div className="vv mono">
            {app.configPath ? (
              <span data-cy="copy-path" title="Click to copy" onClick={() => copyPath(app.configPath)}>
                {app.configPath}
              </span>
            ) : (
              <span className="faint">—</span>
            )}
          </div>

          <div className="kk">App log</div>
          <div className="vv mono">
            {app.appLogPath ? (
              <span data-cy="copy-path" title="Click to copy" onClick={() => copyPath(app.appLogPath)}>
                {app.appLogPath}
              </span>
            ) : (
              <span className="faint">—</span>
            )}
          </div>

          <div className="kk">daprd log</div>
          <div className="vv mono">
            {app.daprdLogPath ? (
              <span data-cy="copy-path" title="Click to copy" onClick={() => copyPath(app.daprdLogPath)}>
                {app.daprdLogPath}
              </span>
            ) : (
              <span className="faint">—</span>
            )}
          </div>
        </div>
      </div>

      {/* Enabled features (preserved data, not in mock layout but present in data) */}
      {app.enabledFeatures && app.enabledFeatures.length > 0 && (
        <div className="panel" style={{ marginTop: 14 }}>
          <div className="ph">Enabled features</div>
          <div className="kv">
            <div className="kk">Features</div>
            <div className="vv">{app.enabledFeatures.join(', ')}</div>
          </div>
        </div>
      )}

      {/* Loaded components */}
      <div className="sec-title">
        Loaded components{' '}
        <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
          — from /v1.0/metadata
        </span>
      </div>
      <div className="panel">
        <div className="compchips">
          {app.components && app.components.length > 0 ? (
            app.components.map((c) => (
              <Link
                key={c.name}
                className="chip k link"
                to={`/resources/component/${c.name}`}
              >
                {c.name} <span className="muted">{c.type}</span>
              </Link>
            ))
          ) : (
            <span className="faint">No components loaded</span>
          )}
        </div>
      </div>

      <Toast msg={msg} />
    </div>
  )
}

export function AppDetail() {
  const { appId } = useParams<{ appId: string }>()
  const { data: app, isLoading, isError } = useApp(appId ?? '')

  if (isLoading) {
    return (
      <div className="page">
        <p className="muted">Loading…</p>
      </div>
    )
  }

  if (isError || !app) {
    return (
      <div className="page">
        <p style={{ color: 'var(--fail-fg)' }}>App not found or failed to load.</p>
      </div>
    )
  }

  return <AppDetailContent app={app} />
}
