import { hashState } from './hash'
import { LEVELS, speedAt, type LevelConfig, type LevelTable } from './levels'
import { mix, nextRandom, seedFrom } from './rng'
import {
  GROUND_Y, PLAYER_X, SPAWN_X, TICK_HZ,
  type Entity, type EntityKind, type GameState, type InputKind, type OutcomeEvent, type Player, type Ports, type StartInput,
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

export const PIT_HIT_DEPTH = 14
/** A falling rack starts to drop this many ticks before it would reach the hat. */
export const FALL_LEAD_TICKS = 60
/** Racks fall faster than the hat so they land well ahead of it (~21 ticks from the top). */
export const RACK_GRAVITY = 1
const PIT_MIN_W = 30
const PIT_RANGE_W = 30

export const RACKS: ReadonlySet<EntityKind> = new Set<EntityKind>(['low', 'high', 'tall', 'falling'])
export const HAZARDS: ReadonlySet<EntityKind> = new Set<EntityKind>([...RACKS, 'pit'])

const SIZE: Record<EntityKind, { w: number; h: number }> = {
  low: { w: 14, h: 20 },
  high: { w: 22, h: 30 },
  coin: { w: 10, h: 10 },
  orb: { w: 12, h: 12 },
  crate: { w: 14, h: 14 },
  tall: { w: 16, h: 44 },
  falling: { w: 18, h: 24 },
  pit: { w: PIT_MIN_W, h: 0 },
}
// Fixed order so weighted picks don't depend on object key order. New kinds go last,
// so the v1 kinds keep their cumulative weights.
const ORDER: readonly EntityKind[] = ['low', 'high', 'coin', 'orb', 'crate', 'tall', 'falling', 'pit']

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

function spawnY(kind: EntityKind, r: number): number {
  switch (kind) {
    case 'low': return GROUND_Y - 20
    case 'high': return GROUND_Y - 42
    case 'tall': return GROUND_Y - 44
    case 'falling': return -SIZE.falling.h
    case 'pit': return GROUND_Y
    case 'coin': return r < 0.5 ? GROUND_Y - 24 : GROUND_Y - 70
    default: return GROUND_Y - 60
  }
}

function spawn(kind: EntityKind, id: number, x: number, yRoll: number): Entity {
  const size = SIZE[kind]
  // Pits take their width from the same roll other kinds use for height.
  const w = kind === 'pit' ? PIT_MIN_W + Math.floor(yRoll * (PIT_RANGE_W + 1)) : size.w
  const e: Entity = { id, kind, x, y: spawnY(kind, yRoll), w, h: size.h, taken: false }
  if (kind === 'falling') e.vy = 0
  return e
}

/** The pit under the player's foot centre, if any. */
export function overPit(entities: readonly Entity[]): Entity | undefined {
  const foot = PLAYER_X + PLAYER_W / 2
  return entities.find((e) => e.kind === 'pit' && foot >= e.x && foot < e.x + e.w)
}

function launch(p: Player): void {
  p.vy = JUMP_VY
  p.sliding = false
  p.coyoteUntil = 0
  p.jumpBufferUntil = 0
}

/** Inputs, gravity and landing for one hat. Mutates `p`. */
export function movePlayer(p: Player, inputs: readonly InputKind[], tick: number, entities: readonly Entity[]): void {
  void tick
  const pit = overPit(entities)
  const standing = p.y === GROUND_Y && p.vy === 0 && !pit
  for (const input of inputs) {
    if (input === 'jump') {
      if (standing) launch(p)
    } else if (input === 'slideStart' || input === 'slideEnd') {
      p.sliding = input === 'slideStart'
    }
  }
  const supported = p.y === GROUND_Y && p.vy === 0 && !pit
  if (supported) return
  const before = p.y
  p.vy += GRAVITY
  p.y += p.vy
  // Land only when coming down through the ground line onto solid ground.
  if (p.vy >= 0 && before <= GROUND_Y && p.y >= GROUND_Y && !overPit(entities)) {
    p.y = GROUND_Y
    p.vy = 0
  }
}

function updateFalling(e: Entity, speed: number): void {
  if (e.kind !== 'falling' || e.x - PLAYER_X > FALL_LEAD_TICKS * speed) return
  const floor = GROUND_Y - e.h
  if (e.y >= floor) return
  e.vy = (e.vy ?? 0) + RACK_GRAVITY
  e.y = Math.min(floor, e.y + e.vy)
  if (e.y >= floor) e.vy = 0
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

  movePlayer(p, inputs, s.tick, s.entities)

  const speed = speedAt(cfg, s.elapsed)
  s.scroll += speed
  for (const e of s.entities) {
    e.x -= speed
    updateFalling(e, speed)
  }
  s.entities = s.entities.filter((e) => e.x + e.w > 0)

  const boss = s.bossUntil > 0
  const weights = boss ? cfg.bossWeights : cfg.weights
  while (s.scroll >= s.nextSpawnAt) {
    const kindRoll = nextRandom(s.rng)
    const yRoll = nextRandom(kindRoll.state)
    const gapRoll = nextRandom(yRoll.state)
    s.rng = gapRoll.state
    const kind = chooseKind(weights, kindRoll.value)
    s.entities.push(spawn(kind, s.nextId, SPAWN_X, yRoll.value))
    s.nextId += 1
    s.nextSpawnAt += (MIN_GAP + gapRoll.value * GAP_RANGE) * (boss ? BOSS_GAP_SCALE : 1) * (speed / 4)
  }

  const height = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  const box: Box = { x: PLAYER_X, y: p.y - height, w: PLAYER_W, h: height }
  if (p.y >= GROUND_Y + PIT_HIT_DEPTH) s.status = 'failed'
  for (const e of s.entities) {
    if (s.status !== 'running') break
    if (e.taken || e.kind === 'pit' || !overlaps(box, e)) continue
    if (RACKS.has(e.kind)) {
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
