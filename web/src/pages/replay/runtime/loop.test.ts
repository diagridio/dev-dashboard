import { describe, expect, it, vi } from 'vitest'
import { MAX_TICKS_PER_FRAME, startLoop } from './loop'

function fakeRaf() {
  const queue: FrameRequestCallback[] = []
  return {
    raf: (cb: FrameRequestCallback) => queue.push(cb),
    caf: vi.fn(),
    fire(now: number) {
      queue.shift()?.(now)
    },
  }
}

describe('startLoop', () => {
  it('turns elapsed time into whole 60 Hz ticks, carrying the remainder', () => {
    const f = fakeRaf()
    const seen: number[] = []
    startLoop((t) => seen.push(t), f.raf, f.caf)
    for (const now of [0, 20, 60, 62, 70]) f.fire(now)
    expect(seen).toEqual([0, 1, 2, 0, 1])
  })

  it('clamps a long gap to MAX_TICKS_PER_FRAME and drops the backlog', () => {
    const f = fakeRaf()
    const seen: number[] = []
    startLoop((t) => seen.push(t), f.raf, f.caf)
    f.fire(0)
    f.fire(5000)
    f.fire(5020)
    expect(seen).toEqual([0, MAX_TICKS_PER_FRAME, 1])
  })

  it('stop() cancels the pending frame and ignores late callbacks', () => {
    const f = fakeRaf()
    const onFrame = vi.fn()
    const loop = startLoop(onFrame, f.raf, f.caf)
    f.fire(0)
    loop.stop()
    expect(f.caf).toHaveBeenCalled()
    f.fire(20)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })
})
