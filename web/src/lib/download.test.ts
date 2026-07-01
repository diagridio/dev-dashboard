import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { downloadText } from './download'

describe('downloadText', () => {
  beforeEach(() => {
    // jsdom lacks these; stub them.
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
  })
  afterEach(() => vi.restoreAllMocks())

  it('creates an anchor with the given filename and clicks it', () => {
    const click = vi.fn()
    const orig = document.createElement.bind(document)
    const spy = vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = orig(tag) as HTMLElement
      if (tag === 'a') (el as HTMLAnchorElement).click = click
      return el
    })
    downloadText('order.yaml', 'a: 1\n')
    const anchor = spy.mock.results.map((r) => r.value as HTMLElement).find((e) => e.tagName === 'A') as HTMLAnchorElement
    expect(anchor.download).toBe('order.yaml')
    expect(anchor.href).toContain('blob:mock')
    expect(click).toHaveBeenCalledOnce()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock')
  })
})
