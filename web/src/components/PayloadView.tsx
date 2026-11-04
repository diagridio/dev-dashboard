import { useState } from 'react'
import { useApps } from '../hooks/useApps'
import { useBinaryFile } from '../hooks/useBinaryFile'
import { appKey } from '../lib/appKey'
import { parseDaprRef, type DaprRef } from '../lib/daprRef'
import { formatBytes } from '../lib/formatBytes'
import { highlightJson } from '../lib/json-highlight'
import { Spinner } from './Spinner'

const MAX_BYTES = 1048576

const tooLarge = (n: number) => `Payload is ${formatBytes(n)} — too large to show here (limit 1 MiB)`

/** Renders a workflow payload: plain data as before, a $daprRef envelope as an on-demand loadable card. */
export function PayloadView({ value, appId }: { value: string; appId: string }) {
  const parsed = parseDaprRef(value)
  if (parsed.kind === 'data') return <pre className="json">{highlightJson(value)}</pre>
  if (parsed.kind === 'invalid') {
    return (
      <>
        <pre className="json">{highlightJson(value)}</pre>
        <p className="muted" role="note">Invalid data reference: {parsed.reason}</p>
      </>
    )
  }
  return <RefCard dref={parsed.ref} appId={appId} />
}

function RefCard({ dref, appId }: { dref: DaprRef; appId: string }) {
  const [show, setShow] = useState(false)
  const apps = useApps()
  const app = apps.data?.find((a) => a.appId === appId)
  const key = app ? appKey(app) : null

  const stages = dref.stages ?? []
  let blocked: string | null = null
  if (stages.length > 0) blocked = `staged payloads (${stages.map((s) => s.n).join(', ')}) are not supported`
  else if (dref.size > MAX_BYTES) blocked = tooLarge(dref.size)
  else if (!key) blocked = apps.isLoading ? '' : `Start ${appId} to load this payload`

  const q = useBinaryFile(key, dref, show && blocked === null)

  if (show && q.data) {
    const { content, integrity } = q.data
    return (
      <div className="card">
        <div style={{ padding: '9px 14px', display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className={`pill ${integrity === 'verified' ? 'secref-ok' : 'secref-warn'}`}>
            {integrity === 'verified' ? 'verified' : 'hash mismatch'}
          </span>
          <button type="button" className="btn ghost" onClick={() => setShow(false)}>Hide</button>
        </div>
        {content.kind === 'json' && <pre className="json">{highlightJson(content.text)}</pre>}
        {content.kind === 'text' && <pre>{content.text}</pre>}
        {content.kind === 'binary' && (
          <p className="muted" style={{ padding: '0 14px' }}>Binary payload ({content.size} bytes) — not shown</p>
        )}
      </div>
    )
  }

  const loading = show && q.isFetching
  const err = show && q.isError ? q.error : null
  const errText = err ? (err.status === 413 ? tooLarge(err.size ?? dref.size) : err.message) : null

  return (
    <div className="card">
      <div style={{ padding: '9px 14px' }} className="b">Stored in binary store</div>
      <div className="kv">
        <div className="kk">store</div>
        <div className="vv mono">{dref.store}</div>
        <div className="kk">key</div>
        <div className="vv mono">{dref.key}</div>
        <div className="kk">size</div>
        <div className="vv"><span title={`${dref.size} bytes`}>{formatBytes(dref.size)}</span></div>
      </div>
      <div style={{ padding: '9px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn ghost" disabled={blocked !== null || loading} onClick={() => setShow(true)}>
          Load payload
        </button>
        {!!blocked && <span className="muted">{blocked}</span>}
        {loading && (
          <span role="status" className="muted"><Spinner /> Loading…</span>
        )}
        {errText && (
          <>
            <span className="err" role="alert">{errText}</span>
            <button type="button" className="btn ghost" onClick={() => void q.refetch()}>Retry</button>
          </>
        )}
      </div>
    </div>
  )
}
