import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApps } from '../hooks/useApps'
import { useClearInactive, useAppForget } from '../hooks/useAppAction'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { runtimeSwatch } from '../lib/runtimeSwatch'
import { appKey } from '../lib/appKey'
import { appDisplayState } from '../lib/appDisplayState'
import { modeLabel } from '../lib/modeLabel'
import { getCapabilities } from '../lib/capabilities'
import { trackAction } from '../lib/telemetry'
import { useToast } from '../lib/toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
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
  const caps = getCapabilities()
  const { toast, toastNode } = useToast()
  const clearInactive = useClearInactive()
  const [confirmClear, setConfirmClear] = useState(false)

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
  // Stat cards follow the combined display state so a row and its card never
  // disagree; the amber states (app down, orphaned) need attention and count
  // as Unhealthy.
  const labels = apps.map((a) => appDisplayState(a).label)
  const healthy = labels.filter((l) => l === 'healthy').length
  const starting = labels.filter((l) => l === 'starting').length
  const unhealthy = labels.filter((l) => l === 'unhealthy' || l === 'app down' || l === 'orphaned').length
  // Total components loaded across every running app; '—' when none report any.
  const componentsTotal = apps.reduce((n, a) => n + (a.components?.length ?? 0), 0)
  const componentsLoaded = componentsTotal > 0 ? componentsTotal : '—'
  const inactive = apps.filter(isStopped)

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Applications</h1>
          <div className="sub">Dapr apps &amp; sidecars discovered on this machine</div>
        </div>
        {caps.lifecycle && inactive.length > 0 && (
          <button
            className="btn ghost"
            disabled={clearInactive.isPending}
            onClick={() => setConfirmClear(true)}
          >
            Clear inactive · {inactive.length}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmClear}
        title={`Remove ${inactive.length} stopped application${inactive.length === 1 ? '' : 's'} from the dashboard?`}
        confirmLabel="Clear inactive"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          trackAction('clear_inactive', { count: inactive.length })
          clearInactive.mutate(undefined, {
            onError: (e) => toast.show(e instanceof Error ? e.message : 'Clear failed'),
          })
          setConfirmClear(false)
        }}
      >
        <p className="muted">
          They&rsquo;ll reappear if they run again or when the dashboard restarts. Nothing is deleted from Docker.
        </p>
      </ConfirmDialog>
      <div className="stats">
        <div className="stat">
          <div className="n">{running}</div>
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
                <th>Mode</th>
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
      {toastNode}
    </div>
  )
}

function AppRow({ app, onOpen }: { app: AppSummary; onOpen: () => void }) {
  const caps = getCapabilities()
  const forget = useAppForget(appKey(app))
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removable = caps.lifecycle && isStopped(app)
  const num = (v: number) =>
    v ? <td className="mono tabnum">{v}</td> : <td className="mono tabnum faint">—</td>
  const state = appDisplayState(app)
  const unreachable = app.source === 'compose' && app.sidecarReachable === false && app.daprdStatus !== 'stopped'
  const key = appKey(app)
  const hasContainerName = key !== app.appId
  const hasLabel = !hasContainerName && !!app.label && app.label !== app.appId
  const secondary = hasContainerName ? key : hasLabel ? app.label : null
  return (
    <tr onClick={onOpen}>
      <td>
        <span
          className="health"
          title={state.hint ?? (unreachable ? 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata' : undefined)}
        >
          <span className={`led ${state.led}`} /> {state.label}
          {unreachable && ' ⓘ'}
        </span>
      </td>
      <td className="b">
        <Link className="celllink" to={`/apps/${key}`} onClick={(e) => e.stopPropagation()}>
          {secondary ? (
            <>
              {app.appId}
              <span className="muted" style={{ display: 'block', fontSize: 11, fontWeight: 400 }}>
                {secondary}
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
      <td
        className="mono muted"
        title={
          app.runTemplate
            ? `run template: ${app.runTemplate}`
            : app.composeProject
              ? `compose project: ${app.composeProject}`
              : undefined
        }
      >
        {modeLabel(app)}
      </td>
      <td className="kebab" onClick={(e) => e.stopPropagation()}>
        {removable ? (
          <button
            className="tbtn"
            disabled={forget.isPending}
            aria-label={`Remove ${app.appId} from the dashboard`}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </button>
        ) : (
          '⋯'
        )}
        <ConfirmDialog
          open={confirmRemove}
          title={`Remove "${app.appId}" from the dashboard?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            trackAction('app_remove', { source: app.source, scope: 'list' })
            forget.mutate()
            setConfirmRemove(false)
          }}
        >
          <p className="muted">It&rsquo;ll reappear if it runs again or when the dashboard restarts.</p>
        </ConfirmDialog>
      </td>
    </tr>
  )
}
