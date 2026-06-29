import { describe, it, expect } from 'vitest'
import { sortHistoryForDisplay, orderHistoryForDisplay, eventAnchorId } from './eventOrder'
import type { WorkflowHistoryEvent } from '../types/workflow'

function ev(type: string, sequenceId: number, ms: number): WorkflowHistoryEvent {
  return { type, sequenceId, timestamp: new Date(Date.UTC(2026, 5, 28, 10, 0, 0, ms)).toISOString() }
}

describe('sortHistoryForDisplay', () => {
  it('puts ExecutionStarted first even when OrchestratorStarted has an earlier array position but later timestamp', () => {
    const input = [
      ev('OrchestratorStarted', -1, 27),
      ev('ExecutionStarted', 0, 0),
      ev('TaskScheduled', 1, 100),
      ev('ExecutionCompleted', 2, 1000),
    ]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[0]).toBe('ExecutionStarted')
    expect(out[out.length - 1]).toBe('ExecutionCompleted')
    expect(out).toEqual(['ExecutionStarted', 'OrchestratorStarted', 'TaskScheduled', 'ExecutionCompleted'])
  })

  it('pins a terminal ExecutionFailed last regardless of timestamp jitter', () => {
    const input = [
      ev('ExecutionStarted', 0, 0),
      ev('ExecutionFailed', 5, 50), // earlier ms than a later task, but must still sort last
      ev('TaskCompleted', 4, 80),
    ]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[out.length - 1]).toBe('ExecutionFailed')
  })

  it('keeps original order for events sharing a timestamp (stable)', () => {
    const input = [ev('TaskScheduled', 1, 100), ev('TaskCompleted', 2, 100), ev('TimerCreated', 3, 100)]
    const out = sortHistoryForDisplay(input).map((e) => e.sequenceId)
    expect(out).toEqual([1, 2, 3])
  })

  it('does not mutate the input array', () => {
    const input = [ev('ExecutionCompleted', 2, 1000), ev('ExecutionStarted', 0, 0)]
    const snapshot = input.map((e) => e.type)
    sortHistoryForDisplay(input)
    expect(input.map((e) => e.type)).toEqual(snapshot)
  })

  it('handles a running workflow with no terminal event', () => {
    const input = [ev('OrchestratorStarted', -1, 27), ev('ExecutionStarted', 0, 0), ev('TaskScheduled', 1, 100)]
    const out = sortHistoryForDisplay(input).map((e) => e.type)
    expect(out[0]).toBe('ExecutionStarted')
    expect(out).toEqual(['ExecutionStarted', 'OrchestratorStarted', 'TaskScheduled'])
  })
})

describe('orderHistoryForDisplay', () => {
  const input = [
    ev('ExecutionStarted', 0, 0),
    ev('TaskScheduled', 1, 100),
    ev('TaskCompleted', 2, 200),
    ev('ExecutionCompleted', 3, 300),
  ]

  it("'asc' matches sortHistoryForDisplay exactly", () => {
    expect(orderHistoryForDisplay(input, 'asc')).toEqual(sortHistoryForDisplay(input))
  })

  it("'desc' is the full reverse of the ascending order", () => {
    const asc = sortHistoryForDisplay(input)
    const desc = orderHistoryForDisplay(input, 'desc')
    expect(desc.map((e) => e.type)).toEqual([...asc].reverse().map((e) => e.type))
    // full flip: terminal event on top, ExecutionStarted at the bottom
    expect(desc[0].type).toBe('ExecutionCompleted')
    expect(desc[desc.length - 1].type).toBe('ExecutionStarted')
  })

  it('does not mutate the input array', () => {
    const copy = [...input]
    orderHistoryForDisplay(input, 'desc')
    expect(input).toEqual(copy)
  })
})

describe('eventAnchorId', () => {
  it('uses the sequenceId for real events (>= 0)', () => {
    expect(eventAnchorId(ev('ExecutionStarted', 0, 0), 5)).toBe('event-0')
    expect(eventAnchorId(ev('TaskScheduled', 7, 100), 5)).toBe('event-7')
  })

  it('falls back to the canonical index for replay sentinels (-1)', () => {
    expect(eventAnchorId(ev('OrchestratorStarted', -1, 27), 3)).toBe('event-replay-3')
  })
})
