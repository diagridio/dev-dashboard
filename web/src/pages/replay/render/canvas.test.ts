import { describe, expect, it } from 'vitest'
import { BOSS_TICKS, initialState, PLAYER_H, PLAYER_W, SLIDE_H } from '../engine/step'
import { GROUND_Y, PLAYER_X, VIEW_W, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import { render, type RenderView } from './canvas'
import type { Palette } from './palette'

const pal: Palette = {
  bg: 'white', ground: 'gray', backdrop: 'silver', player: 'green', hat: 'navy', hatOutline: 'transparent', obstacle: 'red', coin: 'gold', orb: 'purple',
  crate: 'blue', text: 'black', muted: 'gray', glitch: 'cyan', fail: 'red',
}

/** A recording stand-in for CanvasRenderingContext2D: every method call is logged. */
function mockCtx() {
  const calls: { name: string; args: unknown[]; fill?: unknown }[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (target, prop: string) => {
      if (prop in target) return target[prop]
      if (prop === 'createRadialGradient' || prop === 'createLinearGradient') return () => ({ addColorStop: () => {} })
      return (...args: unknown[]) => { calls.push({ name: prop, args, fill: target.fillStyle }) }
    },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function view(phase: Phase, state: GameState = initialState({ level: 1, seed: 1, score: 5, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }), extra: Partial<RenderView> = {}): RenderView {
  return { state, phase, notice: null, reducedMotion: false, frame: 3, ...extra }
}

const lvl1 = (over: Partial<GameState> = {}): GameState => ({
  ...initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 3, shield: 0 }),
  ...over,
})

/** Level 0 has no safety HUD, so the only hat on screen is the player's. */
const lvl0 = (over: Partial<GameState> = {}): GameState => lvl1({ level: 0, ...over })

const texts = (calls: { name: string; args: unknown[] }[]) => calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])

/** Bounds of every rounded rect / rect the hat draws (the recording ctx has roundRect). */
function hatShapes(calls: { name: string; args: unknown[] }[]) {
  return calls
    .filter((c) => c.name === 'roundRect')
    .map((c) => { const [x, y, w, h] = c.args as number[]; return { x, y, w, h } })
}

