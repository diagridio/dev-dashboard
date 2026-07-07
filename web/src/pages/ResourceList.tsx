import { Link, useNavigate, useParams } from 'react-router-dom'
import { useResources } from '../hooks/useResources'
import type { ResourceKind } from '../types/resources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { ResourceDetail } from './ResourceDetail'
import { StateStoreConnectionsPanel } from '../components/StateStoreConnectionsPanel'

interface ResourceListProps {
  kind: ResourceKind
}

const LABELS: Record<
  ResourceKind,
  {
    title: string
    sub: React.ReactNode
  }
> = {
  component: {
    title: 'Components',
    sub: (
      <>
        Resource files from <span className="mono">~/.dapr/resources</span> and live{' '}
        <span className="mono">--resources-path</span> args
      </>
    ),
  },
  configuration: {
    title: 'Configurations',
    sub: (
      <>
        Dapr <span className="mono">Configuration</span> resources from{' '}
        <span className="mono">~/.dapr/config.yaml</span> and{' '}
        <span className="mono">--config</span> args
      </>
    ),
  },
}

export function ResourceList({ kind }: ResourceListProps) {
  const { data: resources, isLoading } = useResources(kind)
  const { name: selectedParam } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const { title, sub } = LABELS[kind]
  const kindPath = kind === 'component' ? 'components' : 'configurations'

  // Resolve the selection: id match first, then name (pre-id deep links),
  // then default to the first item.
  const selected =
    resources?.find((r) => r.id === selectedParam) ??
    resources?.find((r) => r.name === selectedParam) ??
    (resources && resources.length > 0 ? resources[0] : undefined)

  useDocumentTitle(title)

  if (isLoading) {
    return (
      <div className="page">
        <div className="phead">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          {kind === 'component' && (
            <Link className="btn ghost" to="/components/new">+ New component</Link>
          )}
        </div>
        <p className="muted">Loading…</p>
        {kind === 'component' && <StateStoreConnectionsPanel />}
      </div>
    )
  }

  // Empty state
  if (!resources || resources.length === 0) {
    return (
      <div className="page">
        <div className="phead">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
          {kind === 'component' && (
            <Link className="btn ghost" to="/components/new">+ New component</Link>
          )}
        </div>
        <div className="md">
          <div className="card complist" />
          <div className="card">
            <p className="hint" style={{ padding: '14px' }}>
              No {title.toLowerCase()} found.
            </p>
          </div>
        </div>
        {kind === 'component' && <StateStoreConnectionsPanel />}
      </div>
    )
  }

  const handleSelect = (id: string) => {
    navigate(`/${kindPath}/${id}`)
  }

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>{title}</h1>
          <div className="sub">{sub}</div>
        </div>
        {kind === 'component' && (
          <Link className="btn ghost" to="/components/new">+ New component</Link>
        )}
      </div>
      <div className="md">
        <div className="card complist">
          {resources.map((resource) => {
            const isSelected = resource.id === selected?.id
            const ct =
              kind === 'component'
                ? [resource.type, resource.version].filter(Boolean).join(' · ')
                : resource.type ?? ''
            return (
              <div
                key={resource.id}
                className={`ci${isSelected ? ' sel' : ''}`}
                onClick={() => handleSelect(resource.id)}
                role="button"
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleSelect(resource.id)
                }}
              >
                <span className="cn">{resource.name}</span>
                {ct && <span className="ct">{ct}</span>}
                <span
                  className="ct"
                  title={resource.path}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {resource.path}
                </span>
              </div>
            )
          })}
        </div>
        {selected ? (
          <ResourceDetail kind={kind} idOrName={selected.id} />
        ) : (
          <div className="card">
            <p className="hint" style={{ padding: '14px' }}>
              Select an item to view details.
            </p>
          </div>
        )}
      </div>
      {kind === 'component' && <StateStoreConnectionsPanel />}
    </div>
  )
}
