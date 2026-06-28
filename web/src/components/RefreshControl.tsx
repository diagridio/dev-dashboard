import { useRefreshInterval } from '../lib/refresh'

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: 'Off', value: 0 },
]

/**
 * Page-level refresh control. Renders the mock's `.live` indicator, a `.tbtn`
 * pause/resume toggle, and a `.select` interval picker.
 *
 * Intended for use inside `.ctrlset` (e.g. Workflows overview) or `.refreshbar`
 * (e.g. Workflow detail). NOT placed in the top bar.
 */
export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === intervalMs)?.label ?? `${intervalMs / 1000}s`

  return (
    <>
      <span className="live">
        <span className="beat" />
        {paused ? 'paused' : `refreshing every ${intervalLabel}`}
      </span>

      <button
        className="tbtn"
        data-cy="refresh-pause"
        aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        aria-pressed={paused}
        onClick={() => setPaused(!paused)}
      >
        {paused ? '▶ Resume' : '⏸ Pause'}
      </button>

      <select
        className="select"
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
    </>
  )
}
