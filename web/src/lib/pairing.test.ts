import { describe, it, expect } from 'vitest'
import { buildPairIndex } from './pairing'
import type { WorkflowHistoryEvent } from '../types/workflow'

function ev(
  type: string,
  sequenceId: number,
  ms: number,
  scheduledId?: number,
): WorkflowHistoryEvent {
  return {
    type,
    sequenceId,
    timestamp: new Date(Date.UTC(2026, 5, 28, 10, 0, 0, ms)).toISOString(),
    ...(scheduledId !== undefined ? { scheduledId } : {}),
  }
}

describe('buildPairIndex', () => {
  it('pairs a scheduled activity with its completion by scheduledId', () => {
    // ascending canonical order: [ExecutionStarted, TaskScheduled#1, TaskCompleted->1]
    const asc = [
      ev('ExecutionStarted', 0, 0),
      ev('TaskScheduled', 1, 100),
      ev('TaskCompleted', 2, 440, 1),
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(1)).toEqual({ pairId: 1, role: 'start', partnerIndex: 2, durationMs: null })
    expect(idx.get(2)).toEqual({ pairId: 1, role: 'end', partnerIndex: 1, durationMs: 340 })
    expect(idx.has(0)).toBe(false) // ExecutionStarted is not part of a pair
  })

  it('pairs across fan-out/fan-in interleaving (completions out of schedule order)', () => {
    const asc = [
      ev('TaskScheduled', 1, 10), // index 0
      ev('TaskScheduled', 2, 20), // index 1
      ev('TaskCompleted', 3, 60, 2), // index 2 -> pairs with index 1
      ev('TaskCompleted', 4, 90, 1), // index 3 -> pairs with index 0
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.partnerIndex).toBe(3)
    expect(idx.get(1)?.partnerIndex).toBe(2)
    expect(idx.get(2)).toMatchObject({ pairId: 2, role: 'end', partnerIndex: 1 })
    expect(idx.get(3)).toMatchObject({ pairId: 1, role: 'end', partnerIndex: 0 })
  })

  it('marks a still-running scheduled activity as an unmatched start', () => {
    const asc = [ev('TaskScheduled', 1, 10)]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)).toEqual({ pairId: 1, role: 'start', partnerIndex: null, durationMs: null })
  })

  it('marks an orphan completion (no matching start) as an unmatched end', () => {
    const asc = [ev('TaskCompleted', 9, 50, 7)]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)).toEqual({ pairId: 7, role: 'end', partnerIndex: null, durationMs: null })
  })

  it('pairs timers via TimerCreated EventId <- TimerFired scheduledId', () => {
    const asc = [
      ev('TimerCreated', 5, 0), // index 0, EventId 5
      ev('TimerFired', 6, 200, 5), // index 1, scheduledId 5
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.role).toBe('start')
    expect(idx.get(0)?.partnerIndex).toBe(1)
    expect(idx.get(1)).toMatchObject({ pairId: 5, role: 'end', partnerIndex: 0, durationMs: 200 })
  })

  it('pairs sub-orchestration create/completed and create/failed', () => {
    const asc = [
      ev('SubOrchestrationCreated', 2, 0), // index 0
      ev('SubOrchestrationCompleted', 3, 500, 2), // index 1
      ev('SubOrchestrationCreated', 4, 10), // index 2
      ev('SubOrchestrationFailed', 5, 800, 4), // index 3
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(0)?.partnerIndex).toBe(1)
    expect(idx.get(1)).toMatchObject({ role: 'end', partnerIndex: 0 })
    expect(idx.get(2)?.partnerIndex).toBe(3)
    expect(idx.get(3)).toMatchObject({ role: 'end', partnerIndex: 2 })
  })

  it('ignores start events with the sentinel sequenceId -1', () => {
    const asc = [ev('OrchestratorStarted', -1, 0)]
    const idx = buildPairIndex(asc)
    expect(idx.size).toBe(0)
  })

  it('yields null duration when the completion predates its start (bad clock)', () => {
    const asc = [
      ev('TaskScheduled', 1, 500), // index 0
      ev('TaskCompleted', 2, 100, 1), // index 1, earlier ms
    ]
    const idx = buildPairIndex(asc)
    expect(idx.get(1)?.durationMs).toBeNull()
  })
})
