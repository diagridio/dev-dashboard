import { useRef } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
  /** Element to focus when the dialog opens (defaults to the dialog itself). */
  initialFocusRef?: React.RefObject<HTMLElement | null>
  /** Confirm-style dialogs use a narrower card than form dialogs. */
  narrow?: boolean
}

export function Modal({ open, title, onClose, children, initialFocusRef, narrow }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useModalFocus(open, onClose, dialogRef, initialFocusRef)

  if (!open) return null

  return (
    <div
      role="none"
      className="modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className={`card modal-card${narrow ? ' narrow' : ''}`}
      >
        <h2 id="modal-title" className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}
