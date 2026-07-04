import { Modal } from '../Modal'

/** Standard save/cancel modal wrapper shared by the builder add/edit dialogs. */
export function DialogShell({ open, title, onClose, onSave, canSave, children }: {
  open: boolean; title: string; onClose: () => void; onSave: () => void; canSave: boolean; children: React.ReactNode
}) {
  return (
    <Modal open={open} title={title} onClose={onClose}>
      {children}
      <div className="modal-actions">
        <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
        <button type="button" className="btn ghost" disabled={!canSave} onClick={onSave}>Save</button>
      </div>
    </Modal>
  )
}

/** Saving a name that already exists upserts over that record — block it, unless it is the record being edited. */
export function duplicateNameError(name: string, existingNames: string[] | undefined, editing: boolean | undefined, initialName: string | undefined, what: string): string | null {
  if (!existingNames?.includes(name)) return null
  if (editing && name === initialName) return null
  return `A ${what} with this name already exists`
}
