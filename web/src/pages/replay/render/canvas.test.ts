import { describe, expect, it } from 'vitest'
import { BOSS_TICKS, initialState, PLAYER_H, PLAYER_W, SLIDE_H } from '../engine/step'
import { GROUND_Y, PLAYER_X, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import { render, type RenderView } from './canvas'
import type { Palette } from './palette'

const pal: Palette = {
  bg: 'white', ground: 'gray', backdrop: 'silver', player: 'green', hat: 'navy', hatOutline: 'transparent', obstacle: 'red', coin: 'gold', orb: 'purple',
  crate: 'blue', text: 'black', muted: 'gray', glitch: 'cyan', fail: 'red',
}

/** A recording stand-in for CanvasRenderingContext2D: every method call is logged. */
function mockCtx() {
  const calls: { name: string; args: unknown[] }[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (target, prop: string) =>
      prop in target ? target[prop] : (...args: unknown[]) => { calls.push({ name: prop, args }) },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function view(phase: Phase, state: GameState = initialState({ level: 1, seed: 1, score: 5, elapsed: 0, distance: 0, boss: false }), extra: Partial<RenderView> = {}): RenderView {
  return { state, phase, notice: null, reducedMotion: false, frame: 3, ...extra }
}

const texts = (calls: { name: string; args: unknown[] }[]) => calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])

/** Bounds of every rounded rect / rect the hat draws (the recording ctx has roundRect). */
function hatShapes(calls: { name: string; args: unknown[] }[]) {
  return calls
    .filter((c) => c.name === 'roundRect')
    .map((c) => { const [x, y, w, h] = c.args as number[]; return { x, y, w, h } })
}

describe('render', () => {
  it('draws the HUD with level, score and multiplier', () => {
    const { ctx, calls } = mockCtx()
    const state = { ...initialState({ level: 1, seed: 1, score: 5, elapsed: 0, distance: 0, boss: false }), multiplier: 3 }
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('LEVEL 1 · REPLAY')
    expect(texts(calls).some((t) => String(t).startsWith('SCORE 5 ×3'))).toBe(true)
  })

  it('shows the crash banner and shakes the screen while crashing', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'crashing', framesLeft: 10 }), pal)
    expect(texts(calls)).toContain('daprd: signal: killed')
    expect(calls.some((c) => c.name === 'translate')).toBe(true)
  })

  it('sets the device-pixel base transform first, and still shakes on top of it', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'crashing', framesLeft: 10 }, undefined, { pixelScale: 2 }), pal)
    expect(calls[0]).toEqual({ name: 'setTransform', args: [2, 0, 0, 2, 0, 0] })
    expect(calls.some((c) => c.name === 'translate')).toBe(true)
    expect(calls.findIndex((c) => c.name === 'save')).toBeGreaterThan(0)
  })

  it('defaults the base transform to scale 1', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }), pal)
    expect(calls[0]).toEqual({ name: 'setTransform', args: [1, 0, 0, 1, 0, 0] })
  })

  it('keeps the crash banner but drops the shake with reduced motion', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'crashing', framesLeft: 10 }, undefined, { reducedMotion: true }), pal)
    expect(texts(calls)).toContain('daprd: signal: killed')
    expect(calls.some((c) => c.name === 'translate')).toBe(false)
  })

  it('badges activities served from history only while replaying', () => {
    const state = {
      ...initialState({ level: 1, seed: 1, score: 1, elapsed: 0, distance: 0, boss: false }),
      entities: [{ id: 1, kind: 'coin' as const, x: 200, y: GROUND_Y - 30, w: 10, h: 10, taken: true }],
    }
    const replaying = mockCtx()
    render(replaying.ctx, view({ kind: 'replaying' }, state), pal)
    expect(texts(replaying.calls)).toContain('✓ from history')
    expect(texts(replaying.calls).some((t) => String(t).includes('REPLAYING HISTORY'))).toBe(true)
    const live = mockCtx()
    render(live.ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(live.calls)).not.toContain('✓ from history')
  })

  it('labels orbs as unrecorded calls and crates as an activity, drawing orbs as circles', () => {
    const entity = (id: number, kind: 'orb' | 'crate') => ({ id, kind, x: 200 + id * 20, y: GROUND_Y - 60, w: 12, h: 12, taken: false })
    const state = {
      ...initialState({ level: 3, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false }),
      entities: [entity(3, 'orb'), entity(4, 'orb'), entity(5, 'orb'), entity(6, 'crate')],
    }
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toEqual(expect.arrayContaining(['Math.random()', 'Date.now()', 'fetch()', 'callActivity(random)']))
    expect(calls.filter((c) => c.name === 'arc')).toHaveLength(3)
  })

  it('draws coins as round coins and obstacles as racks, glinting from game time', () => {
    const entity = (id: number, kind: 'coin' | 'low' | 'high', x: number, y: number, w: number, h: number) => ({ id, kind, x, y, w, h, taken: false })
    const base = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false })
    const state = { ...base, entities: [entity(0, 'coin', 200, GROUND_Y - 30, 10, 10), entity(1, 'low', 260, GROUND_Y - 20, 14, 20), entity(2, 'high', 320, 100, 22, 30)] }
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(calls.some((c) => c.name === 'arc' && c.args[0] === 205 && c.args[1] === GROUND_Y - 25 && c.args[2] === 5)).toBe(true)
    const clips = (cs: { name: string }[]) => cs.filter((c) => c.name === 'clip').length
    expect(calls.some((c) => c.name === 'lineTo' && c.args[0] === 331 && c.args[1] === 100)).toBe(true)
    const still = mockCtx()
    render(still.ctx, view({ kind: 'playing' }, { ...state, elapsed: 60 }), pal)
    expect(clips(calls) - clips(still.calls)).toBe(1) // elapsed 0 is a glint moment for coin 0
    const calm = mockCtx()
    render(calm.ctx, view({ kind: 'playing' }, state, { reducedMotion: true }), pal)
    expect(clips(calls) - clips(calm.calls)).toBe(1)
  })

  it('shows the boss countdown during a boss segment', () => {
    const { ctx, calls } = mockCtx()
    const state = initialState({ level: 2, seed: 1, score: 0, elapsed: 0, distance: 0, boss: true })
    expect(state.bossUntil).toBe(BOSS_TICKS)
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('NonDeterministicError · survive 15s')
  })

  it('draws the player as the hat inside its hitbox', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }), pal)
    const shapes = hatShapes(calls)
    expect(shapes.length).toBeGreaterThan(0)
    const left = Math.min(...shapes.map((s) => s.x))
    const right = Math.max(...shapes.map((s) => s.x + s.w))
    const top = Math.min(...shapes.map((s) => s.y))
    const bottom = Math.max(...shapes.map((s) => s.y + s.h))
    expect(left).toBeGreaterThanOrEqual(PLAYER_X - 1e-6)
    expect(right).toBeLessThanOrEqual(PLAYER_X + PLAYER_W + 1e-6)
    expect(top).toBeGreaterThanOrEqual(GROUND_Y - PLAYER_H - 1e-6)
    expect(bottom).toBeCloseTo(GROUND_Y)
  })

  it('flattens the hat to the slide height while sliding on the ground', () => {
    const { ctx, calls } = mockCtx()
    const state = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false })
    render(ctx, view({ kind: 'playing' }, { ...state, player: { ...state.player, sliding: true } }), pal)
    expect(Math.min(...hatShapes(calls).map((s) => s.y))).toBeGreaterThanOrEqual(GROUND_Y - SLIDE_H - 1e-6)
  })

  it('scales a stretched hat around its bottom centre', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, undefined, { pose: { sx: 0.8, sy: 1.25 } }), pal)
    const shapes = hatShapes(calls)
    const left = Math.min(...shapes.map((s) => s.x))
    const right = Math.max(...shapes.map((s) => s.x + s.w))
    const top = Math.min(...shapes.map((s) => s.y))
    const bottom = Math.max(...shapes.map((s) => s.y + s.h))
    expect(bottom).toBeCloseTo(GROUND_Y)
    expect((left + right) / 2).toBeCloseTo(PLAYER_X + PLAYER_W / 2)
    expect(right - left).toBeCloseTo(PLAYER_W * 0.8)
    expect(bottom - top).toBeCloseTo(PLAYER_H * 1.25)
  })

  it('draws the notice when there is one', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, undefined, { notice: 'Dapr Workflow enabled' }), pal)
    expect(texts(calls)).toContain('Dapr Workflow enabled')
  })
})
