import { useConnection } from '../lib/connection'
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
 *
 * The dot is also the backend connection indicator: when the health check
 * reports the backend unreachable it turns red (with a "Backend offline"
 * label) and that state wins over the live/paused looks.
 */
export function RefreshControl() {
  const { intervalMs, paused, setInterval, setPaused } = useRefreshInterval()
  const { online } = useConnection()

  const intervalLabel =
    INTERVAL_OPTIONS.find((o) => o.value === intervalMs)?.label ?? `${intervalMs / 1000}s`

  const off = intervalMs === 0
  const live = !paused && !off
  const offline = !online

  // Precedence: offline > off > paused. `off` (interval 0 → nothing polls) is
  // the more fundamental refresh state, so it wins over `paused` in the title
  // even when both are set.
  const title = offline
    ? 'Backend unreachable — retrying…'
    : off
      ? 'Auto-refresh off'
      : paused
        ? 'Auto-refresh paused — click to resume'
        : `Auto-refresh every ${intervalLabel} — click to pause`

  const dotState = offline ? ' offline' : live ? '' : ' off'

  return (
    <div className="refresh-compact">
      {offline && (
        <span className="offline-label" data-cy="offline-label">
          Backend offline
        </span>
      )}
      <button
        className={`beatbtn${dotState}`}
        data-cy="refresh-pause"
        aria-label="Pause auto-refresh"
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
