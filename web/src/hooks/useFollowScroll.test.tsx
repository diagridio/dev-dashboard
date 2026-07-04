import { renderHook, act } from '@testing-library/react'
import { useRef } from 'react'
import { describe, it, expect, vi } from 'vitest'
import { useFollowScroll } from './useFollowScroll'

interface FakeElOpts {
  scrollHeight?: number
  scrollTop?: number
  clientHeight?: number
}

function makeEl({ scrollHeight = 500, scrollTop = 0, clientHeight = 200 }: FakeElOpts = {}) {
  return { scrollHeight, scrollTop, clientHeight } as unknown as HTMLDivElement
}

function renderFollowScroll(
  el: HTMLDivElement | null,
  { itemCount = 0, following = true, onDisengage = vi.fn() } = {},
) {
  const hook = renderHook(
    ({ count, follow }: { count: number; follow: boolean }) => {
      const ref = useRef<HTMLDivElement | null>(el)
      return useFollowScroll(ref, count, follow, onDisengage)
    },
    { initialProps: { count: itemCount, follow: following } },
  )
  return { ...hook, onDisengage }
}

describe('useFollowScroll', () => {
  it('scrolls to the bottom on mount when following', () => {
    const el = makeEl({ scrollHeight: 500, scrollTop: 0 })
    renderFollowScroll(el, { following: true })
    expect(el.scrollTop).toBe(500)
  })

  it('scrolls to the bottom when itemCount grows while following', () => {
    const el = makeEl({ scrollHeight: 500, scrollTop: 0 })
    const { rerender } = renderFollowScroll(el, { itemCount: 1, following: true })
    el.scrollTop = 100 // pretend the browser is mid-scroll
    ;(el as unknown as { scrollHeight: number }).scrollHeight = 700
    rerender({ count: 2, follow: true })
    expect(el.scrollTop).toBe(700)
  })

  it('does NOT scroll when following is off', () => {
    const el = makeEl({ scrollHeight: 500, scrollTop: 42 })
    renderFollowScroll(el, { following: false })
    expect(el.scrollTop).toBe(42)
  })

  it('does NOT scroll when scrollHeight is 0 (unlaid-out element)', () => {
    const el = makeEl({ scrollHeight: 0, scrollTop: 0 })
    renderFollowScroll(el, { following: true })
    expect(el.scrollTop).toBe(0)
  })

  it('handleScroll disengages follow when scrolled away past the threshold', () => {
    // distFromBottom = 500 - 0 - 200 = 300 > 24
    const el = makeEl({ scrollHeight: 500, scrollTop: 0, clientHeight: 200 })
    const { result, onDisengage } = renderFollowScroll(el, { following: true })
    // Neutralise the mount auto-scroll so distFromBottom stays large
    el.scrollTop = 0
    act(() => result.current())
    expect(onDisengage).toHaveBeenCalledTimes(1)
  })

  it('handleScroll does NOT disengage at or within the threshold (24px)', () => {
    // distFromBottom = 500 - 276 - 200 = 24 → not > 24
    const el = makeEl({ scrollHeight: 500, scrollTop: 276, clientHeight: 200 })
    const { result, onDisengage } = renderFollowScroll(el, { following: true })
    el.scrollTop = 276
    act(() => result.current())
    expect(onDisengage).not.toHaveBeenCalled()
  })

  it('handleScroll does NOT disengage when following is already off', () => {
    const el = makeEl({ scrollHeight: 500, scrollTop: 0, clientHeight: 200 })
    const { result, onDisengage } = renderFollowScroll(el, { following: false })
    act(() => result.current())
    expect(onDisengage).not.toHaveBeenCalled()
  })

  it('handleScroll is a no-op for a zero-height (unlaid-out) element', () => {
    const el = makeEl({ scrollHeight: 0, scrollTop: 0, clientHeight: 0 })
    const { result, onDisengage } = renderFollowScroll(el, { following: true })
    act(() => result.current())
    expect(onDisengage).not.toHaveBeenCalled()
  })

  it('handleScroll is a no-op when the ref is empty', () => {
    const { result, onDisengage } = renderFollowScroll(null, { following: true })
    expect(() => act(() => result.current())).not.toThrow()
    expect(onDisengage).not.toHaveBeenCalled()
  })
})
