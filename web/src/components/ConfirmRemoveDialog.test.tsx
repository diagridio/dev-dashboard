import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
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
})
