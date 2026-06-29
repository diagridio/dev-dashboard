import { useRefreshInterval } from '../lib/refresh'

const INTERVAL_OPTIONS = [
  { label: '1s', value: 1000 },
  { label: '3s', value: 3000 },
  { label: '5s', value: 5000 },
  { label: '10s', value: 10000 },
  { label: 'Off', value: 0 },
]

/**
 * Compact global refresh control for the top navigation bar. Renders a beating
 * dot that doubles as a pause/resume button, plus an interval picker. Reads and
 * writes the global RefreshContext, so it governs polling on every page.
 */
export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === intervalMs)?.label ?? `${intervalMs / 1000}s`

  const off = intervalMs === 0
  const live = !paused && !off

  const title = paused
    ? 'Auto-refresh paused — click to resume'
    : off
      ? 'Auto-refresh off'
      : `Auto-refresh every ${intervalLabel} — click to pause`

  return (
    <div className="refresh-compact">
      <button
        className={`beatbtn${live ? '' : ' off'}`}
        data-cy="refresh-pause"
        aria-label={paused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
        aria-pressed={paused}
        title={title}
        onClick={() => setPaused(!paused)}
      >
        <span className="beat" />
      </button>

      <select
        className="select compact"
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
    </div>
  )
}
