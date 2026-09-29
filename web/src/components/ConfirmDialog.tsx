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
  /**
   * The confirmed action is in flight: both buttons are disabled and Escape /
   * backdrop clicks no longer close the dialog, so it can't be re-triggered or
   * dismissed mid-operation. The caller closes it when the action settles.
   */
  busy?: boolean
  /** Confirm button label while busy (defaults to confirmLabel). */
  busyLabel?: string
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
  busy = false,
  busyLabel,
  children,
}: Props) {
  const cancelRef = useRef<HTMLButtonElement>(null)

  return (
    <Modal open={open} title={title} onClose={busy ? () => {} : onCancel} initialFocusRef={cancelRef} narrow>
      {children}
      <div className="modal-actions">
        <button ref={cancelRef} className="btn ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button
          data-cy={confirmDataCy}
          className={`btn ${danger ? 'danger' : 'primary'}`}
          onClick={onConfirm}
          disabled={busy}
        >
          {busy ? (busyLabel ?? confirmLabel) : confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
