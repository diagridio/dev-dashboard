import { useState, type ReactNode } from 'react'
import { LEVELS } from './engine/levels'
import type { Phase, RunStats } from './runtime/types'

interface Props {
  phase: Phase
  stats: RunStats
  best: number
  score: number
  /** The level the run reached. */
  level: number
  /** The UTC date of the daily run, and today's best score on it. */
  date: string
  dailyBest: number
  /** Opens the dashboard's Share dialog from the end-of-run card. */
  onShare?: () => void
  /** True while a recorded run plays back: the end card is "Playback finished". */
  playback?: boolean
  /** The finished run's execution ID (its run code); null while it is being created. */
  executionId?: string | null
  /** Why no execution ID could be made, shown instead of it. */
  executionIdError?: string | null
  onCopyExecutionId?: () => void
  /** The execution ID was just copied: the copy button shows ✓. */
  idCopied?: boolean
  /** Replays the finished run from its execution ID. */
  onReplayRun?: () => void
  /** Replays the run behind a pasted execution ID (title card). */
  onWatch?: (code: string) => void
  watchError?: string | null
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="replay-overlay">
      <div className="card replay-card">{children}</div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  )
}

function WatchForm({ onWatch, error }: { onWatch: (code: string) => void; error: string | null }) {
  const [code, setCode] = useState('')
  return (
    <form
      className="replay-watch"
      onSubmit={(e) => {
        e.preventDefault()
        onWatch(code)
      }}
    >
      <p>Replay a run from its execution ID: one someone shared with you, or one you copied after an earlier run.</p>
      <input className="inp" aria-label="Execution ID" placeholder="Paste an execution ID" value={code} onChange={(e) => setCode(e.target.value)} />
      <button type="submit" className="tbtn">Replay run</button>
      {error && <p className="replay-error">{error}</p>}
    </form>
  )
}

/** The finished run's execution ID in a read-only field, with the standard copy button behind it. */
function ExecutionId({ id, copied, onCopy }: { id: string; copied: boolean; onCopy?: () => void }) {
  return (
    <div className="replay-execid">
      <span className="replay-keys">Execution ID</span>
      <input className="inp" aria-label="Execution ID" readOnly value={id} onFocus={(e) => e.currentTarget.select()} />
      <button type="button" className={copied ? 'copybtn ok' : 'copybtn'} aria-label="Copy execution ID" onClick={onCopy}>
        {copied ? '✓ Copied' : '⧉ Copy'}
      </button>
    </div>
  )
}

/** DOM cards over the canvas for every phase that waits on the player. */
export function Overlay({
  phase, stats, best, score, level, date, dailyBest, onShare, playback,
  executionId, executionIdError, onCopyExecutionId, idCopied, onReplayRun, onWatch, watchError,
}: Props) {
  switch (phase.kind) {
    case 'title':
      return (
        <Card>
          <h2>Press Enter to start</h2>
          <p>Guide a workflow through a datacenter full of chaos. It will crash. Dapr will replay it.</p>
          <p className="replay-keys replay-start-meta">Daily run · {date} (UTC)</p>
          <p className="replay-keys replay-start-meta">Space / ↑ jump (hold for higher) · ↓ slide · Esc pause</p>
          {(best > 0 || dailyBest > 0) && <p className="replay-keys replay-start-meta">Today's best: {dailyBest} · Best: {best}</p>}
          {onWatch && (
            <>
              <hr className="replay-divider" />
              <WatchForm onWatch={onWatch} error={watchError ?? null} />
            </>
          )}
        </Card>
      )
    case 'resume':
      return (
        <Card>
          <h2>Resume your run?</h2>
          <p>A saved history was found (tick {phase.tick}). Replaying it rebuilds your run exactly where you left it.</p>
          <p className="replay-keys">Enter resume · Esc discard</p>
        </Card>
      )
    case 'tip': {
      const cfg = LEVELS[phase.level]
      return (
        <Card>
          <h2>Level {phase.level} · {cfg.name}</h2>
          <p>{cfg.tip.body}</p>
          <p className="replay-keys">Enter to start</p>
        </Card>
      )
    }
    case 'paused':
      return (
        <Card>
          <h2>Paused</h2>
          <p className="replay-keys">Esc or Enter to continue</p>
        </Card>
      )
    case 'lost':
      return (
        <Card>
          <h2>Progress lost</h2>
          <p>The process crashed and its state lived only in memory, so the workflow starts over from zero. Let's fix that.</p>
          <p className="replay-keys">Enter to enable Dapr Workflow</p>
        </Card>
      )
    case 'over':
      return (
        <Card>
          {playback ? (
            <h2>Playback finished</h2>
          ) : (
            <h2>Workflow <span className="pill s-fail">FAILED</span></h2>
          )}
          <p>Reason: {phase.reason}</p>
          <div className="stats replay-stats">
            <Stat label="Level" value={level} />
            <Stat label="Score" value={score} />
            <Stat label="Best" value={best} />
            <Stat label="Replays" value={stats.replays} />
            <Stat label="From history" value={stats.fromHistory} />
            <Stat label="Executed" value={stats.executed} />
            <Stat label="Non-determinism" value={stats.incidents} />
            <Stat label="Retries used" value={stats.retriesUsed} />
            <Stat label="Circuit trips" value={stats.circuitTrips} />
            <Stat label="Boosts lost" value={stats.boostsLost} />
          </div>
          {executionId ? (
            <>
              <ExecutionId id={executionId} copied={idCopied ?? false} onCopy={onCopyExecutionId} />
              {!playback && <p>Share this execution ID with a friend or colleague so they can replay your game.</p>}
            </>
          ) : executionIdError ? (
            <p className="replay-error">{executionIdError}</p>
          ) : (
            <p className="replay-keys">Creating the execution ID…</p>
          )}
          <div className="replay-foot">
            <p className="replay-keys">Enter to play again</p>
            {onReplayRun && (
              <button type="button" className="tbtn" onClick={onReplayRun}>
                Replay entire run
              </button>
            )}
            {/* Same class and label as the TopNav Share button. */}
            {onShare && (
              <button type="button" className="tbtn" onClick={onShare}>
                Share ↗
              </button>
            )}
          </div>
        </Card>
      )
    default:
      return null
  }
}
