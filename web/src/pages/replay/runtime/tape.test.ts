import { describe, expect, it } from 'vitest'
import { TapePlayer, TapeRecorder, emptyTape, isTape, quantise, toUnit } from './tape'

describe('tape values', () => {
  it('quantises to uint32 and back without drift', () => {
    for (const v of [0, 0.25, 0.123456789, 0.9999999999]) {
      const u = quantise(v)
      expect(Number.isInteger(u) && u >= 0 && u <= 0xffffffff).toBe(true)
      expect(quantise(toUnit(u))).toBe(u)
    }
  })
})

describe('TapeRecorder and TapePlayer', () => {
  it('play back exactly what was recorded, then report exhaustion', () => {
    const tape = emptyTape('2026-09-30')
    const rec = new TapeRecorder(tape, { impure: () => 0.3, chaosRand: () => 0.7 })
    const a = [rec.impure(), rec.chaos(), rec.impure()]
    const play = new TapePlayer(tape)
    expect([play.impure(), play.chaos(), play.impure()]).toEqual(a)
    expect(play.exhausted).toBe(false)
    play.impure()
    expect(play.exhausted).toBe(true)
  })

  it('seeks both cursors', () => {
    const tape = { ...emptyTape('2026-09-30'), impure: [1, 2, 3], chaos: [4, 5] }
    const play = new TapePlayer(tape)
    play.seek(2, 1)
    expect([play.impure(), play.chaos()]).toEqual([toUnit(3), toUnit(5)])
  })
})

describe('isTape', () => {
  const ok = { ...emptyTape('2026-09-30'), inputs: [[3, 'jump']], impure: [1], chaos: [2], restarts: [[10, 1, 1]], liveTick: 20 }
  it('accepts a well-formed tape', () => expect(isTape(ok)).toBe(true))
  it.each([
    ['version', { ...ok, v: 2 }],
    ['date', { ...ok, date: 'today' }],
    ['input kind', { ...ok, inputs: [[3, 'fly']] }],
    ['input order', { ...ok, inputs: [[5, 'jump'], [3, 'jump']] }],
    ['impure range', { ...ok, impure: [2 ** 32] }],
    ['chaos type', { ...ok, chaos: ['x'] }],
    ['restart shape', { ...ok, restarts: [[10, 1]] }],
    ['live tick', { ...ok, liveTick: -1 }],
  ])('rejects a bad %s', (_name, bad) => expect(isTape(bad)).toBe(false))
})
