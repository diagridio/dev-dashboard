import { Link, useNavigate } from 'react-router-dom'
import { useApps } from '../hooks/useApps'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { ledClass, runtimeSwatch } from '../lib/runtimeSwatch'
import { appKey } from '../lib/appKey'
import type { AppSummary } from '../types/api'

// Fully stopped: both the app process/container and its daprd sidecar report 'stopped'.
const isStopped = (a: AppSummary) => a.appStatus === 'stopped' && a.daprdStatus === 'stopped'

const PAGE_HEADER = (
  <div className="phead">
    <div>
      <h1>Applications</h1>
      <div className="sub">Dapr apps &amp; sidecars discovered on this machine</div>
    </div>
  </div>
)

export function Applications() {
  const navigate = useNavigate()
  const { data: apps, isLoading } = useApps()

  useDocumentTitle('Applications')

  if (isLoading) {
    return (
      <div className="page">
        {PAGE_HEADER}
        <p className="muted">Loading…</p>
      </div>
    )
  }

  if (!apps || apps.length === 0) {
    return (
      <div className="page">
        {PAGE_HEADER}
        <p className="muted">No Dapr apps running</p>
      </div>
    )
  }

  const running = apps.filter((a) => !isStopped(a)).length
  const healthy = apps.filter((a) => a.health === 'healthy').length
  const starting = apps.filter((a) => a.health === 'starting').length
  const unhealthy = apps.filter((a) => a.health === 'unhealthy').length
  // Total components loaded across every running app; '—' when none report any.
  const componentsTotal = apps.reduce((n, a) => n + (a.components?.length ?? 0), 0)
  const componentsLoaded = componentsTotal > 0 ? componentsTotal : '—'

  return (
    <div className="page">
      {PAGE_HEADER}
      <div className="stats">
        <div className="stat">
          <div className="n mint">{running}</div>
          <div className="l">Apps running</div>
        </div>
        <div className="stat">
          <div className="n">{healthy}</div>
          <div className="l">Healthy</div>
        </div>
        <div className="stat">
          <div className="n">{starting}</div>
          <div className="l">Starting</div>
        </div>
        <div className="stat">
          <div className={unhealthy > 0 ? 'n bad' : 'n'}>{unhealthy}</div>
          <div className="l">Unhealthy</div>
        </div>
        <div className="stat">
          <div className="n">{componentsLoaded}</div>
          <div className="l">Components loaded</div>
        </div>
      </div>
      <div className="card">
        <div className="tablewrap">
          <table className="t click">
            <thead>
              <tr>
                <th>Health</th>
                <th>App ID</th>
                <th>Runtime</th>
                <th>App port</th>
                <th>HTTP</th>
                <th>gRPC</th>
                <th>daprd PID</th>
                <th>App PID</th>
                <th>Age</th>
                <th>Run template</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {apps.map((app) => (
                <AppRow key={appKey(app)} app={app} onOpen={() => navigate(`/apps/${appKey(app)}`)} />
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <p className="hint">Tip — click a row to open the application + daprd detail.</p>
    </div>
  )
}

function AppRow({ app, onOpen }: { app: AppSummary; onOpen: () => void }) {
  const num = (v: number) =>
    v ? <td className="mono tabnum">{v}</td> : <td className="mono tabnum faint">—</td>
  const sourceLabel = app.runTemplate || (app.isAspire ? 'Aspire' : app.source === 'compose' ? 'Compose' : '—')
  const stopped = isStopped(app)
  const unreachable = app.source === 'compose' && app.sidecarReachable === false && app.daprdStatus !== 'stopped'
  const key = appKey(app)
  const hasContainerName = key !== app.appId
  return (
    <tr onClick={onOpen}>
      <td>
        <span
          className="health"
          title={unreachable ? 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata' : undefined}
        >
          <span className={`led ${ledClass(stopped ? 'unknown' : app.health)}`} /> {stopped ? 'stopped' : app.health}
          {unreachable && ' ⓘ'}
        </span>
      </td>
      <td className="b">
        <Link className="celllink" to={`/apps/${key}`} onClick={(e) => e.stopPropagation()}>
          {hasContainerName ? (
            <>
              {app.appId}
              <span className="muted" style={{ display: 'block', fontSize: 11, fontWeight: 400 }}>
                {key}
              </span>
            </>
          ) : (
            app.appId
          )}
        </Link>
      </td>
      <td>
        <span className="lang">
          <span className="sw" style={{ background: runtimeSwatch(app.runtime) }} />
          {app.runtime}
        </span>
      </td>
      {num(app.appPort)}
      {num(app.httpPort)}
      {num(app.grpcPort)}
      {num(app.daprdPid)}
      {num(app.appPid)}
      <td className="muted mono tabnum">{app.age}</td>
      <td className="mono muted" title={app.composeProject ? `compose project: ${app.composeProject}` : undefined}>
        {sourceLabel}
      </td>
      <td className="kebab">⋯</td>
    </tr>
  )
}
