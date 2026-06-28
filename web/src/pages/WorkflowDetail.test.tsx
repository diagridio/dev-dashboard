import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { EventRow } from './WorkflowDetail'
import type { WorkflowHistoryEvent } from '../types/workflow'

const createdAt = '2026-06-28T10:00:00.000Z'

function row(event: WorkflowHistoryEvent) {
  return render(<EventRow event={event} createdAt={createdAt} isNewest={false} />)
}

describe('EventRow', () => {
  it('labels a real event with output as "Event ID N" and is expandable', () => {
    const { container } = row({
      type: 'ExecutionCompleted',
      sequenceId: 2,
      timestamp: '2026-06-28T10:00:01.000Z',
      output: '"ok"',
    })
    expect(screen.getByText('Event ID 2')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })

  it('renders an empty OrchestratorStarted event as static (no details, no caret, no Event ID)', () => {
    const { container } = row({
      type: 'OrchestratorStarted',
      sequenceId: -1,
      timestamp: '2026-06-28T10:00:00.027Z',
    })
    expect(container.querySelector('details')).toBeNull()
    expect(container.querySelector('.caret')).toBeNull()
    expect(screen.queryByText(/Event ID/)).toBeNull()
    expect(screen.getByText('OrchestratorStarted')).toBeInTheDocument()
  })

  it('shows "Event ID 0" for ExecutionStarted with input (expandable)', () => {
    const { container } = row({
      type: 'ExecutionStarted',
      sequenceId: 0,
      timestamp: createdAt,
      name: 'OrderWorkflow',
      input: '{}',
    })
    expect(screen.getByText('Event ID 0')).toBeInTheDocument()
    expect(container.querySelector('details')).not.toBeNull()
  })
})
