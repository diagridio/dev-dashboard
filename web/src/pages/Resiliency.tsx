import { Link, useNavigate, useParams } from 'react-router-dom'
import { useResource, useResources } from '../hooks/useResources'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { highlightYaml } from '../lib/yaml-highlight'
import { copyText } from '../lib/clipboard'
import { useToast } from '../lib/toast'
import type { ResourceSummary, ResiliencySpec } from '../types/resources'

function PageHead() {
  return (
    <div className="phead">
      <div>
        <h1>Resiliency</h1>
        <div className="sub">
          Dapr <span className="mono">Resiliency</span> resources from{' '}
          <span className="mono">~/.dapr/resources</span> and live{' '}
          <span className="mono">--resources-path</span> args
        </div>
      </div>
      <Link className="btn primary" to="/resiliency/new">+ New resiliency policy</Link>
    </div>
  )
}

function scopeLabel(scopes?: string[]): string {
  return scopes && scopes.length > 0 ? `scopes: ${scopes.join(', ')}` : 'all apps'
}

export function Resiliency() {
  useDocumentTitle('Resiliency')
  const { data: resources, isLoading, isError } = useResources('resiliency')
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
              {isError
                ? 'Failed to load resiliency policies.'
                : <>No resiliency policies. Use &ldquo;New resiliency policy&rdquo; to build one.</>}
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
  const handleSelect = (id: string) => navigate(`/resiliency/${id}`)

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
                <span className="ct">{scopeLabel(r.scopes)}</span>
                <span
                  className="ct"
                  title={r.path}
                  style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                >
                  {r.path}
                </span>
              </div>
            )
          })}
        </div>
        <ResiliencyDetail summary={selected} />
      </div>
    </div>
  )
}

interface PolicyRow {
  type: string
  name: string
  settings: string
}

function formatSettings(obj: Record<string, unknown>): string {
  return Object.entries(obj)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ')
}

function policyRows(spec: ResiliencySpec): PolicyRow[] {
  const p = spec.policies ?? {}
  return [
    ...Object.entries(p.timeouts ?? {}).map(([name, d]) => ({ type: 'timeout', name, settings: d })),
    ...Object.entries(p.retries ?? {}).map(([name, r]) => ({
      type: 'retry',
      name,
      settings: formatSettings(r as Record<string, unknown>),
    })),
    ...Object.entries(p.circuitBreakers ?? {}).map(([name, cb]) => ({
      type: 'circuit breaker',
      name,
      settings: formatSettings(cb as Record<string, unknown>),
    })),
  ]
}

interface TargetRow {
  kind: string
  name: string
  timeout?: string
  retry?: string
  circuitBreaker?: string
}

function targetRows(spec: ResiliencySpec): TargetRow[] {
  const t = spec.targets ?? {}
  const rows: TargetRow[] = [
    ...Object.entries(t.apps ?? {}).map(([name, r]) => ({ kind: 'app', name, ...r })),
    ...Object.entries(t.actors ?? {}).map(([name, r]) => ({ kind: 'actor', name, ...r })),
  ]
  for (const [name, c] of Object.entries(t.components ?? {})) {
    if (c.outbound) rows.push({ kind: 'component · outbound', name, ...c.outbound })
    if (c.inbound) rows.push({ kind: 'component · inbound', name, ...c.inbound })
  }
  return rows
}

function ResiliencyDetail({ summary }: { summary: ResourceSummary }) {
  const { data: detail } = useResource('resiliency', summary.id)
  const { toast, toastNode } = useToast()
  const spec = summary.resiliency
  const policies = spec ? policyRows(spec) : []
  const targets = spec ? targetRows(spec) : []
  const rawYaml = detail?.raw ?? ''

  return (
    <div>
      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph">{summary.name}</div>
        <div className="kv">
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
        </div>
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph">Policies</div>
        {policies.length > 0 ? (
          <table className="t">
            <thead>
              <tr><th>Type</th><th>Name</th><th>Settings</th></tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={`${p.type}/${p.name}`}>
                  <td>{p.type}</td>
                  <td className="mono">{p.name}</td>
                  <td className="mono">{p.settings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint" style={{ padding: '14px' }}>No policies defined.</p>
        )}
      </div>

      <div className="panel" style={{ marginBottom: 12 }}>
        <div className="ph">Targets</div>
        {targets.length > 0 ? (
          <table className="t">
            <thead>
              <tr><th>Kind</th><th>Target</th><th>Timeout</th><th>Retry</th><th>Circuit breaker</th></tr>
            </thead>
            <tbody>
              {targets.map((t) => (
                <tr key={`${t.kind}/${t.name}`}>
                  <td>{t.kind}</td>
                  <td className="mono">{t.name}</td>
                  <td className="mono">{t.timeout ?? '—'}</td>
                  <td className="mono">{t.retry ?? '—'}</td>
                  <td className="mono">{t.circuitBreaker ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="hint" style={{ padding: '14px' }}>No targets defined.</p>
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
