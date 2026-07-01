import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YamlPreview } from './YamlPreview'

describe('YamlPreview', () => {
  beforeEach(() => {
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('seeds the textarea with the generated yaml', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" />)
    expect(screen.getByRole('textbox')).toHaveValue('a: 1\n')
  })

  it('reports edited=true on manual edit and edited=false on reset', () => {
    const onEditedChange = vi.fn()
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" onEditedChange={onEditedChange} />)
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'a: 2\n' } })
    expect(onEditedChange).toHaveBeenLastCalledWith(true)
    fireEvent.click(screen.getByRole('button', { name: /reset to generated/i }))
    expect(screen.getByRole('textbox')).toHaveValue('a: 1\n')
    expect(onEditedChange).toHaveBeenLastCalledWith(false)
  })

  it('calls onEditedChange(false) on mount so parent stale state is cleared', () => {
    const onEditedChange = vi.fn()
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" onEditedChange={onEditedChange} />)
    expect(onEditedChange).toHaveBeenCalledWith(false)
  })

  it('download button uses the current buffer and the monochrome class', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="order.yaml" />)
    const dl = screen.getByRole('button', { name: /download/i })
    expect(dl).toHaveClass('btn', 'mono')
    fireEvent.click(dl)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })
})
