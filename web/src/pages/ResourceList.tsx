import { Link } from 'react-router-dom'
import { useResources } from '../hooks/useResources'
import type { ResourceKind } from '../types/resources'
import { useDocumentTitle } from '../lib/useDocumentTitle'

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

const chipStyle: React.CSSProperties = {
  display: 'inline-block',
  marginRight: 'var(--space-1)',
  padding: '1px 8px',
  borderRadius: 10,
  border: '1px solid var(--border)',
  background: 'var(--surface)',
  fontSize: 'calc(var(--font) - 1px)',
  color: 'var(--text-muted)',
  textDecoration: 'none',
}

const LABELS: Record<ResourceKind, { title: string; empty: string }> = {
  component: { title: 'Components', empty: 'No components' },
  configuration: { title: 'Configurations', empty: 'No configurations' },
}

interface ResourceListProps {
  kind: ResourceKind
}

export function ResourceList({ kind }: ResourceListProps) {
  const { data: resources, isLoading } = useResources(kind)
  const { title, empty } = LABELS[kind]

  useDocumentTitle(title)

  if (isLoading) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>Loading…</p>
      </div>
    )
  }

  if (!resources || resources.length === 0) {
    return (
      <div style={{ padding: 'var(--space-4)' }}>
        <p style={{ color: 'var(--text-muted)' }}>
          {empty}
        </p>
      </div>
    )
  }

  return (
    <div style={{ padding: 'var(--space-4)' }}>
      <div style={{ overflowX: 'auto' }}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Name</th>
              {kind === 'component' ? (
                <>
                  <th style={thStyle}>Type</th>
                  <th style={thStyle}>Version</th>
                  <th style={thStyle}>Loaded by</th>
                </>
              ) : (
                <th style={thStyle}>Path</th>
              )}
            </tr>
          </thead>
          <tbody>
            {resources.map((resource) => (
              <tr key={resource.name}>
                <td style={tdStyle}>
                  <Link
                    className="mono"
                    to={`/resources/${kind}/${resource.name}`}
                  >
                    {resource.name}
                  </Link>
                </td>
                {kind === 'component' ? (
                  <>
                    <td style={tdStyle} className="mono">
                      {resource.type ?? '—'}
                    </td>
                    <td style={tdStyle} className="mono">
                      {resource.version ?? '—'}
                    </td>
                    <td style={tdStyle}>
                      {resource.loadedBy && resource.loadedBy.length > 0 ? (
                        resource.loadedBy.map((appId) => (
                          <Link
                            key={appId}
                            to={`/apps/${appId}`}
                            className="mono"
                            style={chipStyle}
                          >
                            {appId}
                          </Link>
                        ))
                      ) : (
                        '—'
                      )}
                    </td>
                  </>
                ) : (
                  <td style={tdStyle} className="mono">
                    {resource.path}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
