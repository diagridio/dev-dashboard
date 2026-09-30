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
})
