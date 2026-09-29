import { useEffect, useState } from 'react'
import { Modal } from './Modal'
import { Field } from './form'
import { useCreateStateRecord } from '../hooks/useStateRecords'
import type { StateWriteError } from '../types/state'

interface Props {
  open: boolean
  onClose: () => void
  /** The store the page is browsing; the write targets the same one. */
  store?: string
  /** Known key prefixes, offered as suggestions rather than as a closed list. */
  appIds: string[]
  /** The page's current app filter, if any. */
  defaultAppId?: string
}

const APPID_LIST = 'new-state-record-appids'

export function NewStateRecordDialog({ open, onClose, store, appIds, defaultAppId }: Props) {
  const [appId, setAppId] = useState(defaultAppId ?? '')
  const [key, setKey] = useState('')
  const [value, setValue] = useState('')
  const create = useCreateStateRecord()

  // Reset the form whenever the dialog opens, so a previous success or conflict
  // never greets the next record.
  useEffect(() => {
    if (!open) return
    setAppId(defaultAppId ?? '')
    setKey('')
    setValue('')
    create.reset()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, defaultAppId])

  function submit(overwrite: boolean) {
    create.mutate({ appId: appId.trim(), key: key.trim(), value, overwrite, store })
  }

  /**
   * Editing either half of the key retires the last failure. A conflict is
   * about one specific key: leaving the Overwrite button up after a rename
   * would offer to clobber a record the user never saw.
   */
  function editKeyPart(set: (v: string) => void, v: string) {
    if (create.isError) create.reset()
    set(v)
  }

  const conflict = (create.error as StateWriteError | null)?.status === 409
  // Every field is required. The key halves are trimmed — leading or trailing
  // space in a key is a typo, not a key — but the value is only checked for
  // being present, since whitespace can be exactly the bytes someone means to
  // store.
  const canSave = appId.trim() !== '' && key.trim() !== '' && value !== ''
  const composed = `${appId.trim()}${key.trim() ? `||${key.trim()}` : ''}`

  return (
    <Modal open={open} title="New state record" onClose={onClose}>
      {create.isSuccess ? (
        <div>
          <p>
            Created <span className="mono">{create.data.key}</span>.
          </p>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      ) : (
        <div>
          {/* Raw controls rather than the form/ TextInput primitives: the app id
              needs a datalist and all three want the mono face. Field still owns
              the label and its required asterisk. */}
          <Field label="App ID" htmlFor="new-rec-app" required>
            <input
              id="new-rec-app"
              className="inp mono"
              list={APPID_LIST}
              autoComplete="off"
              placeholder="order-app"
              value={appId}
              onChange={(e) => editKeyPart(setAppId, e.target.value)}
            />
          </Field>
          <datalist id={APPID_LIST}>
            {appIds.map((id) => (
              <option key={id} value={id} />
            ))}
          </datalist>

          <Field label="Key" htmlFor="new-rec-key" required>
            <input
              id="new-rec-key"
              className="inp mono"
              placeholder="cart-1"
              value={key}
              onChange={(e) => editKeyPart(setKey, e.target.value)}
            />
          </Field>

          <Field label="Value" htmlFor="new-rec-value" required>
            <textarea
              id="new-rec-value"
              className="inp mono"
              rows={6}
              value={value}
              onChange={(e) => setValue(e.target.value)}
            />
          </Field>
          <p className="muted" style={{ fontSize: 12, marginTop: -4 }}>
            Stored verbatim. Dapr SDKs read values as JSON — wrap text in quotes to read it back as
            a string.
          </p>

          <p className="muted" style={{ fontSize: 12 }}>
            Stored key: <span className="mono" data-testid="composed-key">{composed}</span>
          </p>

          {create.isError &&
            (conflict ? (
              <p className="err">{(create.error as Error).message} — overwrite it?</p>
            ) : (
              <p className="err">{(create.error as Error).message}</p>
            ))}

          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            {conflict ? (
              <button
                type="button"
                className="btn danger"
                disabled={create.isPending}
                onClick={() => submit(true)}
              >
                Overwrite
              </button>
            ) : (
              <button
                type="button"
                className="btn primary"
                disabled={!canSave || create.isPending}
                onClick={() => submit(false)}
              >
                Save
              </button>
            )}
          </div>
        </div>
      )}
    </Modal>
  )
}
