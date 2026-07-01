import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { EventRow } from './WorkflowDetail'
import type { WorkflowHistoryEvent } from '../types/workflow'

function renderRow(event: WorkflowHistoryEvent, pair: Parameters<typeof EventRow>[0]['pair']) {
  const noop = () => {}
  return render(
    <MemoryRouter>
      <EventRow
        event={event}
        createdAt={'2026-06-28T10:00:00.000Z'}
        isNewest={false}
        toast={{ show: noop } as never}
        anchorId="event-1"
        appId="app"
        pair={pair}
        pairHovered={false}
        onPairHover={noop}
      />
    </MemoryRouter>,
  )
}

describe('EventRow pair chip', () => {
  it('renders a start chip linking to the completion row', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskScheduled',
      sequenceId: 1,
      timestamp: '2026-06-28T10:00:00.100Z',
      name: 'Charge',
      input: '{"x":1}',
    }
    renderRow(event, { pairId: 1, role: 'start', partnerIndex: 4, durationMs: null })
    const chip = screen.getByRole('link', { name: /jump to result/i })
    expect(chip.getAttribute('href')).toBe('#event-4')
    expect(chip.textContent).toContain('#1')
  })

  it('renders an end chip with duration linking to the scheduled row', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskCompleted',
      sequenceId: 2,
      timestamp: '2026-06-28T10:00:00.440Z',
      scheduledId: 1,
      output: '"ok"',
    }
    renderRow(event, { pairId: 1, role: 'end', partnerIndex: 1, durationMs: 340 })
    const chip = screen.getByRole('link', { name: /jump to scheduled/i })
    expect(chip.getAttribute('href')).toBe('#event-1')
    expect(chip.textContent).toContain('#1')
    expect(chip.textContent).toContain('340ms')
  })

  it('renders a non-linked pending chip for a still-running scheduled activity', () => {
    const event: WorkflowHistoryEvent = {
      type: 'TaskScheduled',
      sequenceId: 1,
      timestamp: '2026-06-28T10:00:00.100Z',
      name: 'Charge',
    }
    renderRow(event, { pairId: 1, role: 'start', partnerIndex: null, durationMs: null })
    expect(screen.queryByRole('link', { name: /jump to/i })).toBeNull()
    expect(screen.getByText(/#1/)).toBeTruthy()
  })
})
