import { useId, useState } from 'react'
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
  const reasonId = useId()
  const apps = useApps()
  // A stopped instance stays listed (lifecycle overlay); only a live one can serve the file.
  const app = apps.data?.find((a) => a.appId === appId && a.sidecarReachable !== false && a.daprdStatus !== 'stopped')
  const key = app ? appKey(app) : null

  const stages = dref.stages ?? []
  let blocked: string | null = null
  if (stages.length > 0) blocked = `staged payloads (${stages.map((s) => s.n).join(', ')}) are not supported`
  else if (dref.size > MAX_BYTES) blocked = tooLarge(dref.size)
  else if (!key) {
    if (apps.isLoading) blocked = ''
    else if (apps.isError) blocked = "Couldn't load the app list"
    else blocked = `Start ${appId} to load this payload`
  }

  const q = useBinaryFile(key, dref, show && blocked === null)

  if (show && q.data) {
    const { content, integrity } = q.data
    return (
      <div className="refcard">
        <div className="refcard-bar">
          <span
            className={`pill integ-${integrity === 'verified' ? 'ok' : integrity === 'mismatch' ? 'warn' : 'unknown'}`}
            title={integrity === 'unverified' ? 'SHA-256 check needs HTTPS or localhost' : undefined}
          >
            {integrity === 'verified' ? 'verified' : integrity === 'mismatch' ? 'hash mismatch' : 'unverified'}
          </span>
          <button type="button" className="btn ghost" onClick={() => setShow(false)}>Hide</button>
        </div>
        {content.kind === 'json' && <pre className="json">{highlightJson(content.text)}</pre>}
        {content.kind === 'text' && <pre className="json">{content.text}</pre>}
        {content.kind === 'binary' && (
          <p className="muted refcard-note">Binary payload ({content.size} bytes) — not shown</p>
        )}
      </div>
    )
  }

  const loading = show && q.isFetching
  const err = show && q.isError && !q.isFetching ? q.error : null
  const errText = err ? (err.status === 413 ? tooLarge(err.size ?? dref.size) : err.message) : null

  return (
    <div className="refcard">
      <div className="refcard-bar b">Stored in binary store</div>
      <div className="kv">
        <div className="kk">store</div>
        <div className="vv mono">{dref.store}</div>
        <div className="kk">key</div>
        <div className="vv mono">{dref.key}</div>
        <div className="kk">size</div>
        <div className="vv"><span title={`${dref.size} bytes`}>{formatBytes(dref.size)}</span></div>
      </div>
      <div className="refcard-bar wrap">
        <button
          type="button"
          className="btn ghost"
          disabled={blocked !== null || loading}
          aria-describedby={blocked ? reasonId : undefined}
          onClick={() => setShow(true)}
        >
          Load payload
        </button>
        {!!blocked && <span id={reasonId} className="muted">{blocked}</span>}
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
