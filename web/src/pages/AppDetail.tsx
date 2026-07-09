import { Link, useNavigate, useParams } from 'react-router-dom'
import { useApp } from '../hooks/useApps'
import type { AppDetail as AppDetailType } from '../types/api'
import { copyText } from '../lib/clipboard'
import { ledClass, runtimeSwatch } from '../lib/runtimeSwatch'
import { useToast } from '../lib/toast'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { appKey } from '../lib/appKey'

// ---------- content ----------

function AppDetailContent({ app }: { app: AppDetailType }) {
  const navigate = useNavigate()
  const { toast, toastNode } = useToast()

  useDocumentTitle(appKey(app))

  const copyPath = (path: string) => {
    copyText(path)
    toast.show('Path copied')
  }

  const key = appKey(app)
  const hasContainerName = key !== app.appId

  const appPidDisplay = !app.metadataOk ? 'unknown' : app.appPid ? String(app.appPid) : '—'
  const isCompose = app.source === 'compose'
  const unreachable = isCompose && app.sidecarReachable === false

  return (
    <div className="page">
      {/* Breadcrumbs */}
      <div className="crumbs">
        <Link to="/">Applications</Link>
        <span className="sep">/</span>
        <span className="cur">{app.appId}</span>
      </div>

      {/* Page header */}
      <div className="phead">
        <div>
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
          {hasContainerName && <div className="sub mono">{key}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tbtn" onClick={() => navigate('/')}>← Back</button>
          <Link className="tbtn" to={`/logs?app=${key}&source=daprd`}>View logs</Link>
        </div>
      </div>

      {/* Metadata unavailable note */}
      {unreachable ? (
        <div className="hint">
          sidecar unreachable — publish the daprd HTTP port (e.g. <span className="mono">3500:3500</span>) in
          your compose file to enable health &amp; metadata
        </div>
      ) : (
        !app.metadataOk && <div className="hint">metadata unavailable — showing process-scan data only</div>
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

            {isCompose ? (
              <>
                <div className="kk">Container</div>
                <div className="vv mono">{app.appContainerName || <span className="faint">—</span>}</div>

                <div className="kk">Container ID</div>
                <div className="vv mono">{app.appContainerId ? app.appContainerId.slice(0, 12) : <span className="faint">—</span>}</div>

                <div className="kk">Compose project</div>
                <div className="vv mono">{app.composeProject || <span className="faint">—</span>}</div>
              </>
            ) : (
              <>
                <div className="kk">App PID</div>
                <div className="vv mono">{appPidDisplay}</div>

                <div className="kk">CLI PID</div>
                <div className="vv mono">{app.cliPid || <span className="faint">—</span>}</div>
              </>
            )}

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

            {isCompose ? (
              <>
                <div className="kk">Container</div>
                <div className="vv mono">{app.daprdContainerName || <span className="faint">—</span>}</div>
              </>
            ) : (
              <>
                <div className="kk">daprd PID</div>
                <div className="vv mono">{app.daprdPid || <span className="faint">—</span>}</div>
              </>
            )}

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
          {app.resourcePaths && app.resourcePaths.length === 1 ? (
            <div
              className="vv mono"
              data-cy="copy-path"
              title="Click to copy"
              onClick={() => copyPath(app.resourcePaths![0])}
            >
              {app.resourcePaths[0]}
            </div>
          ) : app.resourcePaths && app.resourcePaths.length > 1 ? (
            <div className="vv mono" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: 2 }}>
              {app.resourcePaths.map((p, i) => (
                <div
                  key={i}
                  data-cy="copy-path"
                  title="Click to copy"
                  style={{ cursor: 'copy', width: '100%' }}
                  onClick={() => copyPath(p)}
                >
                  {p}
                </div>
              ))}
            </div>
          ) : (
            <div className="vv mono"><span className="faint">—</span></div>
          )}

          <div className="kk">Config</div>
          {app.configPath ? (
            <div
              className="vv mono"
              data-cy="copy-path"
              title="Click to copy"
              onClick={() => copyPath(app.configPath)}
            >
              {app.configPath}
            </div>
          ) : (
            <div className="vv mono"><span className="faint">—</span></div>
          )}

          <div className="kk">App log</div>
          {app.appLogPath ? (
            <div
              className="vv mono"
              data-cy="copy-path"
              title="Click to copy"
              onClick={() => copyPath(app.appLogPath)}
            >
              {app.appLogPath}
            </div>
          ) : (
            <div className="vv mono"><span className="faint">—</span></div>
          )}

          <div className="kk">daprd log</div>
          {app.daprdLogPath ? (
            <div
              className="vv mono"
              data-cy="copy-path"
              title="Click to copy"
              onClick={() => copyPath(app.daprdLogPath)}
            >
              {app.daprdLogPath}
            </div>
          ) : (
            <div className="vv mono"><span className="faint">—</span></div>
          )}
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
                className="chip k"
                to={`/components/${c.name}`}
              >
                {c.name} <span className="muted">{c.type}</span>
              </Link>
            ))
          ) : (
            <span className="faint">No components loaded</span>
          )}
        </div>
      </div>

      {toastNode}
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
        <p className="err">App not found or failed to load.</p>
      </div>
    )
  }

  return <AppDetailContent app={app} />
}
