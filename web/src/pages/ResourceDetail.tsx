import { Link } from 'react-router-dom'
import { useResource } from '../hooks/useResources'
import { CodeBlock } from '../components/CodeBlock'
import { SecretRefsPanel } from '../components/SecretRefsPanel'
import { SecretStorePanel } from '../components/SecretStorePanel'
import type { ResourceKind } from '../types/resources'

export interface ResourceDetailProps {
  kind: ResourceKind
  idOrName: string
}

/**
 * ResourceDetail — right-pane component for the master-detail layout.
 * Fetches and renders the detail for a single resource (kind + id-or-name).
 * Used by ResourceList as the selected-item detail pane.
 */
export function ResourceDetail({ kind, idOrName }: ResourceDetailProps) {
  const { data: detail, isLoading, isError } = useResource(kind, idOrName)

  if (isLoading) {
    return (
      <div className="card">
        <p className="muted" style={{ padding: '14px' }}>
          Loading…
        </p>
      </div>
    )
  }

  if (isError || !detail) {
    return (
      <div className="card">
        <p className="err" style={{ padding: '14px' }}>
          Resource not found or failed to load.
        </p>
      </div>
    )
  }

  const rawYaml = detail.raw ?? ''

  const metaStr =
    kind === 'component'
      ? [detail.type, detail.version].filter(Boolean).join(' · ') + ' · loaded by'
      : 'Configuration · used by'

  const refList = detail.loadedBy ?? []
  const refLabel = kind === 'component' ? 'loaded' : 'used'

  return (
    <div>
      {kind === 'component' && detail.secretStore && <SecretStorePanel info={detail.secretStore} />}
      {kind === 'component' && (detail.secretRefs?.length ?? 0) > 0 && (
        <SecretRefsPanel resourceId={detail.id} refs={detail.secretRefs!} componentType={detail.type} />
      )}
      <div className="card">
        <div className="ph" style={{ display: 'flex', alignItems: 'center', gap: 9, padding: '11px 14px', borderBottom: '1px solid var(--line)', fontWeight: 600, fontSize: '13.5px' }}>
          <span className="mono" style={{ fontWeight: 500, color: 'var(--muted)', fontSize: 12 }}>
            {metaStr}
          </span>
          {refList.length > 0 ? (
            <span>
              {refList.map((appId) => (
                <Link
                  key={appId}
                  className="appref link"
                  to={`/apps/${appId}`}
                  style={{ marginRight: 4 }}
                >
                  {appId}
                </Link>
              ))}
            </span>
          ) : (
            <span className="muted" style={{ fontStyle: 'italic', fontWeight: 400, fontSize: 12 }}>
              not currently {refLabel}
            </span>
          )}
        </div>
        <CodeBlock value={rawYaml} kind="yaml" label="YAML" />
      </div>
    </div>
  )
}
