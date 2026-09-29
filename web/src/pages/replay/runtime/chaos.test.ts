import { describe, expect, it } from 'vitest'
import { makeLevels } from '../testing'
import { ChaosScheduler } from './chaos'

const levels = makeLevels({ chaosMeanTicks: 1000 }, {
  0: { scriptedCrashAt: 900, chaosMeanTicks: null },
  1: { firstCrashTicks: [480, 720] },
  2: { crashAfterPickup: ['orb'] },
  3: { chaosMeanTicks: null },
  4: { chaosFloorTicks: 480 },
})

describe('ChaosScheduler', () => {
  it('uses the scripted crash tick when the level has one', () => {
    const c = new ChaosScheduler(() => 0.5, levels)
    c.start(0, true)
    expect(c.isDue(899)).toBe(false)
    expect(c.isDue(900)).toBe(true)
  })

  it('puts the first crash of a level inside firstCrashTicks', () => {
    const early = new ChaosScheduler(() => 0, levels)
    early.start(1, true)
    expect(early.nextCrashAt).toBe(480)
    const late = new ChaosScheduler(() => 1, levels)
    late.start(1, true)
    expect(late.nextCrashAt).toBe(720)
  })

  it('schedules later crashes around the mean', () => {
    const c = new ChaosScheduler(() => 0.5, levels)
    c.start(1, false)
    expect(c.nextCrashAt).toBe(1000)
    c.scheduleNext(1, 300, 0)
    expect(c.nextCrashAt).toBe(1300)
  })

  it('shrinks the mean toward the floor as time in the level grows', () => {
    const c = new ChaosScheduler(() => 0.5, levels)
    c.scheduleNext(4, 0, 0)
    expect(c.nextCrashAt).toBe(1000)
    c.scheduleNext(4, 0, 100_000)
    expect(c.nextCrashAt).toBe(480)
  })

  it('pulls the crash forward after a listed pickup, never back', () => {
    const c = new ChaosScheduler(() => 0.5, levels)
    c.start(2, false)
    expect(c.nextCrashAt).toBe(1000)
    c.onPickup(2, 'crate', 100)
    expect(c.nextCrashAt).toBe(1000)
    c.onPickup(2, 'orb', 100)
    expect(c.nextCrashAt).toBe(280)
    c.onPickup(2, 'orb', 200)
    expect(c.nextCrashAt).toBe(280)
  })

  it('never crashes when the level has no chaos', () => {
    const c = new ChaosScheduler(() => 0.5, levels)
    c.start(3, true)
    expect(c.nextCrashAt).toBeNull()
    expect(c.isDue(1_000_000)).toBe(false)
  })
})
