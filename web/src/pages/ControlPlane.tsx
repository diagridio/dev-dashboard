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

  const runAction = (name: string, act: ControlPlaneAction) => {
    if (window.confirm(`Run "${data.runtime} ${act} ${name}"?`)) {
      action.mutate({ name, action: act })
    }
  }

  return (
    <div className="page">
      {header}
      <div className="cards">
        {data.services.map((svc) => (
          <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
        ))}
      </div>
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
  const isK8s = svc.status === 'kubernetes-only'
  return (
    <div className={isK8s ? 'card faint' : 'card'} style={{ padding: '14px 16px' }}>
      <div className="b">{svc.name}</div>
      {isK8s ? (
        <div className="sub">Kubernetes only</div>
      ) : (
        <>
          <div style={{ marginTop: 8 }}>
            <span className="health">
              <span className={svc.healthy ? 'led ok' : 'led bad'} />
              {svc.status}
            </span>
          </div>
          <div className="mono faint" style={{ marginTop: 6, fontSize: 12 }}>
            {svc.ports.length ? svc.ports.join(', ') : '—'}
          </div>
          <div className="mono" style={{ marginTop: 4, fontSize: 12 }}>
            {svc.memoryHuman || '—'}
          </div>
          <div className="mono faint" style={{ marginTop: 4, fontSize: 12, wordBreak: 'break-all' }}>
            {svc.logPath || '—'}
          </div>
          <div style={{ marginTop: 8 }}>
            <Link className="celllink" to={`/logs?cp=${encodeURIComponent(svc.name)}`}>
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
        </>
      )}
    </div>
  )
}
