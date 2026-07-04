import { render, screen, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog'

describe('ConfirmRemoveDialog', () => {
  it('states count + mechanism and confirms with force', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Completed' }, { appId: 'o', instanceId: 'b', status: 'Running' }]} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText(/remove 2 workflow/i)).toBeInTheDocument()
    await userEvent.click(document.querySelector('[data-cy="confirm-force"]') as HTMLElement)
    await userEvent.click(document.querySelector('[data-cy="confirm-remove"]') as HTMLElement)
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('pre-checks force checkbox when initialForce=true', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Running' }]} onConfirm={onConfirm} onCancel={() => {}} initialForce={true} />)
    const checkbox = document.querySelector('[data-cy="confirm-force"]') as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    // Confirm immediately (without toggling) should pass force=true
    await userEvent.click(document.querySelector('[data-cy="confirm-remove"]') as HTMLElement)
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('does not pre-check force checkbox when initialForce=false (default)', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Running' }]} onConfirm={onConfirm} onCancel={() => {}} initialForce={false} />)
    const checkbox = document.querySelector('[data-cy="confirm-force"]') as HTMLInputElement
    expect(checkbox.checked).toBe(false)
    // Confirm without toggling should pass force=false
    await userEvent.click(document.querySelector('[data-cy="confirm-remove"]') as HTMLElement)
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('wraps Tab from the last focusable element to the first', () => {
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Running' }]} onConfirm={() => {}} onCancel={() => {}} />)
    const checkbox = document.querySelector('[data-cy="confirm-force"]') as HTMLElement
    const remove = document.querySelector('[data-cy="confirm-remove"]') as HTMLElement
    remove.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(checkbox).toHaveFocus()
  })

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Running' }]} onConfirm={() => {}} onCancel={() => {}} />)
    const checkbox = document.querySelector('[data-cy="confirm-force"]') as HTMLElement
    const remove = document.querySelector('[data-cy="confirm-remove"]') as HTMLElement
    checkbox.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(remove).toHaveFocus()
  })

  it('restores focus to the trigger element on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          <ConfirmRemoveDialog
            open={open}
            targets={[{ appId: 'o', instanceId: 'a', status: 'Running' }]}
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
    // Move focus into the dialog (as a real user Tab/click would) before closing.
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    cancel.focus()
    fireEvent.click(cancel)
    expect(trigger).toHaveFocus()
  })
})
