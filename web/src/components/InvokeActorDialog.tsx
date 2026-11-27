import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from './Modal'
import { ClearableInput } from './form'
import { CodeBlock } from './CodeBlock'
import { useInvokeActor } from '../hooks/useActors'
import { actorPath, recentIds, recentMethods, rememberInvoke } from '../lib/actorRecents'
import type { InvokeVerb } from '../types/actors'

interface Props {
  open: boolean
  onClose: () => void
  appKey: string
  appId: string
  actorType: string
  actorId?: string
  suggestedIds?: string[]
}

const VERBS: InvokeVerb[] = ['GET', 'POST', 'PUT', 'DELETE']

function prettyBody(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2)
  } catch {
    return body
  }
}

export function InvokeActorDialog({ open, onClose, appKey, appId, actorType, actorId, suggestedIds }: Props) {
  const [id, setId] = useState(actorId ?? '')
  const [method, setMethod] = useState('')
  const [verb, setVerb] = useState<InvokeVerb>('POST')
  const [body, setBody] = useState('')
  const [idError, setIdError] = useState('')
  const [methodError, setMethodError] = useState('')
  const [bodyError, setBodyError] = useState('')
  const invoke = useInvokeActor(appKey, actorType)

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setId(actorId ?? '')
    setMethod('')
    setVerb('POST')
    setBody('')
    setIdError('')
    setMethodError('')
    setBodyError('')
    invoke.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const idOptions = useMemo(
    () => (open ? Array.from(new Set([...recentIds(appKey, actorType), ...(suggestedIds ?? [])])) : []),
    [open, appKey, actorType, suggestedIds],
  )
  const methodOptions = useMemo(() => (open ? recentMethods(appKey, actorType) : []), [open, appKey, actorType])

  function submit() {
    const trimmedId = id.trim()
    const trimmedMethod = method.trim()
    setIdError('')
    setMethodError('')
    setBodyError('')
    let ok = true
    if (trimmedId === '') { setIdError('Actor ID is required'); ok = false }
    if (trimmedMethod === '') { setMethodError('Method is required'); ok = false }
    if (body.trim() !== '') {
      try {
        JSON.parse(body)
      } catch {
        setBodyError('Invalid JSON body')
        ok = false
      }
    }
    if (!ok) return
    invoke.mutate(
      { id: trimmedId, method: trimmedMethod, verb, body },
      {
        onSuccess: (res) => {
          if (res.status >= 200 && res.status < 300) rememberInvoke(appKey, actorType, trimmedId, trimmedMethod)
        },
      },
    )
  }

  const result = invoke.data

  return (
    <Modal open={open} title="Invoke an actor" onClose={onClose}>
      <p className="muted">
        Invoking <span className="mono">{actorType}</span> runs real app code on the actor host.
      </p>

      {invoke.isSuccess && result ? (
        <div>
          <div className="kv">
            <span className="kk">Status</span>
            <span className="vv mono">{result.status}</span>
            <span className="kk">Duration</span>
            <span className="vv mono">{result.durationMs} ms</span>
          </div>
          {result.error && <p className="err">{result.error}</p>}
          {result.body !== '' && <CodeBlock value={prettyBody(result.body)} kind="text" label="Response" />}
          <p>
            <Link className="celllink" to={actorPath(appKey, actorType, id.trim())}>Open actor</Link>
            {' · '}
            <Link className="celllink" to={`/logs?app=${encodeURIComponent(appId)}&source=app`}>Open {appId} logs</Link>
          </p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => invoke.reset()}>Invoke again</button>
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="field">
            <label htmlFor="invoke-id">Actor ID</label>
            <ClearableInput
              id="invoke-id"
              label="Actor ID"
              className="inp mono"
              list="invoke-ids"
              value={id}
              readOnly={actorId !== undefined}
              onChange={setId}
            />
            <datalist id="invoke-ids">
              {idOptions.map((v) => <option key={v} value={v} />)}
            </datalist>
            {idError && <p className="field-err">{idError}</p>}
          </div>

          <div className="field">
            <label htmlFor="invoke-method">Method</label>
            <ClearableInput
              id="invoke-method"
              label="Method"
              className="inp mono"
              list="invoke-methods"
              value={method}
              onChange={setMethod}
            />
            <datalist id="invoke-methods">
              {methodOptions.map((v) => <option key={v} value={v} />)}
            </datalist>
            {methodError && <p className="field-err">{methodError}</p>}
          </div>

          <div className="field">
            <label htmlFor="invoke-verb">HTTP verb</label>
            <select id="invoke-verb" className="inp" value={verb} onChange={(e) => setVerb(e.target.value as InvokeVerb)}>
              {VERBS.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </div>

          <div className="field">
            <label htmlFor="invoke-body">Body</label>
            <textarea
              id="invoke-body"
              className="inp mono"
              rows={6}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
            <p className="muted">.NET actors: methods with more than one parameter can't be called this way.</p>
            {bodyError && <p className="field-err">{bodyError}</p>}
          </div>

          {invoke.isError && <p className="err">{(invoke.error as Error).message}</p>}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={invoke.isPending} onClick={submit}>
              Invoke
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
