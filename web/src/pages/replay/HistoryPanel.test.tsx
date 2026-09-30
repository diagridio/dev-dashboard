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
          { type: 'ActivityCompleted', tick: 10, id: 3, hash: 1, result: 0.25 },
          { type: 'OrbTaken', tick: 20, id: 4, hash: 2 },
        ]}
      />,
    )
    const types = [...container.querySelectorAll('.evtype')].map((n) => n.textContent)
    expect(types).toEqual(['#3 NonDeterministicCall', '#2 ActivityCompleted', '#1 Input'])
    expect(screen.getByText('crate 3 · result 0.250')).toBeInTheDocument()
    expect(screen.getByText('orb 4 · value not recorded')).toBeInTheDocument()
    expect(screen.getByText('3 events')).toBeInTheDocument()
  })
})
