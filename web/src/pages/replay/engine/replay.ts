import { LEVELS, type LevelTable } from './levels'
import { initialState, step } from './step'
import type { GameState, HistoryEvent, InputEvent, InputKind, OutcomeEvent, Ports, ReplayResult, StartInput } from './types'

export interface Replayer {
  readonly state: GameState
  readonly done: boolean
  /** Runs up to maxTicks more ticks (or until done). */
  advance(maxTicks: number): void
  result(): ReplayResult
}

export function isInputEvent(e: HistoryEvent): e is InputEvent {
  return e.type === 'Input' || e.type === 'OrchestratorStarted' || e.type === 'RetryAttempt'
}

export function inputOf(e: InputEvent): InputKind {
  if (e.type === 'Input') return e.kind
  return e.type === 'OrchestratorStarted' ? 'resume' : 'retry'
}

const idOf = (e: OutcomeEvent): number => ('id' in e ? e.id : 0)

function matches(expected: readonly OutcomeEvent[], actual: readonly OutcomeEvent[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((e, i) => e.type === actual[i].type && idOf(e) === idOf(actual[i]) && e.hash === actual[i].hash)
  )
}

/**
 * Re-runs step() from `start`, feeding recorded inputs at their ticks and
 * comparing every recorded outcome (type, id, state hash) with what the step
 * produces now. Crate results come from history; orbs call `impure` again.
 */
export function createReplayer(
  start: StartInput,
  history: readonly HistoryEvent[],
  toTick: number,
  impure: () => number,
  levels: LevelTable = LEVELS,
): Replayer {
  const crateResults = new Map<number, number>()
  for (const e of history) {
    if (e.type === 'ActivityCrateCollected') crateResults.set(e.id, e.result)
  }
  const ports: Ports = { impure, crateValue: (id) => crateResults.get(id) ?? impure() }
  let state = initialState(start)
  let cursor = 0
  let divergedAt: number | null = null
  let done = toTick <= 0

  return {
    get state() {
      return state
    },
    get done() {
      return done
    },
    advance(maxTicks: number) {
      for (let n = 0; n < maxTicks && !done; n++) {
        const tick = state.tick
        const inputs: InputKind[] = []
        const expected: OutcomeEvent[] = []
        const firstIndex = cursor
        while (cursor < history.length && history[cursor].tick <= tick) {
          const e = history[cursor]
          if (isInputEvent(e)) inputs.push(inputOf(e))
          else expected.push(e)
          cursor++
        }
        const next = step(state, inputs, ports, levels)
        if (divergedAt === null && !matches(expected, next.events)) {
          const firstOutcome = history.slice(firstIndex, cursor).findIndex((e) => !isInputEvent(e))
          divergedAt = firstOutcome >= 0 ? firstIndex + firstOutcome : cursor
        }
        if (next.state.status === 'failed' || next.state.status === 'retry') {
          // A replay that dies (or needs a retry) has diverged from a run that didn't: stop just before.
          if (divergedAt === null) divergedAt = cursor
          done = true
          break
        }
        state = next.state
        if (state.tick >= toTick || state.status !== 'running') done = true
      }
    },
    result() {
      return divergedAt === null ? { ok: true, state } : { ok: false, divergedAt, state }
    },
  }
}

export function replay(
  start: StartInput,
  history: readonly HistoryEvent[],
  toTick: number,
  impure: () => number,
  levels: LevelTable = LEVELS,
): ReplayResult {
  const r = createReplayer(start, history, toTick, impure, levels)
  r.advance(Number.POSITIVE_INFINITY)
  return r.result()
}
