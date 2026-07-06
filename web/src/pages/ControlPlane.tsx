import { Link } from 'react-router-dom'
import { useControlPlane, useControlPlaneAction } from '../hooks/useControlPlane'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { ControlPlaneService, ControlPlaneAction } from '../types/controlplane'

export function ControlPlane() {
  useDocumentTitle('Control Plane')
  const { data, isLoading } = useControlPlane()
  const action = useControlPlaneAction()

  const header = (
    <div className="phead">
      <div>
        <h1>Control Plane</h1>
        <div className="sub">Local Dapr control-plane services · via container runtime</div>
      </div>
    </div>
  )

  if (isLoading) {
    return <div className="page">{header}<p className="muted">Loading…</p></div>
  }

  if (!data || !data.available) {
    return (
      <div className="page">
        {header}
        <p className="muted">
          No container runtime (Docker/Podman) detected. Run <span className="mono">dapr init</span> to
          start the control plane.
        </p>
      </div>
    )
  }

  if (data.available && !data.reachable) {
    return (
      <div className="page">
        {header}
        <p className="muted">
          Docker or Podman is installed but not running. Start it to manage the control plane.
        </p>
      </div>
    )
  }

  if (data.available && data.reachable && !data.controlPlanePresent) {
    return (
      <div className="page">
        {header}
        <p className="muted">
          No Dapr control plane found. Run <span className="mono">dapr init</span> to start it.
        </p>
      </div>
    )
  }

  const runAction = (name: string, act: ControlPlaneAction) => {
    if (window.confirm(`Run "${data.runtime} ${act} ${name}"?`)) {
      action.mutate({ name, action: act })
    }
  }

  const initServices = data.services.filter((s) => !s.composeProject)
  const composeProjects = [...new Set(data.services.filter((s) => s.composeProject).map((s) => s.composeProject!))]

  return (
    <div className="page">
      {header}
      <div className="cards">
        {initServices.map((svc) => (
          <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
        ))}
      </div>
      {composeProjects.map((project) => (
        <div key={project}>
          <div className="sec-title">
            compose · {project}{' '}
            <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              — docker compose managed
            </span>
          </div>
          <div className="cards">
            {data.services
              .filter((s) => s.composeProject === project)
              .map((svc) => (
                <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function ServiceCard({
  svc,
  onAction,
}: {
  svc: ControlPlaneService
  onAction: (name: string, act: ControlPlaneAction) => void
}) {
  return (
    <div className="card cp-card">
      <div className="b">{svc.name}</div>
      <div className="cp-field">
        <div className="cp-label">Status</div>
        <span className="health">
          <span className={svc.healthy ? 'led ok' : 'led bad'} />
          {svc.status}
        </span>
      </div>
      <div className="cp-field">
        <div className="cp-label">Ports</div>
        <div className="cp-value mono faint">
          {svc.ports && svc.ports.length ? svc.ports.join(', ') : '—'}
        </div>
      </div>
      <div className="cp-field">
        <div className="cp-label">Memory</div>
        <div className="cp-value mono">
          {svc.memoryHuman || '—'}
        </div>
      </div>
      <div className="cp-field">
        <div className="cp-label">Log</div>
        <div className="cp-value mono faint cp-logpath">
          {svc.logPath || '—'}
        </div>
      </div>
      <div className="cp-field">
        <Link className="chip k" to={`/logs?cp=${encodeURIComponent(svc.name)}`}>
          View logs
        </Link>
      </div>
      {svc.actionable && (
        <div className="actions">
          {svc.status === 'stopped' && (
            <button className="btn ghost" onClick={() => onAction(svc.name, 'start')}>Start</button>
          )}
          {svc.status === 'running' && (
            <>
              <button className="btn ghost" onClick={() => onAction(svc.name, 'restart')}>Restart</button>
              <button className="btn danger" onClick={() => onAction(svc.name, 'stop')}>Stop</button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
