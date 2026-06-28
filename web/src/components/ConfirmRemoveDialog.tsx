import { useEffect, useRef, useState } from 'react'
import type { WorkflowStatus } from '../types/workflow'

const TERMINAL: WorkflowStatus[] = ['Completed', 'Failed', 'Terminated']

export function mechanismFor(status: WorkflowStatus | undefined, force: boolean): string {
  if (force) return 'Force delete'
  if (status && TERMINAL.includes(status)) return 'Purge'
  return 'Terminate + Purge'
}

interface Target {
  appId: string
  instanceId: string
  status?: WorkflowStatus
}

interface Props {
  open: boolean
  targets: Target[]
  onConfirm: (force: boolean) => void
  onCancel: () => void
  initialForce?: boolean
}

export function ConfirmRemoveDialog({ open, targets, onConfirm, onCancel, initialForce = false }: Props) {
  const [force, setForce] = useState(initialForce)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)

  // Reset force when dialog opens/closes
  useEffect(() => {
    if (open) {
      setForce(initialForce)
      // Autofocus cancel on next tick
      setTimeout(() => cancelRef.current?.focus(), 0)
    }
  }, [open, initialForce])

  // Escape key handler + focus trap
  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel()
      if (e.key === 'Tab') {
        const dialog = dialogRef.current
        if (!dialog) return
        const focusable = dialog.querySelectorAll<HTMLElement>(
          'button, input, [tabindex]:not([tabindex="-1"])'
        )
        const first = focusable[0]
        const last = focusable[focusable.length - 1]
        if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first?.focus()
        } else if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last?.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open, onCancel])

  if (!open) return null

  // Compute mechanism summary
  const counts: Record<string, number> = {}
  for (const t of targets) {
    const m = mechanismFor(t.status, force)
    counts[m] = (counts[m] ?? 0) + 1
  }
  const mechanisms = Object.keys(counts)
  const isMixed = mechanisms.length > 1

  let mechanismSummary: string
  if (isMixed) {
    mechanismSummary = mechanisms.map((m) => `${counts[m]} will be ${m.toLowerCase()}`).join(', ')
  } else {
    mechanismSummary =
      targets.length === 1
        ? `This workflow will be ${mechanisms[0]?.toLowerCase() ?? ''}`
        : `All ${targets.length} will be ${mechanisms[0]?.toLowerCase() ?? ''}`
  }

  return (
    <div
      role="none"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-remove-title"
        className="card"
        style={{ maxWidth: 420, width: '100%', padding: 28, display: 'flex', flexDirection: 'column', gap: 18 }}
      >
        <h2 id="confirm-remove-title" style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>
          Remove {targets.length} workflow{targets.length !== 1 ? 's' : ''}?
        </h2>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{mechanismSummary}.</p>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            data-cy="confirm-force"
            checked={force}
            onChange={(e) => setForce(e.target.checked)}
          />
          Force delete (bypass sidecar)
        </label>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
          <button ref={cancelRef} className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            data-cy="confirm-remove"
            className="btn danger"
            onClick={() => onConfirm(force)}
          >
            Remove
          </button>
        </div>
      </div>
    </div>
  )
}
