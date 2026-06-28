import { Link } from 'react-router-dom'
import { useResource } from '../hooks/useResources'
import { highlightYaml } from '../lib/yaml-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { ResourceKind } from '../types/resources'

export interface ResourceDetailProps {
  kind: ResourceKind
  name: string
}

/**
 * ResourceDetail — right-pane component for the master-detail layout.
 * Fetches and renders the detail for a single resource (kind + name).
 * Used by ResourceList as the selected-item detail pane.
 */
export function ResourceDetail({ kind, name }: ResourceDetailProps) {
  const { data: detail, isLoading, isError } = useResource(kind, name)
  const { toast, toastNode } = useToast()

  useDocumentTitle(name)

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

  const copyYaml = () => {
    if (rawYaml) {
      copyText(rawYaml)
      toast.show('YAML copied')
    }
  }

  return (
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
        <button className="copybtn" style={{ marginLeft: 'auto' }} onClick={copyYaml}>
          ⧉ Copy YAML
        </button>
      </div>
      <pre className="code">{highlightYaml(rawYaml)}</pre>
      {toastNode}
    </div>
  )
}
