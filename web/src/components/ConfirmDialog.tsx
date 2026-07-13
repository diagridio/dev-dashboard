import { useRef } from 'react'
import { Modal } from './Modal'

interface Props {
  open: boolean
  title: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  /** Destructive actions (default) get the danger button; set false for start/restart-style actions. */
  danger?: boolean
  confirmDataCy?: string
  children?: React.ReactNode
}

/**
 * Shared confirmation dialog: styled Modal with a Cancel + confirm footer.
 * Cancel receives initial focus so Enter never triggers the action by accident.
 */
export function ConfirmDialog({
  open,
  title,
  confirmLabel,
  onConfirm,
  onCancel,
  danger = true,
  confirmDataCy,
  children,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Modal open={open} title={title} onClose={onCancel} initialFocusRef={cancelRef} narrow>
      {children}
      <div className="modal-actions">
        <button ref={cancelRef} className="btn ghost" onClick={onCancel}>
          Cancel
        </button>
        <button
          data-cy={confirmDataCy}
          className={`btn ${danger ? 'danger' : 'primary'}`}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
