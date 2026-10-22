import { hashState } from './hash'
import { LEVELS, speedAt, type LevelConfig, type LevelTable } from './levels'
import { mix, nextRandom, seedFrom } from './rng'
import {
  GROUND_Y, PLAYER_X, SPAWN_X, TICK_HZ, VIEW_W,
  type Entity, type EntityKind, type GameState, type InputKind, type Lane, type OutcomeEvent, type Player, type Ports, type StartInput,
} from './types'

export const GRAVITY = 0.5
export const JUMP_VY = -9
export const PLAYER_W = 30
export const PLAYER_H = 16
export const SLIDE_H = 9
/** Racks only hit inside the hat's box minus this many px on the left and right, so a graze is forgiven. */
export const HAZARD_INSET_X = 3
export const BOOST_TICKS = 10 * TICK_HZ
export const BOSS_TICKS = 15 * TICK_HZ
export const SHIELD_FULL = 10
export const GRACE_RESUME = 60
export const GRACE_RETRY = 60
export const GRACE_BOOST = 60
export const GRACE_BARGE = 30
/** Parallel lanes during fan-out (three proved too hard to follow). */
export const FAN_LANES = 2
/** The lane whose hat becomes the main hat again at fan-in. */
export const MERGE_LANE = 0
/** No other spawns this close before a gate, and after a merge. */
export const FAN_CLEAR_PX = 200
/** Each lane strip is drawn at this scale (VIEW_H / FAN_LANES tall), so a lane shows VIEW_W / LANE_SCALE px of world. */
export const LANE_SCALE = 0.75
/** Lane entities spawn just off the right edge of a lane strip. */
export const LANE_SPAWN_X = VIEW_W / LANE_SCALE + 10
export const GATE_W = 12

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
  fanout: { w: GATE_W, h: GROUND_Y },
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

interface Track {
  player: Player
  entities: Entity[]
}

function firstGate(cfg: LevelConfig, distance: number): number {
  if (!cfg.fanOut) return Number.POSITIVE_INFINITY
  return (Math.floor(distance / cfg.fanOut.everyPx) + 1) * cfg.fanOut.everyPx
}

