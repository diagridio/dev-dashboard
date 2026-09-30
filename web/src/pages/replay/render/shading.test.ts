import { describe, expect, it } from 'vitest'
import { GROUND_Y } from '../engine/types'
import { groundShadow, LIGHT, shadeSphere, specular } from './shading'

interface Call { name: string; args: unknown[]; fill: unknown }
interface Grad { kind: 'radial' | 'linear'; args: number[]; stops: [number, string][] }

/** Recording stand-in for a 2D context with gradient support. */
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
      return (...args: unknown[]) => { calls.push({ name: prop, args, fill: target.fillStyle }) }
    },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, gradients }
}

const shadowOf = (bottomY: number, width = 12) => {
  const m = mockCtx()
  groundShadow(m.ctx, 50, bottomY, width)
  const ell = m.calls.find((c) => c.name === 'ellipse')!
  const fill = m.calls.find((c) => c.name === 'fill')!
  return { ...m, ell, fill }
}
const alpha = (s: unknown) => Number(/,\s*([\d.]+)\)$/.exec(String(s))![1])
const balanced = (calls: Call[]) => calls.filter((c) => c.name === 'save').length === calls.filter((c) => c.name === 'restore').length

describe('groundShadow', () => {
  it('sits on the ground line, centred on the object', () => {
    const { ell } = shadowOf(GROUND_Y)
    expect(ell.args.slice(0, 2)).toEqual([50, GROUND_Y + 1])
  })

  it('is full size on the ground and shrinks and fades as the object rises', () => {
    const ground = shadowOf(GROUND_Y)
    const air = shadowOf(GROUND_Y - 45)
    expect(ground.ell.args[2]).toBe(6)
    expect(air.ell.args[2] as number).toBeLessThan(ground.ell.args[2] as number)
    expect(alpha(air.fill.fill)).toBeLessThan(alpha(ground.fill.fill))
    expect(alpha(ground.fill.fill)).toBeCloseTo(0.18)
  })

  it('clamps at 35% when very high', () => {
    const high = shadowOf(GROUND_Y - 500)
    expect(high.ell.args[2]).toBeCloseTo(6 * 0.35)
    expect(alpha(high.fill.fill)).toBeCloseTo(0.18 * 0.35)
  })

  it('balances save/restore', () => {
    expect(balanced(shadowOf(GROUND_Y - 20).calls)).toBe(true)
  })
})

describe('shadeSphere and specular', () => {
  it('shadeSphere makes a radial gradient with its focus at the light offset', () => {
    const m = mockCtx()
    shadeSphere(m.ctx, 100, 100, 10, 0.45)
    const g = m.gradients[0]
    expect(g.kind).toBe('radial')
    expect(g.args).toEqual([100 + LIGHT.x * 10, 100 + LIGHT.y * 10, 1, 100, 100, 10])
    expect(g.stops[g.stops.length - 1]).toEqual([1, 'rgba(0, 0, 0, 0.45)'])
    expect(m.calls.some((c) => c.name === 'fill')).toBe(true)
    expect(balanced(m.calls)).toBe(true)
  })

  it('specular draws a soft radial spot plus a sharp core at the given point', () => {
    const m = mockCtx()
    specular(m.ctx, 30, 40, 8)
    expect(m.gradients[0].kind).toBe('radial')
    expect(m.gradients[0].args.slice(0, 2)).toEqual([30, 40])
    expect(m.gradients[0].stops[0][1]).toBe('rgba(255, 255, 255, 0.9)')
    expect(m.calls.some((c) => c.name === 'arc' && c.args[0] === 30 && c.args[1] === 40 && c.args[2] === 2)).toBe(true)
    expect(m.calls.some((c) => c.name === 'fill' && c.fill === 'rgba(255, 255, 255, 0.95)')).toBe(true)
    expect(balanced(m.calls)).toBe(true)
  })
})
