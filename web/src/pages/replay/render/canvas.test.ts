import { describe, expect, it } from 'vitest'
import { BOSS_TICKS, initialState } from '../engine/step'
import { GROUND_Y, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import { render, type RenderView } from './canvas'
import type { Palette } from './palette'

const pal: Palette = {
  bg: 'white', ground: 'gray', player: 'green', obstacle: 'red', coin: 'gold', orb: 'purple',
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

  it('shows the boss countdown during a boss segment', () => {
    const { ctx, calls } = mockCtx()
    const state = initialState({ level: 2, seed: 1, score: 0, elapsed: 0, distance: 0, boss: true })
    expect(state.bossUntil).toBe(BOSS_TICKS)
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('NonDeterministicError · survive 15s')
  })

  it('draws the notice when there is one', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, undefined, { notice: 'Dapr Workflow enabled' }), pal)
    expect(texts(calls)).toContain('Dapr Workflow enabled')
  })
})
