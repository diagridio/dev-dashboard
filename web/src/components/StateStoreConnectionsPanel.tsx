import { useState } from 'react'
import { useStateStores } from '../hooks/useWorkflows'
import { useStoreMutations } from '../hooks/useStoreMutations'
import { StateStoreConnectionDialog } from './StateStoreConnectionDialog'
import { Modal } from './Modal'
import { storeTypeLabel } from '../lib/storeTypes'
import type { StateStore } from '../types/workflow'

export function StateStoreConnectionsPanel() {
  const { data: stores } = useStateStores()
  const { deleteStore } = useStoreMutations()

  const [dialog, setDialog] = useState<{ mode: 'add' | 'edit'; initial?: StateStore } | null>(null)
  const [pendingDelete, setPendingDelete] = useState<StateStore | null>(null)

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: 13 }}>State store connections</b>
        <button className="btn primary" onClick={() => setDialog({ mode: 'add' })}>+ Add connection</button>
      </div>

      {(stores ?? []).length === 0 && <p className="hint">No state store connections yet.</p>}

      {(stores ?? []).map((s) => (
        <div
          key={s.id}
          className="field-row"
          style={{ justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--line-soft)' }}
        >
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
            <b style={{ fontSize: 12.5 }}>{s.name}</b>
            <span className="chip">{storeTypeLabel(s.type)}</span>
            {s.connection && <span className="chip">{s.connection}</span>}
            <span className="pill">{s.source}</span>
            {s.active && <span className="pill" style={{ color: 'var(--done-fg)' }}>ACTIVE</span>}
          </span>
          {s.source === 'manual' && (
            <span style={{ display: 'flex', gap: 6 }}>
              <button className="btn ghost" aria-label={`edit ${s.name}`} onClick={() => setDialog({ mode: 'edit', initial: s })}>Edit</button>
              <button className="btn danger" aria-label={`delete ${s.name}`} onClick={() => setPendingDelete(s)}>Delete</button>
            </span>
          )}
        </div>
      ))}

      {/* Mount the dialog only while open, so the component catalog isn't
          fetched on every Components-page load — only when Add/Edit is used. */}
      {dialog && (
        <StateStoreConnectionDialog
          open
          mode={dialog.mode}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
        />
      )}

      <Modal open={pendingDelete !== null} title="Delete connection?" onClose={() => setPendingDelete(null)}>
        <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 14 }}>
          Remove the connection <b>{pendingDelete?.name}</b>? This only removes it from the dashboard registry.
        </p>
        <div className="modal-actions">
          <button className="btn ghost" onClick={() => setPendingDelete(null)}>Cancel</button>
          <button
            className="btn danger"
            onClick={async () => {
              if (pendingDelete) await deleteStore.mutateAsync(pendingDelete.id)
              setPendingDelete(null)
            }}
          >Delete</button>
        </div>
      </Modal>
    </div>
  )
}
