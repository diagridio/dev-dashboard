import type { WorkflowStatus } from '../types/workflow'

const TOKENS: Record<WorkflowStatus, string> = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Terminated: 'terminated',
  Suspended: 'suspended',
  Pending: 'pending',
}

export function StatusPill({ status }: { status: WorkflowStatus }) {
  const t = TOKENS[status] ?? 'pending'
  return (
    <span
      data-cy="status-pill"
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
        background: `var(--wf-${t}-bg)`,
        color: `var(--wf-${t}-fg)`,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  )
}
