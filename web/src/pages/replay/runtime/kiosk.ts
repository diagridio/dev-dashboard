// Kiosk mode: the game plays itself at a booth. KioskSource stands in for the
// outside world (seeded, so every kiosk loop is the same show) and KioskBot
// picks the inputs by simulating candidate moves with the real engine.
import type { LevelTable } from '../engine/levels'
import { nextRandom } from '../engine/rng'
import { HAZARD_INSET_X, livePlayer, PLAYER_H, PLAYER_W, RACKS, SLIDE_H, step } from '../engine/step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState, type Player, type PlayerInput, type Ports } from '../engine/types'
import type { Source } from './tape'

/** The fixed seed of the kiosk run. */
export const KIOSK_SEED = 0x0da92026 >>> 0

/** A mulberry32 stream, independent of any other stream from the same seed. */
class Stream {
  private s: number
  constructor(seed: number, salt: number) {
    this.s = nextRandom((seed ^ salt) >>> 0).state
  }

  next(): number {
    const r = nextRandom(this.s)
    this.s = r.state
    return r.value
  }
}

/** Seeded outside world: the kiosk run is the same on every loop. */
export class KioskSource implements Source {
  readonly exhausted = false
  private readonly imp: Stream
  private readonly cha: Stream
  constructor(seed: number) {
    this.imp = new Stream(seed, 0x9e3779b9)
    this.cha = new Stream(seed, 0x85ebca6b)
  }

  impure(): number {
    return this.imp.next()
  }

  chaos(): number {
    return this.cha.next()
  }
}

// Search tuning.
/** Ticks an idle candidate must survive, and how far ahead (× speed) the bot looks for things to plan around. */
const HORIZON = 48
/** Latest press the search tries, in ticks from now, and the step between tried presses. */
const MAX_DELAY = 30
const DELAY_STEP = 2
/**
 * After a move ends (landed, slide over) the hat must survive this many idle ticks; what comes
 * after that is the follow-up check's job, so back-to-back racks can be jumped one after another.
 */
const ROOM = 2
/** When nothing gets through but idling survives this long, the trouble is out of reach: wait and look again. */
const FAR = MAX_DELAY + 10
/** An idle plan lasts this long before the bot looks again. */
const IDLE_TICKS = 6
/** Preferred clearance: racks are treated as this much wider (each side) and taller. */
const SAFE_X = 4
const SAFE_Y = 4
/** A slide ends this many px after the last overhead hazard has passed. */
const SLIDE_CLEAR_X = 4
/** A jump whose landing would take longer than this is cut off as a failure. */
const MAX_AIR = 40
/** Rival plans with a failing follow-up are checked this many deep before falling back. */
const FOLLOW_UP_TRIES = 6
const ORB_PENALTY = 1000

const SIM_PORTS: Ports = { impure: () => 0.5, crateValue: () => 0.5 }

type Action =
  | { kind: 'tap'; release: number }
  | { kind: 'hold'; release: number }
  | { kind: 'slide' }

// In order of preference when they tie. A slide comes first so a high rack is slid under
// rather than jumped. Taps are 4 and 6 ticks: a release at 12 or later is the same arc as a
// full hold, and taps of 7+ clear tall racks, which should get a visibly held jump.
const ACTIONS: readonly Action[] = [
  { kind: 'slide' },
  { kind: 'tap', release: 4 },
  { kind: 'tap', release: 6 },
  { kind: 'hold', release: 30 },
]

interface Entry { at: number; input: PlayerInput }
interface Plan { startTick: number; length: number; script: Entry[] }

interface Outcome {
  /** Survived the whole evaluation (at least HORIZON ticks from now, and ROOM ticks after the move). */
  ok: boolean
  /**
   * Alive at the checkpoint: the move is over, ROOM ticks have passed, and the hat is past the
   * first thing idling would hit. A plan that is not ok but passed is fine if a follow-up exists.
   */
  passed: boolean
  /** Ticks from now until the hit (or the end of the evaluation). */
  survived: number
  /** Kept the preferred clearance from every rack and pit edge. */
  safe: boolean
  pickups: number
  orbs: number
  /** Simulated state at the checkpoint, for the follow-up check. */
  end: GameState | null
  script: Entry[]
  length: number
}

interface Candidate { order: number; delay: number; out: Outcome }

