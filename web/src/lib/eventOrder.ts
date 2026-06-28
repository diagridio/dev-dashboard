import type { WorkflowHistoryEvent } from '../types/workflow'

const TERMINAL_EXEC_TYPES = new Set(['ExecutionCompleted', 'ExecutionFailed', 'ExecutionTerminated'])

// Pin rank: ExecutionStarted always first (0), terminal Execution* always last (2),
// everything else in the middle (1) ordered by timestamp.
function pinRank(event: WorkflowHistoryEvent): number {
  if (event.type === 'ExecutionStarted') return 0
  if (TERMINAL_EXEC_TYPES.has(event.type)) return 2
  return 1
}

/**
 * Order history for display: ExecutionStarted first, the terminal Execution*
 * event last, and everything between stable-sorted by timestamp ascending.
 * Events with equal or unparseable timestamps keep their original relative order.
 * Returns a new array; the input is not mutated.
 */
export function sortHistoryForDisplay(history: WorkflowHistoryEvent[]): WorkflowHistoryEvent[] {
  return history
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      const rankA = pinRank(a.event)
      const rankB = pinRank(b.event)
      if (rankA !== rankB) return rankA - rankB
      const ta = Date.parse(a.event.timestamp)
      const tb = Date.parse(b.event.timestamp)
      const aOk = !Number.isNaN(ta)
      const bOk = !Number.isNaN(tb)
      if (aOk && bOk && ta !== tb) return ta - tb
      return a.index - b.index // stable: preserve original order
    })
    .map((x) => x.event)
}
