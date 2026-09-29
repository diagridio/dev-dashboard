import { describe, expect, it } from 'vitest'
import { GROUND_Y, VIEW_W } from '../engine/types'
import { drawBackground, drawDesks, drawRacks } from './background'
import type { Palette } from './palette'

const pal = { backdrop: 'silver', ground: 'gray', player: 'green' } as Palette
interface Call { name: string; args: number[]; fill: unknown; alpha: unknown }

/** Recording stand-in for a 2D context; style and alpha are captured at call time. */
function mockCtx() {
  const calls: Call[] = []
  const props: Record<string, unknown> = { globalAlpha: 1 }
  const ctx = new Proxy(props, {
    get: (target, prop: string) =>
      prop in target ? target[prop] : (...args: unknown[]) => { calls.push({ name: prop, args: args as number[], fill: target.fillStyle, alpha: target.globalAlpha }) },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

type Layer = typeof drawRacks
const record = (draw: Layer, worldX: number, frame = 0, reduced = false) => {
  const m = mockCtx()
  draw(m.ctx, worldX, pal, frame, reduced)
  return m.calls
}
const rects = (calls: Call[]) => calls.filter((c) => c.name === 'fillRect' || c.name === 'strokeRect')
const leds = (calls: Call[]) => calls.filter((c) => c.name === 'fillRect' && c.fill === 'green')

describe('drawBackground', () => {
  it('draws the same thing for the same position and frame', () => {
    const a = mockCtx()
    const b = mockCtx()
    drawBackground(a.ctx, 1234, pal, 17, false)
    drawBackground(b.ctx, 1234, pal, 17, false)
    expect(a.calls.length).toBeGreaterThan(0)
    expect(a.calls).toEqual(b.calls)
  })

  it('draws the racks and the desks, and restores the context', () => {
    const { ctx, calls } = mockCtx()
    drawBackground(ctx, 300, pal, 0, false)
    expect(calls[0].name).toBe('save')
    expect(calls[calls.length - 1].name).toBe('restore')
    expect(rects(record(drawRacks, 300)).length).toBeGreaterThan(0)
    expect(rects(record(drawDesks, 300)).length).toBeGreaterThan(0)
  })

  it('scrolls the far layer at 0.2 and the near layer at 0.5 of the world', () => {
    for (const [draw, factor] of [[drawRacks, 0.2], [drawDesks, 0.5]] as const) {
      const a = rects(record(draw, 100))
      const b = rects(record(draw, 110))
      expect(b).toHaveLength(a.length)
      a.forEach((c, i) => {
        expect(b[i].args[0]).toBeCloseTo(c.args[0] - 10 * factor, 6)
        expect(b[i].args.slice(1)).toEqual(c.args.slice(1))
      })
    }
  })

  it('keeps racks standing on the ground', () => {
    const bottoms = record(drawRacks, 500).filter((c) => c.name === 'fillRect' && c.fill === 'silver').map((c) => c.args[1] + c.args[3])
    expect(bottoms.length).toBeGreaterThan(0)
    for (const b of bottoms) expect(b).toBe(GROUND_Y)
  })

  it('blinks LEDs with the frame, but holds a static pattern with reduced motion', () => {
    for (const draw of [drawRacks, drawDesks]) {
      const still = record(draw, 0, 0, true)
      for (const frame of [30, 60, 90, 300]) expect(leds(record(draw, 0, frame, true))).toEqual(leds(still))
      expect(leds(still).length).toBeGreaterThan(0)
    }
    const across = [0, 30, 60, 90].map((f) => JSON.stringify(leds(record(drawRacks, 0, f))))
    expect(new Set(across).size).toBeGreaterThan(1)
  })

  it('holds an LED pattern steady within a blink interval', () => {
    expect(leds(record(drawRacks, 0, 0))).toEqual(leds(record(drawRacks, 0, 29)))
  })

  it('only draws tiles that touch the screen', () => {
    for (const [draw, tile] of [[drawRacks, 64], [drawDesks, 120]] as const) {
      for (const worldX of [0, 37, 1000, 123456]) {
        for (const c of rects(record(draw, worldX))) {
          expect(c.args[0]).toBeGreaterThanOrEqual(-tile)
          expect(c.args[0]).toBeLessThan(VIEW_W + tile)
        }
      }
    }
  })

  it('uses only theme palette colours, softened with alpha', () => {
    for (const c of record(drawRacks, 200).concat(record(drawDesks, 200))) {
      if (c.name !== 'fillRect') continue
      expect(['silver', 'gray', 'green']).toContain(c.fill)
      expect(c.alpha).toBeLessThan(1)
    }
  })
})
