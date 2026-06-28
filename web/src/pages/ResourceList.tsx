import { useNavigate, useParams } from 'react-router-dom'
import { useResources } from '../hooks/useResources'
import type { ResourceKind } from '../types/resources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { ResourceDetail } from './ResourceDetail'

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
  const { name: selectedName } = useParams<{ name?: string }>()
  const navigate = useNavigate()
  const { title, sub } = LABELS[kind]
  const kindPath = kind === 'component' ? 'components' : 'configurations'

  // Determine effective selected name (from URL or first item)
  const effectiveName =
    selectedName ?? (resources && resources.length > 0 ? resources[0].name : undefined)

  useDocumentTitle(title)

  if (isLoading) {
    return (
      <div className="page">
        <div className="phead">
          <div>
            <h1>{title}</h1>
            <div className="sub">{sub}</div>
          </div>
        </div>
        <p className="muted">Loading…</p>
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
        </div>
        <div className="md">
          <div className="card complist" />
          <div className="card">
            <p className="hint" style={{ padding: '14px' }}>
              No {title.toLowerCase()} found.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const handleSelect = (name: string) => {
    navigate(`/${kindPath}/${name}`)
  }

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>{title}</h1>
          <div className="sub">{sub}</div>
        </div>
      </div>
      <div className="md">
        <div className="card complist">
          {resources.map((resource) => {
            const isSelected = resource.name === effectiveName
            const ct =
              kind === 'component'
                ? [resource.type, resource.version].filter(Boolean).join(' · ')
                : resource.type ?? ''
            return (
              <div
                key={resource.name}
                className={`ci${isSelected ? ' sel' : ''}`}
                onClick={() => handleSelect(resource.name)}
                role="button"
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleSelect(resource.name)
                }}
              >
                <span className="cn">{resource.name}</span>
                {ct && <span className="ct">{ct}</span>}
              </div>
            )
          })}
        </div>
        {effectiveName ? (
          <ResourceDetail kind={kind} name={effectiveName} />
        ) : (
          <div className="card">
            <p className="hint" style={{ padding: '14px' }}>
              Select an item to view details.
            </p>
          </div>
        )}
      </div>
    </div>
  )
}
