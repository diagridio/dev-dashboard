import { Link, useParams } from 'react-router-dom'
import { useApp } from '../hooks/useApps'
import type { HealthStatus, AppDetail as AppDetailType } from '../types/api'

function legacyCopy(t: string) {
  const ta = document.createElement('textarea')
  ta.value = t
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

function copyText(t: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(t).catch(() => legacyCopy(t))
  } else {
    legacyCopy(t)
  }
}

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

function HealthDot({ health }: { health: HealthStatus }) {
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

const sectionStyle: React.CSSProperties = {
  marginBottom: 'var(--space-6)',
}

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  color: 'var(--text-muted)',
  marginBottom: 'var(--space-3)',
  paddingBottom: 'var(--space-2)',
  borderBottom: '1px solid var(--border)',
}

const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 'var(--space-3)',
  padding: 'var(--space-2) 0',
  borderBottom: '1px solid var(--border-soft)',
}

const labelStyle: React.CSSProperties = {
  color: 'var(--text-muted)',
  minWidth: 140,
  flexShrink: 0,
}

const valueStyle: React.CSSProperties = {
  color: 'var(--text)',
}

function Field({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div style={rowStyle}>
      <span style={labelStyle}>{label}</span>
      <span style={valueStyle} className={mono ? 'mono' : undefined}>
        {value ?? '—'}
      </span>
    </div>
  )
}

function CopyablePath({ path }: { path: string }) {
  return (
    <span
      className="mono"
      data-cy="copy-path"
      title="Click to copy"
      style={{ cursor: 'copy' }}
      onClick={() => copyText(path)}
    >
      {path}
    </span>
  )
}

function AppDetailContent({ app }: { app: AppDetailType }) {
  const appPidDisplay = !app.metadataOk ? 'unknown' : app.appPid ? String(app.appPid) : '—'

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {/* Header */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', marginBottom: 'var(--space-2)' }}>
          <h1
            className="mono"
            style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)' }}
          >
            {app.appId}
          </h1>
          <HealthDot health={app.health} />
        </div>
        <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>{app.runtime}</div>
      </div>

      {/* Metadata unavailable note */}
      {!app.metadataOk && (
        <div
          style={{
            padding: 'var(--space-3)',
            marginBottom: 'var(--space-4)',
            background: 'var(--surface)',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--warn)',
            fontSize: 13,
          }}
        >
          metadata unavailable — showing process-scan data only
        </div>
      )}

      {/* Application section */}
      <div style={sectionStyle}>
        <div style={sectionHeadingStyle}>Application</div>
        <Field label="Runtime" value={app.runtime} />
        <Field label="App port" value={app.appPort ?? '—'} mono />
        <Field label="Protocol" value="http" />
        <Field label="App PID" value={appPidDisplay} mono />
        <Field label="CLI PID" value={app.cliPid ?? '—'} mono />
        <Field label="Command" value={app.command || '—'} mono />
      </div>

      {/* Dapr sidecar section */}
      <div style={sectionStyle}>
        <div style={sectionHeadingStyle}>Dapr sidecar</div>
        <Field label="Runtime version" value={app.runtimeVersion || '—'} mono />
        <Field label="HTTP port" value={app.httpPort ?? '—'} mono />
        <Field label="gRPC port" value={app.grpcPort ?? '—'} mono />
        <Field label="daprd PID" value={app.daprdPid ?? '—'} mono />
        <Field label="Health" value={<HealthDot health={app.health} />} />
      </div>

      {/* Metadata section */}
      <div style={sectionStyle}>
        <div style={sectionHeadingStyle}>Metadata</div>
        <Field label="Runtime version" value={app.runtimeVersion || '—'} mono />
        <Field
          label="Enabled features"
          value={
            app.enabledFeatures && app.enabledFeatures.length > 0
              ? app.enabledFeatures.join(', ')
              : '—'
          }
        />
        <div style={rowStyle}>
          <span style={labelStyle}>Components</span>
          <span style={valueStyle}>
            {app.components && app.components.length > 0 ? (
              <span style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
                {app.components.map((c) => (
                  <Link
                    key={c.name}
                    to={`/resources/component/${c.name}`}
                    style={{
                      display: 'inline-block',
                      padding: '2px var(--space-2)',
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 4,
                      color: 'var(--link)',
                      textDecoration: 'none',
                      fontSize: 13,
                    }}
                  >
                    {c.name}
                  </Link>
                ))}
              </span>
            ) : (
              '—'
            )}
          </span>
        </div>
      </div>

      {/* Paths section */}
      <div style={sectionStyle}>
        <div style={sectionHeadingStyle}>Paths</div>
        {app.resourcePaths && app.resourcePaths.length > 0 ? (
          app.resourcePaths.map((p, i) => (
            <Field
              key={i}
              label={i === 0 ? 'Resources' : ''}
              value={<CopyablePath path={p} />}
            />
          ))
        ) : (
          <Field label="Resources" value="—" />
        )}
        <Field label="Config" value={app.configPath ? <CopyablePath path={app.configPath} /> : '—'} />
        <Field label="App log" value={app.appLogPath ? <CopyablePath path={app.appLogPath} /> : '—'} />
        <Field label="daprd log" value={app.daprdLogPath ? <CopyablePath path={app.daprdLogPath} /> : '—'} />
      </div>
    </div>
  )
}

export function AppDetail() {
  const { appId } = useParams<{ appId: string }>()
  const { data: app, isLoading, isError } = useApp(appId ?? '')

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (isError || !app) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--bad)' }}>App not found or failed to load.</p>
      </div>
    )
  }

  return <AppDetailContent app={app} />
}
