import type { WorkflowStatus } from '../types/workflow'

const STATUS_CLASS: Record<WorkflowStatus, string> = {
  Running: 's-run',
  Completed: 's-done',
  Failed: 's-fail',
  Terminated: 's-term',
  Suspended: 's-susp',
  Pending: 's-pend',
}

export function StatusPill({ status }: { status: WorkflowStatus }) {
  const cls = STATUS_CLASS[status] ?? 's-pend'
  return (
    <span
      data-cy="status-pill"
      className={'pill ' + cls}
    >
      {status.toUpperCase()}
    </span>
  )
}
