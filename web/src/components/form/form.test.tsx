import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { Field, TextInput, NumberInput, SelectInput, Toggle } from './index'

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

describe('NumberInput', () => {
  it('reports raw string value (allowing empty)', () => {
    const onChange = vi.fn()
    render(<NumberInput value="" onChange={onChange} aria-label="n" />)
    fireEvent.change(screen.getByLabelText('n'), { target: { value: '5' } })
    expect(onChange).toHaveBeenCalledWith('5')
  })
})
