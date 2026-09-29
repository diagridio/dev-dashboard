import { describe, expect, it } from 'vitest'
import type { Palette } from './palette'
import { drawHat } from './sprites'

const pal = { hat: 'navy', hatOutline: 'white' } as Palette
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

const box = { x: 100, y: 200, w: 30, h: 16 }

describe('drawHat', () => {
  it('fills the crown and brim with the hat colour, then two highlights', () => {
    const { ctx, calls } = mockCtx()
    drawHat(ctx, box, pal)
    const fills = calls.filter((c) => c.name === 'fill')
    expect(fills.filter((c) => c.fill === 'navy')).toHaveLength(2)
    const light = fills.filter((c) => c.fill !== 'navy')
    expect(light).toHaveLength(2)
    expect(String(light[0].fill)).toContain('rgba(255, 255, 255')
  })

  it('strokes the outline only when it is not transparent', () => {
    const on = mockCtx()
    drawHat(on.ctx, box, pal)
    expect(on.calls.filter((c) => c.name === 'stroke' && c.stroke === 'white')).toHaveLength(2)
    const off = mockCtx()
    drawHat(off.ctx, box, { ...pal, hatOutline: 'transparent' })
    expect(off.calls.some((c) => c.name === 'stroke')).toBe(false)
  })

  it('stays within the box', () => {
    const { ctx, calls } = mockCtx()
    drawHat(ctx, box, pal)
    const shapes = calls.filter((c) => c.name === 'rect' || c.name === 'roundRect')
    expect(shapes.length).toBeGreaterThan(0)
    for (const c of shapes) {
      const [x, y, w, h] = c.args as number[]
      expect(x).toBeGreaterThanOrEqual(box.x - 1e-6)
      expect(y).toBeGreaterThanOrEqual(box.y - 1e-6)
      expect(x + w).toBeLessThanOrEqual(box.x + box.w + 1e-6)
      expect(y + h).toBeLessThanOrEqual(box.y + box.h + 1e-6)
    }
  })

  it('falls back to rect when roundRect is missing', () => {
    const calls: string[] = []
    const noop = () => {}
    const ctx = {
      beginPath: noop, fill: noop, stroke: noop, save: noop, restore: noop, clip: noop,
      rect: () => calls.push('rect'),
    } as unknown as CanvasRenderingContext2D
    drawHat(ctx, box, pal)
    expect(calls).toContain('rect')
  })
})
