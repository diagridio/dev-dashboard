import { useEffect, useState } from 'react'
import type { WorkflowStatus } from '../types/workflow'
import { ConfirmDialog } from './ConfirmDialog'
import { Spinner } from './Spinner'

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
  /** The removal request is in flight. */
  busy?: boolean
}

export function ConfirmRemoveDialog({ open, targets, onConfirm, onCancel, initialForce = false, busy = false }: Props) {
  const [force, setForce] = useState(initialForce)

  // Reset force when dialog opens/closes
  useEffect(() => {
    if (open) setForce(initialForce)
  }, [open, initialForce])

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
    <ConfirmDialog
      open={open}
      title={`Remove ${targets.length} workflow${targets.length !== 1 ? 's' : ''}?`}
      confirmLabel="Remove"
      confirmDataCy="confirm-remove"
      onConfirm={() => onConfirm(force)}
      onCancel={onCancel}
      busy={busy}
      busyLabel="Removing…"
    >
      <p style={{ margin: 0, color: 'var(--muted)', fontSize: 14 }}>{mechanismSummary}.</p>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 14,
          cursor: busy ? 'default' : 'pointer',
          marginTop: 14,
        }}
      >
        <input
          type="checkbox"
          data-cy="confirm-force"
          checked={force}
          disabled={busy}
          onChange={(e) => setForce(e.target.checked)}
        />
        Force delete (bypass sidecar)
      </label>
      {busy && (
        <p role="status" className="mono" style={{ display: 'flex', gap: 8, margin: '14px 0 0', fontSize: 13, color: 'var(--muted)' }}>
          <Spinner />
          Removing {targets.length} workflow{targets.length !== 1 ? 's' : ''}…
        </p>
      )}
    </ConfirmDialog>
  )
}
