import React, { useEffect } from 'react'
import { useParams, Link } from 'react-router-dom'
import { useResource } from '../hooks/useResources'
import { highlightYaml } from '../lib/yaml-highlight'

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

export function ResourceDetail() {
  const { kind, name } = useParams<{ kind: string; name: string }>()
  const { data: detail, isLoading, isError } = useResource(
    (kind ?? '') as import('../types/resources').ResourceKind,
    name ?? '',
  )

  useEffect(() => {
    if (name) {
      document.title = name
    }
  }, [name])

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (isError || !detail) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--bad)' }}>Resource not found or failed to load.</p>
      </div>
    )
  }

  const rawYaml = detail.raw ?? ''

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      {/* Header */}
      <div style={{ marginBottom: 'var(--space-6)' }}>
        <h1
          className="mono"
          style={{ margin: 0, fontSize: 22, fontWeight: 700, color: 'var(--text)', marginBottom: 'var(--space-2)' }}
        >
          {detail.name}
        </h1>
        <div style={{ color: 'var(--text-muted)', fontSize: 13, display: 'flex', gap: 'var(--space-3)' }}>
          <span>{detail.kind}</span>
          {detail.type && <span>{detail.type}</span>}
          {detail.version && <span>{detail.version}</span>}
        </div>
      </div>

      {/* YAML viewer */}
      <div style={sectionStyle}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            ...sectionHeadingStyle,
          }}
        >
          <span>YAML</span>
          {rawYaml && (
            <button
              data-cy="copy-yaml"
              title="Copy YAML"
              onClick={() => copyText(rawYaml)}
              style={{
                cursor: 'pointer',
                background: 'none',
                border: '1px solid var(--border)',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 12,
                color: 'var(--text-muted)',
              }}
            >
              Copy
            </button>
          )}
        </div>
        <div
          style={{
            overflowX: 'auto',
            border: '1px solid var(--border)',
            background: 'var(--surface)',
            borderRadius: 4,
          }}
        >
          <pre
            className="mono"
            style={{
              margin: 0,
              padding: 'var(--space-3)',
              fontSize: 13,
              lineHeight: 1.6,
              whiteSpace: 'pre',
            }}
          >
            {highlightYaml(rawYaml)}
          </pre>
        </div>
      </div>

      {/* Loaded by (components only) */}
      {detail.kind === 'component' && (
        <div style={sectionStyle}>
          <div style={sectionHeadingStyle}>Loaded by</div>
          {detail.loadedBy && detail.loadedBy.length > 0 ? (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
              {detail.loadedBy.map((appId) => (
                <Link
                  key={appId}
                  to={'/apps/' + appId}
                  style={{
                    color: 'var(--link)',
                    textDecoration: 'none',
                    padding: '2px 8px',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    fontSize: 13,
                  }}
                >
                  {appId}
                </Link>
              ))}
            </div>
          ) : (
            <p style={{ color: 'var(--text-muted)', fontSize: 13, margin: 0 }}>
              not currently loaded
            </p>
          )}
        </div>
      )}
    </div>
  )
}
