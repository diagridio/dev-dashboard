import { describe, expect, it } from 'vitest'
import type { Entity } from '../engine/types'
import type { Palette } from './palette'
import { drawCoin, drawRack } from './props'

const pal = { coin: 'gold', obstacle: 'red', player: 'green', ground: 'gray' } as Palette
interface Call { name: string; args: unknown[]; fill: unknown; stroke: unknown }

/** Recording stand-in for a 2D context; fillStyle/strokeStyle are captured at call time. */
function mockCtx() {
  const calls: Call[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (target, prop: string) =>
      prop in target ? target[prop] : (...args: unknown[]) => { calls.push({ name: prop, args, fill: target.fillStyle, stroke: target.strokeStyle }) },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

const coin = (id = 0): Entity => ({ id, kind: 'coin', x: 100, y: 150, w: 10, h: 10, taken: false })
const low: Entity = { id: 0, kind: 'low', x: 200, y: 230, w: 14, h: 20, taken: false }
const high: Entity = { id: 1, kind: 'high', x: 300, y: 120, w: 22, h: 30, taken: false }

function coinCalls(e: Entity, elapsed: number, reduced = false) {
  const { ctx, calls } = mockCtx()
  drawCoin(ctx, e, pal, elapsed, reduced)
  return calls
}
function rackCalls(e: Entity, elapsed: number, reduced = false) {
  const { ctx, calls } = mockCtx()
  drawRack(ctx, e, pal, elapsed, reduced)
  return calls
}
const glints = (calls: Call[]) => calls.filter((c) => c.name === 'clip').length
/** The status LEDs are the 2x2 squares. */
const leds = (calls: Call[]) => calls.filter((c) => c.name === 'fillRect' && c.args[2] === 2 && c.args[3] === 2)

describe('drawCoin', () => {
  it('fills a circle centred in the box with the coin colour', () => {
    const calls = coinCalls(coin(), 5)
    const base = calls.find((c) => c.name === 'arc')!
    expect(base.args.slice(0, 3)).toEqual([105, 155, 5])
    const fill = calls.find((c) => c.name === 'fill')!
    expect(fill.fill).toBe('gold')
  })

  it('draws a darker rim, a bright inner ring and a highlight', () => {
    const calls = coinCalls(coin(), 5)
    const strokes = calls.filter((c) => c.name === 'stroke')
    expect(strokes.some((c) => c.stroke === 'gold')).toBe(true)
    expect(strokes.some((c) => c.stroke === 'rgba(0, 0, 0, 0.25)')).toBe(true)
    expect(strokes.some((c) => c.stroke === 'rgba(255, 255, 255, 0.55)')).toBe(true)
    expect(calls.some((c) => c.name === 'fill' && c.fill === 'rgba(255, 255, 255, 0.8)')).toBe(true)
  })

  it('keeps every arc inside the box', () => {
    const arcs = coinCalls(coin(), 5).filter((c) => c.name === 'arc')
    expect(arcs.length).toBeGreaterThan(2)
    for (const c of arcs) {
      const [x, y, r] = c.args as number[]
      expect(x - r).toBeGreaterThanOrEqual(100 - 1e-6)
      expect(x + r).toBeLessThanOrEqual(110 + 1e-6)
      expect(y - r).toBeGreaterThanOrEqual(150 - 1e-6)
      expect(y + r).toBeLessThanOrEqual(160 + 1e-6)
    }
  })

  it('glints briefly every 120 ticks, clipped to the circle', () => {
    expect(glints(coinCalls(coin(0), 0))).toBe(1)
    expect(glints(coinCalls(coin(0), 11))).toBe(1)
    expect(glints(coinCalls(coin(0), 12))).toBe(0)
    expect(glints(coinCalls(coin(0), 60))).toBe(0)
    expect(glints(coinCalls(coin(0), 120))).toBe(1)
  })

  it('never glints with reduced motion', () => {
    for (let t = 0; t < 240; t++) expect(glints(coinCalls(coin(0), t, true))).toBe(0)
  })

  it('offsets the glint by id so coins do not shine together', () => {
    let any = false
    for (let t = 0; t < 240; t++) {
      const a = glints(coinCalls(coin(0), t))
      const b = glints(coinCalls(coin(1), t))
      any = any || a + b > 0
      expect(a + b).toBeLessThanOrEqual(1)
    }
    expect(any).toBe(true)
  })
})

describe('drawRack', () => {
  it('fills the frame with the obstacle colour at the exact hitbox', () => {
    for (const e of [low, high]) {
      const first = rackCalls(e, 0).find((c) => c.name === 'fillRect' && c.fill === 'red')!
      expect(first.args).toEqual([e.x, e.y, e.w, e.h])
    }
  })

  it('draws slot lines and LEDs, all inside the box', () => {
    for (const e of [low, high]) {
      const calls = rackCalls(e, 0)
      const light = calls.filter((c) => c.name === 'fillRect' && c.fill === 'rgba(255, 255, 255, 0.25)')
      expect(light.length).toBeGreaterThan(2)
      expect(leds(calls).length).toBeGreaterThanOrEqual(1)
      // The cable mount clip (gray) is the only thing allowed outside the hitbox.
      for (const c of calls.filter((k) => k.name === 'fillRect' && k.fill !== 'gray')) {
        const [x, y, w, h] = c.args as number[]
        expect(x).toBeGreaterThanOrEqual(e.x - 1e-6)
        expect(y).toBeGreaterThanOrEqual(e.y - 1e-6)
        expect(x + w).toBeLessThanOrEqual(e.x + e.w + 1e-6)
        expect(y + h).toBeLessThanOrEqual(e.y + e.h + 1e-6)
      }
    }
  })

  it('blinks the LEDs over time, but not with reduced motion', () => {
    const states = (reduced: boolean) => new Set(Array.from({ length: 12 }, (_, i) => leds(rackCalls(low, i * 15, reduced)).map((c) => c.fill).join('|')))
    expect(states(false).size).toBeGreaterThan(1)
    expect(states(true).size).toBe(1)
  })

  it('hangs high racks from a cable up to the top of the canvas; low racks have none', () => {
    const cx = high.x + high.w / 2
    const calls = rackCalls(high, 0)
    const move = calls.find((c) => c.name === 'moveTo')!
    const line = calls.find((c) => c.name === 'lineTo')!
    expect([move.args[0], line.args[0]]).toEqual([cx, cx])
    expect(Math.min(move.args[1] as number, line.args[1] as number)).toBe(0)
    expect(Math.max(move.args[1] as number, line.args[1] as number)).toBe(high.y)
    expect(calls.find((c) => c.name === 'stroke')!.stroke).toBe('gray')
    expect(calls.findIndex((c) => c.name === 'stroke')).toBeLessThan(calls.findIndex((c) => c.fill === 'red'))
    expect(rackCalls(low, 0).some((c) => c.name === 'moveTo')).toBe(false)
  })
})
