import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { ConfirmDialog } from './ConfirmDialog'

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    render(
      <ConfirmDialog open={false} title="Stop app?" confirmLabel="Stop" onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('shows title, body and calls onConfirm', async () => {
    const onConfirm = vi.fn()
    render(
      <ConfirmDialog open title="Stop app?" confirmLabel="Stop" onConfirm={onConfirm} onCancel={() => {}}>
        <p>The app will stop.</p>
      </ConfirmDialog>,
    )
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Stop app?')).toBeInTheDocument()
    expect(screen.getByText('The app will stop.')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(onConfirm).toHaveBeenCalledOnce()
  })

  it('calls onCancel from the Cancel button', async () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="Stop app?" confirmLabel="Stop" onConfirm={() => {}} onCancel={onCancel} />)
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('closes on Escape', () => {
    const onCancel = vi.fn()
    render(<ConfirmDialog open title="Stop app?" confirmLabel="Stop" onConfirm={() => {}} onCancel={onCancel} />)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('marks the confirm button danger by default and primary when danger=false', () => {
    const { rerender } = render(
      <ConfirmDialog open title="t" confirmLabel="Go" onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('danger')
    rerender(
      <ConfirmDialog open title="t" confirmLabel="Go" danger={false} onConfirm={() => {}} onCancel={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Go' })).toHaveClass('primary')
  })

  it('focuses Cancel on open and restores focus to the trigger on close', () => {
    vi.useFakeTimers()
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          <ConfirmDialog
            open={open}
            title="t"
            confirmLabel="Go"
            onConfirm={() => {}}
            onCancel={() => setOpen(false)}
          />
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    vi.runAllTimers()
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toHaveFocus()
    fireEvent.click(cancel)
    expect(trigger).toHaveFocus()
    vi.useRealTimers()
  })

  it('while busy: disables both buttons and ignores Escape and backdrop clicks', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    render(
      <ConfirmDialog open busy title="Stop app?" confirmLabel="Stop" onConfirm={onConfirm} onCancel={onCancel} />,
    )
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    const confirm = screen.getByRole('button', { name: 'Stop' })
    expect(cancel).toBeDisabled()
    expect(confirm).toBeDisabled()
    await userEvent.click(confirm)
    await userEvent.click(cancel)
    fireEvent.keyDown(document, { key: 'Escape' })
    fireEvent.click(document.querySelector('.modal-backdrop') as HTMLElement)
    expect(onConfirm).not.toHaveBeenCalled()
    expect(onCancel).not.toHaveBeenCalled()
  })

  it('shows busyLabel on the confirm button while busy', () => {
    render(
      <ConfirmDialog
        open
        busy
        busyLabel="Stopping…"
        title="Stop app?"
        confirmLabel="Stop"
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
  })
})
