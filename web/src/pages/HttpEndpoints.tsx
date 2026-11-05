import { Link, useNavigate, useParams } from 'react-router-dom'
import { useResource, useResources } from '../hooks/useResources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { highlightYaml } from '../lib/yaml-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import { SecretStatusPill } from '../components/SecretStatusPill'
import type { HTTPEndpointHeader, ResourceSummary, SecretRefStatus } from '../types/resources'

function PageHead() {
  return (
    <div className="phead">
      <div>
        <h1>HTTP Endpoints</h1>
        <div className="sub">
          Dapr <span className="mono">HTTPEndpoint</span> resources (non-Dapr services called through{' '}
          <span className="mono">/v1.0/invoke</span>) from <span className="mono">~/.dapr/components</span> and live{' '}
          <span className="mono">--resources-path</span> args
        </div>
      </div>
    </div>
  )
}

function scopeLabel(scopes?: string[]): string {
  return scopes && scopes.length > 0 ? `scopes: ${scopes.join(', ')}` : 'all apps'
}

/** Where a header's value comes from; secret and env values are never shown. */
function headerSource(h: HTTPEndpointHeader): string {
  if (h.secretKeyRef) {
    return `secretKeyRef ${h.secretKeyRef.name}${h.secretKeyRef.key ? `/${h.secretKeyRef.key}` : ''}`
  }
  if (h.envRef) return `envRef ${h.envRef}`
  return 'value'
}

/** A secret reference that was checked and does not resolve. */
function isUnresolved(ref: SecretRefStatus): boolean {
  return ref.status !== 'resolved' && ref.status !== 'not-checked'
}

function hasUnresolvedRef(r: ResourceSummary): boolean {
  return r.secretRefs?.some(isUnresolved) ?? false
}

/** Value cell of a header: plain values as-is; references stay masked and
 *  carry their resolution status, like component secret references. */
function HeaderValue({ header, refs }: { header: HTTPEndpointHeader; refs?: SecretRefStatus[] }) {
  if (!header.secretKeyRef && !header.envRef) return <>{header.value ?? ''}</>
  const ref = refs?.find((r) => r.field === header.name)
  return (
    <span style={{ display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
      {ref && <SecretStatusPill status={ref.status} />}
      {ref && isUnresolved(ref) && ref.detail ? (
        <span style={{ fontSize: 12, color: 'var(--muted)' }}>{ref.detail}</span>
      ) : (
        <span className="muted">••••••••</span>
      )}
    </span>
  )
}

export function HttpEndpoints() {
  useDocumentTitle('HTTP Endpoints')
  const { data: resources, isLoading, isError } = useResources('httpendpoint')
  const { name: selectedParam } = useParams<{ name?: string }>()
  const navigate = useNavigate()

  if (isLoading) {
    return (
      <div className="page">
        <PageHead />
        <p className="muted">Loading…</p>
      </div>
    )
  }

  if (isError || !resources || resources.length === 0) {
    return (
      <div className="page">
        <PageHead />
        <div className="md">
          <div className="card complist" />
          <div className="card">
            <p className={isError ? 'err' : 'hint'} style={{ padding: '14px' }}>
              {isError ? 'Failed to load HTTP endpoints.' : 'No HTTPEndpoint resources found.'}
            </p>
          </div>
        </div>
      </div>
    )
  }

  // Resolve the selection: id match first, then name, then the first item.
  const selected =
    resources.find((r) => r.id === selectedParam) ??
    resources.find((r) => r.name === selectedParam) ??
    resources[0]
  const handleSelect = (id: string) => navigate(`/http-endpoints/${id}`)

  return (
    <div className="page">
      <PageHead />
      <div className="md">
        <div className="card complist">
          {resources.map((r) => {
            const isSelected = r.id === selected.id
            return (
              <div
                key={r.id}
                className={`ci${isSelected ? ' sel' : ''}`}
                onClick={() => handleSelect(r.id)}
                role="button"
                aria-selected={isSelected}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') handleSelect(r.id)
                }}
              >
                <span className="cn">{r.name}</span>
                {hasUnresolvedRef(r) && (
                  <span
                    className="cn-secretwarn"
                    aria-label={`${r.name} has an unresolved secret reference`}
                    title="Unresolved secret reference"
                  >
                    ⚠
                  </span>
                )}
                <span className="ct">{r.httpEndpoint?.baseUrl ?? '—'}</span>
                <span className="ct">{scopeLabel(r.scopes)}</span>
              </div>
            )
          })}
        </div>
        <HttpEndpointDetail summary={selected} />
      </div>
    </div>
  )
}

function HttpEndpointDetail({ summary }: { summary: ResourceSummary }) {
  const { data: detail } = useResource('httpendpoint', summary.id)
  const { toast, toastNode } = useToast()
  const spec = summary.httpEndpoint
  const headers = spec?.headers ?? []
  const rawYaml = detail?.raw ?? ''

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph">{summary.name}</div>
        <div className="kv">
          <div className="kk">Base URL</div>
          <div className="vv mono">{spec?.baseUrl || '—'}</div>
          {spec?.clientTLS && (
            <>
              <div className="kk">Client TLS</div>
              <div className="vv">configured</div>
            </>
          )}
          <div className="kk">File</div>
          <div className="vv mono">{summary.path}</div>
          <div className="kk">Scopes</div>
          <div className="vv" style={{ flexWrap: 'wrap', gap: 4 }}>
            {summary.scopes && summary.scopes.length > 0 ? (
              summary.scopes.map((s) => (
                <span key={s} className="appref">{s}</span>
              ))
            ) : (
              <span className="muted">all apps</span>
            )}
          </div>
          <div className="kk">Loaded by</div>
          <div className="vv" style={{ flexWrap: 'wrap', gap: 4 }}>
            {summary.loadedBy && summary.loadedBy.length > 0 ? (
              summary.loadedBy.map((key) => (
                <Link key={key} className="appref link" to={`/apps/${key}`}>{key}</Link>
              ))
            ) : (
              <span className="muted" style={{ fontStyle: 'italic' }}>not currently loaded</span>
            )}
          </div>
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph">Headers</div>
        {headers.length > 0 ? (
          <table className="t">
            <thead>
              <tr><th>Name</th><th>Source</th><th>Value</th></tr>
            </thead>
            <tbody>
              {headers.map((h, i) => (
                <tr key={`${h.name}/${i}`}>
                  <td className="mono">{h.name}</td>
                  <td className="mono">{headerSource(h)}</td>
                  <td className="mono">
                    <HeaderValue header={h} refs={summary.secretRefs} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint" style={{ padding: '14px' }}>No headers defined.</p>
        )}
      </div>

      <div className="panel">
        <div className="ph">
          YAML
          <button
            className="copybtn"
            onClick={() => {
              if (rawYaml) {
                copyText(rawYaml)
                toast.show('YAML copied')
              }
            }}
          >
            ⧉ Copy YAML
          </button>
        </div>
        <pre className="code">{highlightYaml(rawYaml)}</pre>
        {toastNode}
      </div>
    </div>
  )
}
