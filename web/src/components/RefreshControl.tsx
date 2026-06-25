import { useRefreshInterval } from '../lib/refresh'

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: 'Off', value: 0 },
]

export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2, 8px)' }}>
      <select
        data-cy="refresh-interval"
        aria-label="Refresh interval"
        value={intervalMs}
        onChange={(e) => setInterval(Number(e.target.value))}
      >
        {INTERVAL_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <button
        data-cy="refresh-pause"
        aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? 'Resume' : 'Pause'}
      </button>
    </div>
  )
}