const grounded = (p: Player) => p.y === GROUND_Y && p.vy === 0

function tracks(s: GameState): { player: Player; entities: Entity[] }[] {
  return s.fan ? s.fan.lanes : [s]
}

function overlapsX(e: Entity, left: number, right: number): boolean {
  return e.x < right && e.x + e.w > left
}

/** Overhead hazards a slide passes under: high racks, and orbs the bot must not take. */
function overhead(e: Entity, takeOrb: boolean): boolean {
  return !e.taken && (e.kind === 'high' || (e.kind === 'orb' && !takeOrb))
}

/** Own collision check: a hit even during grace (the bot should look like it dodges), plus clearance. */
function judge(s: GameState): { hit: boolean; tight: boolean } {
  let hit = false
  let tight = false
  for (const t of tracks(s)) {
    const p = t.player
    if (p.y > GROUND_Y + 2) hit = true
    const height = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
    const top = p.y - height
    const left = PLAYER_X + HAZARD_INSET_X
    const right = PLAYER_X + PLAYER_W - HAZARD_INSET_X
    const foot = PLAYER_X + PLAYER_W / 2
    for (const e of t.entities) {
      if (e.taken) continue
      if (e.kind === 'pit') {
        if (p.y >= GROUND_Y && foot >= e.x - SAFE_X && foot < e.x + e.w + SAFE_X) tight = true
        continue
      }
      if (!RACKS.has(e.kind)) continue
      const vertical = top < e.y + e.h && p.y > e.y
      if (vertical && overlapsX(e, left, right)) hit = true
      // Jumping over: keep SAFE_Y above the top; sliding under a high rack keeps its own fixed gap.
      if (top < e.y + e.h && p.y > e.y - SAFE_Y && overlapsX(e, left - SAFE_X, right + SAFE_X)) tight = true
    }
  }
  return { hit, tight }
}

/** The kiosk bot: plans short scripts of inputs by simulating them with the real engine. */
export class KioskBot {
  private plan: Plan | null = null
  constructor(private readonly levels: LevelTable) {}

  reset(): void {
    this.plan = null
  }

  inputs(s: GameState, takeOrb: boolean): PlayerInput[] {
    if (s.status !== 'running') return []
    const plan = this.plan
    if (plan) {
      const at = s.tick - plan.startTick
      if (at >= 0 && at < plan.length) return plan.script.filter((e) => e.at === at).map((e) => e.input)
      this.plan = null
    }
    const p = livePlayer(s)
    if (p.sliding) {
      const left = PLAYER_X - SLIDE_CLEAR_X
      const right = PLAYER_X + PLAYER_W + SLIDE_CLEAR_X
      const under = tracks(s).some((t) => t.entities.some((e) => overhead(e, takeOrb) && overlapsX(e, left, right)))
      return under ? [] : ['slideEnd']
    }
    if (!grounded(p)) return []
    const next = this.choose(s, takeOrb)
    if (!next) return []
    this.plan = next
    return next.script.filter((e) => e.at === 0).map((e) => e.input)
  }

  private choose(s: GameState, takeOrb: boolean): Plan | null {
    const first = step(s, [], SIM_PORTS, this.levels).state
    const speed = first.scroll - s.scroll
    const reach = PLAYER_X + PLAYER_W + speed * HORIZON
    const ahead = tracks(s).flatMap((t) => t.entities).filter((e) => !e.taken && e.kind !== 'fanout' && e.x + e.w > PLAYER_X && e.x < reach)
    if (ahead.length === 0) return null

    const search = new Search(s, takeOrb, this.levels)
    const wanted = ahead.filter((e) => e.kind === 'coin' || e.kind === 'crate' || (e.kind === 'orb' && takeOrb)).length
    const idle = search.idle()
    if (idle.ok && idle.orbs === 0 && idle.pickups >= wanted) return idlePlan(s)

    const ranked = search.all(idle)
    // Commit to the best plan that still has a way through afterwards.
    let tries = 0
    for (const c of ranked) {
      if (!c.out.passed || tries >= FOLLOW_UP_TRIES) break
      if (c.order < 0) return idlePlan(s)
      tries++
      if (!c.out.end || new Search(c.out.end, takeOrb, this.levels).hasWayThrough()) return toPlan(s, c)
    }
    const best = ranked[0]
    if (best?.out.passed) return toPlan(s, best)
    // Nothing gets through. If the trouble is beyond reach of any press, wait and look again;
    // otherwise go down fighting with the move that lasts longest.
    if (idle.survived >= FAR) return idlePlan(s)
    const longest = [...ranked].sort((a, b) => b.out.survived - a.out.survived || a.order - b.order)[0]
    return longest ? toPlan(s, longest) : idlePlan(s)
  }
}

