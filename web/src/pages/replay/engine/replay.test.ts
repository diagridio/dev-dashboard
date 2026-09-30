import { describe, expect, it } from 'vitest'
import { autopilot, counter, makeLevels } from '../testing'
import { hashState } from './hash'
import type { LevelTable } from './levels'
import { createReplayer, replay } from './replay'
import { initialState, step } from './step'
import type { EntityKind, GameState, HistoryEvent, StartInput } from './types'

const start: StartInput = { level: 1, seed: 42, score: 0, elapsed: 0, distance: 0, boss: false }

/** Plays live like the runtime does: inputs recorded before the step, then its events. */
function record(ticks: number, levels: LevelTable, want: readonly EntityKind[], impure: () => number) {
  let state: GameState = initialState(start)
  const history: HistoryEvent[] = []
  for (let i = 0; i < ticks && state.status === 'running'; i++) {
    const inputs = autopilot(state, want)
    for (const kind of inputs) history.push({ type: 'Input', tick: state.tick, kind })
    const r = step(state, inputs, { impure, crateValue: () => impure() }, levels)
    history.push(...r.events)
    state = r.state
  }
  return { history, state }
}

describe('replay', () => {
  it('rebuilds a live run exactly from its history', () => {
    const levels = makeLevels()
    const live = record(600, levels, ['coin'], counter())
    expect(live.history.some((e) => e.type === 'ActivityCoinCollected')).toBe(true)
    const r = replay(start, live.history, live.state.tick, counter(), levels)
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(live.state))
  })

  it('replays an empty history to the initial state', () => {
    const r = replay(start, [], 0, counter())
    expect(r).toEqual({ ok: true, state: initialState(start) })
  })

  it('diverges at the first orb when the impure value differs on replay', () => {
    const levels = makeLevels({ weights: { orb: 1 } })
    const live = record(400, levels, ['orb'], counter())
    const orbIndex = live.history.findIndex((e) => e.type === 'OrbTaken')
    expect(orbIndex).toBeGreaterThanOrEqual(0)
    const r = replay(start, live.history, live.state.tick, () => 0.99, levels)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.divergedAt).toBe(orbIndex)
  })

  it('does not diverge on orbs when the outside world happens to answer the same', () => {
    const levels = makeLevels({ weights: { orb: 1 } })
    const live = record(400, levels, ['orb'], counter())
    expect(replay(start, live.history, live.state.tick, counter(), levels).ok).toBe(true)
  })

  it('replays crate pickups from their recorded results', () => {
    const levels = makeLevels({ weights: { crate: 1 } })
    const live = record(400, levels, ['crate'], counter())
    expect(live.history.some((e) => e.type === 'ActivityCrateCollected')).toBe(true)
    const r = replay(start, live.history, live.state.tick, () => 0.99, levels)
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(live.state))
  })

  it('advances incrementally for the visible fast-forward', () => {
    const levels = makeLevels()
    const live = record(200, levels, ['coin'], counter())
    const r = createReplayer(start, live.history, 200, counter(), levels)
    r.advance(10)
    expect(r.state.tick).toBe(10)
    expect(r.done).toBe(false)
    r.advance(Number.POSITIVE_INFINITY)
    expect(r.done).toBe(true)
    expect(r.state.tick).toBe(200)
  })

  it('treats a replay that would die as diverged and stops just before', () => {
    const levels = makeLevels({ weights: { low: 1 } })
    const live = record(10_000, levels, [], counter())
    expect(live.state.status).toBe('failed')
    const r = replay(start, live.history, live.state.tick + 50, counter(), levels)
    expect(r.ok).toBe(false)
    expect(r.state.status).toBe('running')
    expect(r.state.tick).toBe(live.state.tick - 1)
  })
})
