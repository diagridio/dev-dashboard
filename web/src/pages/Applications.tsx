import { Link, useNavigate } from 'react-router-dom'
import { useApps } from '../hooks/useApps'
import { LiveIndicator } from '../components/LiveIndicator'
import type { AppSummary, HealthStatus } from '../types/api'

// Maps a health status to its LED modifier class.
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

// Picks a language swatch color from the runtime string (mock A palette).
function runtimeSwatch(runtime: string): string {
  const r = runtime.toLowerCase()
  if (r.includes('go')) return '#00ADD8'
  if (r.includes('python') || r.includes('py')) return '#3776AB'
  if (r.includes('node') || r.includes('js')) return '#539E43'
  if (r.includes('.net') || r.includes('dotnet')) return '#8330FF'
  return 'var(--faint)'
}

const PAGE_HEADER = (
  <div className="phead">
    <div>
      <h1>Applications</h1>
      <div className="sub">Dapr apps &amp; sidecars discovered on this machine</div>
    </div>
    <LiveIndicator />
  </div>
)

export function Applications() {
  const navigate = useNavigate()
  const { data: apps, isLoading } = useApps()

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

  const running = apps.length
  const healthy = apps.filter((a) => a.health === 'healthy').length
  const starting = apps.filter((a) => a.health === 'starting').length
  // Total components loaded across every running app; '—' when none report any.
  const componentsTotal = apps.reduce((n, a) => n + (a.components?.length ?? 0), 0)
  const componentsLoaded = componentsTotal > 0 ? componentsTotal : '—'
  // Prefer a real run-template name; else label Aspire-managed apps; else '—'.
  const runTemplate =
    apps.find((a) => a.runTemplate)?.runTemplate ||
    (apps.some((a) => a.isAspire) ? 'Aspire' : '—')

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
          <div className="n">{componentsLoaded}</div>
          <div className="l">Components loaded</div>
        </div>
        <div className="stat">
          <div className="n mono" style={{ fontSize: 18 }}>
            {runTemplate}
          </div>
          <div className="l">Run template</div>
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
                <AppRow key={app.appId} app={app} onOpen={() => navigate(`/apps/${app.appId}`)} />
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
  return (
    <tr onClick={onOpen}>
      <td>
        <span className="health">
          <span className={`led ${ledClass(app.health)}`} /> {app.health}
        </span>
      </td>
      <td className="b">
        <Link className="celllink" to={`/apps/${app.appId}`} onClick={(e) => e.stopPropagation()}>
          {app.appId}
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
      <td className="mono muted">{app.runTemplate || (app.isAspire ? 'Aspire' : '—')}</td>
      <td className="kebab">⋯</td>
    </tr>
  )
}
