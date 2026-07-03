import { useState } from 'react'
import { useStateStores } from '../hooks/useWorkflows'
import { useStoreMutations } from '../hooks/useStoreMutations'
import { StateStoreConnectionDialog } from './StateStoreConnectionDialog'
import { Modal } from './Modal'
import { storeTypeLabel } from '../lib/storeTypes'
import { useToast } from '../lib/toast'
import type { StateStore } from '../types/workflow'

export function StateStoreConnectionsPanel() {
  const { data: stores } = useStateStores()
  const { deleteStore } = useStoreMutations()
  // The panel owns the toast: the add dialog unmounts on close, so any toast
  // rendered inside it would disappear before the user could see it.
  const { toast, toastNode } = useToast()

  const [addOpen, setAddOpen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<StateStore | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const openDeleteConfirm = (s: StateStore) => {
    setDeleteError(null)
    setPendingDelete(s)
  }
  const closeDeleteConfirm = () => {
    setDeleteError(null)
    setPendingDelete(null)
  }

  async function handleConfirmDelete() {
    if (!pendingDelete) return
    setDeleteError(null)
    try {
      await deleteStore.mutateAsync(pendingDelete.id)
      toast.show(`Removed ${pendingDelete.name}`)
      closeDeleteConfirm()
    } catch (e) {
      // Keep the modal open so the user sees what failed and can retry/cancel.
      setDeleteError((e as Error).message)
    }
  }

  return (
    <div className="card" style={{ padding: '14px 16px', marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <b style={{ fontSize: 13 }}>State store connections</b>
        <button className="btn ghost" onClick={() => setAddOpen(true)}>+ Add connection</button>
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
              <button className="btn danger" aria-label={`delete ${s.name}`} onClick={() => openDeleteConfirm(s)}>Delete</button>
            </span>
          )}
        </div>
      ))}

      {/* Mount the dialog only while open, so the component catalog isn't
          fetched on every Components-page load — only when Add is used. */}
      {addOpen && (
        <StateStoreConnectionDialog
          open
          onClose={() => setAddOpen(false)}
          onSaved={(name) => {
            setAddOpen(false)
            toast.show(`Added ${name}`)
          }}
        />
      )}

      <Modal open={pendingDelete !== null} title="Delete connection?" onClose={closeDeleteConfirm}>
        <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 14 }}>
          Remove the connection <b>{pendingDelete?.name}</b>? This only removes it from the dashboard registry.
        </p>
        {deleteError && <p className="field-err">{deleteError}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeDeleteConfirm}>Cancel</button>
          <button className="btn danger" onClick={handleConfirmDelete}>Delete</button>
        </div>
      </Modal>

      {toastNode}
    </div>
  )
}
