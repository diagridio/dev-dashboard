import { useVersion, useHealth } from '../hooks/useMeta'

/** Thin footer that shows server version and health status. */
export function StatusFooter() {
  const { data: versionData, isPending: versionPending, isError: versionError } = useVersion()
  const { data: healthData, isPending: healthPending, isError: healthError } = useHealth()

  const version = versionPending
    ? '…'
    : versionError
      ? 'unknown'
      : versionData?.version ?? 'unknown'

  const health = healthPending
    ? '…'
    : healthError
      ? 'error'
      : (healthData?.status ?? 'unknown')

  const healthColor =
    health === 'ok'
      ? 'var(--green, #22c55e)'
      : health === '…'
        ? 'var(--text-muted, inherit)'
        : 'var(--red, #ef4444)'

  return (
    <footer
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '1rem',
        padding: '0.25rem 1rem',
        fontSize: '0.75rem',
        color: 'var(--text-muted, #6b7280)',
        borderTop: '1px solid var(--border, #e5e7eb)',
        flexShrink: 0,
      }}
    >
      <span>v{version}</span>
      <span style={{ color: healthColor }}>● {health}</span>
    </footer>
  )
}
