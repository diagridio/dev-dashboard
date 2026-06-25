import { Link } from 'react-router-dom'
import { useApps } from '../hooks/useApps'
import type { HealthStatus } from '../types/api'

// Maps a health status to its CSS custom property color token
function healthColor(health: HealthStatus): string {
  switch (health) {
    case 'healthy':
      return 'var(--ok)'
    case 'starting':
      return 'var(--warn)'
    case 'unhealthy':
      return 'var(--bad)'
    default:
      return 'var(--text-faint)'
  }
}

interface HealthDotProps {
  health: HealthStatus
}

function HealthDot({ health }: HealthDotProps) {
  const color = healthColor(health)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', color }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: color,
          flexShrink: 0,
        }}
      />
      {health}
    </span>
  )
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 'var(--font)',
}

const thStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border)',
  color: 'var(--text-muted)',
  fontWeight: 500,
  whiteSpace: 'nowrap',
}

const tdStyle: React.CSSProperties = {
  padding: 'var(--space-2) var(--space-3)',
  borderBottom: '1px solid var(--border-soft)',
  whiteSpace: 'nowrap',
}

export function Applications() {
  const { data: apps, isLoading } = useApps()

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (!apps || apps.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>No Dapr apps running</p>
      </div>
    )
  }

  return (
    <div style={{ padding: 'var(--space-4)', overflowX: 'auto' }}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Health</th>
            <th style={thStyle}>App ID</th>
            <th style={thStyle}>Runtime</th>
            <th style={thStyle}>App Port</th>
            <th style={thStyle}>HTTP Port</th>
            <th style={thStyle}>gRPC Port</th>
            <th style={thStyle}>daprd PID</th>
            <th style={thStyle}>App PID</th>
            <th style={thStyle}>Age</th>
            <th style={thStyle}>Run template</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.appId}>
              <td style={tdStyle}>
                <HealthDot health={app.health} />
              </td>
              <td style={tdStyle}>
                <Link className="mono" to={`/apps/${app.appId}`}>
                  {app.appId}
                </Link>
              </td>
              <td style={tdStyle}>{app.runtime}</td>
              <td style={tdStyle} className="mono">
                {app.appPort}
              </td>
              <td style={tdStyle} className="mono">
                {app.httpPort}
              </td>
              <td style={tdStyle} className="mono">
                {app.grpcPort}
              </td>
              <td style={tdStyle} className="mono">
                {app.daprdPid}
              </td>
              <td style={tdStyle} className="mono">
                {app.appPid}
              </td>
              <td style={tdStyle}>{app.age}</td>
              <td style={tdStyle} className="mono">
                {app.runTemplate || '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
