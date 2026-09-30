import { describe, expect, it } from 'vitest'
import { hashState } from '../engine/hash'
import { initialState, livePlayer, step } from '../engine/step'
import type { GameState, HistoryEvent, StartInput } from '../engine/types'
import { autopilot, counter, makeLevels } from '../testing'
import { MONTAGE_FRAMES, Montage, type MontageSegment } from './montage'

const start: StartInput = { level: 1, seed: 5, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }
const levels = makeLevels({ weights: { coin: 2, orb: 1 } })

/** A live segment with orbs, keeping the impure value of every orb pickup. */
function liveSegment(ticks: number): { segment: MontageSegment; end: GameState } {
  const impure = counter()
  let state = initialState(start, levels)
  const history: HistoryEvent[] = []
  const orbValues: [number, number][] = []
  for (let i = 0; i < ticks; i++) {
    const inputs = autopilot(state, ['coin', 'orb'])
    for (const kind of inputs) history.push({ type: 'Input', tick: state.tick, kind })
    let last = 0
    const r = step(state, inputs, { impure: () => (last = impure()), crateValue: () => impure() }, levels)
    for (const e of r.events) if (e.type === 'OrbTaken') orbValues.push([e.id, last])
    history.push(...r.events)
    state = r.state
  }
  return { segment: { start, history, endTick: state.tick, orbValues }, end: state }
}

function finish(m: Montage): number {
  let frames = 0
  while (!m.done) {
    m.advance()
    frames++
  }
  return frames
}

describe('Montage', () => {
  it('replays a segment exactly, using the recorded orb values', () => {
    const { segment, end } = liveSegment(900)
    expect(segment.orbValues.length).toBeGreaterThan(0)
    const m = new Montage([segment], levels)
    finish(m)
    expect(hashState(m.state)).toBe(hashState(end))
  })

  it('needs the orb values: other values make the replay diverge', () => {
    const { segment, end } = liveSegment(900)
    const m = new Montage([{ ...segment, orbValues: segment.orbValues.map(([id]) => [id, 0.999] as [number, number]) }], levels)
    finish(m)
    expect(hashState(m.state)).not.toBe(hashState(end))
  })

  it('fits in about MONTAGE_FRAMES frames and counts every event', () => {
    const a = liveSegment(3000).segment
    const b = { ...liveSegment(1200).segment }
    const m = new Montage([a, b], levels)
    expect(m.events).toBe(a.history.length + b.history.length)
    expect(finish(m)).toBeLessThanOrEqual(MONTAGE_FRAMES + 2)
  })

  it('flashes at each segment boundary and keeps a short trail', () => {
    const m = new Montage([liveSegment(100).segment, liveSegment(100).segment], levels)
    let flashed = false
    while (!m.done) {
      m.advance()
      flashed ||= m.flash > 0
      expect(m.trail.length).toBeLessThanOrEqual(6)
    }
    expect(flashed).toBe(true)
  })

  it('trails the steered lane hat during fan-out, not the frozen player', () => {
    const fanLevels = makeLevels({ fanOut: { everyPx: 300, ticks: 600 } })
    const impure = counter()
    let state = initialState(start, fanLevels)
    const history: HistoryEvent[] = []
    let jumped = false
    for (let i = 0; i < 900; i++) {
      const inputs: 'jump'[] = state.fan && !jumped ? ['jump'] : []
      jumped ||= inputs.length > 0
      for (const kind of inputs) history.push({ type: 'Input', tick: state.tick, kind })
      const r = step(state, inputs, { impure, crateValue: impure }, fanLevels)
      history.push(...r.events)
      state = r.state
    }
    const m = new Montage([{ start, history, endTick: state.tick, orbValues: [] }], fanLevels)
    let checked = false
    while (!m.done) {
      m.advance()
      if (m.state.fan) {
        expect(m.trail[0]).toBe(livePlayer(m.state).y)
        checked ||= livePlayer(m.state).y !== m.state.player.y
      }
    }
    expect(checked).toBe(true)
  })
})