export function initialState(start: StartInput, levels: LevelTable = LEVELS): GameState {
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
    fan: null,
    nextGateAt: firstGate(levels[start.level], start.distance),
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
    // Orbs sit at the coin heights: a low one is dodged by sliding, a high one by not jumping.
    case 'coin':
    case 'orb':
      return r < 0.5 ? GROUND_Y - 24 : GROUND_Y - 70
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

export const COYOTE_TICKS = 6
export const JUMP_BUFFER_TICKS = 6
export const JUMP_CUT_VY = -3

/** Inputs, gravity and landing for one hat. Mutates `p`. */
export function movePlayer(p: Player, inputs: readonly InputKind[], tick: number, entities: readonly Entity[]): void {
  const pit = overPit(entities)
  const atGround = p.y === GROUND_Y && p.vy === 0
  const standing = atGround && !pit
  // The tick the foot first crosses a pit edge is still a coyote tick.
  const edge = atGround && !!pit
  for (const input of inputs) {
    if (input === 'jump') {
      p.jumpHeld = true
      if (standing || edge || tick < p.coyoteUntil) launch(p)
      else p.jumpBufferUntil = tick + JUMP_BUFFER_TICKS
    } else if (input === 'jumpEnd') {
      p.jumpHeld = false
      if (p.vy < JUMP_CUT_VY) p.vy = JUMP_CUT_VY
    } else if (input === 'slideStart' || input === 'slideEnd') {
      p.sliding = input === 'slideStart'
    }
  }
  const grounded = p.y === GROUND_Y && p.vy === 0
  if (grounded && !pit) return
  // Walking off an edge (not jumping) opens the coyote window once.
  if (grounded) p.coyoteUntil = tick + COYOTE_TICKS
  const before = p.y
  p.vy += GRAVITY
  p.y += p.vy
  // Land only when coming down through the ground line onto solid ground.
  if (p.vy >= 0 && before <= GROUND_Y && p.y >= GROUND_Y && !overPit(entities)) {
    p.y = GROUND_Y
    p.vy = 0
    if (tick < p.jumpBufferUntil) launch(p)
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

function bounce(p: Player): void {
  p.vy = JUMP_VY
  p.sliding = false
}

/**
 * One hit (a rack, or `pit` = fallen too deep), resolved by the first layer that
 * can absorb it: grace, circuit breaker, boost, retry; otherwise the run fails.
 */
function resolveHit(s: GameState, cfg: LevelConfig, p: Player, rack: Entity | undefined, pit: boolean, events: OutcomeEvent[]): void {
  const id = pit ? 0 : (rack?.id ?? 0)
  if (s.tick < s.graceUntil) {
    if (pit) bounce(p)
    return
  }
  if (cfg.shieldEnabled && s.shield >= SHIELD_FULL) {
    s.shield = 0
    s.graceUntil = s.tick + GRACE_BARGE
    if (pit) bounce(p)
    else if (rack) rack.taken = true
    events.push({ type: 'CircuitBreakerTripped', tick: s.tick, id, hash: 0 })
    return
  }
  if (s.multiplier > 1) {
    s.multiplier = 1
    s.multUntil = s.tick
    s.graceUntil = s.tick + GRACE_BOOST
    if (pit) bounce(p)
    events.push({ type: 'BoostLost', tick: s.tick, id, hash: 0 })
    return
  }
  if (s.retries > 0) {
    s.status = 'retry'
    s.failedAt = s.tick
    return
  }
  s.status = 'failed'
}

function boost(s: GameState): void {
  s.multiplier = 3
  s.multUntil = s.tick + BOOST_TICKS
}

function clone(prev: GameState): GameState {
  const copy = (es: readonly Entity[]) => es.map((e) => ({ ...e }))
  return {
    ...prev,
    player: { ...prev.player },
    entities: copy(prev.entities),
    fan: prev.fan && {
      until: prev.fan.until,
      lanes: prev.fan.lanes.map((l) => ({ ...l, player: { ...l.player }, entities: copy(l.entities) })),
    },
  }
}

/** The hat the player is steering: during fan-out `state.player` is frozen, so read a lane. */
export function livePlayer(s: GameState): Player {
  return (s.fan ? s.fan.lanes[MERGE_LANE] : s).player
}

function tracks(s: GameState): Track[] {
  return s.fan ? s.fan.lanes : [s]
}

function scrollTrack(t: Track, speed: number): void {
  for (const e of t.entities) {
    e.x -= speed
    updateFalling(e, speed)
  }
  t.entities = t.entities.filter((e) => e.x + e.w > 0)
}

/** Three rolls from the level RNG: kind, y (or pit width) and gap. */
function roll(s: GameState): { kind: number; y: number; gap: number } {
  const kindRoll = nextRandom(s.rng)
  const yRoll = nextRandom(kindRoll.state)
  const gapRoll = nextRandom(yRoll.state)
  s.rng = gapRoll.state
  return { kind: kindRoll.value, y: yRoll.value, gap: gapRoll.value }
}

function spawnMain(s: GameState, cfg: LevelConfig, speed: number): void {
  const boss = s.bossUntil > 0
  const at = s.distance + s.scroll
  if (cfg.fanOut && !boss && at >= s.nextGateAt - FAN_CLEAR_PX) {
    // Quiet run-up to the gate; the gate itself appears once, at nextGateAt.
    if (at >= s.nextGateAt && !s.entities.some((e) => e.kind === 'fanout')) {
      s.entities.push({ id: s.nextId, kind: 'fanout', x: SPAWN_X, y: 0, w: GATE_W, h: GROUND_Y, taken: false })
      s.nextId += 1
    }
    return
  }
  const weights = boss ? cfg.bossWeights : cfg.weights
  while (s.scroll >= s.nextSpawnAt) {
    const r = roll(s)
    s.entities.push(spawn(chooseKind(weights, r.kind), s.nextId, SPAWN_X, r.y))
    s.nextId += 1
    s.nextSpawnAt += (MIN_GAP + r.gap * GAP_RANGE) * (boss ? BOSS_GAP_SCALE : 1) * (speed / 4)
  }
}

function spawnLanes(s: GameState, cfg: LevelConfig, speed: number): void {
  const fan = s.fan
  if (!fan) return
  // Stop early enough that everything spawned passes the hats, plus a clear run-out, before the merge.
  if ((fan.until - s.tick) * speed <= LANE_SPAWN_X - PLAYER_X + FAN_CLEAR_PX) return
  for (const lane of fan.lanes) {
    while (s.scroll >= lane.nextSpawnAt) {
      const r = roll(s)
      lane.entities.push(spawn(chooseKind(cfg.laneWeights, r.kind), s.nextId, LANE_SPAWN_X, r.y))
      s.nextId += 1
      lane.nextSpawnAt += (MIN_GAP + r.gap * GAP_RANGE) * (speed / 4)
    }
  }
}

function enterGate(s: GameState, cfg: LevelConfig, events: OutcomeEvent[]): void {
  const gate = s.entities.find((e) => e.kind === 'fanout')
  if (!gate || gate.x > PLAYER_X || !cfg.fanOut) return
  s.fan = {
    until: s.tick + cfg.fanOut.ticks,
    lanes: Array.from({ length: FAN_LANES }, () => ({ player: { ...s.player }, entities: [], nextSpawnAt: s.scroll + FAN_CLEAR_PX, coins: 0 })),
  }
  s.entities = []
  events.push({ type: 'FanOut', tick: s.tick, hash: 0 })
}

function fanIn(s: GameState, cfg: LevelConfig, events: OutcomeEvent[]): void {
  const fan = s.fan
  if (!fan) return
  s.player = { ...fan.lanes[MERGE_LANE].player }
  s.entities = []
  events.push({ type: 'FanIn', tick: s.tick, hash: 0, results: fan.lanes.map((l) => l.coins) })
  s.fan = null
  // The next gate is measured from the merge, so fan-outs never follow each other directly.
  s.nextGateAt = s.distance + s.scroll + (cfg.fanOut?.everyPx ?? Number.POSITIVE_INFINITY)
  s.nextSpawnAt = s.scroll + FAN_CLEAR_PX
}

function pickup(s: GameState, cfg: LevelConfig, e: Entity, lane: Lane | null, ports: Ports, events: OutcomeEvent[]): void {
  e.taken = true
  if (e.kind === 'coin') {
    s.score += s.multiplier
    if (lane) lane.coins += 1
    if (cfg.shieldEnabled) s.shield = Math.min(SHIELD_FULL, s.shield + 1)
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

function collide(s: GameState, cfg: LevelConfig, ports: Ports, events: OutcomeEvent[]): void {
  let hitDone = false
  const lanes = s.fan?.lanes ?? null
  tracks(s).forEach((t, i) => {
    const p = t.player
    const height = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
    const box: Box = { x: PLAYER_X, y: p.y - height, w: PLAYER_W, h: height }
    const hazardBox: Box = { ...box, x: box.x + HAZARD_INSET_X, w: box.w - 2 * HAZARD_INSET_X }
    if (!hitDone && p.y >= GROUND_Y + PIT_HIT_DEPTH) {
      resolveHit(s, cfg, p, undefined, true, events)
      hitDone = true
    }
    for (const e of t.entities) {
      if (s.status !== 'running') return
      if (e.taken || e.kind === 'pit' || e.kind === 'fanout') continue
      const rack = RACKS.has(e.kind)
      if (!overlaps(rack ? hazardBox : box, e)) continue
      if (rack) {
        if (!hitDone) resolveHit(s, cfg, p, e, false, events)
        hitDone = true
        continue
      }
      pickup(s, cfg, e, lanes ? lanes[i] : null, ports, events)
    }
  })
}

/** Advances exactly one 1/60 s tick. Pure: same (prev, inputs, port values) → same result. */
export function step(prev: GameState, inputs: readonly InputKind[], ports: Ports, levels: LevelTable = LEVELS): StepResult {
  if (prev.status !== 'running') return { state: prev, events: [] }
  const cfg = levels[prev.level]
  const s = clone(prev)
  const events: OutcomeEvent[] = []

  if (s.multiplier > 1 && s.tick >= s.multUntil) s.multiplier = 1
  for (const input of inputs) {
    if (input === 'resume') s.graceUntil = Math.max(s.graceUntil, s.tick + GRACE_RESUME)
    else if (input === 'retry') {
      s.retries = Math.max(0, s.retries - 1)
      s.graceUntil = Math.max(s.graceUntil, s.tick + GRACE_RETRY)
    }
  }
  for (const t of tracks(s)) movePlayer(t.player, inputs, s.tick, t.entities)

  const speed = speedAt(cfg, s.elapsed)
  s.scroll += speed
  for (const t of tracks(s)) scrollTrack(t, speed)
  if (s.fan) spawnLanes(s, cfg, speed)
  else {
    spawnMain(s, cfg, speed)
    enterGate(s, cfg, events)
  }

  collide(s, cfg, ports, events)

  if (s.fan && s.status === 'running' && s.tick + 1 >= s.fan.until) fanIn(s, cfg, events)
  if (s.status === 'running' && !s.fan && s.distance + s.scroll >= cfg.length) s.status = 'levelDone'
  s.tick += 1
  s.elapsed += 1
  const hash = hashState(s)
  return { state: s, events: events.map((e) => ({ ...e, hash })) }
}
