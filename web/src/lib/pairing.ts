import type { WorkflowHistoryEvent } from '../types/workflow'

const START_TYPES = new Set(['TaskScheduled', 'TimerCreated', 'SubOrchestrationCreated'])
const END_TYPES = new Set([
  'TaskCompleted',
  'TaskFailed',
  'TimerFired',
  'SubOrchestrationCompleted',
  'SubOrchestrationFailed',
])

export type PairRole = 'start' | 'end'

export interface PairInfo {
  /** The shared pairing id: the start event's EventId (sequenceId). */
  pairId: number
  role: PairRole
  /** Canonical index of the counterpart row, or null if unmatched (running / orphan). */
  partnerIndex: number | null
  /** Elapsed ms (end - start); set only on matched 'end' rows, else null. */
  durationMs: number | null
}

/**
 * Match start events (TaskScheduled / TimerCreated / SubOrchestrationCreated) to
 * their completion events by the durabletask back-reference (completion.scheduledId
 * == start.sequenceId). Uses a per-id open/close pass rather than a global id map
 * because sequenceId is not globally unique across replays/episodes: an id is only
 * ever reused after its previous use has completed, so a stack of open starts per id
 * matches each completion to the correct (most recent still-open) start.
 *
 * Input MUST be the canonical ascending order (from sortHistoryForDisplay); the
 * returned map is keyed by each event's index in that array.
 */
export function buildPairIndex(ascending: WorkflowHistoryEvent[]): Map<number, PairInfo> {
  const result = new Map<number, PairInfo>()
  const open = new Map<number, number[]>() // pairId -> stack of open start indices

  ascending.forEach((event, index) => {
    if (START_TYPES.has(event.type) && event.sequenceId >= 0) {
      const stack = open.get(event.sequenceId) ?? []
      stack.push(index)
      open.set(event.sequenceId, stack)
      return
    }
    if (END_TYPES.has(event.type) && event.scheduledId !== undefined) {
      const pairId = event.scheduledId
      const stack = open.get(pairId)
      const startIndex = stack && stack.length > 0 ? stack.pop()! : null
      if (startIndex === null) {
        // Orphan completion: no matching start in this history.
        result.set(index, { pairId, role: 'end', partnerIndex: null, durationMs: null })
        return
      }
      const start = Date.parse(ascending[startIndex].timestamp)
      const end = Date.parse(event.timestamp)
      const durationMs = Number.isNaN(start) || Number.isNaN(end) || end < start ? null : end - start
      result.set(startIndex, { pairId, role: 'start', partnerIndex: index, durationMs: null })
      result.set(index, { pairId, role: 'end', partnerIndex: startIndex, durationMs })
    }
  })

  // Any start still on a stack never completed -> running / unmatched.
  for (const [pairId, stack] of open) {
    for (const startIndex of stack) {
      result.set(startIndex, { pairId, role: 'start', partnerIndex: null, durationMs: null })
    }
  }

  return result
}
