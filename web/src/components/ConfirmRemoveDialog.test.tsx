import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog'

describe('ConfirmRemoveDialog', () => {
  it('states count + mechanism and confirms with force', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Completed' }, { appId: 'o', instanceId: 'b', status: 'Running' }]} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText(/remove 2 workflow/i)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('confirm-force'))
    await userEvent.click(screen.getByTestId('confirm-remove'))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})
