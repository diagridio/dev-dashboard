import type { PlayerInput } from '../engine/types'
import type { SaveBody } from './types'
import { isSaveBody } from './validate'

/**
 * Everything the outside world fed a run: player inputs by live tick, every
 * random value (quantised to uint32 so it reproduces exactly) and every save
 * resume. A Game fed a tape reproduces the run exactly.
 */
export interface Tape {
  v: 1
  date: string
  inputs: [liveTick: number, command: PlayerInput][]
  impure: number[]
  chaos: number[]
  /**
   * A saved run was resumed at this live tick: the cursors are where its values start and
   * `save` is the snapshot it resumed from, so playback restores it whatever phase it is in.
   */
  restarts: { liveTick: number; impureAt: number; chaosAt: number; save: SaveBody }[]
  /** Live ticks recorded so far. */
  liveTick: number
}

const U32 = 2 ** 32
const PLAYER_INPUTS: readonly string[] = ['jump', 'jumpEnd', 'slideStart', 'slideEnd']

export const quantise = (v: number): number => Math.min(U32 - 1, Math.max(0, Math.floor(v * U32)))
export const toUnit = (u: number): number => u / U32

export function emptyTape(date: string): Tape {
  return { v: 1, date, inputs: [], impure: [], chaos: [], restarts: [], liveTick: 0 }
}

const isU32 = (n: unknown): boolean => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n < U32
const isTick = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

export function isTape(v: unknown): v is Tape {
  if (typeof v !== 'object' || v === null) return false
  const t = v as Record<string, unknown>
  if (t.v !== 1 || typeof t.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(t.date) || !isTick(t.liveTick)) return false
  if (!Array.isArray(t.impure) || !t.impure.every(isU32) || !Array.isArray(t.chaos) || !t.chaos.every(isU32)) return false
  if (!Array.isArray(t.inputs) || !Array.isArray(t.restarts)) return false
  const inputsOk = t.inputs.every(
    (x, i, all) =>
      Array.isArray(x) && x.length === 2 && isTick(x[0]) && PLAYER_INPUTS.includes(x[1] as string) &&
      (i === 0 || (all[i - 1] as [number])[0] <= x[0]),
  )
  const restartsOk = t.restarts.every((x: unknown) => {
    if (typeof x !== 'object' || x === null) return false
    const r = x as Record<string, unknown>
    return isTick(r.liveTick) && isTick(r.impureAt) && isTick(r.chaosAt) && isSaveBody(r.save)
  })
  return inputsOk && restartsOk
}

/** Where a Game's outside-world values come from. */
export interface Source {
  impure(): number
  chaos(): number
  readonly exhausted: boolean
}

/** Live play: real randomness, quantised and written to the tape. */
export class TapeRecorder implements Source {
  readonly exhausted = false
  constructor(
    readonly tape: Tape,
    private readonly world: { impure: () => number; chaosRand: () => number },
  ) {}

  impure(): number {
    const u = quantise(this.world.impure())
    this.tape.impure.push(u)
    return toUnit(u)
  }

  chaos(): number {
    const u = quantise(this.world.chaosRand())
    this.tape.chaos.push(u)
    return toUnit(u)
  }
}

/** Playback: values come from the tape; running past its end sets `exhausted`. */
export class TapePlayer implements Source {
  exhausted = false
  private i = 0
  private c = 0
  constructor(readonly tape: Tape) {}

  impure(): number {
    if (this.i >= this.tape.impure.length) return this.dry()
    return toUnit(this.tape.impure[this.i++])
  }

  chaos(): number {
    if (this.c >= this.tape.chaos.length) return this.dry()
    return toUnit(this.tape.chaos[this.c++])
  }

  seek(impureAt: number, chaosAt: number): void {
    this.i = impureAt
    this.c = chaosAt
  }

  private dry(): number {
    this.exhausted = true
    return 0
  }
}
