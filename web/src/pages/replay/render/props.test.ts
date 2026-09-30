import { describe, expect, it } from 'vitest'
import type { Entity } from '../engine/types'
import type { Palette } from './palette'
import { GROUND_Y, VIEW_H } from '../engine/types'
import { PIT_DARKEN, drawCoin, drawCrate, drawFallShadow, drawOrb, drawPit, drawRack } from './props'

const pal = { backdrop: 'silver', coin: 'gold', orb: 'purple', crate: 'blue', obstacle: 'red', player: 'green', ground: 'gray' } as Palette
interface Call { name: string; args: unknown[]; fill: unknown; stroke: unknown }
interface Grad { kind: 'radial' | 'linear'; args: number[]; stops: [number, string][] }

/** Recording stand-in for a 2D context; fillStyle/strokeStyle are captured at call time. */
function mockCtx() {
  const calls: Call[] = []
  const gradients: Grad[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop]
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') {
        return (...args: number[]) => {
          const g: Grad = { kind: prop === 'createRadialGradient' ? 'radial' : 'linear', args, stops: [] }
          gradients.push(g)
          return { addColorStop: (o: number, c: string) => g.stops.push([o, c]) }
        }
      }
      return (...args: unknown[]) => { calls.push({ name: prop, args, fill: target.fillStyle, stroke: target.strokeStyle }) }
    },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, gradients }
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
    const fill = calls.find((c) => c.name === 'fill' && c.fill === 'gold')!
    expect(calls.indexOf(fill)).toBeGreaterThan(calls.indexOf(base))
  })

  it('draws a darker rim and a bright inner ring', () => {
    const calls = coinCalls(coin(), 5)
    const strokes = calls.filter((c) => c.name === 'stroke')
    expect(strokes.some((c) => c.stroke === 'gold')).toBe(true)
    expect(strokes.some((c) => c.stroke === 'rgba(0, 0, 0, 0.25)')).toBe(true)
    expect(strokes.some((c) => c.stroke === 'rgba(255, 255, 255, 0.55)')).toBe(true)
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
      // The cable mount clip is the only thing allowed outside the hitbox.
      const isMountClip = (k: Call) => e.kind === 'high' && k.fill === 'gray' && (k.args as number[]).join() === [e.x + e.w / 2 - 2, e.y - 2, 4, 2].join()
      for (const c of calls.filter((k) => k.name === 'fillRect' && !isMountClip(k))) {
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

const orb: Entity = { id: 2, kind: 'orb', x: 200, y: GROUND_Y - 60, w: 12, h: 12, taken: false }
const crate: Entity = { id: 3, kind: 'crate', x: 300, y: GROUND_Y - 20, w: 16, h: 16, taken: false }

function run(draw: (ctx: CanvasRenderingContext2D) => void) {
  const m = mockCtx()
  draw(m.ctx)
  return m
}
const shadowIdx = (calls: Call[]) => calls.findIndex((c) => c.name === 'ellipse')
const isSpec = (g: Grad) => g.kind === 'radial' && g.stops[0]?.[1] === 'rgba(255, 255, 255, 0.9)'

describe('drawOrb', () => {
  const orbRun = () => run((ctx) => drawOrb(ctx, orb, pal))

  it('draws a ground shadow before the sphere base', () => {
    const { calls } = orbRun()
    const base = calls.findIndex((c) => c.name === 'fill' && c.fill === 'purple')
    expect(shadowIdx(calls)).toBeGreaterThanOrEqual(0)
    expect(shadowIdx(calls)).toBeLessThan(base)
  })

  it('fills a circle centred in the box, r = w/2, with the orb colour', () => {
    const { calls } = orbRun()
    const i = calls.findIndex((c) => c.name === 'fill' && c.fill === 'purple')
    const arc = calls.slice(0, i).reverse().find((c) => c.name === 'arc')!
    expect(arc.args.slice(0, 3)).toEqual([206, GROUND_Y - 54, 6])
  })

  it('shades the sphere and adds a specular highlight up-left of centre', () => {
    const { gradients } = orbRun()
    expect(gradients.some((g) => g.kind === 'radial' && g.stops[g.stops.length - 1]![1] === 'rgba(0, 0, 0, 0.45)')).toBe(true)
    const spec = gradients.find(isSpec)!
    expect(spec.args[0]).toBeLessThan(206)
    expect(spec.args[1]).toBeLessThan(GROUND_Y - 54)
  })

  it('has a faint rim light on the lower-right edge', () => {
    const { calls } = orbRun()
    expect(calls.some((c) => c.name === 'stroke' && c.stroke === 'rgba(255, 255, 255, 0.25)')).toBe(true)
  })

  it('keeps every arc inside the box', () => {
    for (const c of orbRun().calls.filter((k) => k.name === 'arc')) {
      const [x, y, r] = c.args as number[]
      expect(x - r).toBeGreaterThanOrEqual(orb.x - 1e-6)
      expect(x + r).toBeLessThanOrEqual(orb.x + orb.w + 1e-6)
      expect(y - r).toBeGreaterThanOrEqual(orb.y - 1e-6)
      expect(y + r).toBeLessThanOrEqual(orb.y + orb.h + 1e-6)
    }
  })

  it('draws nothing for a taken orb', () => {
    expect(run((ctx) => drawOrb(ctx, { ...orb, taken: true }, pal)).calls).toHaveLength(0)
  })
})

describe('drawCoin shading', () => {
  it('adds a ground shadow, sphere shading and the shared specular', () => {
    const { calls, gradients } = run((ctx) => drawCoin(ctx, coin(), pal, 5, true))
    expect(shadowIdx(calls)).toBeGreaterThanOrEqual(0)
    expect(shadowIdx(calls)).toBeLessThan(calls.findIndex((c) => c.name === 'fill' && c.fill === 'gold'))
    expect(gradients.some((g) => g.stops[g.stops.length - 1]![1] === 'rgba(0, 0, 0, 0.25)')).toBe(true)
    const spec = gradients.find(isSpec)!
    expect(spec.args[0]).toBeLessThan(105)
    expect(spec.args[1]).toBeLessThan(155)
  })
})

describe('drawCrate', () => {
  const crateRun = () => run((ctx) => drawCrate(ctx, crate, pal))

  it('draws a ground shadow before the base rect at the hitbox', () => {
    const { calls } = crateRun()
    const base = calls.findIndex((c) => c.name === 'fillRect' && c.fill === 'blue')
    expect(calls[base].args).toEqual([300, GROUND_Y - 20, 16, 16])
    expect(shadowIdx(calls)).toBeGreaterThanOrEqual(0)
    expect(shadowIdx(calls)).toBeLessThan(base)
  })

  it('overlays a top-left to bottom-right linear gradient', () => {
    const g = crateRun().gradients.find((k) => k.kind === 'linear')!
    expect(g.args[0]).toBeLessThan(g.args[2])
    expect(g.args[1]).toBeLessThan(g.args[3])
    expect(g.stops[0][1]).toBe('rgba(255, 255, 255, 0.18)')
    expect(g.stops[g.stops.length - 1]![1]).toBe('rgba(0, 0, 0, 0.28)')
  })

  it('bevels light on top/left and dark on bottom/right, inside the box', () => {
    const { calls } = crateRun()
    const rects = (fill: string) => calls.filter((c) => c.name === 'fillRect' && c.fill === fill).map((c) => c.args as number[])
    const light = rects('rgba(255, 255, 255, 0.45)')
    const dark = rects('rgba(0, 0, 0, 0.35)')
    expect(light).toContainEqual([300, GROUND_Y - 20, 16, 1])
    expect(light).toContainEqual([300, GROUND_Y - 20, 1, 16])
    expect(dark).toContainEqual([300, GROUND_Y - 5, 16, 1])
    expect(dark).toContainEqual([315, GROUND_Y - 20, 1, 16])
  })

  it('puts a specular inside the box near the top-left corner', () => {
    const spec = crateRun().gradients.find(isSpec)!
    expect(spec.args[0]).toBeGreaterThan(300)
    expect(spec.args[0]).toBeLessThan(308)
    expect(spec.args[1]).toBeGreaterThan(GROUND_Y - 20)
    expect(spec.args[1]).toBeLessThan(GROUND_Y - 12)
  })
})

describe('consistent lighting', () => {
  it('puts every collectible specular up-left of its centre', () => {
    const cases: [Entity, (ctx: CanvasRenderingContext2D) => void][] = [
      [orb, (ctx) => drawOrb(ctx, orb, pal)],
      [coin(), (ctx) => drawCoin(ctx, coin(), pal, 5, true)],
      [crate, (ctx) => drawCrate(ctx, crate, pal)],
    ]
    for (const [e, draw] of cases) {
      const spec = run(draw).gradients.find(isSpec)!
      expect(spec.args[0]).toBeLessThan(e.x + e.w / 2)
      expect(spec.args[1]).toBeLessThan(e.y + e.h / 2)
    }
  })

  it('draws a falling rack hanging from the top edge with a ground warning shadow', () => {
    const { ctx, calls } = mockCtx()
    const e = { id: 3, kind: 'falling' as const, x: 300, y: -24, w: 18, h: 24, taken: false, vy: 0 }
    drawFallShadow(ctx, e, pal)
    expect(calls.some((c) => c.name === 'ellipse')).toBe(true)
  })

  it('draws a hanging cable for a falling rack that has not landed', () => {
    const { ctx, calls } = mockCtx()
    drawRack(ctx, { id: 3, kind: 'falling', x: 300, y: 40, w: 18, h: 24, taken: false, vy: 0 }, pal, 0, true)
    expect(calls.some((c) => c.name === 'moveTo')).toBe(true)
  })

  it('draws a pit as a dark red shaft below the ground line: the obstacle colour, then a darkening layer', () => {
    const { ctx, calls } = mockCtx()
    drawPit(ctx, { id: 1, kind: 'pit', x: 100, y: GROUND_Y, w: 40, h: 0, taken: false }, pal)
    const shaft = calls.filter((c) => c.name === 'fillRect' && (c.args as number[])[0] === 100 && (c.args as number[])[2] === 40)
    expect(shaft.map((c) => c.fill)).toEqual([pal.obstacle, PIT_DARKEN])
    expect(shaft.every((c) => (c.args as number[])[1] === GROUND_Y && (c.args as number[])[3] === VIEW_H - GROUND_Y)).toBe(true)
  })
})