function idlePlan(s: GameState): Plan {
  return { startTick: s.tick, length: IDLE_TICKS, script: [] }
}

function toPlan(s: GameState, c: Candidate): Plan {
  if (c.order < 0) return idlePlan(s)
  return { startTick: s.tick, length: c.out.length, script: c.out.script }
}

/** One planning pass from a grounded state. Idle states are computed once and shared by every delayed press. */
class Search {
  private readonly idleStates: GameState[]
  private readonly idlePickups: number[]
  private readonly idleOrbs: number[]
  private readonly idleTight: boolean[]
  /** First idle tick with a hit; Infinity when idle has not been hit. */
  private idleDeath = Number.POSITIVE_INFINITY
  private idleDone = false

  constructor(
    start: GameState,
    private readonly takeOrb: boolean,
    private readonly levels: LevelTable,
  ) {
    this.idleStates = [start]
    this.idlePickups = [0]
    this.idleOrbs = [0]
    this.idleTight = [false]
  }

  /** Extends the shared idle run up to `t` ticks (or until it is hit or the level ends). */
  private idleTo(t: number): void {
    while (this.idleStates.length <= t && !this.idleDone) {
      const i = this.idleStates.length - 1
      const r = step(this.idleStates[i], [], SIM_PORTS, this.levels)
      const tally = count(r.events)
      const j = judge(r.state)
      if (j.hit || tally.hit || r.state.status === 'failed' || r.state.status === 'retry') {
        this.idleDeath = i + 1
        this.idleDone = true
        return
      }
      this.idleStates.push(r.state)
      this.idlePickups.push(this.idlePickups[i] + tally.pickups)
      this.idleOrbs.push(this.idleOrbs[i] + tally.orbs)
      this.idleTight.push(this.idleTight[i] || j.tight)
      if (r.state.status !== 'running') this.idleDone = true
    }
  }

  /** Doing nothing for HORIZON ticks. */
  idle(): Outcome {
    this.idleTo(HORIZON)
    const at = Math.min(this.idleStates.length - 1, HORIZON)
    const ok = this.idleDeath > HORIZON
    return {
      ok, passed: ok, survived: ok ? HORIZON : this.idleDeath, safe: !this.idleTight[at],
      pickups: this.idlePickups[at], orbs: this.idleOrbs[at], end: null, script: [], length: IDLE_TICKS,
    }
  }

  /** True when idling or some move from here gets through (checks a plan's follow-up; no further depth). */
  hasWayThrough(): boolean {
    const fine = (o: Outcome) => this.takeOrb || o.orbs === 0
    const idle = this.idle()
    if (idle.ok && fine(idle)) return true
    for (let d = 0; d <= MAX_DELAY; d += DELAY_STEP) {
      for (const a of ACTIONS) {
        const out = this.press(d, a)
        if (out?.passed && fine(out)) return true
      }
    }
    return false
  }

  /** Every candidate, best first. Idle has order -1. */
  all(idle: Outcome): Candidate[] {
    const cands: Candidate[] = [{ order: -1, delay: 0, out: idle }]
    for (let d = 0; d <= MAX_DELAY; d += DELAY_STEP) {
      ACTIONS.forEach((a, order) => {
        const out = this.press(d, a)
        if (out) cands.push({ order, delay: d, out })
      })
    }
    // Per action, prefer the middle of the window of working presses (a slide: start just before it is needed).
    const mid = new Map<number, number>()
    ACTIONS.forEach((a, order) => {
      const ok = cands.filter((c) => c.order === order && c.out.passed).map((c) => c.delay)
      if (ok.length === 0) return
      mid.set(order, a.kind === 'slide' ? Math.max(0, ok[ok.length - 1] - DELAY_STEP) : ok[Math.floor((ok.length - 1) / 2)])
    })
    const orbScore = (o: Outcome) => (o.orbs === 0 ? 0 : this.takeOrb ? 1 : -ORB_PENALTY)
    const rank = (c: Candidate): number[] => [
      c.out.passed ? 1 : 0, orbScore(c.out), c.out.ok ? 1 : 0, c.out.safe ? 1 : 0, c.out.pickups,
      -c.order, -Math.abs(c.delay - (mid.get(c.order) ?? 0)),
    ]
    return cands
      .map((c) => ({ c, r: rank(c) }))
      .sort((a, b) => {
        for (let i = 0; i < a.r.length; i++) if (a.r[i] !== b.r[i]) return b.r[i] - a.r[i]
        return a.c.delay - b.c.delay
      })
      .map((x) => x.c)
  }

