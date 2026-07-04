import { useRef } from 'react'
import { useModalFocus } from '../hooks/useModalFocus'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}

export function Modal({ open, title, onClose, children }: Props) {
  const dialogRef = useRef<HTMLDivElement>(null)

  useModalFocus(open, onClose, dialogRef)

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
        className="card modal-card"
      >
        <h2 id="modal-title" className="modal-title">{title}</h2>
        {children}
      </div>
    </div>
  )
}
