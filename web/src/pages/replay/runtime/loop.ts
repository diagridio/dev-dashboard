import { TICK_HZ } from '../engine/types'

/** A long gap (background tab, debugger) never simulates more than this per frame. */
export const MAX_TICKS_PER_FRAME = 5
const TICK_MS = 1000 / TICK_HZ

export interface Loop {
  stop(): void
}

/** requestAnimationFrame loop with a fixed-timestep accumulator. */
export function startLoop(
  onFrame: (ticks: number) => void,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): Loop {
  let last: number | null = null
  let acc = 0
  let stopped = false
  let id = 0
  const frame = (now: number) => {
    if (stopped) return
    acc += last === null ? 0 : now - last
    last = now
    let ticks = Math.floor(acc / TICK_MS)
    acc -= ticks * TICK_MS
    if (ticks > MAX_TICKS_PER_FRAME) {
      ticks = MAX_TICKS_PER_FRAME
      acc = 0
    }
    onFrame(ticks)
    if (!stopped) id = raf(frame)
  }
  id = raf(frame)
  return {
    stop() {
      stopped = true
      caf(id)
    },
  }
}
