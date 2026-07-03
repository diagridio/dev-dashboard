import { useEffect, useMemo, useState } from 'react'
import { Modal } from './Modal'
import { MetadataFieldInput } from './MetadataFieldInput'
import { useComponentCatalog } from '../hooks/useComponentCatalog'
import { useStoreMutations } from '../hooks/useStoreMutations'
import { SUPPORTED_STORE_TYPES, storeTypeLabel } from '../lib/storeTypes'

interface Props {
  open: boolean
  onClose: () => void
  /** Called after a successful save. The owner is responsible for closing the
   * dialog and showing the confirmation toast — this component unmounts on
   * close, so a toast rendered here would never be seen. */
  onSaved: (name: string) => void
}

export function StateStoreConnectionDialog({ open, onClose, onSaved }: Props) {
  const { fieldsFor, isError } = useComponentCatalog()
  const { addStore } = useStoreMutations()

  const [name, setName] = useState('')
  const [type, setType] = useState<string>(SUPPORTED_STORE_TYPES[0])
  const [values, setValues] = useState<Record<string, string>>({})
  const [optional, setOptional] = useState<string[]>([])
  const [actorStateStore, setActorStateStore] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reset form whenever the dialog opens.
  useEffect(() => {
    if (!open) return
    setName('')
    setType(SUPPORTED_STORE_TYPES[0])
    setValues({})
    setOptional([])
    setActorStateStore(true)
    setError(null)
  }, [open])

  const allFields = fieldsFor(type)
  const required = useMemo(() => allFields.filter((f) => f.required), [allFields])
  const optionalPool = useMemo(
    () => allFields.filter((f) => !f.required && !optional.includes(f.name)),
    [allFields, optional],
  )

  const setValue = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }))

  const numberInvalid = allFields.some(
    (f) => f.type === 'number' && (values[f.name] ?? '') !== '' && Number.isNaN(Number(values[f.name])),
  )
  const canSave =
    name.trim() !== '' && required.every((f) => (values[f.name] ?? '').trim() !== '') && !numberInvalid

  async function handleSave() {
    setError(null)
    const metadata: Record<string, string> = {}
    for (const f of required) metadata[f.name] = values[f.name]
    for (const n of optional) {
      const v = values[n] ?? ''
      if (v !== '') metadata[n] = v
    }
    if (actorStateStore) metadata.actorStateStore = 'true'

    try {
      await addStore.mutateAsync({ name: name.trim(), type, metadata })
      onSaved(name.trim())
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const optionalByName = (n: string) => allFields.find((f) => f.name === n)

  return (
    <Modal open={open} title="Add state store connection" onClose={onClose}>
      {isError && <p className="field-err">Couldn't load the component catalog; try reloading.</p>}

      <div className="field">
        <label htmlFor="ss-name">Name <span className="req">*</span></label>
        <input id="ss-name" aria-label="Name" className="inp" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div className="field">
        <label htmlFor="ss-type">Type</label>
        <select
          id="ss-type"
          aria-label="Type"
          className="inp"
          value={type}
          onChange={(e) => {
            setType(e.target.value)
            setValues({})
            setOptional([])
          }}
        >
          {SUPPORTED_STORE_TYPES.map((t) => (
            <option key={t} value={t}>{storeTypeLabel(t)}</option>
          ))}
        </select>
      </div>

      <div className="section-label">Required fields</div>
      {required.map((f) => (
        <div className="field" key={f.name}>
          <label>{f.name} <span className="req">*</span></label>
          <MetadataFieldInput field={f} value={values[f.name] ?? ''} onChange={(v) => setValue(f.name, v)} />
        </div>
      ))}

      <div className="section-label">Optional fields</div>
      {optional.map((n) => {
        const f = optionalByName(n)
        if (!f) return null
        return (
          <div className="field" key={n}>
            <label>{n}</label>
            <div className="field-row">
              <MetadataFieldInput field={f} value={values[n] ?? ''} onChange={(v) => setValue(n, v)} />
              <button
                type="button"
                className="btn ghost"
                aria-label={`remove ${n}`}
                onClick={() => {
                  setOptional((prev) => prev.filter((x) => x !== n))
                  setValues((prev) => {
                    const next = { ...prev }
                    delete next[n]
                    return next
                  })
                }}
              >✕</button>
            </div>
          </div>
        )
      })}
      {optionalPool.length > 0 && (
        <select
          className="inp"
          aria-label="add optional field"
          value=""
          onChange={(e) => {
            if (e.target.value) setOptional((prev) => [...prev, e.target.value])
          }}
        >
          <option value="">+ add optional field…</option>
          {optionalPool.map((f) => (
            <option key={f.name} value={f.name}>{f.name}</option>
          ))}
        </select>
      )}

      <div className="field-row" style={{ marginTop: 12 }}>
        <input
          id="ss-actor"
          type="checkbox"
          checked={actorStateStore}
          onChange={(e) => setActorStateStore(e.target.checked)}
        />
        <label htmlFor="ss-actor">Use for actors / workflows (actorStateStore)</label>
      </div>

      {error && <p className="field-err">{error}</p>}

      <div className="modal-actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn ghost" disabled={!canSave} onClick={handleSave}>Save connection</button>
      </div>
    </Modal>
  )
}