  /** Waits `d` ticks, then performs `a`; null when idling is hit before the press. */
  private press(d: number, a: Action): Outcome | null {
    this.idleTo(d)
    if (d >= this.idleStates.length) return null
    let s = this.idleStates[d]
    let pickups = this.idlePickups[d]
    let orbs = this.idleOrbs[d]
    let safe = !this.idleTight[d]
    const script: Entry[] = []
    let now = d
    /** Tick (from now) the move ended: released, and grounded and standing again. */
    let endedAt = -1
    let end: GameState | null = null
    let sawOverhead = false
    const fail = (): Outcome => ({ ok: false, passed: end !== null, survived: now, safe: false, pickups, orbs, end, script, length: lengthOf(script, d) })
    for (;;) {
      const t = now - d
      const ins: PlayerInput[] = []
      if (endedAt < 0) {
        if (a.kind === 'slide') {
          if (t === 0) ins.push('slideStart')
          else {
            const left = PLAYER_X - SLIDE_CLEAR_X
            const right = PLAYER_X + PLAYER_W + SLIDE_CLEAR_X
            const under = tracks(s).some((tr) => tr.entities.some((e) => overhead(e, this.takeOrb) && overlapsX(e, left, right)))
            if (under) sawOverhead = true
            if ((sawOverhead && !under) || t >= HORIZON) ins.push('slideEnd')
          }
        } else {
          if (t === 0) ins.push('jump')
          if (t === a.release) ins.push('jumpEnd')
        }
        for (const input of ins) script.push({ at: now, input })
      }
      const r = step(s, ins, SIM_PORTS, this.levels)
      const tally = count(r.events)
      const j = judge(r.state)
      now++
      if (j.hit || tally.hit || r.state.status === 'failed' || r.state.status === 'retry') return fail()
      s = r.state
      // Pickups count within a window common to every candidate, so a longer evaluation earns nothing extra.
      if (now <= HORIZON) pickups += tally.pickups
      orbs += tally.orbs
      if (j.tight) safe = false
      if (s.status !== 'running') {
        end = s
        break
      }
      if (endedAt < 0) {
        const p = livePlayer(s)
        // A slide that passes under nothing is pointless.
        if (a.kind === 'slide' && !p.sliding && !sawOverhead) return null
        const released = a.kind === 'slide' ? !p.sliding : t >= a.release
        if (released && grounded(p) && !p.sliding) endedAt = now
        else if (t > MAX_AIR + (a.kind === 'slide' ? HORIZON : 0)) return fail()
      }
      if (endedAt >= 0) {
        // Past the move, past what idling would hit, and some room to spare.
        const checkpoint = Math.max(endedAt + ROOM, Number.isFinite(this.idleDeath) ? this.idleDeath + 1 : 0)
        if (now === checkpoint) end = s
        if (now >= checkpoint && now >= HORIZON) break
      }
    }
    return { ok: true, passed: true, survived: now, safe, pickups, orbs, end, script, length: lengthOf(script, d) }
  }
}

function lengthOf(script: readonly Entry[], d: number): number {
  return (script.length > 0 ? script[script.length - 1].at : d) + 1
}

function count(events: readonly { type: string }[]): { hit: boolean; pickups: number; orbs: number } {
  let hit = false
  let pickups = 0
  let orbs = 0
  for (const e of events) {
    if (e.type === 'CircuitBreakerTripped' || e.type === 'BoostLost') hit = true
    else if (e.type === 'ActivityCoinCollected' || e.type === 'ActivityCrateCollected') pickups++
    else if (e.type === 'OrbTaken') orbs++
  }
  return { hit, pickups, orbs }
}