describe('render', () => {
  it('draws three clipped half-scale strips with one hat each during fan-out', () => {
    const single = mockCtx()
    // Level 0 has no RETRY hats in the HUD, so every hat shape belongs to a player.
    const s = { ...lvl1(), level: 0 as const }
    render(single.ctx, view({ kind: 'playing' }, s), pal)
    const lane = { player: { ...s.player }, entities: [], nextSpawnAt: 0, coins: 0 }
    const fanned = mockCtx()
    render(fanned.ctx, view({ kind: 'playing' }, { ...s, fan: { until: 99, lanes: [lane, lane, lane] } }), pal)
    // The hat sprite clips too: each lane adds its own strip clip on top of the hats' clips.
    const clips = (calls: { name: string }[]) => calls.filter((c) => c.name === 'clip').length
    expect(clips(fanned.calls)).toBe(3 * clips(single.calls) + 3)
    expect(fanned.calls.filter((c) => c.name === 'scale' && c.args[0] === 0.5)).toHaveLength(3)
    expect(hatShapes(fanned.calls).length).toBe(3 * hatShapes(single.calls).length)
  })

  it('draws the fan-out gate with its label', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1({ entities: [{ id: 4, kind: 'fanout', x: 300, y: 0, w: 12, h: GROUND_Y, taken: false }] })), pal)
    expect(texts(calls)).toContain('fan-out ×3')
  })

  it('shows retries and the circuit-breaker charge on a second HUD row', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1({ retries: 2, shield: 7 })), pal)
    expect(texts(calls)).toContain('RETRY')
    expect(texts(calls)).toContain('CB 7/10')
    render(ctx, view({ kind: 'playing' }, lvl1({ shield: 10 })), pal)
    expect(texts(calls)).toContain('CB ARMED')
  })

  it('hides the safety HUD in level 0', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, { ...lvl1(), level: 0 }), pal)
    expect(texts(calls)).not.toContain('RETRY')
    expect(texts(calls).some((t) => String(t).startsWith('CB '))).toBe(false)
  })

  it('blinks the hat during grace, and outlines it instead with reduced motion', () => {
    const hidden = mockCtx()
    render(hidden.ctx, view({ kind: 'playing' }, lvl1({ tick: 4, graceUntil: 60, retries: 0 })), pal)
    const shown = mockCtx()
    render(shown.ctx, view({ kind: 'playing' }, lvl1({ tick: 0, graceUntil: 60, retries: 0 })), pal)
    expect(hatShapes(hidden.calls).length).toBeLessThan(hatShapes(shown.calls).length)
    const still = mockCtx()
    render(still.ctx, view({ kind: 'playing' }, lvl1({ tick: 4, graceUntil: 60 }), { reducedMotion: true }), pal)
    expect(still.calls.some((c) => c.name === 'strokeRect')).toBe(true)
  })

  it('shows the rewind banner while rewinding', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'rewinding', frames: [], index: 0, attempt: 2, of: 3 }), pal)
    expect(texts(calls)).toContain('◀◀ RetryPolicy · attempt 2/3')
  })

  it('draws a smashed rack as debris, never as "from history"', () => {
    const { ctx, calls } = mockCtx()
    const s = lvl1({ entities: [{ id: 5, kind: 'low', x: 200, y: GROUND_Y - 20, w: 14, h: 20, taken: true }] })
    render(ctx, view({ kind: 'replaying' }, s), pal)
    expect(texts(calls)).not.toContain('✓ from history')
    expect(calls.some((c) => c.name === 'fillRect' && c.fill === pal.obstacle && (c.args as number[])[3] === 3)).toBe(true)
  })

  it('draws the HUD with level, score and multiplier', () => {
    const { ctx, calls } = mockCtx()
    const state = { ...initialState({ level: 1, seed: 1, score: 5, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }), multiplier: 3 }
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
      ...initialState({ level: 1, seed: 1, score: 1, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }),
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
      ...initialState({ level: 3, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }),
      entities: [entity(3, 'orb'), entity(4, 'orb'), entity(5, 'orb'), entity(6, 'crate')],
    }
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toEqual(expect.arrayContaining(['Math.random()', 'Date.now()', 'fetch()', 'callActivity(random)']))
    // Orbs and crates go through drawOrb / drawCrate: sphere bases in the orb colour, a crate rect in the crate colour.
    const bases = calls.filter((c) => c.name === 'fill' && c.fill === 'purple').length
    expect(bases).toBe(3)
    expect(calls.some((c) => c.name === 'fillRect' && c.fill === 'blue' && c.args.join() === [320, GROUND_Y - 60, 12, 12].join())).toBe(true)
  })

  it('draws coins as round coins and obstacles as racks, glinting from game time', () => {
    const entity = (id: number, kind: 'coin' | 'low' | 'high', x: number, y: number, w: number, h: number) => ({ id, kind, x, y, w, h, taken: false })
    const base = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 })
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
    const state = initialState({ level: 2, seed: 1, score: 0, elapsed: 0, distance: 0, boss: true, retries: 0, shield: 0 })
    expect(state.bossUntil).toBe(BOSS_TICKS)
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('NonDeterministicError · survive 15s')
  })

  it('draws the player as the hat inside its hitbox', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl0()), pal)
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
    const state = lvl0()
    render(ctx, view({ kind: 'playing' }, { ...state, player: { ...state.player, sliding: true } }), pal)
    expect(Math.min(...hatShapes(calls).map((s) => s.y))).toBeGreaterThanOrEqual(GROUND_Y - SLIDE_H - 1e-6)
  })

  it('scales a stretched hat around its bottom centre', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl0(), { pose: { sx: 0.8, sy: 1.25 } }), pal)
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

  it('blinks background LEDs on game time, not on the rendered frame', () => {
    const ledCalls = (elapsed: number, frame: number) => {
      const calls: string[] = []
      const props: Record<string, unknown> = {}
      const ctx = new Proxy(props, {
        get: (target, prop: string) => (prop in target ? target[prop] : (...args: unknown[]) => {
          if (prop === 'fillRect' && target.globalAlpha === 0.45 && target.fillStyle === 'green' && args[2] === 2 && args[3] === 2) calls.push(args.join())
        }),
        set: (target, prop: string, value) => {
          target[prop] = value
          return true
        },
      }) as unknown as CanvasRenderingContext2D
      const state = { ...initialState({ level: 1, seed: 1, score: 0, elapsed, distance: 0, boss: false, retries: 0, shield: 0 }), elapsed }
      render(ctx, view({ kind: 'playing' }, state, { frame }), pal)
      return calls
    }
    const base = ledCalls(0, 0)
    expect(base.length).toBeGreaterThan(0)
    for (const frame of [1, 7, 30, 500]) expect(ledCalls(0, frame)).toEqual(base)
    expect(ledCalls(30, 0)).not.toEqual(base)
  })

  it('leaves a gap in the ground line over a pit', () => {
    const { ctx, calls } = mockCtx()
    const s = { ...initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }),
      entities: [{ id: 1, kind: 'pit' as const, x: 200, y: GROUND_Y, w: 40, h: 0, taken: false }] }
    render(ctx, view({ kind: 'playing' }, s), pal)
    const groundLines = calls.filter((c) => c.name === 'fillRect' && c.fill === pal.ground && c.args[1] === GROUND_Y && c.args[3] === 2)
    expect(groundLines.length).toBe(2)
    const [a, b] = groundLines.map((c) => c.args as number[])
    expect(a[0] + a[2]).toBe(200)
    expect(b[0]).toBe(240)
  })

  it('shows the montage banner, a ghost trail and the continue-as-new flash', () => {
    const { ctx, calls } = mockCtx()
    const montage = { events: 42, flash: 8, trail: [GROUND_Y, GROUND_Y - 10, GROUND_Y - 20] }
    render(ctx, view({ kind: 'montage', events: 42 }, lvl1(), { montage }), pal)
    expect(texts(calls)).toContain('LEVEL COMPLETE · replaying 42 events')
    const plain = mockCtx()
    render(plain.ctx, view({ kind: 'montage', events: 42 }, lvl1(), { montage: { ...montage, trail: [], flash: 0 } }), pal)
    expect(hatShapes(calls).length).toBeGreaterThan(hatShapes(plain.calls).length)
    const flash = (cs: typeof calls) => cs.some((c) => c.name === 'fillRect' && c.fill === pal.text && c.args[2] === VIEW_W)
    expect(flash(calls)).toBe(true)
    expect(flash(plain.calls)).toBe(false)
  })

  it('skips the flash with reduced motion', () => {
    const { ctx, calls } = mockCtx()
    const montage = { events: 1, flash: 8, trail: [] }
    render(ctx, view({ kind: 'montage', events: 1 }, lvl1(), { montage, reducedMotion: true }), pal)
    expect(calls.some((c) => c.name === 'fillRect' && c.fill === pal.text && c.args[2] === VIEW_W)).toBe(false)
  })

  it('marks playback in the HUD', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1(), { playbackDate: '2026-09-30' }), pal)
    expect(texts(calls)).toContain('▶ PLAYBACK · 2026-09-30')
  })
})
