import type { HistoryEvent } from './engine/types'

const SHOWN = 60
const NODE: Record<HistoryEvent['type'], string> = { Input: 'n-sched', ActivityCompleted: 'n-done', OrbTaken: 'n-fail' }

function describeEvent(e: HistoryEvent): { type: string; detail: string } {
  switch (e.type) {
    case 'Input':
      return { type: 'Input', detail: e.kind }
    case 'OrbTaken':
      return { type: 'NonDeterministicCall', detail: `orb ${e.id} · value not recorded` }
    case 'ActivityCompleted':
      return {
        type: 'ActivityCompleted',
        detail: e.result === undefined ? `coin ${e.id}` : `crate ${e.id} · result ${e.result.toFixed(3)}`,
      }
  }
}

/** The run's event history, in the WorkflowDetail history look, newest first. */
export function HistoryPanel({ history }: { history: readonly HistoryEvent[] }) {
  const first = Math.max(0, history.length - SHOWN)
  const rows = history.slice(first).map((e, i) => ({ e, index: first + i })).reverse()
  return (
    <div className="panel">
      <div className="ph">
        History <span className="replay-count">{history.length} events</span>
      </div>
      {rows.length === 0 ? (
        <p className="replay-empty">No events yet.</p>
      ) : (
        <div className="replay-hist">
          {rows.map(({ e, index }) => {
            const d = describeEvent(e)
            return (
              <div key={index} className="ev">
                <div className="t">
                  <span className="off">t{e.tick}</span>
                </div>
                <div className="rail">
                  <span className={`node ${NODE[e.type]}`} />
                </div>
                <div className="c">
                  <div className="evd evstatic">
                    <div className="evstatic-head">
                      <span className="caretspace" aria-hidden="true">▸</span>
                      <span className="evtype">#{index + 1} {d.type}</span>
                      <div className="evnamecell">
                        <span className="evname">{d.detail}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
