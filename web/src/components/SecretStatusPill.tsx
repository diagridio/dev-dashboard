import type { SecretStatus } from '../types/resources'

// Class tokens are prefixed with the component's own name so they cannot
// collide with unrelated global rules — see web/STYLEGUIDE.md.
// 'not-checked' has no pill: callers render no status for it at all.
const STATUS_CLASS: Record<Exclude<SecretStatus, 'not-checked'>, string> = {
  resolved: 'secref-ok',
  'store-not-specified': 'secref-err',
  'store-not-found': 'secref-err',
  'store-unsupported': 'secref-warn',
  'store-unreadable': 'secref-err',
  'key-not-found': 'secref-err',
  'empty-value': 'secref-warn',
  forbidden: 'secref-warn',
}

export function SecretStatusPill({ status }: { status: SecretStatus }) {
  if (status === 'not-checked') return null
  const cls = STATUS_CLASS[status] ?? 'secref-warn'
  return (
    <span data-cy="secret-status-pill" className={'pill ' + cls}>
      {status.replace(/-/g, ' ').toUpperCase()}
    </span>
  )
}
