import { hashState } from './hash'
import { LEVELS, speedAt, type LevelConfig, type LevelTable } from './levels'
import { mix, nextRandom, seedFrom } from './rng'
import {
  GROUND_Y, PLAYER_X, SPAWN_X, TICK_HZ,
  type EntityKind, type GameState, type InputKind, type OutcomeEvent, type Player, type Ports, type StartInput,
} from './types'

export const GRAVITY = 0.5
export const JUMP_VY = -9
export const PLAYER_W = 30
export const PLAYER_H = 16
export const SLIDE_H = 9
export const BOOST_TICKS = 10 * TICK_HZ
export const BOSS_TICKS = 15 * TICK_HZ

// Tuning knobs: spawn spacing in px at speed 4 (scaled with speed so reaction
// time stays constant), and how much denser the boss phase is.
const MIN_GAP = 150
const GAP_RANGE = 130
const BOSS_GAP_SCALE = 0.8
const FIRST_SPAWN_AT = 240

const SIZE: Record<EntityKind, { w: number; h: number }> = {
  low: { w: 14, h: 20 },
  high: { w: 22, h: 30 },
  coin: { w: 10, h: 10 },
  orb: { w: 12, h: 12 },
  crate: { w: 14, h: 14 },
}
// Fixed order so weighted picks don't depend on object key order.
const ORDER: readonly EntityKind[] = ['low', 'high', 'coin', 'orb', 'crate']

export interface StepResult {
  state: GameState
  events: OutcomeEvent[]
}

export function newPlayer(): Player {
  return { y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 }
}

export function initialState(start: StartInput): GameState {
  return {
    level: start.level,
    tick: 0,
    elapsed: start.elapsed,
    rng: start.seed >>> 0,
    score: start.score,
    multiplier: 1,
    multUntil: 0,
    player: newPlayer(),
    scroll: 0,
    distance: start.distance,
    nextSpawnAt: FIRST_SPAWN_AT,
    nextId: 1,
    entities: [],
    bossUntil: start.boss ? BOSS_TICKS : 0,
    status: 'running',
    retries: start.retries,
    shield: start.shield,
    graceUntil: 0,
    failedAt: 0,
  }
}

/** Snapshot input for a fresh history segment (Dapr's ContinueAsNew). */
export function continueAsNew(s: GameState, patch: Partial<StartInput> = {}): StartInput {
  return {
    level: s.level, seed: seedFrom(s.rng), score: s.score, elapsed: s.elapsed, distance: s.distance + s.scroll, boss: false,
    retries: s.retries, shield: s.shield,
    ...patch,
  }
}

function chooseKind(weights: LevelConfig['weights'], r: number): EntityKind {
  const total = ORDER.reduce((n, k) => n + (weights[k] ?? 0), 0)
  let x = r * total
  for (const k of ORDER) {
    const w = weights[k] ?? 0
    if (x < w) return k
    x -= w
  }
  return 'coin'
}

/** Top edge for a new entity. High obstacles leave a slide gap; pickups float. */
function spawnY(kind: EntityKind, r: number): number {
  switch (kind) {
    case 'low': return GROUND_Y - 20
    case 'high': return GROUND_Y - 42
    case 'coin': return r < 0.5 ? GROUND_Y - 24 : GROUND_Y - 70
    default: return GROUND_Y - 60
  }
}

interface Box { x: number; y: number; w: number; h: number }

function overlaps(a: Box, b: Box): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
}

function boost(s: GameState): void {
  s.multiplier = 3
  s.multUntil = s.tick + BOOST_TICKS
}

/** Advances exactly one 1/60 s tick. Pure: same (prev, inputs, port values) → same result. */
export function step(prev: GameState, inputs: readonly InputKind[], ports: Ports, levels: LevelTable = LEVELS): StepResult {
  if (prev.status !== 'running') return { state: prev, events: [] }
  const cfg = levels[prev.level]
  const s: GameState = { ...prev, player: { ...prev.player }, entities: prev.entities.map((e) => ({ ...e })) }
  const p = s.player
  const events: OutcomeEvent[] = []

  if (s.multiplier > 1 && s.tick >= s.multUntil) s.multiplier = 1

  for (const input of inputs) {
    if (input === 'jump') {
      if (p.y >= GROUND_Y) {
        p.vy = JUMP_VY
        p.sliding = false
      }
    } else {
      p.sliding = input === 'slideStart'
    }
  }
  if (p.y < GROUND_Y || p.vy < 0) {
    p.vy += GRAVITY
    p.y = Math.min(GROUND_Y, p.y + p.vy)
    if (p.y >= GROUND_Y) p.vy = 0
  }

  const speed = speedAt(cfg, s.elapsed)
  s.scroll += speed
  for (const e of s.entities) e.x -= speed
  s.entities = s.entities.filter((e) => e.x + e.w > 0)

  const boss = s.bossUntil > 0
  const weights = boss ? cfg.bossWeights : cfg.weights
  while (s.scroll >= s.nextSpawnAt) {
    const kindRoll = nextRandom(s.rng)
    const yRoll = nextRandom(kindRoll.state)
    const gapRoll = nextRandom(yRoll.state)
    s.rng = gapRoll.state
    const kind = chooseKind(weights, kindRoll.value)
    const size = SIZE[kind]
    s.entities.push({ id: s.nextId, kind, x: SPAWN_X, y: spawnY(kind, yRoll.value), w: size.w, h: size.h, taken: false })
    s.nextId += 1
    s.nextSpawnAt += (MIN_GAP + gapRoll.value * GAP_RANGE) * (boss ? BOSS_GAP_SCALE : 1) * (speed / 4)
  }

  const height = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  const box: Box = { x: PLAYER_X, y: p.y - height, w: PLAYER_W, h: height }
  for (const e of s.entities) {
    if (e.taken || !overlaps(box, e)) continue
    if (e.kind === 'low' || e.kind === 'high') {
      s.status = 'failed'
      break
    }
    e.taken = true
    if (e.kind === 'coin') {
      s.score += s.multiplier
      events.push({ type: 'ActivityCoinCollected', tick: s.tick, id: e.id, hash: 0 })
    } else if (e.kind === 'orb') {
      s.rng = mix(s.rng, ports.impure())
      boost(s)
      events.push({ type: 'OrbTaken', tick: s.tick, id: e.id, hash: 0 })
    } else {
      const result = ports.crateValue(e.id)
      s.rng = mix(s.rng, result)
      boost(s)
      s.score += s.multiplier
      events.push({ type: 'ActivityCrateCollected', tick: s.tick, id: e.id, hash: 0, result })
    }
  }

  if (s.status === 'running' && s.distance + s.scroll >= cfg.length) s.status = 'levelDone'
  s.tick += 1
  s.elapsed += 1
  const hash = hashState(s)
  return { state: s, events: events.map((e) => ({ ...e, hash })) }
}
