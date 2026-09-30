import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HistoryPanel } from './HistoryPanel'

describe('HistoryPanel', () => {
  it('shows an empty state', () => {
    render(<HistoryPanel history={[]} />)
    expect(screen.getByText('No events yet.')).toBeInTheDocument()
  })

  it('lists events newest first, numbered by history position', () => {
    const { container } = render(
      <HistoryPanel
        history={[
          { type: 'Input', tick: 0, kind: 'jump' },
          { type: 'ActivityCrateCollected', tick: 10, id: 3, hash: 1, result: 0.25 },
          { type: 'OrbTaken', tick: 20, id: 4, hash: 2 },
          { type: 'ActivityCoinCollected', tick: 30, id: 5, hash: 3 },
        ]}
      />,
    )
    const types = [...container.querySelectorAll('.evtype')].map((n) => n.textContent)
    expect(types).toEqual(['#4 ActivityCoinCollected', '#3 NonDeterministicCall', '#2 ActivityCrateCollected', '#1 Input'])
    expect(screen.getByText('coin 5')).toBeInTheDocument()
    expect(screen.getByText('crate 3 · result 0.250')).toBeInTheDocument()
    expect(screen.getByText('orb 4 · value not recorded')).toBeInTheDocument()
    expect(screen.getByText('4 events')).toBeInTheDocument()
  })

  it('describes the safety events', () => {
    render(
      <HistoryPanel
        history={[
          { type: 'OrchestratorStarted', tick: 1 },
          { type: 'CircuitBreakerTripped', tick: 2, id: 9, hash: 1 },
          { type: 'CircuitBreakerTripped', tick: 3, id: 0, hash: 1 },
          { type: 'BoostLost', tick: 4, id: 3, hash: 1 },
          { type: 'RetryAttempt', tick: 5, attempt: 2, failedAt: 90 },
        ]}
      />,
    )
    expect(screen.getByText('replay resumed · 1 s grace')).toBeInTheDocument()
    expect(screen.getByText('rack 9 smashed')).toBeInTheDocument()
    expect(screen.getByText('pit bridged')).toBeInTheDocument()
    expect(screen.getByText('×3 boost absorbed the hit')).toBeInTheDocument()
    expect(screen.getByText('attempt 2 · failed at t90')).toBeInTheDocument()
  })

  it('describes fan-out and fan-in', () => {
    render(<HistoryPanel history={[{ type: 'FanOut', tick: 1, hash: 1 }, { type: 'FanIn', tick: 2, hash: 2, results: [3, 1, 2] }]} />)
    expect(screen.getByText('3 activities in parallel')).toBeInTheDocument()
    expect(screen.getByText('WhenAll · coins 3 / 1 / 2')).toBeInTheDocument()
  })
})
