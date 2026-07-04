import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { useState } from 'react'
import { Modal } from './Modal'

describe('Modal', () => {
  it('renders nothing when closed', () => {
    const { container } = render(<Modal open={false} title="X" onClose={() => {}}>body</Modal>)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows title and content when open', () => {
    render(<Modal open title="Add connection" onClose={() => {}}><p>hello</p></Modal>)
    expect(screen.getByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText('Add connection')).toBeInTheDocument()
    expect(screen.getByText('hello')).toBeInTheDocument()
  })

  it('calls onClose on Escape', () => {
    const onClose = vi.fn()
    render(<Modal open title="X" onClose={onClose}>body</Modal>)
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(onClose).toHaveBeenCalled()
  })

  it('wraps Tab from the last focusable element to the first', () => {
    render(
      <Modal open title="X" onClose={() => {}}>
        <button>first</button>
        <button>last</button>
      </Modal>,
    )
    const first = screen.getByRole('button', { name: 'first' })
    const last = screen.getByRole('button', { name: 'last' })
    last.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    expect(first).toHaveFocus()
  })

  it('wraps Shift+Tab from the first focusable element to the last', () => {
    render(
      <Modal open title="X" onClose={() => {}}>
        <button>first</button>
        <button>last</button>
      </Modal>,
    )
    const first = screen.getByRole('button', { name: 'first' })
    const last = screen.getByRole('button', { name: 'last' })
    first.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(last).toHaveFocus()
  })

  it('restores focus to the trigger element on close', () => {
    function Harness() {
      const [open, setOpen] = useState(false)
      return (
        <>
          <button onClick={() => setOpen(true)}>trigger</button>
          <Modal open={open} title="X" onClose={() => setOpen(false)}>
            <button onClick={() => setOpen(false)}>close</button>
          </Modal>
        </>
      )
    }
    render(<Harness />)
    const trigger = screen.getByRole('button', { name: 'trigger' })
    trigger.focus()
    fireEvent.click(trigger)
    // Move focus into the dialog (as a real user Tab/click would) before closing.
    const close = screen.getByRole('button', { name: 'close' })
    close.focus()
    fireEvent.click(close)
    expect(trigger).toHaveFocus()
  })
})
