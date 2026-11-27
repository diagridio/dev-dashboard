import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { CodeBlock } from './CodeBlock'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

describe('CodeBlock', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders json highlighted', () => {
    const { container } = render(<CodeBlock value='{"a":1}' kind="json" label="Input" />)
    const pre = container.querySelector('pre')!
    expect(pre).toHaveTextContent('"a"')
    expect(pre.classList.contains('json')).toBe(true)
    expect(pre.querySelector('.k')).not.toBeNull()
  })

  it('renders yaml highlighted', () => {
    const { container } = render(<CodeBlock value={'name: x'} kind="yaml" label="YAML" />)
    const pre = container.querySelector('pre')!
    expect(pre).toHaveTextContent('name: x')
    expect(pre.classList.contains('code')).toBe(true)
    expect(pre.querySelector('.yk')).not.toBeNull()
  })

  it('renders text as-is', () => {
    const { container } = render(<CodeBlock value="plain <b>text</b>" kind="text" label="Trace" />)
    const pre = container.querySelector('pre')!
    expect(pre.textContent).toBe('plain <b>text</b>')
    expect(pre.querySelector('span')).toBeNull()
  })

  it('copies value', () => {
    render(<CodeBlock value='{"a":1}' kind="json" label="Input" />)
    expect(screen.getByRole('button', { name: 'Copy Input' })).toHaveTextContent('⧉ Copy')
    fireEvent.click(screen.getByRole('button', { name: 'Copy Input' }))
    expect(copyText).toHaveBeenCalledWith('{"a":1}')
    expect(screen.getByText('Input copied')).toBeInTheDocument()
  })

  it('copies copyValue when given', () => {
    render(
      <CodeBlock value="shown" kind="text" label="Raw" copyValue="actual" copyText="⧉ Copy raw" copyTitle="Copy the raw value" />,
    )
    const btn = screen.getByRole('button', { name: 'Copy Raw' })
    expect(btn).toHaveTextContent('⧉ Copy raw')
    expect(btn).toHaveAttribute('title', 'Copy the raw value')
    fireEvent.click(btn)
    expect(copyText).toHaveBeenCalledWith('actual')
  })

  it('empty value disables the copy button and copies nothing', () => {
    render(<CodeBlock value="" kind="yaml" label="YAML" />)
    const btn = screen.getByRole('button', { name: 'Copy YAML' })
    expect(btn).toBeDisabled()
    fireEvent.click(btn)
    expect(copyText).not.toHaveBeenCalled()
    expect(screen.queryByText('YAML copied')).toBeNull()
  })

  it('copy button is not inside the pre', () => {
    render(<CodeBlock value="x" kind="text" label="X" />)
    expect(screen.getByRole('button', { name: 'Copy X' }).closest('pre')).toBeNull()
  })

  it('wrap adds the wrap class', () => {
    const { container } = render(<CodeBlock value="x" kind="text" label="X" wrap />)
    expect(container.querySelector('pre')!.classList.contains('wrap')).toBe(true)
  })
})
