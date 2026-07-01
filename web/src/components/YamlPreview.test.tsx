import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { YamlPreview } from './YamlPreview'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

describe('YamlPreview (read-only)', () => {
  beforeEach(() => {
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('renders the yaml read-only in a <pre> (no textbox)', () => {
    const { container } = render(<YamlPreview yaml={'a: 1\nb: x\n'} filename="c.yaml" />)
    const pre = container.querySelector('pre.code')
    expect(pre).not.toBeNull()
    expect(pre?.textContent).toContain('a: 1')
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('Copy copies the yaml', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="c.yaml" />)
    fireEvent.click(screen.getByRole('button', { name: /^copy$/i }))
    expect(copyText).toHaveBeenCalledWith('a: 1\n')
  })

  it('Download uses the monochrome class and triggers a download', () => {
    render(<YamlPreview yaml={'a: 1\n'} filename="order.yaml" />)
    const dl = screen.getByRole('button', { name: /download/i })
    expect(dl).toHaveClass('btn', 'mono')
    fireEvent.click(dl)
    expect(URL.createObjectURL).toHaveBeenCalled()
  })
})
