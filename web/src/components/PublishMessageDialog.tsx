import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from './Modal'
import { usePublishMessage } from '../hooks/usePublishMessage'

interface Props {
  open: boolean
  onClose: () => void
  instanceKey: string
  appId: string
  pubsubName: string
  topic: string
}

const CONTENT_TYPES = ['application/json', 'text/plain', 'application/octet-stream']

function isJSONType(ct: string): boolean {
  return ct.includes('json')
}

export function PublishMessageDialog({ open, onClose, instanceKey, appId, pubsubName, topic }: Props) {
  const [data, setData] = useState('{}')
  const [contentType, setContentType] = useState('application/json')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [ttl, setTtl] = useState('')
  const [rawPayload, setRawPayload] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const pub = usePublishMessage(instanceKey)

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setData('{}')
    setContentType('application/json')
    setShowAdvanced(false)
    setTtl('')
    setRawPayload(false)
    setJsonError('')
    pub.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  function submit() {
    setJsonError('')
    if (isJSONType(contentType) && data.trim() !== '') {
      try {
        JSON.parse(data)
      } catch {
        setJsonError('Invalid JSON payload')
        return
      }
    }
    const metadata: Record<string, string> = {}
    if (ttl.trim() !== '') metadata.ttlInSeconds = ttl.trim()
    if (rawPayload) metadata.rawPayload = 'true'
    pub.mutate({ pubsubName, topic, data, contentType, metadata: Object.keys(metadata).length ? metadata : undefined })
  }

  return (
    <Modal open={open} title="Publish a message" onClose={onClose}>
      <p className="muted">
        Publishing to <span className="mono">{pubsubName}</span> / <span className="mono">{topic}</span> sends a real
        message to the broker.
      </p>

      {pub.isSuccess ? (
        <div>
          <p>Published to <span className="mono">{topic}</span>.</p>
          <p>
            <Link className="celllink" to={`/logs?app=${encodeURIComponent(appId)}&source=app`}>Open {appId} logs</Link> to
            watch it get handled.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <div>
          <div className="field">
            <label htmlFor="pub-data">Payload</label>
            <textarea
              id="pub-data"
              className="inp mono"
              rows={6}
              value={data}
              onChange={(e) => setData(e.target.value)}
            />
            {jsonError && <p className="field-err">{jsonError}</p>}
          </div>

          <div className="field">
            <label htmlFor="pub-ct">Content-Type</label>
            <select id="pub-ct" className="inp" value={contentType} onChange={(e) => setContentType(e.target.value)}>
              {CONTENT_TYPES.map((ct) => (
                <option key={ct} value={ct}>{ct}</option>
              ))}
            </select>
          </div>

          <button type="button" className="btn ghost" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide' : 'Show'} advanced
          </button>
          {showAdvanced && (
            <>
              <div className="field">
                <label htmlFor="pub-ttl">ttlInSeconds</label>
                <input id="pub-ttl" className="inp" type="number" min="0" value={ttl} onChange={(e) => setTtl(e.target.value)} />
              </div>
              <label className="childtoggle">
                <input type="checkbox" checked={rawPayload} onChange={(e) => setRawPayload(e.target.checked)} /> rawPayload
                (bypass CloudEvent wrapping)
              </label>
            </>
          )}

          {pub.isError && <p className="err">{(pub.error as Error).message}</p>}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
            <button type="button" className="btn primary" disabled={pub.isPending} onClick={submit}>
              Publish
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
