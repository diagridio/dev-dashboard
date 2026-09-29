import type { ReactNode } from 'react'
import { LEVELS } from './engine/levels'
import type { Phase, RunStats } from './runtime/types'

interface Props {
  phase: Phase
  stats: RunStats
  best: number
  score: number
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

/** DOM cards over the canvas for every phase that waits on the player. */
export function Overlay({ phase, stats, best, score }: Props) {
  switch (phase.kind) {
    case 'title':
      return (
        <Card>
          <h2>Press Enter to start</h2>
          <p>Guide a workflow through a datacenter full of chaos. It will crash. Dapr will replay it.</p>
          <p className="replay-keys">Space / ↑ jump · ↓ slide · Esc pause</p>
          {best > 0 && <p className="replay-keys">Best score: {best}</p>}
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
          <a className="replay-link" href={cfg.tip.href} target="_blank" rel="noreferrer">Learn more ↗</a>
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
          <h2>Workflow <span className="pill s-fail">FAILED</span></h2>
          <p>Reason: {phase.reason}</p>
          <div className="stats replay-stats">
            <Stat label="Score" value={score} />
            <Stat label="Best" value={best} />
            <Stat label="Replays" value={stats.replays} />
            <Stat label="From history" value={stats.fromHistory} />
            <Stat label="Executed" value={stats.executed} />
            <Stat label="Non-determinism" value={stats.incidents} />
          </div>
          <p className="replay-keys">Enter to play again</p>
        </Card>
      )
    default:
      return null
  }
}
