import { describe, it, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
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

function renderRowEx(
  event: WorkflowHistoryEvent,
  pair: Parameters<typeof EventRow>[0]['pair'],
  extra?: Partial<Parameters<typeof EventRow>[0]>,
) {
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
        {...extra}
      />
    </MemoryRouter>,
  )
}

describe('EventRow selection', () => {
  const scheduled: WorkflowHistoryEvent = {
    type: 'TaskScheduled', sequenceId: 1, timestamp: '2026-06-28T10:00:00.100Z', name: 'Charge', input: '{"x":1}',
  }
  const startPair = { pairId: 1, role: 'start' as const, partnerIndex: 4, durationMs: null }

  it('renders the details open when isActive', () => {
    const { container } = renderRowEx(scheduled, startPair, { isActive: true })
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(true)
  })

  it('renders the details closed when not active', () => {
    const { container } = renderRowEx(scheduled, startPair, { isActive: false })
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(false)
  })

  it('adds the pair-selected class to the row when pairSelected', () => {
    const { container } = renderRowEx(scheduled, startPair, { pairSelected: true })
    expect(container.querySelector('.ev')!.className).toContain('pair-selected')
  })

  it('calls onToggleSelect and suppresses native toggle when the summary is clicked', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { isActive: false, onToggleSelect: () => { calls++ } })
    const summary = container.querySelector('details.evd > summary')!
    fireEvent.click(summary)
    expect(calls).toBe(1)
    // Controlled: still closed because state (isActive) did not change in this shallow render.
    expect((container.querySelector('details.evd') as HTMLDetailsElement).open).toBe(false)
  })

  it('does NOT call onToggleSelect when the pair chip is clicked (stopPropagation)', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { onToggleSelect: () => { calls++ } })
    const chip = container.querySelector('a.pairchip') as HTMLAnchorElement
    fireEvent.click(chip)
    expect(calls).toBe(0)
  })

  it('does NOT call onToggleSelect when the copy-link (#) button is clicked (stopPropagation)', () => {
    let calls = 0
    const { container } = renderRowEx(scheduled, startPair, { onToggleSelect: () => { calls++ } })
    fireEvent.click(container.querySelector('.evanchor') as HTMLElement)
    expect(calls).toBe(0)
  })
})

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
