import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Field, TextInput, NumberInput, SelectInput, Toggle, DialogShell, duplicateNameError } from './index'

describe('Field', () => {
  it('renders label, required marker, and error', () => {
    render(<Field label="Name" required error="bad"><input aria-label="Name" /></Field>)
    expect(screen.getByText('Name')).toBeInTheDocument()
    expect(screen.getByText('*')).toBeInTheDocument()
    expect(screen.getByText('bad')).toBeInTheDocument()
  })
})

describe('TextInput', () => {
  it('is controlled and reports string values', () => {
    const onChange = vi.fn()
    render(<TextInput value="a" onChange={onChange} aria-label="f" />)
    fireEvent.change(screen.getByLabelText('f'), { target: { value: 'ab' } })
    expect(onChange).toHaveBeenCalledWith('ab')
  })
})

describe('SelectInput', () => {
  it('renders options and reports the chosen value', () => {
    const onChange = vi.fn()
    render(
      <SelectInput value="" onChange={onChange} aria-label="pick"
        options={[{ label: 'One', value: '1' }, { label: 'Two', value: '2' }]} />,
    )
    fireEvent.change(screen.getByLabelText('pick'), { target: { value: '2' } })
    expect(onChange).toHaveBeenCalledWith('2')
  })
})

describe('Toggle', () => {
  it('reports boolean changes', () => {
    const onChange = vi.fn()
    render(<Toggle checked={false} onChange={onChange} label="on" />)
    fireEvent.click(screen.getByLabelText('on'))
    expect(onChange).toHaveBeenCalledWith(true)
  })
})

describe('DialogShell', () => {
  it('renders title + children, gates Save on canSave, and fires callbacks', () => {
    const onSave = vi.fn(); const onClose = vi.fn()
    const { rerender } = render(
      <DialogShell open title="Add thing" canSave={false} onSave={onSave} onClose={onClose}>body</DialogShell>,
    )
    expect(screen.getByText('Add thing')).toBeInTheDocument()
    expect(screen.getByText('body')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /save/i })).toBeDisabled()
    rerender(<DialogShell open title="Add thing" canSave onSave={onSave} onClose={onClose}>body</DialogShell>)
    fireEvent.click(screen.getByRole('button', { name: /save/i }))
    expect(onSave).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(onClose).toHaveBeenCalled()
  })
})

describe('duplicateNameError', () => {
  it('blocks an existing name unless it is the record being edited', () => {
    expect(duplicateNameError('a', ['a', 'b'], undefined, undefined, 'thing')).toMatch(/already exists/)
    expect(duplicateNameError('c', ['a', 'b'], undefined, undefined, 'thing')).toBeNull()
    expect(duplicateNameError('a', ['a', 'b'], true, 'a', 'thing')).toBeNull()
    expect(duplicateNameError('b', ['a', 'b'], true, 'a', 'thing')).toMatch(/already exists/)
    expect(duplicateNameError('a', undefined, undefined, undefined, 'thing')).toBeNull()
  })
})

describe('NumberInput', () => {
  it('reports raw string value (allowing empty)', () => {
    const onChange = vi.fn()
    render(<NumberInput value="" onChange={onChange} aria-label="n" />)
    fireEvent.change(screen.getByLabelText('n'), { target: { value: '5' } })
    expect(onChange).toHaveBeenCalledWith('5')
  })
})
