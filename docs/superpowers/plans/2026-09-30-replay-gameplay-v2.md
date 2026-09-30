# REPLAY gameplay v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the REPLAY easter egg more fun and more "durable execution": survivable hits (circuit breaker → ×3 boost → RetryPolicy rewind), modern runner movement, new obstacles, a fan-out level, level-end replay montages, a daily seed and shareable run codes.

**Architecture:** Every gameplay rule is added to the pure engine (`engine/step.ts` + `GameState`, covered by `hashState`), so crash replay stays exact. The runtime (`runtime/game.ts`) gains a rewind buffer, runtime-generated history inputs (`OrchestratorStarted`, `RetryAttempt`), a montage phase, and a *tape* that records the outside world (inputs by live tick, quantised random values, save resumes). That makes the whole `Game` reproducible, which is what powers share-a-run.

**Tech Stack:** TypeScript, React 19, Canvas 2D, Vitest + Testing Library (jsdom). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-30-replay-gameplay-v2-design.md` (builds on `docs/superpowers/specs/2026-09-29-replay-easter-egg-design.md`).

## Global Constraints

- Browser-only: no calls to the dashboard API, daprd or any state store. The only writes are the game's own `localStorage` keys (`devdash.replay.save`, `devdash.replay.best`, new `devdash.replay.daily`).
- No new dependencies. Plain TypeScript + Canvas 2D; compression uses the built-in `CompressionStream('deflate-raw')`.
- `engine/` stays pure: `engine/purity.test.ts` bans `Math.random`, `Date`, `performance`, `window`, `document`, `localStorage` in engine code (comments and strings excepted).
- Canvas colours come only from palette slots (`render/palette.ts` → `theme.css` tokens). Reuse existing slots; `rgba(...)` shading literals follow the existing `props.ts` style.
- Keep all game code in `web/src/pages/replay/`.
- Save format becomes `version: 2`; a v1 or corrupt save reads as "no save".
- Daily seed uses the **UTC** date `YYYY-MM-DD`; `seedForDate(date)` = FNV-1a over `replay:${date}`.
- Run codes are prefixed `RPL1.`; codes longer than 256 KB are rejected.
- Telemetry action names: `replay_share_copy`, `replay_watch`.
- The TypeScript lib is ES2021: no `Array.prototype.at`, `findLast` or other ES2022+ APIs (tests included).
- Gates for every task: `cd web && npx vitest run src/pages/replay` green, **and** `cd web && npx tsc -b` clean (vitest does not typecheck, including test files). Final task: `make test` and `cd web && npm run build`.
- Work in the worktree `/Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/replay-gameplay-v2` on branch `worktree-replay-gameplay-v2`. Subagents start in the main repo cwd: use absolute paths and check `git branch --show-current` before committing.

## Review Focus

1. **A hit in the first ticks of a segment** (the rewind buffer only holds the tick-0 anchor): the rewind must land on the anchor, spend a retry and resume with grace. It must not crash or loop. Test in Task 7.
2. **A run code pasted with whitespace or line breaks** (chat apps wrap long strings): decoding strips whitespace before validating. Test in Task 16.
3. **Tab closed during a rewind or a montage, then reopened**: the resume prompt appears and resuming lands in a playable state: the retry applied exactly once after a rewind, and tick 0 of the next level after a montage. Test in Task 7 (rewind) and Task 12 (montage).
4. **Slide key held through a retry rewind**: on returning to `playing` the slide state matches the key, and the matching input is recorded, so replay stays exact. Test in Task 7.
5. **Clipboard write rejected** (permissions, non-secure context): the run code is shown in a read-only, pre-selected textarea instead. Test in Task 17.

---

## File map

| File | Change | Responsibility |
|---|---|---|
| `engine/types.ts` | modify | State model: new player/entity/state fields, levels 0–5, new inputs and history events |
| `engine/step.ts` | modify | Movement (variable jump, coyote, buffer, pit support), new obstacles, hit chain, fan-out |
| `engine/levels.ts` | modify | Level table 0–5, `retries`, `shieldEnabled`, `laneWeights`, `fanOut` |
| `engine/hash.ts` | modify | Hash every new field |
| `engine/replay.ts` | modify | Feed `OrchestratorStarted`/`RetryAttempt` as inputs; `'retry'` counts as divergence |
| `engine/seed.ts` | create | `seedForDate(date)` (pure) |
| `runtime/types.ts` | modify | New phases (`rewinding`, `montage`), stats, commands, `Save` v2 |
| `runtime/keys.ts` | modify | Jump key release → `jumpEnd` |
| `runtime/rewind.ts` | create | Rewind ring buffer + safe-spot picking |
| `runtime/montage.ts` | create | Segment bookkeeping + montage replayer driver |
| `runtime/tape.ts` | create | `Tape` type, recorder/playback random sources, validation |
| `runtime/share.ts` | create | Run code encode/decode (`RPL1.` + deflate-raw + base64url) |
| `runtime/daily.ts` | create | `utcDate()` |
| `runtime/game.ts` | modify | Hit/rewind flow, system inputs, montage, daily seed, tape recording and playback |
| `runtime/persistence.ts` | modify | Save v2 validation, daily best |
| `render/canvas.ts` | modify | Ground gaps, HUD row, grace blink, rewind/montage/playback overlays, fan-out strips |
| `render/props.ts` | modify | Pit, tall/falling racks, debris, fan-out gate sprites |
| `HistoryPanel.tsx`, `Overlay.tsx`, `Replay.tsx` | modify | New events, stats, Copy run code / Watch a run, deps wiring |
| `testing.ts` | modify | `makeLevels` covers new config fields and level 5 |

All paths below are relative to `web/src/pages/replay/` unless they start with `web/` or `docs/`.

---

# Phase 1 — Movement feel and new obstacles

### Task 1: State model v2

Adds the new state fields every later task relies on, hashes them, and bumps the save version. Behaviour doesn't change yet.

**Files:**
- Modify: `engine/types.ts`, `engine/step.ts` (`initialState`, `continueAsNew`), `engine/hash.ts`, `runtime/persistence.ts`, `runtime/types.ts`, `runtime/game.ts` (StartInput literals)
- Test: `engine/hash.test.ts`, `engine/step.test.ts`, `runtime/persistence.test.ts`
- Fixture updates: every `StartInput` literal (`grep -rn "boss: \(false\|true\) }" web/src/pages/replay`) and every `Player` literal (`grep -rn "sliding: \(false\|true\) }" web/src/pages/replay`)

**Interfaces:**
- Produces:
  - `Player { y; vy; sliding; jumpHeld: boolean; coyoteUntil: number; jumpBufferUntil: number }`
  - `Entity.vy?: number` (only `'falling'` uses it)
  - `StartInput { ...v1; retries: number; shield: number }`
  - `GameState { ...v1; retries: number; shield: number; graceUntil: number; failedAt: number; status: 'running' | 'failed' | 'levelDone' | 'retry' }`
  - `newPlayer(): Player` exported from `engine/step.ts`
  - `SAVE_VERSION = 2`, `Save.version: 2`

- [ ] **Step 1: Write the failing tests**

In `engine/hash.test.ts`, extend the fixture and the mutation table:

```ts
function state(): GameState {
  return {
    level: 1, tick: 10, elapsed: 10, rng: 12345, score: 3, multiplier: 1, multUntil: 0,
    player: { y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 },
    scroll: 40, distance: 0, nextSpawnAt: 240, nextId: 2,
    entities: [{ id: 1, kind: 'coin', x: 300, y: GROUND_Y - 30, w: 10, h: 10, taken: false }],
    bossUntil: 0, status: 'running',
    retries: 3, shield: 0, graceUntil: 0, failedAt: 0,
  }
}
```

and add these rows to the `it.each` table:

```ts
    ['retries', (s: GameState) => { s.retries -= 1 }],
    ['shield', (s: GameState) => { s.shield += 1 }],
    ['grace', (s: GameState) => { s.graceUntil = 60 }],
    ['failedAt', (s: GameState) => { s.failedAt = 9 }],
    ['jumpHeld', (s: GameState) => { s.player.jumpHeld = true }],
    ['coyote', (s: GameState) => { s.player.coyoteUntil = 5 }],
    ['jump buffer', (s: GameState) => { s.player.jumpBufferUntil = 5 }],
    ['entity vy', (s: GameState) => { s.entities[0].vy = 1.5 }],
    ['retry status', (s: GameState) => { s.status = 'retry' }],
```

In `engine/step.test.ts`, change `start` to include `retries: 0, shield: 0`, update the `initialState` player expectation, and add:

```ts
  it('starts with the retries and shield charge of its start input, and no grace', () => {
    const s = initialState({ ...start, retries: 3, shield: 7 })
    expect(s).toMatchObject({ retries: 3, shield: 7, graceUntil: 0, failedAt: 0 })
    expect(s.player).toEqual({ y: GROUND_Y, vy: 0, sliding: false, jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0 })
  })
```

and in `describe('continueAsNew')`:

```ts
  it('carries retries and the shield charge, unless patched', () => {
    const s = { ...initialState(start), retries: 2, shield: 6 }
    expect(continueAsNew(s)).toMatchObject({ retries: 2, shield: 6 })
    expect(continueAsNew(s, { retries: 3 })).toMatchObject({ retries: 3, shield: 6 })
  })
```

In `runtime/persistence.test.ts`, change `sample` to `version: 2` and add `retries: 3, shield: 0` to its `start`. Then add:

```ts
  it('treats a version-1 save as no save', () => {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ ...sample, version: 1 }))
    expect(localSaveStore().load()).toBeNull()
  })

  it('rejects a save whose start input lacks retries or shield', () => {
    const { retries: _r, ...start } = sample.start
    expect(parseSave(JSON.stringify({ ...sample, start }))).toBeNull()
  })
```

- [ ] **Step 2: Run the tests to check they fail**

Run: `cd web && npx vitest run src/pages/replay/engine/hash.test.ts src/pages/replay/engine/step.test.ts src/pages/replay/runtime/persistence.test.ts`
Expected: FAIL. The new hash rows don't change the hash, `initialState` lacks the fields, and the v1 save is still accepted.

- [ ] **Step 3: Implement**

`engine/types.ts`, replacing the `Entity`, `Player`, `StartInput` and `GameState` declarations:

```ts
export interface Entity {
  id: number
  kind: EntityKind
  /** Left edge, screen px. */
  x: number
  /** Top edge, screen px. */
  y: number
  w: number
  h: number
  taken: boolean
  /** Vertical speed; only falling racks move vertically. */
  vy?: number
}

export interface Player {
  /** Feet position; GROUND_Y when standing. */
  y: number
  vy: number
  sliding: boolean
  /** A jump key is down: releasing it early cuts the jump short. */
  jumpHeld: boolean
  /** The player can still jump while tick < coyoteUntil after walking off an edge. */
  coyoteUntil: number
  /** A jump pressed in the air fires on landing while tick < jumpBufferUntil. */
  jumpBufferUntil: number
}

/** The input a history segment starts from (a new run, a level, continue-as-new). */
export interface StartInput {
  level: Level
  seed: number
  score: number
  /** Ticks already spent in this level, drives the level-4 speed ramp. */
  elapsed: number
  /** Distance (px) already travelled in this level by earlier segments. */
  distance: number
  /** True when this segment is the NonDeterministicError boss phase. */
  boss: boolean
  /** RetryPolicy attempts left in this level. */
  retries: number
  /** Circuit-breaker charge (coins), 0..SHIELD_FULL. */
  shield: number
}
```

In `GameState`, add after `bossUntil`:

```ts
  /** RetryPolicy attempts left in this level. */
  retries: number
  /** Circuit-breaker charge, 0..SHIELD_FULL. */
  shield: number
  /** Hits are ignored while tick < graceUntil. */
  graceUntil: number
  /** Tick of the hit that set status 'retry'; 0 otherwise. */
  failedAt: number
  status: 'running' | 'failed' | 'levelDone' | 'retry'
```

(replacing the old `status` line).

`engine/step.ts`:

```ts
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
```

(add `Player` to the type import from `./types`).

`engine/hash.ts`:

```ts
const STATUS: Record<GameState['status'], number> = { running: 0, failed: 1, levelDone: 2, retry: 3 }

export function hashState(s: GameState): number {
  const p = s.player
  const parts: number[] = [
    s.level, s.tick, s.elapsed, s.rng, q(s.score), s.multiplier, s.multUntil,
    q(p.y), q(p.vy), p.sliding ? 1 : 0, p.jumpHeld ? 1 : 0, p.coyoteUntil, p.jumpBufferUntil,
    q(s.scroll), q(s.distance), q(s.nextSpawnAt), s.nextId, s.bossUntil, STATUS[s.status],
    s.retries, s.shield, s.graceUntil, s.failedAt, s.entities.length,
  ]
  for (const e of s.entities) parts.push(e.id, KIND[e.kind], q(e.x), q(e.y), q(e.vy ?? 0), e.taken ? 1 : 0)
  // ...FNV-1a loop unchanged
```

`runtime/types.ts`: `version: 2` in `Save`.

`runtime/persistence.ts`:

```ts
export const SAVE_VERSION = 2

function isStart(v: unknown): v is StartInput {
  return (
    isObj(v) && [0, 1, 2, 3, 4].includes(v.level as number) &&
    isNum(v.seed) && isNum(v.score) && isNum(v.elapsed) && isNum(v.distance) && typeof v.boss === 'boolean' &&
    isNum(v.retries) && v.retries >= 0 && isNum(v.shield) && v.shield >= 0
  )
}
```

`runtime/game.ts`: add `retries: 0, shield: 0` to the three `StartInput` literals (the `start` field initialiser, `newRun`, and the `'lost'` → level 1 branch). Task 5 replaces the zeros with level values. In `save()`, write `version: 2`.

Then fix every remaining `StartInput` and `Player` literal the two greps list (tests included) by adding `retries: 0, shield: 0` and `jumpHeld: false, coyoteUntil: 0, jumpBufferUntil: 0` respectively.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: all PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): extend the game state for retries, shield, grace and jump feel"
```

---

### Task 2: Pits, tall racks and falling racks (engine)

**Files:**
- Modify: `engine/types.ts` (`EntityKind`), `engine/step.ts`, `engine/hash.ts` (`KIND`), `render/canvas.ts` (`drawEntity` routing, so `tsc` stays green)
- Test: `engine/step.test.ts`

**Interfaces:**
- Consumes: Task 1 `Player`, `Entity.vy`
- Produces:
  - `EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate' | 'tall' | 'falling' | 'pit'`
  - exported constants `PIT_HIT_DEPTH = 14`, `FALL_LEAD_TICKS = 60` (a falling rack drops one second before it would reach the hat), `RACK_GRAVITY = 1`, `RACKS: ReadonlySet<EntityKind>` (`low`, `high`, `tall`, `falling`), `HAZARDS: ReadonlySet<EntityKind>` (`RACKS` + `pit`)
  - `overPit(entities: readonly Entity[]): Entity | undefined`: the untaken pit under the player's foot centre
  - `movePlayer(p: Player, inputs: readonly InputKind[], tick: number, entities: readonly Entity[]): void` (mutates `p`; later tasks extend it)

- [ ] **Step 1: Write the failing tests**

Add to `engine/step.test.ts`:

```ts
import { FALL_LEAD_TICKS, HAZARDS, PIT_HIT_DEPTH, RACKS, overPit } from './step'

/** A pit whose span covers the player's foot centre after this tick's scroll (speed 4). */
function withPit(w = 40): GameState {
  const s = initialState(start)
  const foot = PLAYER_X + PLAYER_W / 2
  return { ...s, entities: [{ id: 50, kind: 'pit', x: foot - 10 + 4, y: GROUND_Y, w, h: 0, taken: false }] }
}

describe('pits', () => {
  it('drops the player when the foot centre is over a pit', () => {
    const s = step(withPit(), [], ports(), levels).state
    expect(s.player.y).toBeGreaterThan(GROUND_Y)
    expect(s.status).toBe('running')
  })

  it('fails once the player has fallen PIT_HIT_DEPTH into the pit', () => {
    let s = withPit(200)
    for (let i = 0; i < 30 && s.status === 'running'; i++) s = step(s, [], ports(), levels).state
    expect(s.status).toBe('failed')
    expect(s.player.y).toBeGreaterThanOrEqual(GROUND_Y + PIT_HIT_DEPTH)
  })

  it('jumps over a pit', () => {
    let s = { ...initialState(start), entities: [{ id: 50, kind: 'pit' as const, x: 200, y: GROUND_Y, w: 50, h: 0, taken: false }] }
    for (let i = 0; i < 200 && s.status === 'running' && s.entities.length > 0; i++) {
      const gap = s.entities[0].x - (PLAYER_X + PLAYER_W)
      s = step(s, s.player.y === GROUND_Y && gap > 0 && gap <= 12 ? ['jump'] : [], ports(), levels).state
    }
    expect(s.status).toBe('running')
    expect(s.player.y).toBe(GROUND_Y)
  })

  it('finds the pit under the foot centre only', () => {
    const foot = PLAYER_X + PLAYER_W / 2
    const pit = { id: 1, kind: 'pit' as const, x: foot - 5, y: GROUND_Y, w: 10, h: 0, taken: false }
    expect(overPit([pit])?.id).toBe(1)
    expect(overPit([{ ...pit, x: foot + 1 }])).toBeUndefined()
  })
})

describe('tall and falling racks', () => {
  it('classifies racks and hazards', () => {
    expect([...RACKS].sort()).toEqual(['falling', 'high', 'low', 'tall'])
    expect(HAZARDS.has('pit')).toBe(true)
    expect(HAZARDS.has('coin')).toBe(false)
  })

  it('fails on a tall rack when standing', () => {
    expect(step(withEntity('tall', GROUND_Y - 44, 16, 44), [], ports(), levels).state.status).toBe('failed')
  })

  it('keeps a falling rack hanging until it is one second away, then lands it well ahead of the player', () => {
    // speed 4: the drop starts FALL_LEAD_TICKS * 4 = 240 px ahead of PLAYER_X.
    const rack = { id: 7, kind: 'falling' as const, x: PLAYER_X + FALL_LEAD_TICKS * 4 + 40, y: -24, w: 18, h: 24, taken: false, vy: 0 }
    let s: GameState = { ...initialState(start), entities: [rack] }
    s = step(s, [], ports(), levels).state
    expect(s.entities[0].y).toBe(-24)
    for (let i = 0; i < 12; i++) s = step(s, [], ports(), levels).state
    expect(s.entities[0].y).toBeGreaterThan(-24)
    for (let i = 0; i < 30; i++) s = step(s, [], ports(), levels).state
    const landed = s.entities.find((e) => e.id === 7)!
    expect(landed.y + landed.h).toBe(GROUND_Y)
    expect(landed.x - PLAYER_X).toBeGreaterThan(80)
    expect(s.status).toBe('running')
  })

  it('spawns pits 30–60 px wide at ground level', () => {
    const table = makeLevels({ weights: { pit: 1, low: 1 } })
    let s = initialState(start)
    const seen: Entity[] = []
    for (let i = 0; i < 3000; i++) {
      s = step(s, [], ports(), table).state
      for (const e of s.entities) if (!seen.some((x) => x.id === e.id)) seen.push({ ...e })
      if (s.status !== 'running') s = { ...s, status: 'running', player: { ...s.player, y: GROUND_Y, vy: 0 } }
    }
    const pits = seen.filter((e) => e.kind === 'pit')
    expect(pits.length).toBeGreaterThan(3)
    for (const p of pits) {
      expect(p.w).toBeGreaterThanOrEqual(30)
      expect(p.w).toBeLessThanOrEqual(60)
      expect(p.y).toBe(GROUND_Y)
    }
  })
})
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/engine/step.test.ts`
Expected: FAIL (the new exports don't exist; `'pit'` isn't an `EntityKind`).

- [ ] **Step 3: Implement**

`engine/types.ts`:

```ts
export type EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate' | 'tall' | 'falling' | 'pit'
```

`engine/hash.ts`:

```ts
const KIND: Record<EntityKind, number> = { low: 1, high: 2, coin: 3, orb: 4, crate: 5, tall: 6, falling: 7, pit: 8 }
```

`engine/step.ts`: add the constants and sizes, then replace the player-physics and collision blocks of `step`:

```ts
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
```

(add `Entity`, `Player` to the type import.) In `step`, replace the old input loop and gravity block with:

```ts
  movePlayer(p, inputs, s.tick, s.entities)
```

In the scroll block:

```ts
  for (const e of s.entities) {
    e.x -= speed
    updateFalling(e, speed)
  }
```

Replace the entity-creation line in the spawn loop with:

```ts
    s.entities.push(spawn(kind, s.nextId, SPAWN_X, yRoll.value))
```

Replace the collision block with:

```ts
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
    // ...pickup branches unchanged (coin / orb / crate)
  }
```

`render/canvas.ts` must route the new kinds now, or `pal[kind]` in `drawEntity` stops typechecking. Put this right after the coin branch (Task 4 adds the pit and falling-rack sprites):

```ts
  if (kind === 'pit') return
  if (kind === 'low' || kind === 'high' || kind === 'tall' || kind === 'falling') {
    drawRack(ctx, e, pal, elapsed, reducedMotion)
    return
  }
```

(It replaces the existing `low`/`high` branch.)

Pits are 0 px tall, so `overlaps` never matches them anyway; the explicit skip documents that. Coins can never sit directly above a pit: `MIN_GAP` (150 px) is wider than the widest pit (60 px), so consecutive spawns never overlap.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS. The v1 tests "jumps, rises and lands again" and "ignores a jump while airborne" still pass, because with no pits `movePlayer` matches v1 physics.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay/engine
git commit -m "feat(replay): add pits, tall racks and falling racks to the engine"
```

---

### Task 3: Variable jump height, coyote time and jump buffering

**Files:**
- Modify: `engine/types.ts` (`InputKind`, `PlayerInput`), `engine/step.ts` (`movePlayer`), `runtime/types.ts` (`Command`), `runtime/keys.ts`, `runtime/game.ts` (`command`), `runtime/persistence.ts` (`isEvent`), `HistoryPanel.tsx` (no change needed: `detail: e.kind`)
- Test: `engine/step.test.ts`, `runtime/keys.test.ts`, `runtime/game.test.ts`, `runtime/persistence.test.ts`

**Interfaces:**
- Consumes: Task 2 `movePlayer`, `overPit`
- Produces:
  - `type PlayerInput = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd'`; `type InputKind = PlayerInput` for now (Task 5 adds `'resume' | 'retry'`)
  - History `Input.kind: PlayerInput`
  - `Command` gains `'jumpEnd'`
  - Constants `COYOTE_TICKS = 6`, `JUMP_BUFFER_TICKS = 6`, `JUMP_CUT_VY = -3`

- [ ] **Step 1: Write the failing tests**

`engine/step.test.ts`:

```ts
import { COYOTE_TICKS, JUMP_BUFFER_TICKS, JUMP_CUT_VY } from './step'

/** Highest point (px above the ground) of a jump released after `holdTicks` (Infinity = never). */
function apex(holdTicks: number): number {
  let s = step(initialState(start), ['jump'], ports(), levels).state
  let top = GROUND_Y - s.player.y
  for (let i = 1; i < 60 && s.player.y < GROUND_Y; i++) {
    s = step(s, i === holdTicks ? ['jumpEnd'] : [], ports(), levels).state
    top = Math.max(top, GROUND_Y - s.player.y)
  }
  return top
}

describe('jump feel', () => {
  it('cuts the jump short when the key is released early', () => {
    expect(apex(Infinity)).toBeGreaterThanOrEqual(76)
    expect(apex(1)).toBeLessThan(25)
    const tap = apex(6)
    expect(tap).toBeGreaterThan(40)
    expect(tap).toBeLessThan(56)
  })

  it('caps upward speed at JUMP_CUT_VY on release and leaves a falling hat alone', () => {
    const up = step(initialState(start), ['jump'], ports(), levels).state
    expect(step(up, ['jumpEnd'], ports(), levels).state.player.vy).toBe(JUMP_CUT_VY + 0.5)
    let falling = up
    while (falling.player.vy < 0) falling = step(falling, [], ports(), levels).state
    const vy = falling.player.vy
    expect(step(falling, ['jumpEnd'], ports(), levels).state.player.vy).toBe(vy + 0.5)
  })

  it('allows a jump for COYOTE_TICKS after walking off an edge', () => {
    let s = withPit(200)
    s = step(s, [], ports(), levels).state // walks off: now falling
    expect(s.player.y).toBeGreaterThan(GROUND_Y)
    for (let i = 1; i < COYOTE_TICKS - 1; i++) s = step(s, [], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state
    expect(s.player.vy).toBeLessThan(0)
  })

  it('does not allow a coyote jump after COYOTE_TICKS', () => {
    let s = withPit(200)
    for (let i = 0; i < COYOTE_TICKS; i++) s = step(s, [], ports(), levels).state
    expect(s.status).toBe('running') // still falling, not yet at pit-hit depth
    s = step(s, ['jump'], ports(), levels).state
    expect(s.player.vy).toBeGreaterThan(0)
  })

  it('buffers a jump pressed just before landing and fires it on landing', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    while (s.player.y < GROUND_Y - 6 || s.player.vy < 0) s = step(s, [], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state // still airborne: buffered
    for (let i = 0; i < JUMP_BUFFER_TICKS && s.player.vy >= 0; i++) s = step(s, [], ports(), levels).state
    expect(s.player.vy).toBeLessThan(0)
  })

  it('drops a buffered jump that is older than JUMP_BUFFER_TICKS', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    s = step(s, ['jump'], ports(), levels).state // far from the ground
    while (s.player.y < GROUND_Y) s = step(s, [], ports(), levels).state
    expect(s.player.vy).toBe(0)
  })
})
```

`runtime/keys.test.ts`:

```ts
  it('maps releasing a jump key to jumpEnd', () => {
    for (const key of [' ', 'ArrowUp', 'w', 'W']) expect(keyToCommand({ key, repeat: false }, false)).toBe('jumpEnd')
  })
```

`runtime/game.test.ts`:

```ts
  it('records a jump release as an Input event', () => {
    const game = new Game(deps())
    play(game)
    game.command('jump')
    game.frame(1)
    game.command('jumpEnd')
    game.frame(1)
    expect(game.history.slice(0, 2)).toEqual([
      { type: 'Input', tick: 0, kind: 'jump' },
      { type: 'Input', tick: 1, kind: 'jumpEnd' },
    ])
  })
```

`runtime/persistence.test.ts`: add `{ type: 'Input', tick: 4, kind: 'jumpEnd' }` to `sample.history` after the jump (the round-trip test then covers it).

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL (the constants aren't exported; `jumpEnd` isn't a kind; the key release maps to `null`).

- [ ] **Step 3: Implement**

`engine/types.ts`:

```ts
/** Keys the player presses. */
export type PlayerInput = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd'
/** Everything step() accepts as an input. */
export type InputKind = PlayerInput
```

and `{ type: 'Input'; tick: number; kind: PlayerInput }` in `HistoryEvent`.

`engine/step.ts`: add the constants and replace `movePlayer`:

```ts
export const COYOTE_TICKS = 6
export const JUMP_BUFFER_TICKS = 6
export const JUMP_CUT_VY = -3

export function movePlayer(p: Player, inputs: readonly InputKind[], tick: number, entities: readonly Entity[]): void {
  const pit = overPit(entities)
  const standing = p.y === GROUND_Y && p.vy === 0 && !pit
  for (const input of inputs) {
    if (input === 'jump') {
      p.jumpHeld = true
      if (standing || tick < p.coyoteUntil) launch(p)
      else p.jumpBufferUntil = tick + JUMP_BUFFER_TICKS
    } else if (input === 'jumpEnd') {
      p.jumpHeld = false
      if (p.vy < JUMP_CUT_VY) p.vy = JUMP_CUT_VY
    } else if (input === 'slideStart' || input === 'slideEnd') {
      p.sliding = input === 'slideStart'
    }
  }
  if (p.y === GROUND_Y && p.vy === 0 && !pit) return
  // Walking off an edge (not jumping) opens the coyote window once.
  if (p.y === GROUND_Y && p.vy === 0) p.coyoteUntil = tick + COYOTE_TICKS
  const before = p.y
  p.vy += GRAVITY
  p.y += p.vy
  if (p.vy >= 0 && before <= GROUND_Y && p.y >= GROUND_Y && !overPit(entities)) {
    p.y = GROUND_Y
    p.vy = 0
    if (tick < p.jumpBufferUntil) launch(p)
  }
}
```

`launch` already clears `coyoteUntil`, so a coyote jump can't be repeated in the same window. A buffered jump fires in the landing tick: `vy` becomes `JUMP_VY` and `y` stays at `GROUND_Y`, so the hat rises on the next tick.

`runtime/types.ts`: `export type Command = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd' | 'pause' | 'confirm' | 'cancel'`.

`runtime/keys.ts`, at the top of `keyToCommand`:

```ts
  if (!down) {
    if (key === 'ArrowDown' || key === 's') return 'slideEnd'
    if (key === ' ' || key === 'ArrowUp' || key === 'w') return 'jumpEnd'
    return null
  }
```

`runtime/game.ts`, in `command()` `case 'playing'`:

```ts
        } else if (c === 'jump' || c === 'jumpEnd' || c === 'slideStart' || c === 'slideEnd') {
```

`runtime/persistence.ts` `isEvent`:

```ts
    case 'Input': return v.kind === 'jump' || v.kind === 'jumpEnd' || v.kind === 'slideStart' || v.kind === 'slideEnd'
```

`Replay.tsx` needs no change: `onKeyUp` already forwards every non-null command.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): variable jump height, coyote time and jump buffering"
```

---

### Task 4: Draw the new obstacles and put them in the levels

**Files:**
- Modify: `render/canvas.ts` (`drawGround`, `drawEntity`), `render/props.ts` (`drawRack`, new `drawPit`, `drawFallShadow`), `engine/levels.ts` (weights)
- Test: `render/canvas.test.ts`, `render/props.test.ts`, `engine/levels.test.ts`

**Interfaces:**
- Consumes: Task 2 entity kinds
- Produces: `drawPit(ctx, e, pal)`, `drawFallShadow(ctx, e, pal)` in `render/props.ts`; `drawRack` handles `tall` and `falling`

- [ ] **Step 1: Write the failing tests**

`render/canvas.test.ts`:

```ts
  it('leaves a gap in the ground line over a pit', () => {
    const { ctx, calls } = mockCtx()
    const s = { ...initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 0, shield: 0 }),
      entities: [{ id: 1, kind: 'pit' as const, x: 200, y: GROUND_Y, w: 40, h: 0, taken: false }] }
    render(ctx, view({ kind: 'playing' }, s), pal)
    const groundLines = calls.filter((c) => c.name === 'fillRect' && c.fill === pal.ground && c.args[1] === GROUND_Y && c.args[3] === 2)
    expect(groundLines.length).toBe(2)
    const [a, b] = groundLines.map((c) => c.args as number[])
    expect(a[0] + a[2]).toBe(200)
    expect(b[0]).toBe(240)
  })
```

`render/props.test.ts` (use the file's existing mock ctx helper and palette):

```ts
  it('draws a falling rack hanging from the top edge with a ground warning shadow', () => {
    const { ctx, calls } = mockCtx()
    const e = { id: 3, kind: 'falling' as const, x: 300, y: -24, w: 18, h: 24, taken: false, vy: 0 }
    drawFallShadow(ctx, e, pal)
    expect(calls.some((c) => c.name === 'ellipse')).toBe(true)
  })

  it('draws a pit as a dark shaft below the ground line', () => {
    const { ctx, calls } = mockCtx()
    drawPit(ctx, { id: 1, kind: 'pit', x: 100, y: GROUND_Y, w: 40, h: 0, taken: false }, pal)
    expect(calls.some((c) => c.name === 'fillRect' && (c.args as number[])[0] === 100 && (c.args as number[])[2] === 40)).toBe(true)
  })
```

`engine/levels.test.ts`:

```ts
  it('introduces pits in level 1, falling racks in level 2 and tall racks in level 3', () => {
    expect(LEVELS[0].weights.pit ?? 0).toBe(0)
    expect(LEVELS[1].weights.pit).toBeGreaterThan(0)
    expect(LEVELS[1].weights.falling ?? 0).toBe(0)
    expect(LEVELS[2].weights.falling).toBeGreaterThan(0)
    expect(LEVELS[2].weights.tall ?? 0).toBe(0)
    expect(LEVELS[3].weights.tall).toBeGreaterThan(0)
    for (const k of ['pit', 'falling', 'tall'] as const) expect(LEVELS[4].weights[k]).toBeGreaterThan(0)
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/render src/pages/replay/engine/levels.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`render/props.ts`:

```ts
/** A pit: a dark shaft under a gap in the ground line. */
export function drawPit(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  ctx.fillStyle = pal.backdrop
  ctx.fillRect(e.x, GROUND_Y, e.w, VIEW_H - GROUND_Y)
  ctx.fillStyle = SHADE
  ctx.fillRect(e.x, GROUND_Y, 2, VIEW_H - GROUND_Y)
  ctx.fillRect(e.x + e.w - 2, GROUND_Y, 2, VIEW_H - GROUND_Y)
}

/** Where a falling rack will land: a shadow that darkens as the rack drops. */
export function drawFallShadow(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  const drop = Math.max(0, Math.min(1, (e.y + e.h) / GROUND_Y))
  ctx.save()
  ctx.globalAlpha = 0.2 + 0.5 * drop
  ctx.fillStyle = pal.obstacle
  ctx.beginPath()
  ctx.ellipse(e.x + e.w / 2, GROUND_Y + 1, (e.w / 2) * (0.5 + 0.5 * drop), 2, 0, 0, TWO_PI)
  ctx.fill()
  ctx.restore()
}
```

(import `GROUND_Y, VIEW_H` from `../engine/types`). In `drawRack`, draw the hanging cable for `falling` too, from the top edge to the rack while it hangs:

```ts
  if (e.kind === 'high' || (e.kind === 'falling' && e.y + e.h < GROUND_Y)) {
```

`tall` needs nothing new: the slot, LED and vent loops scale with `e.h`.

`render/canvas.ts`:

```ts
function drawGround(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  const pits = state.entities.filter((e) => e.kind === 'pit').sort((a, b) => a.x - b.x)
  for (const p of pits) drawPit(ctx, p, pal)
  ctx.fillStyle = pal.ground
  let x = 0
  for (const p of pits) {
    if (p.x > x) ctx.fillRect(x, GROUND_Y, p.x - x, 2)
    x = Math.max(x, p.x + p.w)
  }
  if (x < VIEW_W) ctx.fillRect(x, GROUND_Y, VIEW_W - x, 2)
  const offset = state.scroll % 24
  for (let dx = -offset; dx < VIEW_W; dx += 24) {
    if (!pits.some((p) => dx + 10 > p.x && dx < p.x + p.w)) ctx.fillRect(dx, GROUND_Y + 10, 10, 2)
  }
}
```

In `drawEntity`, the rack branch from Task 2 gains the warning shadow (pits stay skipped there, because `drawGround` draws them):

```ts
  if (kind === 'low' || kind === 'high' || kind === 'tall' || kind === 'falling') {
    if (kind === 'falling' && e.y + e.h < GROUND_Y) drawFallShadow(ctx, e, pal)
    drawRack(ctx, e, pal, elapsed, reducedMotion)
    return
  }
```

`engine/levels.ts` weights (tuning knobs; the tests only pin which kinds are present):

```ts
  1: weights: { low: 3, high: 2, coin: 4, pit: 2 },
  2: weights: { low: 3, high: 2, coin: 3, orb: 2, pit: 1, falling: 2 },
  3: weights: { low: 2, high: 2, coin: 3, orb: 1, crate: 2, pit: 1, falling: 1, tall: 2 },
  4: weights: { low: 2, high: 2, coin: 3, orb: 1, crate: 1, pit: 2, falling: 1, tall: 1 },
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Playtest check**

Run `cd web && npm run dev`, open `/replay` (Konami code or direct URL) and play levels 1–4. Check that pits are visible gaps, falling racks show a shadow before they drop, tall racks need a held jump, and a quick tap still clears a low rack. Tune weights if a level feels unfair.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): draw pits, tall and falling racks and add them to the levels"
```

# Phase 2 — Safety layers: grace, circuit breaker, boost, RetryPolicy rewind

### Task 5: Hit chain, grace and runtime inputs (engine)

**Files:**
- Modify: `engine/types.ts`, `engine/step.ts`, `engine/levels.ts`, `engine/replay.ts`, `runtime/persistence.ts` (`isEvent`), `runtime/game.ts` (the `executed` count, `pending` type), `testing.ts` (`BASE`), `HistoryPanel.tsx` (its `NODE` record and `describeEvent` switch must cover every event type, or `tsc` fails)
- Test: `engine/step.test.ts`, `engine/replay.test.ts`, `runtime/persistence.test.ts`, `HistoryPanel.test.tsx`

**Interfaces:**
- Consumes: Task 1 state fields; Task 2 `RACKS`, `overPit`, `movePlayer`
- Produces:
  - `InputKind = PlayerInput | 'resume' | 'retry'`
  - new `HistoryEvent` members: `{ type: 'OrchestratorStarted'; tick }`, `{ type: 'RetryAttempt'; tick; attempt; failedAt }`, `{ type: 'CircuitBreakerTripped'; tick; id; hash }`, `{ type: 'BoostLost'; tick; id; hash }`. For pit hits `id` is `0`.
  - `type InputEvent = Extract<HistoryEvent, { type: 'Input' | 'OrchestratorStarted' | 'RetryAttempt' }>`, `type OutcomeEvent = Exclude<HistoryEvent, InputEvent>` (in `engine/types.ts`)
  - `isInputEvent(e: HistoryEvent): e is InputEvent` and `inputOf(e: InputEvent): InputKind` exported from `engine/replay.ts`
  - constants in `engine/step.ts`: `SHIELD_FULL = 10`, `GRACE_RESUME = 60`, `GRACE_RETRY = 60`, `GRACE_BOOST = 60`, `GRACE_BARGE = 30`
  - `LevelConfig.retries: number`, `LevelConfig.shieldEnabled: boolean`

- [ ] **Step 1: Write the failing tests**

`engine/step.test.ts`:

```ts
import { GRACE_BARGE, GRACE_BOOST, GRACE_RESUME, GRACE_RETRY, SHIELD_FULL } from './step'

const armed = makeLevels({ shieldEnabled: true })
const rack = (): GameState => withEntity('low', GROUND_Y - 20, 14, 20)

describe('hit chain', () => {
  it('ignores racks during grace', () => {
    const r = step({ ...rack(), graceUntil: 10 }, [], ports(), armed)
    expect(r.state.status).toBe('running')
    expect(r.events).toEqual([])
    expect(r.state.entities[0].taken).toBe(false)
  })

  it('spends an armed circuit breaker first and smashes the rack', () => {
    const r = step({ ...rack(), shield: SHIELD_FULL, multiplier: 3, multUntil: 100, retries: 3 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'running', shield: 0, multiplier: 3, retries: 3, graceUntil: GRACE_BARGE })
    expect(r.state.entities[0].taken).toBe(true)
    expect(r.events).toEqual([{ type: 'CircuitBreakerTripped', tick: 0, id: 99, hash: hashState(r.state) }])
  })

  it('has no circuit breaker in a level without one', () => {
    expect(step({ ...rack(), shield: SHIELD_FULL }, [], ports(), levels).state.status).toBe('failed')
  })

  it('loses an active boost next, keeping the rack in place', () => {
    const r = step({ ...rack(), shield: 5, multiplier: 3, multUntil: 100, retries: 3 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'running', shield: 5, multiplier: 1, retries: 3, graceUntil: GRACE_BOOST })
    expect(r.state.entities[0].taken).toBe(false)
    expect(r.events).toEqual([{ type: 'BoostLost', tick: 0, id: 99, hash: hashState(r.state) }])
  })

  it('asks the runtime for a retry next, without spending it', () => {
    const r = step({ ...rack(), retries: 2 }, [], ports(), armed)
    expect(r.state).toMatchObject({ status: 'retry', failedAt: 0, retries: 2 })
    expect(r.events).toEqual([])
  })

  it('fails when no layer is left', () => {
    expect(step({ ...rack(), retries: 0 }, [], ports(), armed).state.status).toBe('failed')
  })

  it('bounces out of a pit when a layer absorbs the fall, recording id 0', () => {
    let s: GameState = { ...withPit(200), shield: SHIELD_FULL }
    let event: OutcomeEvent | undefined
    for (let i = 0; i < 40 && !event; i++) {
      const r = step(s, [], ports(), armed)
      event = r.events.find((e) => e.type === 'CircuitBreakerTripped')
      s = r.state
    }
    expect(event).toMatchObject({ type: 'CircuitBreakerTripped', id: 0 })
    expect(s.player.vy).toBeLessThan(0)
    expect(s.status).toBe('running')
  })

  it('bounces out of a pit during grace without an event', () => {
    let s: GameState = { ...withPit(200), graceUntil: 1000 }
    let events = 0
    for (let i = 0; i < 12; i++) {
      const r = step(s, [], ports(), armed)
      events += r.events.length
      s = r.state
    }
    expect(s.status).toBe('running')
    expect(s.player.vy).toBeLessThan(0)
    expect(events).toBe(0)
  })

  it('resolves only one hit per tick', () => {
    const s = rack()
    const twin = { ...s.entities[0], id: 98 }
    const r = step({ ...s, entities: [s.entities[0], twin], shield: SHIELD_FULL, multiplier: 3, multUntil: 100 }, [], ports(), armed)
    expect(r.events.map((e) => e.type)).toEqual(['CircuitBreakerTripped'])
    expect(r.state.multiplier).toBe(3)
  })

  it('charges the circuit breaker with coins, capped at SHIELD_FULL, only where it is enabled', () => {
    const coin = withEntity('coin', GROUND_Y - 24, 10, 10)
    expect(step({ ...coin, shield: 8 }, [], ports(), armed).state.shield).toBe(9)
    expect(step({ ...coin, shield: SHIELD_FULL }, [], ports(), armed).state.shield).toBe(SHIELD_FULL)
    expect(step({ ...coin, shield: 8 }, [], ports(), levels).state.shield).toBe(8)
  })

  it("grants grace on 'resume' and spends a retry with grace on 'retry'", () => {
    const s = { ...initialState(start), retries: 3 }
    expect(step(s, ['resume'], ports(), armed).state.graceUntil).toBe(GRACE_RESUME)
    expect(step(s, ['retry'], ports(), armed).state).toMatchObject({ retries: 2, graceUntil: GRACE_RETRY })
    expect(step({ ...s, retries: 0 }, ['retry'], ports(), armed).state.retries).toBe(0)
  })
})
```

(import `OutcomeEvent` from `./types`.)

`engine/replay.test.ts`:

```ts
import { SHIELD_FULL } from './step'
import type { InputKind } from './types'

  it('replays runtime inputs and safety-layer outcomes exactly', () => {
    const levels = makeLevels({ weights: { low: 1 }, shieldEnabled: true })
    const s0: StartInput = { ...start, retries: 3, shield: SHIELD_FULL }
    const ports = { impure: () => 0.25, crateValue: () => 0.5 }
    let state = initialState(s0)
    const history: HistoryEvent[] = []
    for (let i = 0; i < 2000; i++) {
      const inputs: InputKind[] = []
      const tick = state.tick
      if (tick === 5) {
        history.push({ type: 'OrchestratorStarted', tick })
        inputs.push('resume')
      }
      if (tick === 20) {
        history.push({ type: 'RetryAttempt', tick, attempt: 1, failedAt: 19 })
        inputs.push('retry')
      }
      const r = step(state, inputs, ports, levels)
      if (r.state.status !== 'running') break
      history.push(...r.events)
      state = r.state
    }
    expect(history.some((e) => e.type === 'CircuitBreakerTripped')).toBe(true)
    const r = replay(s0, history, state.tick, () => 0.25, levels)
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(state))
    expect(r.state.retries).toBe(2)
  })

  it('treats a replay step that asks for a retry as divergence', () => {
    const levels = makeLevels({ weights: { low: 1 } })
    const s0: StartInput = { ...start, retries: 3, shield: 0 }
    // A history that recorded no hit: the replay runs into the first rack and asks for a retry.
    const r = replay(s0, [{ type: 'OrchestratorStarted', tick: 0 }], 2000, () => 0.25, levels)
    expect(r.ok).toBe(false)
  })
```

`runtime/persistence.test.ts`: extend `sample.history`, keeping it ordered by tick with every tick `< 31`:

```ts
    { type: 'OrchestratorStarted', tick: 11 },
    { type: 'BoostLost', tick: 12, id: 7, hash: 1 },
    { type: 'CircuitBreakerTripped', tick: 13, id: 8, hash: 2 },
    { type: 'RetryAttempt', tick: 14, attempt: 1, failedAt: 70 },
```

`HistoryPanel.test.tsx`:

```tsx
  it('describes the safety events', () => {
    render(
      <HistoryPanel
        history={[
          { type: 'OrchestratorStarted', tick: 1 },
          { type: 'CircuitBreakerTripped', tick: 2, id: 9, hash: 1 },
          { type: 'CircuitBreakerTripped', tick: 3, id: 0, hash: 1 },
          { type: 'BoostLost', tick: 4, id: 3, hash: 1 },
          { type: 'RetryAttempt', tick: 5, attempt: 2, failedAt: 90 },
        ]}
      />,
    )
    expect(screen.getByText('replay resumed · 1 s grace')).toBeInTheDocument()
    expect(screen.getByText('rack 9 smashed')).toBeInTheDocument()
    expect(screen.getByText('pit bridged')).toBeInTheDocument()
    expect(screen.getByText('×3 boost absorbed the hit')).toBeInTheDocument()
    expect(screen.getByText('attempt 2 · failed at t90')).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`engine/types.ts`:

```ts
export type InputKind = PlayerInput | 'resume' | 'retry'

export type HistoryEvent =
  | { type: 'Input'; tick: number; kind: PlayerInput }
  /** Recorded by the runtime whenever a replay resumes live play (grants grace). */
  | { type: 'OrchestratorStarted'; tick: number }
  /** Recorded by the runtime after a retry rewind (spends a retry, grants grace). */
  | { type: 'RetryAttempt'; tick: number; attempt: number; failedAt: number }
  | { type: 'ActivityCoinCollected'; tick: number; id: number; hash: number }
  | { type: 'ActivityCrateCollected'; tick: number; id: number; hash: number; result: number }
  | { type: 'OrbTaken'; tick: number; id: number; hash: number }
  /** id is the smashed rack, or 0 for a pit. */
  | { type: 'CircuitBreakerTripped'; tick: number; id: number; hash: number }
  | { type: 'BoostLost'; tick: number; id: number; hash: number }

/** History events that are fed back to step() as inputs. */
export type InputEvent = Extract<HistoryEvent, { type: 'Input' | 'OrchestratorStarted' | 'RetryAttempt' }>
/** Events produced by step() itself; replay checks each one. */
export type OutcomeEvent = Exclude<HistoryEvent, InputEvent>
```

`engine/levels.ts`: add to `LevelConfig`:

```ts
  /** RetryPolicy attempts per level; 0 = a hit fails the run (unless another layer absorbs it). */
  retries: number
  /** Coins charge a circuit breaker that absorbs one hit. */
  shieldEnabled: boolean
```

In `LEVELS`: level 0 gets `retries: 0, shieldEnabled: false`; levels 1–4 get `retries: 0, shieldEnabled: true`. Retries stay 0 until Task 7 adds the rewind; without it a `'retry'` status would freeze the game. `testing.ts` `BASE`: `retries: 0, shieldEnabled: false`.

`engine/step.ts`:

```ts
export const SHIELD_FULL = 10
export const GRACE_RESUME = 60
export const GRACE_RETRY = 60
export const GRACE_BOOST = 60
export const GRACE_BARGE = 30

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
```

In `step`, right after the multiplier expiry line, apply the runtime inputs:

```ts
  for (const input of inputs) {
    if (input === 'resume') s.graceUntil = Math.max(s.graceUntil, s.tick + GRACE_RESUME)
    else if (input === 'retry') {
      s.retries = Math.max(0, s.retries - 1)
      s.graceUntil = Math.max(s.graceUntil, s.tick + GRACE_RETRY)
    }
  }
```

(`movePlayer` ignores `'resume'` and `'retry'`: its branches only match player inputs.) Replace the collision block with:

```ts
  const height = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  const box: Box = { x: PLAYER_X, y: p.y - height, w: PLAYER_W, h: height }
  let hitDone = false
  if (p.y >= GROUND_Y + PIT_HIT_DEPTH) {
    resolveHit(s, cfg, p, undefined, true, events)
    hitDone = true
  }
  for (const e of s.entities) {
    if (s.status !== 'running') break
    if (e.taken || e.kind === 'pit' || !overlaps(box, e)) continue
    if (RACKS.has(e.kind)) {
      if (!hitDone) resolveHit(s, cfg, p, e, false, events)
      hitDone = true
      continue
    }
    e.taken = true
    if (e.kind === 'coin') {
      s.score += s.multiplier
      if (cfg.shieldEnabled) s.shield = Math.min(SHIELD_FULL, s.shield + 1)
      events.push({ type: 'ActivityCoinCollected', tick: s.tick, id: e.id, hash: 0 })
    } else if (e.kind === 'orb') {
      // ...unchanged
    } else {
      // ...crate branch unchanged
    }
  }
```

`engine/replay.ts`:

```ts
import type { GameState, HistoryEvent, InputEvent, InputKind, OutcomeEvent, Ports, ReplayResult, StartInput } from './types'

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
```

(`idOf` prepares for `FanIn`, which has no `id`, in Task 10.) In `advance`, the collection loop becomes:

```ts
          if (isInputEvent(e)) inputs.push(inputOf(e))
          else expected.push(e)
```

The divergence index uses `.findIndex((e) => !isInputEvent(e))`, and the stop condition is:

```ts
        if (next.state.status === 'failed' || next.state.status === 'retry') {
          // A replay that dies (or needs a retry) has diverged from a run that didn't: stop just before.
```

`runtime/persistence.ts` `isEvent`:

```ts
    case 'OrchestratorStarted': return true
    case 'RetryAttempt': return isNum(v.attempt) && isNum(v.failedAt)
    case 'CircuitBreakerTripped':
    case 'BoostLost':
      return isNum(v.id) && isNum(v.hash)
```

`runtime/game.ts` `tick()` event loop, so that only activities count as executed:

```ts
    for (const e of events) {
      this.history.push(e)
      if (e.type === 'OrbTaken') this.chaos.onPickup(state.level, 'orb', state.tick)
      else if (e.type === 'ActivityCoinCollected' || e.type === 'ActivityCrateCollected') {
        this.stats.executed += 1
        if (e.type === 'ActivityCrateCollected') this.chaos.onPickup(state.level, 'crate', state.tick)
      }
    }
```

Also type `pending` as `PlayerInput[]`, so TypeScript enforces that `'resume'` and `'retry'` never come from keys.

`HistoryPanel.tsx`:

```ts
const NODE: Record<HistoryEvent['type'], string> = {
  Input: 'n-sched',
  OrchestratorStarted: 'n-sched',
  RetryAttempt: 'n-sched',
  ActivityCoinCollected: 'n-done',
  ActivityCrateCollected: 'n-done',
  CircuitBreakerTripped: 'n-done',
  OrbTaken: 'n-fail',
  BoostLost: 'n-fail',
}
```

and in `describeEvent`:

```ts
    case 'OrchestratorStarted':
      return { type: 'OrchestratorStarted', detail: 'replay resumed · 1 s grace' }
    case 'RetryAttempt':
      return { type: 'RetryAttempt', detail: `attempt ${e.attempt} · failed at t${e.failedAt}` }
    case 'CircuitBreakerTripped':
      return { type: 'CircuitBreakerTripped', detail: e.id === 0 ? 'pit bridged' : `rack ${e.id} smashed` }
    case 'BoostLost':
      return { type: 'BoostLost', detail: '×3 boost absorbed the hit' }
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): resolve hits through grace, circuit breaker, boost and retry"
```

---

### Task 6: Runtime inputs, grace after a resume, per-level retries and stats

**Files:**
- Modify: `runtime/game.ts`, `runtime/types.ts` (`RunStats`), `runtime/persistence.ts` (`isStats`, event tick rule)
- Test: `runtime/game.test.ts`, `runtime/persistence.test.ts`

**Interfaces:**
- Consumes: Task 5 `InputEvent`, `isInputEvent`, `inputOf`, `LevelConfig.retries`
- Produces:
  - `RunStats { replays; fromHistory; executed; incidents; retriesUsed: number; circuitTrips: number; boostsLost: number }`
  - `Game` private `queued: InputEvent[]` and `recordInput(e: InputEvent): void`: the event is appended to the history now and applied at the next tick
  - Save rule: an input event may sit *at* the save tick (`e.tick <= save.tick`); outcome events must come before it

- [ ] **Step 1: Write the failing tests**

`runtime/game.test.ts`:

```ts
import { GRACE_RESUME } from '../engine/step'

  it('records OrchestratorStarted when a replay resumes, and grants grace', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [120, 120] }) }))
    play(game)
    runUntil(game, is('crashing'))
    runUntil(game, is('playing'))
    expect(game.history[game.history.length - 1]).toEqual({ type: 'OrchestratorStarted', tick: 120 })
    game.frame(1)
    expect(game.state.graceUntil).toBe(120 + GRACE_RESUME)
  })

  it('starts a boss segment with OrchestratorStarted at tick 0', () => {
    const game = new Game(deps({ impure: counter(), levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, (g) => g.state.bossUntil > 0 && g.phase.kind === 'playing', ['orb'])
    expect(game.history[0]).toEqual({ type: 'OrchestratorStarted', tick: 0 })
  })

  it('gives each level its own retries', () => {
    const levels = makeLevels({ length: 400 }, { 0: { retries: 0 }, 1: { retries: 3 } })
    const game = new Game(deps({ levels }))
    play(game)
    expect(game.start.retries).toBe(0)
    runUntil(game, (g) => g.phase.kind === 'tip' && g.start.level === 1)
    expect(game.start.retries).toBe(3)
  })

  it('counts circuit trips in the run stats, and only activities as executed', () => {
    const levels = makeLevels({ weights: { low: 1, coin: 1 }, shieldEnabled: true })
    const game = new Game(deps({ levels }))
    play(game)
    game.state = { ...game.state, shield: 10 }
    runUntil(game, (g) => g.stats.circuitTrips === 1)
    expect(game.stats).toMatchObject({ circuitTrips: 1, boostsLost: 0, retriesUsed: 0 })
    expect(game.stats.executed).toBe(game.history.filter((e) => e.type === 'ActivityCoinCollected').length)
  })
```

(`game.state` is a public field; setting it in a test is fine, because the next tick steps from it.)

Every `RunStats` literal must gain the three new fields, or `tsc` fails: `sample.stats` below, and the `stats` fixture in `Overlay.test.tsx` (`retriesUsed: 2, circuitTrips: 1, boostsLost: 3`, which Task 8's test relies on). Find them all with `grep -rn "incidents:" web/src/pages/replay`.

`runtime/persistence.test.ts`: add `retriesUsed: 0, circuitTrips: 1, boostsLost: 2` to `sample.stats`, and:

```ts
  it('accepts runtime input events at the save tick but not outcomes', () => {
    const atTick = { ...sample, history: [...sample.history, { type: 'RetryAttempt' as const, tick: 31, attempt: 1, failedAt: 90 }] }
    expect(parseSave(JSON.stringify(atTick))).not.toBeNull()
    const outcome = { ...sample, history: [...sample.history, { type: 'ActivityCoinCollected' as const, tick: 31, id: 1, hash: 1 }] }
    expect(parseSave(JSON.stringify(outcome))).toBeNull()
  })
```

Two v1 tests change with this task, because a boss segment now starts with an `OrchestratorStarted` (and its grace):

- In "detects non-determinism after an orb pickup and enters the boss phase", replace `expect(game.history).toEqual([])` with `expect(game.history).toEqual([{ type: 'OrchestratorStarted', tick: 0 }])`.
- In "fails with the non-determinism reason when the player dies during the boss", let the grace run out before dropping the rack: add `for (let i = 0; i < GRACE_RESUME; i++) game.frame(1)` right after `bossGame()`. `makeLevels` boss weights are coins only, so nothing else can hit the hat meanwhile.

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: FAIL.

- [ ] **Step 3: Implement**

`runtime/types.ts`:

```ts
export interface RunStats {
  /** Crash recoveries (and resumes) that replayed history. */
  replays: number
  /** Activities served from history during replays. */
  fromHistory: number
  /** Activities actually executed in live play. */
  executed: number
  /** Non-determinism incidents (boss phases). */
  incidents: number
  /** RetryPolicy attempts spent (rewinds). */
  retriesUsed: number
  /** Hits absorbed by the circuit breaker. */
  circuitTrips: number
  /** Hits absorbed by losing the ×3 boost. */
  boostsLost: number
}
```

`runtime/game.ts` (import `inputOf`, `isInputEvent` from `../engine/replay`, and `InputEvent`, `InputKind`, `PlayerInput` from `../engine/types`):

```ts
const emptyStats = (): RunStats => ({ replays: 0, fromHistory: 0, executed: 0, incidents: 0, retriesUsed: 0, circuitTrips: 0, boostsLost: 0 })

  /** Input events already in the history at the current tick; the next tick applies them. */
  private queued: InputEvent[] = []

  /** Runtime inputs (resume, retry) go into the history at once, so a save before the next tick keeps them. */
  private recordInput(e: InputEvent): void {
    this.history.push(e)
    this.queued.push(e)
  }
```

`tick()` beginning:

```ts
  private tick(): void {
    const t = this.state.tick
    const inputs: InputKind[] = this.queued.map(inputOf)
    this.queued = []
    const pending = this.pending
    this.pending = []
    for (const kind of pending) {
      this.history.push({ type: 'Input', tick: t, kind })
      inputs.push(kind)
    }
    // ...step as before, with `inputs`
```

In the event loop add:

```ts
      else if (e.type === 'CircuitBreakerTripped') this.stats.circuitTrips += 1
      else if (e.type === 'BoostLost') this.stats.boostsLost += 1
```

The tail of `tick()` keeps using `inputs.length > 0`.

In `beginSegment`, reset `this.queued = []`.

In `advanceReplay`, on `result.ok`, before `setPhase({ kind: 'playing' })`:

```ts
      // Runtime inputs recorded at the resume tick were not applied by the replay (it stops before that tick).
      this.queued = this.history.filter((e): e is InputEvent => isInputEvent(e) && e.tick === this.state.tick)
      this.recordInput({ type: 'OrchestratorStarted', tick: this.state.tick })
```

In the divergence branch, after `this.beginSegment(continueAsNew(result.state, { boss: true }), false)`:

```ts
    this.recordInput({ type: 'OrchestratorStarted', tick: 0 })
```

Level transition in `tick()`:

```ts
      const next = nextLevel(state.level)
      this.beginSegment(continueAsNew(state, { level: next, elapsed: 0, distance: 0, retries: this.levels[next].retries }), true)
```

`newRun`: `retries: this.levels[0].retries, shield: 0`. The `'lost'` → level 1 start: `retries: this.levels[1].retries, shield: 0`.

`runtime/persistence.ts`:

```ts
const STAT_KEYS = ['replays', 'fromHistory', 'executed', 'incidents', 'retriesUsed', 'circuitTrips', 'boostsLost'] as const

function isStats(v: unknown): v is RunStats {
  return isObj(v) && STAT_KEYS.every((k) => isNum(v[k]))
}
```

and at the end of `isSave` (import `isInputEvent` from `../engine/replay`):

```ts
  // Ordered by tick; outcomes happened before the tick we replay to, runtime inputs may sit on it.
  const tick = v.tick as number
  return history.every((e, i) => (i === 0 || history[i - 1].tick <= e.tick) && (isInputEvent(e) ? e.tick <= tick : e.tick < tick))
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS. The existing test "crashes, replays the history and resumes on the exact same tick and state" still passes, because the `OrchestratorStarted` is applied on the *next* tick.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): record OrchestratorStarted on resume, per-level retries and safety stats"
```

---

### Task 7: RetryPolicy rewind

**Files:**
- Create: `runtime/rewind.ts`, `runtime/rewind.test.ts`
- Modify: `runtime/game.ts`, `runtime/types.ts` (`Phase`), `engine/levels.ts` (`retries: 3` for levels 1–4)
- Test: `runtime/game.test.ts`

**Interfaces:**
- Consumes: Task 2 `HAZARDS`; Task 5 `'retry'` status and `RetryAttempt`; Task 6 `recordInput`, `queued`
- Produces:
  - `REWIND_BUFFER_TICKS = 180`, `REWIND_PX = 240`, `REWIND_FRAMES = 30`
  - `isSafe(s: GameState): boolean` (Task 11 extends it to lanes)
  - `class RewindBuffer { reset(anchor: GameState): void; push(s: GameState): void; pick(failedAt: number, minBack: number, floor: number): GameState; between(from: number, to: number): GameState[]; dropAfter(tick: number): void }`
  - `sample<T>(states: readonly T[], n: number): T[]`
  - `Phase` member `{ kind: 'rewinding'; frames: GameState[]; index: number; attempt: number; of: number }`

- [ ] **Step 1: Write the failing buffer tests**

`runtime/rewind.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { initialState } from '../engine/step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState } from '../engine/types'
import { REWIND_BUFFER_TICKS, RewindBuffer, isSafe, sample } from './rewind'

const base = initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 3, shield: 0 })
const at = (tick: number, over: Partial<GameState> = {}): GameState => ({ ...base, tick, ...over })
const rack = (x: number): Entity => ({ id: 1, kind: 'low', x, y: GROUND_Y - 20, w: 14, h: 20, taken: false })

describe('isSafe', () => {
  it('needs the hat standing with no hazard close by', () => {
    expect(isSafe(at(1))).toBe(true)
    expect(isSafe(at(1, { player: { ...base.player, y: GROUND_Y - 5 } }))).toBe(false)
    expect(isSafe(at(1, { entities: [rack(PLAYER_X + 100)] }))).toBe(false)
    expect(isSafe(at(1, { entities: [rack(PLAYER_X + 200)] }))).toBe(true)
    expect(isSafe(at(1, { entities: [{ ...rack(PLAYER_X + 100), taken: true }] }))).toBe(true)
    expect(isSafe(at(1, { entities: [{ ...rack(PLAYER_X + 100), kind: 'coin' }] }))).toBe(true)
  })
})

describe('RewindBuffer', () => {
  function filled(n: number, unsafe: (t: number) => boolean = () => false): RewindBuffer {
    const b = new RewindBuffer()
    b.reset(at(0))
    for (let t = 1; t <= n; t++) b.push(at(t, unsafe(t) ? { entities: [rack(PLAYER_X + 50)] } : {}))
    return b
  }

  it('picks the latest safe state at least minBack ticks before the hit', () => {
    expect(filled(150).pick(150, 60, 0).tick).toBe(90)
    expect(filled(150, (t) => t > 80).pick(150, 60, 0).tick).toBe(80)
  })

  it('falls back to the oldest candidate when nothing is safe', () => {
    expect(filled(150, (t) => t > 0).pick(150, 60, 1).tick).toBe(1)
  })

  it('rewinds to the segment start when hit in the first ticks', () => {
    expect(filled(5).pick(6, 60, 0).tick).toBe(0)
  })

  it('never picks a state before the floor, so a retry cannot be refunded', () => {
    const b = filled(150)
    expect(b.pick(150, 60, 120).tick).toBe(120)
    expect(b.pick(150, 60, 95).tick).toBe(95)
  })

  it('forgets the anchor once the ring has wrapped', () => {
    const b = filled(REWIND_BUFFER_TICKS + 20, () => true)
    expect(b.pick(REWIND_BUFFER_TICKS + 20, 60, 0).tick).toBe(21)
  })

  it('returns the states between two ticks and drops newer ones', () => {
    const b = filled(20)
    expect(b.between(5, 8).map((s) => s.tick)).toEqual([5, 6, 7, 8])
    b.dropAfter(10)
    const ticks = b.between(0, 20).map((s) => s.tick)
    expect(ticks[ticks.length - 1]).toBe(10)
  })
})

describe('sample', () => {
  it('spreads n picks evenly, keeping the first and last', () => {
    expect(sample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4)).toEqual([0, 3, 6, 9])
    expect(sample([1, 2], 4)).toEqual([1, 2])
  })
})
```

- [ ] **Step 2: Write the failing Game tests**

`runtime/game.test.ts` (import `replay` from `../engine/replay`, `LevelConfig` from `../engine/levels`, `REWIND_FRAMES` from `./rewind`):

```ts
const retryLevels = (over: Partial<LevelConfig> = {}) => makeLevels({ weights: { low: 1 }, retries: 3, ...over })

describe('RetryPolicy rewind', () => {
  it('rewinds at least half a screen on a hit, truncates the history and records the retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    const R = game.state.tick
    const retry = game.history[game.history.length - 1]
    if (retry?.type !== 'RetryAttempt') throw new Error('no retry recorded')
    expect(retry).toMatchObject({ tick: R, attempt: 1 })
    expect(retry.failedAt - R).toBeGreaterThanOrEqual(60)
    expect(game.history.slice(0, -1).every((e) => e.tick < R)).toBe(true)
    expect(game.stats.retriesUsed).toBe(1)
    const frames = runUntil(game, is('playing'))
    expect(frames).toBeLessThanOrEqual(REWIND_FRAMES + 1)
    game.frame(1)
    expect(game.state.retries).toBe(2)
    expect(game.state.graceUntil).toBe(R + 60)
  })

  it('rolls back coins collected in the rewound span', () => {
    const game = new Game(deps({ levels: retryLevels({ weights: { low: 1, coin: 3 } }) }))
    play(game)
    runUntil(game, is('rewinding'))
    const coins = game.history.filter((e) => e.type === 'ActivityCoinCollected').length
    expect(game.state.score).toBe(coins)
  })

  it('keeps the history replayable after a retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    runUntil(game, is('playing'))
    for (let i = 0; i < 90; i++) game.frame(1)
    const r = replay(game.start, game.history, game.state.tick, counter(), retryLevels())
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(game.state))
  })

  it('rewinds to the segment start when hit on the very first tick', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    game.state = { ...game.state, entities: [{ id: 999, kind: 'low', x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase.kind).toBe('rewinding')
    expect(game.state.tick).toBe(0)
    runUntil(game, is('playing'))
    game.frame(1)
    expect(game.state).toMatchObject({ retries: 2, graceUntil: 60 })
  })

  it('fails the run when no retries are left', () => {
    const game = new Game(deps({ levels: retryLevels({ retries: 1 }) }))
    play(game)
    runUntil(game, is('rewinding'))
    runUntil(game, is('over'))
    expect(game.stats.retriesUsed).toBe(1)
  })

  it('never rewinds past an earlier retry', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    const first = game.state.tick
    runUntil(game, (g) => g.phase.kind === 'rewinding' && g.stats.retriesUsed === 2)
    expect(game.state.tick).toBeGreaterThan(first)
    expect(game.history.filter((e) => e.type === 'RetryAttempt').map((e) => e.tick)).toEqual([first, game.state.tick])
  })

  it('saves during a rewind and resumes with the retry applied once', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: retryLevels() }))
    play(game)
    runUntil(game, is('rewinding'))
    game.suspend()
    const resumed = new Game(deps({ store, levels: retryLevels() }))
    expect(resumed.phase.kind).toBe('resume')
    resumed.command('confirm')
    runUntil(resumed, is('playing'))
    resumed.frame(1)
    expect(resumed.state.retries).toBe(2)
    expect(resumed.history.filter((e) => e.type === 'RetryAttempt')).toHaveLength(1)
  })

  it('ends a slide released during the rewind once play continues, and records it', () => {
    const game = new Game(deps({ levels: retryLevels() }))
    play(game)
    game.command('slideStart')
    runUntil(game, is('rewinding'))
    game.command('slideEnd')
    runUntil(game, is('playing'))
    const R = game.state.tick
    game.frame(1)
    expect(game.state.player.sliding).toBe(false)
    const atR = game.history.filter((e) => e.tick === R).map((e) => (e.type === 'Input' ? e.kind : e.type))
    expect(atR).toEqual(['RetryAttempt', 'slideEnd'])
  })
})
```

A sliding hat (9 px) still overlaps a low rack (20 px), so the slide test reaches a hit.

- [ ] **Step 3: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: FAIL (`./rewind` doesn't exist; the game freezes on `'retry'`).

- [ ] **Step 4: Implement `runtime/rewind.ts`**

```ts
import { HAZARDS, PLAYER_W } from '../engine/step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState, type Player } from '../engine/types'

/** How many recent states the rewind can reach back to (3 s). */
export const REWIND_BUFFER_TICKS = 180
/** A retry rewinds at least this far (half a screen). */
export const REWIND_PX = 240
/** Frames the ◀◀ rewind effect takes. */
export const REWIND_FRAMES = 30

const SAFE_BEHIND = 10
const SAFE_AHEAD = 120

export function hatSafe(p: Player, entities: readonly Entity[]): boolean {
  if (p.y !== GROUND_Y || p.vy !== 0) return false
  const lo = PLAYER_X - SAFE_BEHIND
  const hi = PLAYER_X + PLAYER_W + SAFE_AHEAD
  return !entities.some((e) => HAZARDS.has(e.kind) && !e.taken && e.x < hi && e.x + e.w > lo)
}

/** The hat stands on solid ground with no hazard close by: a fair place to try again. */
export function isSafe(s: GameState): boolean {
  return hatSafe(s.player, s.entities)
}

/** Recent states of the current segment, for the RetryPolicy rewind. */
export class RewindBuffer {
  private anchor: GameState | null = null
  private ring: GameState[] = []
  private wrapped = false

  /** Starts a segment: its tick-0 state is the fallback until the ring wraps. */
  reset(anchor: GameState): void {
    this.anchor = anchor
    this.ring = []
    this.wrapped = false
  }

  push(s: GameState): void {
    this.ring.push(s)
    if (this.ring.length > REWIND_BUFFER_TICKS) {
      this.ring.shift()
      this.wrapped = true
    }
  }

  private all(): GameState[] {
    return this.wrapped || !this.anchor ? this.ring : [this.anchor, ...this.ring]
  }

  /**
   * The latest safe state at least `minBack` ticks before the hit and not before
   * `floor` (the tick after the last retry, so a rewind can't undo one). If none is
   * safe, the oldest such candidate; if there is none at all, the newest state.
   */
  pick(failedAt: number, minBack: number, floor: number): GameState {
    const all = this.all()
    const candidates = all.filter((s) => s.tick >= floor)
    const limit = failedAt - minBack
    for (let i = candidates.length - 1; i >= 0; i--) {
      if (candidates[i].tick <= limit && isSafe(candidates[i])) return candidates[i]
    }
    const fallback = candidates[0] ?? all[all.length - 1]
    if (!fallback) throw new Error('rewind buffer is empty')
    return fallback
  }

  between(from: number, to: number): GameState[] {
    return this.all().filter((s) => s.tick >= from && s.tick <= to)
  }

  dropAfter(tick: number): void {
    this.ring = this.ring.filter((s) => s.tick <= tick)
  }
}

/** Up to n items spread evenly over `items`, keeping the first and last. */
export function sample<T>(items: readonly T[], n: number): T[] {
  if (items.length <= n) return [...items]
  return Array.from({ length: n }, (_, i) => items[Math.round((i * (items.length - 1)) / (n - 1))])
}
```

In the floor test with `floor = 95`, `limit = 90`: no candidate is at or before 90, so the fallback is the oldest candidate (95).

- [ ] **Step 5: Implement the Game side**

`runtime/types.ts` `Phase`: add `| { kind: 'rewinding'; frames: GameState[]; index: number; attempt: number; of: number }` (import `GameState` from `../engine/types`).

`runtime/game.ts` (import `speedAt` from `../engine/levels`, and `REWIND_FRAMES`, `REWIND_PX`, `RewindBuffer`, `sample` from `./rewind`):

```ts
  private readonly rewind = new RewindBuffer()
```

- `beginSegment`: after `this.state = initialState(start)`, call `this.rewind.reset(this.state)`.
- `startReplay`: after creating the replayer, call `this.rewind.reset(this.replayer.state)`.
- `advanceReplay`: step one tick at a time so every replayed state lands in the buffer:

```ts
    for (let i = 0; i < this.replayTicksPerFrame && !r.done; i++) {
      r.advance(1)
      if (r.state.status === 'running') this.rewind.push(r.state)
    }
```

- `tick()`: straight after `const { state, events } = step(...)`:

```ts
    if (state.status === 'retry') {
      this.retry(state)
      return
    }
```

  Then, once the `failed` and `levelDone` branches have returned (just before the `bossUntil` check), push the new state: `this.rewind.push(state)`.

- The retry itself:

```ts
  /** RetryPolicy: rewind to a safe spot about half a screen back and try again. */
  private retry(hit: GameState): void {
    const cfg = this.levels[hit.level]
    const lastRetry = [...this.history].reverse().find((e) => e.type === 'RetryAttempt')
    const floor = lastRetry ? lastRetry.tick + 1 : 0
    const target = this.rewind.pick(hit.failedAt, Math.ceil(REWIND_PX / speedAt(cfg, hit.elapsed)), floor)
    const frames = sample(this.rewind.between(target.tick, hit.failedAt).reverse(), REWIND_FRAMES)
    this.history = this.history.filter((e) => e.tick < target.tick)
    this.rewind.dropAfter(target.tick)
    this.state = target
    this.prevState = null
    this.pending = []
    this.queued = []
    this.stats.retriesUsed += 1
    const attempt = cfg.retries - target.retries + 1
    this.recordInput({ type: 'RetryAttempt', tick: target.tick, attempt, failedAt: hit.failedAt })
    this.chaos.scheduleNext(target.level, target.tick, target.elapsed)
    this.setPhase({ kind: 'rewinding', frames, index: 0, attempt, of: cfg.retries })
    this.save()
  }
```

- `frame()`:

```ts
    } else if (p.kind === 'rewinding') {
      if (p.index + 1 < p.frames.length) this.phase = { ...p, index: p.index + 1 }
      else this.setPhase({ kind: 'playing' })
    }
```

- `view()`: `state: this.phase.kind === 'rewinding' ? (this.phase.frames[this.phase.index] ?? this.state) : this.state`.
- `save()` needs no change: `'rewinding'` falls through to `tick = this.state.tick` (the target tick), and the `RetryAttempt` at that tick is already in the history. `resumeSaved` needs no change either, because Task 6's `advanceReplay` re-queues the `RetryAttempt` at the resume tick.

`engine/levels.ts`: set `retries: 3` for levels 1–4.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS. The v1 Game tests use `makeLevels()` (`retries: 0`), so they keep failing the run on a hit as before.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): RetryPolicy rewinds to a safe spot about half a screen back"
```

---

### Task 8: Show the safety layers

**Files:**
- Modify: `render/canvas.ts`, `render/props.ts` (`drawDebris`), `Overlay.tsx`, `engine/levels.ts` (level-1 tip)
- Test: `render/canvas.test.ts`, `Overlay.test.tsx`, `engine/levels.test.ts`

**Interfaces:**
- Consumes: Task 7 `rewinding` phase; Task 5 events; Task 6 stats
- Produces: `drawDebris(ctx, e, pal)`; a second HUD row at `y = 32`

- [ ] **Step 1: Write the failing tests**

`render/canvas.test.ts`:

```ts
const lvl1 = (over: Partial<GameState> = {}): GameState => ({
  ...initialState({ level: 1, seed: 1, score: 0, elapsed: 0, distance: 0, boss: false, retries: 3, shield: 0 }),
  ...over,
})

  it('shows retries and the circuit-breaker charge on a second HUD row', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1({ retries: 2, shield: 7 })), pal)
    expect(texts(calls)).toContain('RETRY')
    expect(texts(calls)).toContain('CB 7/10')
    render(ctx, view({ kind: 'playing' }, lvl1({ shield: 10 })), pal)
    expect(texts(calls)).toContain('CB ARMED')
  })

  it('hides the safety HUD in level 0', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, { ...lvl1(), level: 0 }), pal)
    expect(texts(calls)).not.toContain('RETRY')
    expect(texts(calls).some((t) => String(t).startsWith('CB '))).toBe(false)
  })

  it('blinks the hat during grace, and outlines it instead with reduced motion', () => {
    const hidden = mockCtx()
    render(hidden.ctx, view({ kind: 'playing' }, lvl1({ tick: 4, graceUntil: 60, retries: 0 })), pal)
    const shown = mockCtx()
    render(shown.ctx, view({ kind: 'playing' }, lvl1({ tick: 0, graceUntil: 60, retries: 0 })), pal)
    expect(hatShapes(hidden.calls).length).toBeLessThan(hatShapes(shown.calls).length)
    const still = mockCtx()
    render(still.ctx, view({ kind: 'playing' }, lvl1({ tick: 4, graceUntil: 60 }), { reducedMotion: true }), pal)
    expect(still.calls.some((c) => c.name === 'strokeRect')).toBe(true)
  })

  it('shows the rewind banner while rewinding', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'rewinding', frames: [], index: 0, attempt: 2, of: 3 }), pal)
    expect(texts(calls)).toContain('◀◀ RetryPolicy · attempt 2/3')
  })

  it('draws a smashed rack as debris, never as "from history"', () => {
    const { ctx, calls } = mockCtx()
    const s = lvl1({ entities: [{ id: 5, kind: 'low', x: 200, y: GROUND_Y - 20, w: 14, h: 20, taken: true }] })
    render(ctx, view({ kind: 'replaying' }, s), pal)
    expect(texts(calls)).not.toContain('✓ from history')
    expect(calls.some((c) => c.name === 'fillRect' && c.fill === pal.obstacle && (c.args as number[])[3] === 3)).toBe(true)
  })
```

(In the blink test `retries: 0` keeps the HUD's retry hats out of the `roundRect` count.)

`Overlay.test.tsx` (its `stats` fixture already has the new fields from Task 6):

```tsx
  it('shows the safety stats on the end-of-run card', () => {
    render(<Overlay phase={{ kind: 'over', reason: 'hit an obstacle' }} stats={stats} best={40} score={12} level={3} />)
    expect(screen.getByText('Retries used').previousElementSibling).toHaveTextContent('2')
    expect(screen.getByText('Circuit trips').previousElementSibling).toHaveTextContent('1')
    expect(screen.getByText('Boosts lost').previousElementSibling).toHaveTextContent('3')
  })
```

`engine/levels.test.ts`:

```ts
  it('introduces RetryPolicy and the circuit breaker in the level-1 tip', () => {
    expect(LEVELS[1].tip.body).toMatch(/RetryPolicy/)
    expect(LEVELS[1].tip.body).toMatch(/circuit breaker/)
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`render/props.ts`:

```ts
/** A rack the circuit breaker barged through: a few broken units on the floor. */
export function drawDebris(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  ctx.fillStyle = pal.obstacle
  const n = 4
  for (let i = 0; i < n; i++) {
    const w = 3 + ((e.id + i * 7) % 4)
    ctx.fillRect(e.x - 4 + i * (e.w / n + 3), GROUND_Y - 3 - ((e.id + i) % 3), w, 3)
  }
}
```

`render/canvas.ts` (import `RACKS`, `SHIELD_FULL` from `../engine/step`, `drawDebris` from `./props`, `drawHat` from `./sprites`):

```ts
/** Grace blink: hidden on alternate 4-tick beats. */
const blinkHidden = (s: GameState): boolean => s.tick < s.graceUntil && Math.floor(s.tick / 4) % 2 === 1
```

In `drawEntity`, first thing when `e.taken`:

```ts
  if (e.taken) {
    if (RACKS.has(e.kind)) {
      drawDebris(ctx, e, pal)
      return
    }
    // ...existing "from history" logic
```

`drawPlayer` gains a `reducedMotion` parameter; `render()` passes `view.reducedMotion`:

```ts
function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette, pose: Pose, reducedMotion: boolean): void {
  const p = state.player
  const h = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  const box = { x: PLAYER_X, y: p.y - h, w: PLAYER_W, h }
  if (state.tick < state.graceUntil && reducedMotion) {
    ctx.strokeStyle = pal.player
    ctx.lineWidth = 1
    ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4)
  } else if (blinkHidden(state)) {
    return
  }
  drawHat(ctx, box, pal, pose)
}
```

`drawHud` gains the second row, after the existing two `fillText` calls:

```ts
  const cfg = LEVELS[state.level]
  ctx.textAlign = 'left'
  if (cfg.retries > 0) {
    ctx.fillStyle = pal.muted
    ctx.fillText('RETRY', 10, 32)
    for (let i = 0; i < cfg.retries; i++) {
      ctx.save()
      if (i >= state.retries) ctx.globalAlpha = 0.25
      drawHat(ctx, { x: 46 + i * 14, y: 25, w: 11, h: 6 }, pal, NEUTRAL)
      ctx.restore()
    }
  }
  if (cfg.shieldEnabled) {
    const armed = state.shield >= SHIELD_FULL
    const x0 = 100
    for (let i = 0; i < SHIELD_FULL; i++) {
      ctx.fillStyle = i < state.shield ? pal.player : pal.ground
      ctx.fillRect(x0 + i * 5, 26, 4, 6)
    }
    ctx.fillStyle = armed ? pal.player : pal.muted
    ctx.fillText(armed ? 'CB ARMED' : `CB ${state.shield}/${SHIELD_FULL}`, x0 + SHIELD_FULL * 5 + 6, 32)
  }
```

The rewind overlay, called at the end of `render()` when `phase.kind === 'rewinding'` as `drawRewind(ctx, view, pal, phase.attempt, phase.of)`:

```ts
function drawRewind(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette, attempt: number, of: number): void {
  if (!view.reducedMotion) {
    ctx.save()
    ctx.globalAlpha = 0.25
    ctx.fillStyle = pal.glitch
    for (let i = 0; i < 3; i++) ctx.fillRect(0, (view.frame * 9 + i * 97) % VIEW_H, VIEW_W, 2)
    ctx.restore()
  }
  banner(ctx, `◀◀ RetryPolicy · attempt ${attempt}/${of}`, VIEW_H / 2, pal.glitch, BIG_FONT)
}
```

`Overlay.tsx` `over` card, after the `Non-determinism` stat:

```tsx
            <Stat label="Retries used" value={stats.retriesUsed} />
            <Stat label="Circuit trips" value={stats.circuitTrips} />
            <Stat label="Boosts lost" value={stats.boostsLost} />
```

`engine/levels.ts` level-1 tip:

```ts
      body: 'Dapr Workflow is enabled. Every step is written to history. After a crash the workflow replays that history to rebuild its state, and completed activities are not run again. Hitting a rack is a failed activity: your RetryPolicy rewinds and tries again, 3 attempts per level. Every 10 coins arm a circuit breaker that lets you barge through one rack.',
```

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Playtest check**

Run `cd web && npm run dev` and open `/replay`. Hit a rack in level 1: you should see the ◀◀ rewind, land about half a screen back, blink for a second, and the `RETRY` hats should drop by one. Collect 10 coins: `CB ARMED` shows and the next rack turns to debris. Pick up an orb in level 2 and hit a rack: the ×3 disappears and there's no rewind.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): show retries, circuit breaker, grace and rewind"
```

# Phase 3 — Fan-out level

### Task 9: Levels 0–5 with Fan Out as level 4

**Files:**
- Modify: `engine/types.ts` (`Level`), `engine/levels.ts`, `testing.ts` (`makeLevels`, `BASE`), `runtime/game.ts` (`nextLevel`), `runtime/persistence.ts` (`isStart`)
- Test: `engine/levels.test.ts`, `engine/step.test.ts` (`describe('levels')`), `runtime/persistence.test.ts`, `runtime/game.test.ts`

**Interfaces:**
- Produces:
  - `Level = 0 | 1 | 2 | 3 | 4 | 5`
  - `LevelConfig.laneWeights: Partial<Record<EntityKind, number>>` and `LevelConfig.fanOut?: { everyPx: number; ticks: number }`
  - `LEVELS[4].name === 'Fan Out'`, `LEVELS[5].name === 'Production'` (the old level 4, endless)

- [ ] **Step 1: Write the failing tests**

`engine/levels.test.ts`:

```ts
  it('adds Fan Out as level 4 and moves the endless Production level to 5', () => {
    expect(LEVELS[4].name).toBe('Fan Out')
    expect(LEVELS[4].fanOut).toEqual({ everyPx: 2500, ticks: 600 })
    expect(LEVELS[4].tip.body).toMatch(/WhenAll/)
    expect(LEVELS[5].name).toBe('Production')
    expect(LEVELS[5].length).toBe(Number.POSITIVE_INFINITY)
    expect(LEVELS[5].fanOut).toEqual({ everyPx: 4000, ticks: 600 })
    for (const l of [0, 1, 2, 3] as const) expect(LEVELS[l].fanOut).toBeUndefined()
  })

  it('only spawns low racks, pits and coins in fan-out lanes', () => {
    for (const l of [4, 5] as const) expect(Object.keys(LEVELS[l].laneWeights).sort()).toEqual(['coin', 'low', 'pit'])
  })
```

Change the Task 4 level test's last loop to `LEVELS[5].weights`. In `engine/step.test.ts` `describe('levels')`, use `LEVELS[5]` instead of `LEVELS[4]` in the speed-ramp and chaos-floor tests, and loop `[1, 2, 3, 4, 5]` in "only level 0 is non-durable".

`runtime/persistence.test.ts`:

```ts
  it('accepts a level-5 save', () => {
    expect(parseSave(JSON.stringify({ ...sample, start: { ...sample.start, level: 5 } }))).not.toBeNull()
  })
```

`runtime/game.test.ts`:

```ts
  it('stays on the endless level 5 once reached', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 300 }, { 5: { length: Number.POSITIVE_INFINITY } }) }))
    play(game)
    runUntil(game, (g) => g.phase.kind === 'tip' && g.start.level === 5)
    game.command('confirm')
    for (let i = 0; i < 400; i++) game.frame(1)
    expect(game.state.level).toBe(5)
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`engine/types.ts`: `export type Level = 0 | 1 | 2 | 3 | 4 | 5`.

`engine/levels.ts`, in `LevelConfig`:

```ts
  /** What each of the three fan-out lanes spawns (they are drawn at half height). */
  laneWeights: Partial<Record<EntityKind, number>>
  /** Fan-out gates every `everyPx` of distance; the lanes run for `ticks`. */
  fanOut?: { everyPx: number; ticks: number }
```

Give levels 0–3 `laneWeights: LANES` (unused there; the field is required so the lookup never needs a fallback), where:

```ts
const LANES: LevelConfig['laneWeights'] = { low: 2, pit: 2, coin: 4 }
```

Rename the current level 4 to level 5 (keep its values; add `fanOut: { everyPx: 4000, ticks: 600 }, laneWeights: LANES`), and insert the new level 4:

```ts
  4: {
    name: 'Fan Out',
    length: 9000, speed: 4.5, ramp: 0, maxSpeed: 4.5,
    weights: { low: 2, high: 2, coin: 3, crate: 1, pit: 2, falling: 1, tall: 1 }, bossWeights: BOSS,
    laneWeights: LANES, fanOut: { everyPx: 2500, ticks: 600 },
    durable: true, chaosMeanTicks: 1200, retries: 3, shieldEnabled: true,
    tip: {
      body: 'Fan-out: the workflow calls three activities in parallel. Your hat splits into three lanes that all follow your keys, and WhenAll merges them again. If any lane hits a rack the whole workflow takes the hit, just like WhenAll fails when one task fails.',
    },
  },
```

`testing.ts`: `BASE` gains `laneWeights: { coin: 1 }`, and `makeLevels` returns `{ 0: lv(0), 1: lv(1), 2: lv(2), 3: lv(3), 4: lv(4), 5: lv(5) }`.

`runtime/game.ts`: `const nextLevel = (l: Level): Level => (l >= 5 ? 5 : ((l + 1) as Level))`.

`runtime/persistence.ts` `isStart`: `[0, 1, 2, 3, 4, 5].includes(v.level as number)`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): add the Fan Out level and move Production to level 5"
```

---

### Task 10: Fan-out and fan-in (engine)

**Files:**
- Modify: `engine/types.ts`, `engine/step.ts`, `engine/hash.ts`, `engine/replay.ts` (`initialState` call), `runtime/game.ts` (`initialState` calls), `runtime/persistence.ts` (`isEvent`), `HistoryPanel.tsx`, `render/canvas.ts` (skip `fanout` in `drawEntity` until Task 11)
- Test: `engine/step.test.ts`, `engine/hash.test.ts`, `engine/replay.test.ts`, `HistoryPanel.test.tsx`

**Interfaces:**
- Consumes: Task 9 `LevelConfig.fanOut`, `laneWeights`; Task 5 `resolveHit`, `OutcomeEvent`
- Produces:
  - `EntityKind` gains `'fanout'`
  - `interface Lane { player: Player; entities: Entity[]; nextSpawnAt: number; coins: number }`
  - `GameState.fan: { until: number; lanes: Lane[] } | null`, `GameState.nextGateAt: number` (`Infinity` in levels without fan-out)
  - `HistoryEvent` gains `{ type: 'FanOut'; tick; hash }` and `{ type: 'FanIn'; tick; hash; results: number[] }`
  - `initialState(start: StartInput, levels: LevelTable = LEVELS): GameState`
  - constants `FAN_LANES = 3`, `FAN_CLEAR_PX = 200`, `LANE_SPAWN_X = 2 * VIEW_W + 10`, `GATE_W = 12`

- [ ] **Step 1: Write the failing tests**

`engine/step.test.ts`:

```ts
import { FAN_CLEAR_PX, FAN_LANES, LANE_SPAWN_X } from './step'

// 600 ticks at speed 4 = 2400 px of lanes, long enough for lane spawns before the early stop.
const fanLevels = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, weights: { coin: 1 }, laneWeights: { coin: 1 } })
const world = (s: GameState) => s.distance + s.scroll

/** Steps until an event of `type` is emitted; returns the state before and after that tick. */
function until(s: GameState, type: string, table = fanLevels, max = 3000) {
  for (let i = 0; i < max; i++) {
    const r = step(s, [], ports(), table)
    if (r.events.some((e) => e.type === type)) return { before: s, after: r.state, events: r.events }
    s = r.state
  }
  throw new Error(`no ${type}`)
}

describe('fan-out', () => {
  it('places the first gate at the next multiple of everyPx', () => {
    expect(initialState(start, fanLevels).nextGateAt).toBe(400)
    expect(initialState({ ...start, distance: 900 }, fanLevels).nextGateAt).toBe(1200)
    expect(initialState(start, levels).nextGateAt).toBe(Number.POSITIVE_INFINITY)
  })

  it('spawns nothing else from FAN_CLEAR_PX before the gate until the gate', () => {
    let s = initialState(start, fanLevels)
    let idAtQuiet: number | null = null
    for (let i = 0; i < 400; i++) {
      s = step(s, [], ports(), fanLevels).state
      if (idAtQuiet === null && world(s) >= 400 - FAN_CLEAR_PX) idAtQuiet = s.nextId
      const gate = s.entities.find((e) => e.kind === 'fanout')
      if (gate) {
        expect(gate.id).toBe(idAtQuiet)
        return
      }
    }
    throw new Error('no gate')
  })

  it('splits into three lanes when the gate reaches the hat', () => {
    const { after, events } = until(initialState(start, fanLevels), 'FanOut')
    expect(events).toContainEqual({ type: 'FanOut', tick: after.tick - 1, hash: hashState(after) })
    expect(after.fan?.lanes).toHaveLength(FAN_LANES)
    for (const lane of after.fan!.lanes) expect(lane.player).toEqual(after.player)
    expect(after.entities).toEqual([])
    expect(after.fan!.until).toBe(after.tick - 1 + 600)
  })

  it('moves every lane with the same inputs and spawns lane entities at LANE_SPAWN_X', () => {
    let s = until(initialState(start, fanLevels), 'FanOut').after
    s = step(s, ['jump'], ports(), fanLevels).state
    const [a, b, c] = s.fan!.lanes
    expect(a.player).toEqual(b.player)
    expect(b.player).toEqual(c.player)
    expect(a.player.vy).toBeLessThan(0)
    for (let i = 0; i < 80; i++) s = step(s, [], ports(), fanLevels).state
    const spawned = s.fan!.lanes.flatMap((l) => l.entities)
    expect(spawned.length).toBeGreaterThan(0)
    expect(Math.max(...spawned.map((e) => e.x))).toBeGreaterThan(VIEW_W)
    expect(Math.max(...spawned.map((e) => e.x))).toBeLessThanOrEqual(LANE_SPAWN_X)
  })

  it('merges after `ticks` with coins per lane, clears the lanes and resumes normal spawns after a run-out', () => {
    const out = until(initialState(start, fanLevels), 'FanOut')
    const scoreAtSplit = out.after.score
    const merge = until(out.after, 'FanIn')
    const fanIn = merge.events.find((e) => e.type === 'FanIn')
    if (fanIn?.type !== 'FanIn') throw new Error('no FanIn')
    expect(fanIn.results).toHaveLength(FAN_LANES)
    expect(fanIn.results.reduce((a, b) => a + b, 0)).toBe(merge.after.score - scoreAtSplit)
    expect(merge.after.tick - (out.after.tick - 1)).toBe(600)
    expect(merge.after.fan).toBeNull()
    expect(merge.after.player).toEqual(merge.before.fan!.lanes[1].player)
    expect(merge.after.nextGateAt).toBe(world(merge.after) + 400)
    expect(merge.after.nextSpawnAt).toBe(merge.after.scroll + FAN_CLEAR_PX)
    // Spawns stopped early enough that every lane entity was already behind the hats.
    for (const lane of merge.before.fan!.lanes) for (const e of lane.entities) expect(e.x + e.w).toBeLessThan(PLAYER_X)
  })

  it('runs the hit chain once for a rack in any lane', () => {
    const armed = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, shieldEnabled: true })
    const s = until(initialState(start, armed), 'FanOut', armed).after
    const rackAt = { id: 77, kind: 'low' as const, x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }
    const lanes = s.fan!.lanes.map((l, i) => ({ ...l, entities: i === 2 ? [rackAt] : [] }))
    const r = step({ ...s, shield: SHIELD_FULL, fan: { ...s.fan!, lanes } }, [], ports(), armed)
    expect(r.events.map((e) => e.type)).toEqual(['CircuitBreakerTripped'])
    expect(r.state.fan!.lanes[2].entities[0].taken).toBe(true)
    expect(r.state.shield).toBe(0)
  })

  it('defers the end of the level until the lanes merge', () => {
    // The gate spawns at world 400 and reaches the hat about 410 px later, before the level's end at 1000.
    const short = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, length: 1000 })
    const out = until(initialState(start, short), 'FanOut', short)
    expect(world(out.after)).toBeLessThan(1000)
    let s = out.after
    for (let i = 0; i < 100; i++) s = step(s, [], ports(), short).state
    expect(world(s)).toBeGreaterThan(1000)
    expect(s.status).toBe('running')
    expect(until(s, 'FanIn', short).after.status).toBe('levelDone')
  })

  it('does not carry the lanes across continue-as-new', () => {
    const s = until(initialState(start, fanLevels), 'FanOut').after
    expect(initialState(continueAsNew(s, { boss: true }), fanLevels).fan).toBeNull()
  })
})
```

(import `SHIELD_FULL` and `VIEW_W` if they aren't already.)

`engine/hash.test.ts`: fixture gains `fan: null, nextGateAt: Number.POSITIVE_INFINITY`; add rows:

```ts
    ['next gate', (s: GameState) => { s.nextGateAt = 400 }],
    ['fan-out', (s: GameState) => { s.fan = { until: 100, lanes: [{ player: { ...s.player }, entities: [], nextSpawnAt: 0, coins: 0 }] } }],
```

and a separate test for lane contents:

```ts
  it('covers lane players, lane entities and lane coins', () => {
    const lane = () => ({ player: { ...state().player }, entities: [{ ...state().entities[0] }], nextSpawnAt: 10, coins: 1 })
    const withFan = (): GameState => ({ ...state(), fan: { until: 100, lanes: [lane(), lane(), lane()] } })
    const base = hashState(withFan())
    const a = withFan(); a.fan!.lanes[2].player.y -= 1
    const b = withFan(); b.fan!.lanes[1].entities[0].x -= 1
    const c = withFan(); c.fan!.lanes[0].coins += 1
    for (const x of [a, b, c]) expect(hashState(x)).not.toBe(base)
  })
```

`engine/replay.test.ts`:

```ts
  it('replays a fan-out section exactly', () => {
    const levels = makeLevels({ fanOut: { everyPx: 400, ticks: 600 }, weights: { coin: 1 }, laneWeights: { coin: 1 } })
    const live = record(1500, levels, ['coin'], counter())
    expect(live.history.some((e) => e.type === 'FanIn')).toBe(true)
    const r = replay(start, live.history, live.state.tick, counter(), levels)
    expect(r.ok).toBe(true)
    expect(hashState(r.state)).toBe(hashState(live.state))
  })
```

`record` in that file starts from `initialState(start)`. Change it to `initialState(start, levels)` so the gate position is right. Its `start` literal already has `retries`/`shield` from Task 1.

`HistoryPanel.test.tsx`:

```tsx
  it('describes fan-out and fan-in', () => {
    render(<HistoryPanel history={[{ type: 'FanOut', tick: 1, hash: 1 }, { type: 'FanIn', tick: 2, hash: 2, results: [3, 1, 2] }]} />)
    expect(screen.getByText('3 activities in parallel')).toBeInTheDocument()
    expect(screen.getByText('WhenAll · coins 3 / 1 / 2')).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement the types, hash and persistence**

`engine/types.ts`:

```ts
export type EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate' | 'tall' | 'falling' | 'pit' | 'fanout'

/** One parallel branch during fan-out: its own hat and its own entities. */
export interface Lane {
  player: Player
  entities: Entity[]
  nextSpawnAt: number
  /** Coins this lane collected (reported by FanIn). */
  coins: number
}
```

In `GameState`:

```ts
  /** Fan-out in progress: the lanes replace `player`/`entities` until `until`. */
  fan: { until: number; lanes: Lane[] } | null
  /** World distance (distance + scroll) of the next fan-out gate; Infinity when the level has none. */
  nextGateAt: number
```

In `HistoryEvent`:

```ts
  | { type: 'FanOut'; tick: number; hash: number }
  /** results = coins per lane. */
  | { type: 'FanIn'; tick: number; hash: number; results: number[] }
```

`engine/hash.ts`:

```ts
const KIND: Record<EntityKind, number> = { low: 1, high: 2, coin: 3, orb: 4, crate: 5, tall: 6, falling: 7, pit: 8, fanout: 9 }

function pushPlayer(parts: number[], p: Player): void {
  parts.push(q(p.y), q(p.vy), p.sliding ? 1 : 0, p.jumpHeld ? 1 : 0, p.coyoteUntil, p.jumpBufferUntil)
}

function pushEntities(parts: number[], entities: readonly Entity[]): void {
  parts.push(entities.length)
  for (const e of entities) parts.push(e.id, KIND[e.kind], q(e.x), q(e.y), q(e.vy ?? 0), e.taken ? 1 : 0)
}

export function hashState(s: GameState): number {
  const parts: number[] = [s.level, s.tick, s.elapsed, s.rng, q(s.score), s.multiplier, s.multUntil]
  pushPlayer(parts, s.player)
  parts.push(
    q(s.scroll), q(s.distance), q(s.nextSpawnAt), s.nextId, s.bossUntil, STATUS[s.status],
    s.retries, s.shield, s.graceUntil, s.failedAt,
    // Infinity (no gate) folds to 0 through `| 0`, which is stable.
    q(s.nextGateAt),
  )
  pushEntities(parts, s.entities)
  if (s.fan) {
    parts.push(1, s.fan.until, s.fan.lanes.length)
    for (const lane of s.fan.lanes) {
      pushPlayer(parts, lane.player)
      parts.push(q(lane.nextSpawnAt), lane.coins)
      pushEntities(parts, lane.entities)
    }
  } else {
    parts.push(0)
  }
  // ...FNV-1a loop unchanged
```

`runtime/persistence.ts` `isEvent`:

```ts
    case 'FanOut': return isNum(v.hash)
    case 'FanIn': return isNum(v.hash) && Array.isArray(v.results) && v.results.every(isNum)
```

`HistoryPanel.tsx`: `NODE` gains `FanOut: 'n-sched', FanIn: 'n-done'`, and `describeEvent` gains:

```ts
    case 'FanOut':
      return { type: 'FanOut', detail: '3 activities in parallel' }
    case 'FanIn':
      return { type: 'FanIn', detail: `WhenAll · coins ${e.results.join(' / ')}` }
```

`render/canvas.ts` `drawEntity`: `if (kind === 'pit' || kind === 'fanout') return` (Task 11 draws the gate).

`engine/step.ts` `SIZE` is a `Record<EntityKind, …>`, so it needs `fanout: { w: GATE_W, h: GROUND_Y }`. The gate never comes from `chooseKind`, because `ORDER` doesn't list it.

- [ ] **Step 4: Implement the engine**

`engine/step.ts`. The single-track code becomes per-*track* code. A track is anything with a `player` and `entities`: the `GameState` itself, or a `Lane`.

```ts
export const FAN_LANES = 3
/** No other spawns this close before a gate, and after a merge. */
export const FAN_CLEAR_PX = 200
/** Lanes are drawn at half scale, so their world is twice as wide. */
export const LANE_SPAWN_X = 2 * VIEW_W + 10
export const GATE_W = 12

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
    // ...all Task 1 fields unchanged, plus:
    fan: null,
    nextGateAt: firstGate(levels[start.level], start.distance),
  }
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
  s.player = { ...fan.lanes[1].player }
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
    if (!hitDone && p.y >= GROUND_Y + PIT_HIT_DEPTH) {
      resolveHit(s, cfg, p, undefined, true, events)
      hitDone = true
    }
    for (const e of t.entities) {
      if (s.status !== 'running') return
      if (e.taken || e.kind === 'pit' || e.kind === 'fanout' || !overlaps(box, e)) continue
      if (RACKS.has(e.kind)) {
        if (!hitDone) resolveHit(s, cfg, p, e, false, events)
        hitDone = true
        continue
      }
      pickup(s, cfg, e, lanes ? lanes[i] : null, ports, events)
    }
  })
}

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
```

`resolveHit`, `movePlayer`, `spawn`, `updateFalling`, `bounce` and `boost` keep their Task 2–5 code. The old inline spawn loop and collision block are gone; `spawnMain` and `collide` replace them.

`engine/replay.ts`: `let state = initialState(start, levels)`. `runtime/game.ts`: pass `this.levels` to every `initialState` call (constructor, `beginSegment`).

- [ ] **Step 5: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS, including every earlier engine test (the refactor keeps single-track behaviour identical).

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): fan-out into three mirrored lanes and fan-in with WhenAll"
```

---

### Task 11: Fan-out in the runtime and on screen

**Files:**
- Modify: `runtime/rewind.ts` (`isSafe`), `runtime/game.ts` (notices), `render/canvas.ts` (lane strips, `drawGround` width), `render/props.ts` (`drawGate`)
- Test: `runtime/rewind.test.ts`, `runtime/game.test.ts`, `render/canvas.test.ts`

**Interfaces:**
- Consumes: Task 10 `fan`, `Lane`, `FanOut`/`FanIn` events
- Produces: `drawGate(ctx, e, pal)`; `STRIP_H = VIEW_H / 3`, `LANE_SCALE = 0.5` in `render/canvas.ts`

- [ ] **Step 1: Write the failing tests**

`runtime/rewind.test.ts`:

```ts
  it('checks every lane during fan-out', () => {
    const lane = (entities: Entity[]) => ({ player: { ...base.player }, entities, nextSpawnAt: 0, coins: 0 })
    expect(isSafe(at(1, { fan: { until: 99, lanes: [lane([]), lane([]), lane([])] } }))).toBe(true)
    expect(isSafe(at(1, { fan: { until: 99, lanes: [lane([]), lane([]), lane([rack(PLAYER_X + 60)])] } }))).toBe(false)
  })
```

`runtime/game.test.ts`:

```ts
  it('announces fan-out and fan-in', () => {
    const game = new Game(deps({ levels: makeLevels({ fanOut: { everyPx: 400, ticks: 120 } }) }))
    play(game)
    runUntil(game, (g) => g.state.fan !== null)
    expect(game.view().notice).toBe('fan-out · 3 activities in parallel')
    runUntil(game, (g) => g.state.fan === null)
    expect(game.view().notice).toMatch(/^WhenAll · fan-in \d+ \+ \d+ \+ \d+ coins$/)
  })
```

`render/canvas.test.ts`:

```ts
  it('draws three clipped half-scale strips with one hat each during fan-out', () => {
    const single = mockCtx()
    // Level 0 has no RETRY hats in the HUD, so every hat shape belongs to a player.
    const s = { ...lvl1(), level: 0 as const }
    render(single.ctx, view({ kind: 'playing' }, s), pal)
    const lane = { player: { ...s.player }, entities: [], nextSpawnAt: 0, coins: 0 }
    const fanned = mockCtx()
    render(fanned.ctx, view({ kind: 'playing' }, { ...s, fan: { until: 99, lanes: [lane, lane, lane] } }), pal)
    expect(fanned.calls.filter((c) => c.name === 'clip')).toHaveLength(3)
    expect(fanned.calls.filter((c) => c.name === 'scale' && c.args[0] === 0.5)).toHaveLength(3)
    expect(hatShapes(fanned.calls).length).toBe(3 * hatShapes(single.calls).length)
  })

  it('draws the fan-out gate with its label', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1({ entities: [{ id: 4, kind: 'fanout', x: 300, y: 0, w: 12, h: GROUND_Y, taken: false }] })), pal)
    expect(texts(calls)).toContain('fan-out ×3')
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`runtime/rewind.ts`:

```ts
/** Every hat (all lanes during fan-out) stands on solid ground with no hazard close by. */
export function isSafe(s: GameState): boolean {
  const hats = s.fan ? s.fan.lanes : [s]
  return hats.every((t) => hatSafe(t.player, t.entities))
}
```

`runtime/game.ts`, in the `tick()` event loop:

```ts
      else if (e.type === 'FanOut') this.setNotice('fan-out · 3 activities in parallel')
      else if (e.type === 'FanIn') this.setNotice(`WhenAll · fan-in ${e.results.join(' + ')} coins`)
```

`render/props.ts`:

```ts
/** The fan-out gate: an arch the hat runs through, labelled with the fan-out. */
export function drawGate(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette): void {
  const top = GROUND_Y - 64
  ctx.fillStyle = pal.glitch
  ctx.fillRect(e.x, top, 3, GROUND_Y - top)
  ctx.fillRect(e.x + e.w - 3, top, 3, GROUND_Y - top)
  ctx.fillRect(e.x - 4, top - 4, e.w + 8, 4)
  ctx.font = '10px ui-monospace, Menlo, Consolas, monospace'
  ctx.textAlign = 'center'
  ctx.fillText('fan-out ×3', e.x + e.w / 2, top - 8)
}
```

`render/canvas.ts`:

```ts
export const STRIP_H = VIEW_H / 3
export const LANE_SCALE = 0.5
/** World y shown at the top of a lane strip: the full jump height fits above the ground. */
const LANE_TOP = GROUND_Y - 170
```

`drawGround(ctx, state, pal, width = VIEW_W)`: use `width` instead of `VIEW_W` in its loops and final segment. `drawEntity`: `if (kind === 'fanout') { drawGate(ctx, e, pal); return }` (pits still return early).

```ts
function drawLanes(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette, pose: Pose): void {
  const { state } = view
  const fan = state.fan
  if (!fan) return
  fan.lanes.forEach((lane, i) => {
    const track: GameState = { ...state, player: lane.player, entities: lane.entities }
    ctx.save()
    ctx.beginPath()
    ctx.rect(0, i * STRIP_H, VIEW_W, STRIP_H)
    ctx.clip()
    ctx.translate(0, i * STRIP_H)
    ctx.scale(LANE_SCALE, LANE_SCALE)
    ctx.translate(0, -LANE_TOP)
    drawGround(ctx, track, pal, VIEW_W / LANE_SCALE)
    for (const e of lane.entities) drawEntity(ctx, e, pal, view.phase.kind === 'replaying', state.elapsed, view.reducedMotion)
    drawPlayer(ctx, track, pal, pose, view.reducedMotion)
    ctx.restore()
    if (i > 0) {
      ctx.fillStyle = pal.ground
      ctx.fillRect(0, i * STRIP_H, VIEW_W, 1)
    }
  })
}
```

In `render()`, inside the shaken `save()`/`restore()` block, after `drawBackground`:

```ts
  if (state.fan) drawLanes(ctx, view, pal, view.pose ?? NEUTRAL)
  else {
    drawGround(ctx, state, pal)
    for (const e of state.entities) drawEntity(ctx, e, pal, replaying, state.elapsed, view.reducedMotion)
    drawPlayer(ctx, state, pal, view.pose ?? NEUTRAL, view.reducedMotion)
  }
```

`blend()` in `render/interpolate.ts` doesn't interpolate lanes. At half scale the lanes look smooth enough, so leave it.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Playtest check**

Run `cd web && npm run dev` and reach level 4 (or temporarily set `nextLevel` to jump there). Check that the gate is visible and the split shows three strips with one hat each, all jumping together. Hitting a rack in any strip should trigger the layer chain, and the merge should show the `WhenAll` notice. The rewind during fan-out should land on a spot that is safe in all lanes. Tune `LEVELS[4].speed` if the half-scale lanes feel too slow.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): draw fan-out lanes and the gate, and check every lane for a safe rewind"
```

# Phase 4 — Level montage

### Task 12: Montage of the level's history

**Files:**
- Create: `runtime/montage.ts`, `runtime/montage.test.ts`
- Modify: `runtime/game.ts`, `runtime/types.ts` (`Phase`, `Save`), `runtime/persistence.ts` (`isSave`)
- Test: `runtime/game.test.ts`, `runtime/persistence.test.ts`

**Interfaces:**
- Consumes: `createReplayer` (`engine/replay.ts`); Task 10 `initialState(start, levels)`
- Produces:
  - `interface MontageSegment { start: StartInput; history: HistoryEvent[]; endTick: number; orbValues: [id: number, value: number][] }`
  - `class Montage { constructor(segments: readonly MontageSegment[], levels: LevelTable); readonly events: number; readonly ticksPerFrame: number; readonly state: GameState; readonly done: boolean; flash: number; trail: number[]; advance(): void }`
  - `MONTAGE_FRAMES = 240`, `MONTAGE_MIN_TICKS_PER_FRAME = 8`, `FLASH_FRAMES = 8`, `TRAIL = 6`
  - `Phase` member `{ kind: 'montage'; events: number }`
  - `GameView.montage: { events: number; flash: number; trail: number[] } | null`
  - `Save` gains `segments: MontageSegment[]` and `orbValues: [number, number][]`

- [ ] **Step 1: Write the failing `Montage` tests**

`runtime/montage.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashState } from '../engine/hash'
import { initialState, step } from '../engine/step'
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
})
```

- [ ] **Step 2: Write the failing Game tests**

`runtime/game.test.ts`:

```ts
import { MONTAGE_FRAMES } from './montage'

describe('level montage', () => {
  const short = () => makeLevels({ length: 1200 })

  it('plays a montage at the end of a durable level, then shows the next tip', () => {
    const game = new Game(deps({ levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    expect(game.phase).toMatchObject({ kind: 'montage' })
    expect(game.start.level).toBe(1)
    expect(game.view().montage?.events).toBeGreaterThan(0)
    const frames = runUntil(game, is('tip'))
    expect(frames).toBeLessThanOrEqual(MONTAGE_FRAMES + 2)
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
  })

  it('skips the montage on Enter', () => {
    const game = new Game(deps({ levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
  })

  it('has no montage after a non-durable level', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 1200 }, { 0: { durable: false } }) }))
    play(game)
    runUntil(game, (g) => g.phase.kind === 'montage' || g.phase.kind === 'tip', ['coin'])
    expect(game.phase.kind).toBe('tip')
  })

  it('does not touch the outside world while playing a montage', () => {
    let calls = 0
    const impure = counter()
    const game = new Game(deps({ levels: makeLevels({ length: 1200, weights: { coin: 2, orb: 1 } }), impure: () => { calls++; return impure() } }))
    play(game)
    runUntil(game, is('montage'), ['coin', 'orb'])
    const before = calls
    runUntil(game, is('tip'))
    expect(calls).toBe(before)
  })

  it('includes the boss and hotfix segments of the level', () => {
    const levels = makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'], length: 6000 })
    const game = new Game(deps({ levels }))
    play(game)
    runUntil(game, (g) => g.stats.incidents === 1)
    runUntil(game, is('montage'), ['orb'])
    const m = game.view().montage
    expect(m).not.toBeNull()
    let boundaries = 0
    runUntil(game, (g) => {
      if ((g.view().montage?.flash ?? 0) === 8) boundaries++
      return g.phase.kind === 'tip'
    })
    expect(boundaries).toBeGreaterThanOrEqual(1)
  })

  it('saves during a montage and resumes at the start of the next level', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: short() }))
    play(game)
    runUntil(game, is('montage'), ['coin'])
    game.suspend()
    const resumed = new Game(deps({ store, levels: short() }))
    expect(resumed.phase.kind).toBe('resume')
    resumed.command('confirm')
    runUntil(resumed, is('playing'))
    expect(resumed.start.level).toBe(1)
    expect(resumed.state.tick).toBe(0)
  })
})
```

Update the v1 test "clears the divergence when the level ends during the boss phase": after `game.frame(1)` it now expects `expect(game.phase.kind).toBe('montage')`, then `game.command('confirm')`, then the original `expect(game.phase).toEqual({ kind: 'tip', level: 1 })` and the rest. Find other tests that expect a tip straight after a level ends with `grep -n "kind: 'tip', level: 1" web/src/pages/replay/runtime/game.test.ts`. Tests that wait with `runUntil(..., tip)` keep working, because the montage plays itself out.

`runtime/persistence.test.ts`: add `segments: []` and `orbValues: []` to `sample`, and:

```ts
  it('round-trips montage segments and rejects malformed ones', () => {
    const seg = { start: sample.start, history: sample.history, endTick: 31, orbValues: [[5, 0.25]] }
    const withSeg = { ...sample, segments: [seg], orbValues: [[9, 0.5]] }
    expect(parseSave(JSON.stringify(withSeg))).toEqual(withSeg)
    expect(parseSave(JSON.stringify({ ...withSeg, segments: [{ ...seg, orbValues: [[5]] }] }))).toBeNull()
  })
```

- [ ] **Step 3: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: FAIL.

- [ ] **Step 4: Implement `runtime/montage.ts`**

```ts
import type { LevelTable } from '../engine/levels'
import { createReplayer, type Replayer } from '../engine/replay'
import type { GameState, HistoryEvent, StartInput } from '../engine/types'

/** Frames a whole level's montage aims for (~4 s). */
export const MONTAGE_FRAMES = 240
export const MONTAGE_MIN_TICKS_PER_FRAME = 8
/** Frames the continue-as-new flash lasts. */
export const FLASH_FRAMES = 8
/** Ghost positions kept for the trail. */
export const TRAIL = 6

/** One history segment of a level, with the orb values live play saw (never part of history). */
export interface MontageSegment {
  start: StartInput
  history: HistoryEvent[]
  endTick: number
  orbValues: [id: number, value: number][]
}

/**
 * Replays a level's segments back to back at high speed. Crate results come
 * from history as usual; orbs get the values live play saw, so the montage
 * shows what really happened. It reads nothing from the outside world.
 */
export class Montage {
  readonly events: number
  readonly ticksPerFrame: number
  flash = 0
  trail: number[] = []
  private index = 0
  private replayer: Replayer

  constructor(
    private readonly segments: readonly MontageSegment[],
    private readonly levels: LevelTable,
  ) {
    const ticks = segments.reduce((n, s) => n + s.endTick, 0)
    this.ticksPerFrame = Math.max(MONTAGE_MIN_TICKS_PER_FRAME, Math.ceil(ticks / MONTAGE_FRAMES))
    this.events = segments.reduce((n, s) => n + s.history.length, 0)
    this.replayer = this.open(0)
  }

  get state(): GameState {
    return this.replayer.state
  }

  get done(): boolean {
    return this.index >= this.segments.length
  }

  /** One frame of fast-forward. */
  advance(): void {
    if (this.done) return
    if (this.flash > 0) this.flash -= 1
    this.replayer.advance(this.ticksPerFrame)
    this.trail = [this.replayer.state.player.y, ...this.trail].slice(0, TRAIL)
    if (!this.replayer.done) return
    this.index += 1
    if (this.done) return
    this.replayer = this.open(this.index)
    this.flash = FLASH_FRAMES
    this.trail = []
  }

  private open(i: number): Replayer {
    const seg = this.segments[i]
    const values = new Map(seg.orbValues)
    const queue = seg.history.filter((e) => e.type === 'OrbTaken').map((e) => ('id' in e ? values.get(e.id) : undefined) ?? 0)
    return createReplayer(seg.start, seg.history, seg.endTick, () => queue.shift() ?? 0, this.levels)
  }
}
```

The constructor requires at least one segment; the Game only builds a `Montage` when it has one.

- [ ] **Step 5: Implement the Game side**

`runtime/types.ts`: add `| { kind: 'montage'; events: number }` to `Phase`; add `segments: MontageSegment[]` and `orbValues: [number, number][]` to `Save` (import `MontageSegment` from `./montage`).

`runtime/game.ts`:

```ts
import { Montage, type MontageSegment } from './montage'

  /** Closed segments of the current level, for its montage. */
  private segments: MontageSegment[] = []
  /** Live impure values of this segment's orb pickups, by orb id. */
  private orbValues = new Map<number, number>()
  private montage: Montage | null = null

  private closeSegment(endTick: number): void {
    this.segments.push({ start: this.start, history: [...this.history], endTick, orbValues: [...this.orbValues] })
  }
```

- In `tick()`, capture the impure values in call order and map them to the orb events (each orb and each crate calls `impure` exactly once, in event order):

```ts
    const calls: number[] = []
    const impure = () => {
      const v = this.deps.impure()
      calls.push(v)
      return v
    }
    const ports = { impure, crateValue: () => impure() }
    // ...step(...)
    let c = 0
    for (const e of events) {
      if (e.type === 'OrbTaken') this.orbValues.set(e.id, calls[c++])
      else if (e.type === 'ActivityCrateCollected') c++
    }
```

- `beginSegment`: `this.orbValues = new Map()`.
- `newRun`: `this.segments = []`.
- Divergence branch of `advanceReplay`: call `this.closeSegment(this.crashTick)` before `beginSegment(... boss ...)`.
- `hotfix()`: call `this.closeSegment(this.state.tick)` before `beginSegment`.
- Level end in `tick()`:

```ts
    if (state.status === 'levelDone') {
      this.divergedAt = null
      this.closeSegment(state.tick)
      const segments = this.levels[state.level].durable ? this.segments : []
      this.segments = []
      const next = nextLevel(state.level)
      // The next level starts (and is saved) first, so a tab closed during the montage resumes there.
      this.beginSegment(continueAsNew(state, { level: next, elapsed: 0, distance: 0, retries: this.levels[next].retries }), true)
      if (segments.length > 0) {
        this.montage = new Montage(segments, this.levels)
        this.setPhase({ kind: 'montage', events: this.montage.events })
      }
      return
    }
```

- `frame()`:

```ts
    } else if (p.kind === 'montage') {
      this.montage?.advance()
      if (!this.montage || this.montage.done) this.endMontage()
    }
```

- `command()`: `case 'montage': if (c === 'confirm') this.endMontage(); return`.

```ts
  private endMontage(): void {
    this.montage = null
    this.setPhase({ kind: 'tip', level: this.start.level })
  }
```

- `view()` (and `GameView` gains `montage: { events: number; flash: number; trail: number[] } | null`):

```ts
  view(): GameView {
    const n = this.notice
    const p = this.phase
    const m = p.kind === 'montage' ? this.montage : null
    const state = m ? m.state : p.kind === 'rewinding' ? (p.frames[p.index] ?? this.state) : this.state
    return {
      state,
      phase: p,
      divergedAt: this.divergedAt,
      prev: p.kind === 'playing' && this.prevState && this.prevState.tick === this.state.tick - 1 ? this.prevState : null,
      notice: n && this.state.tick < n.untilTick ? n.text : null,
      montage: m ? { events: m.events, flash: m.flash, trail: m.trail } : null,
    }
  }
```

- `save()`: add `segments: this.segments, orbValues: [...this.orbValues]`. `resumeSaved()`: `this.segments = save.segments` and `this.orbValues = new Map(save.orbValues)`.

`runtime/persistence.ts`:

```ts
const isPairs = (v: unknown): v is [number, number][] =>
  Array.isArray(v) && v.every((p) => Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]))

function isSegment(v: unknown): v is MontageSegment {
  return isObj(v) && isStart(v.start) && Array.isArray(v.history) && v.history.every(isEvent) && isNum(v.endTick) && isPairs(v.orbValues)
}
```

In `isSave`: `if (!Array.isArray(v.segments) || !v.segments.every(isSegment) || !isPairs(v.orbValues)) return false`.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): replay each finished level's history as a montage"
```

---

### Task 13: Draw the montage

**Files:**
- Modify: `render/canvas.ts`
- Test: `render/canvas.test.ts`

**Interfaces:**
- Consumes: Task 12 `GameView.montage`
- Produces: `RenderView.montage?: { events: number; flash: number; trail: number[] } | null`

- [ ] **Step 1: Write the failing tests**

```ts
  it('shows the montage banner, a ghost trail and the continue-as-new flash', () => {
    const { ctx, calls } = mockCtx()
    const montage = { events: 42, flash: 8, trail: [GROUND_Y, GROUND_Y - 10, GROUND_Y - 20] }
    render(ctx, view({ kind: 'montage', events: 42 }, lvl1(), { montage }), pal)
    expect(texts(calls)).toContain('LEVEL COMPLETE · replaying 42 events')
    const plain = mockCtx()
    render(plain.ctx, view({ kind: 'montage', events: 42 }, lvl1(), { montage: { ...montage, trail: [], flash: 0 } }), pal)
    expect(hatShapes(calls).length).toBeGreaterThan(hatShapes(plain.calls).length)
    const flash = (cs: typeof calls) => cs.some((c) => c.name === 'fillRect' && c.fill === pal.text && c.args[2] === VIEW_W)
    expect(flash(calls)).toBe(true)
    expect(flash(plain.calls)).toBe(false)
  })

  it('skips the flash with reduced motion', () => {
    const { ctx, calls } = mockCtx()
    const montage = { events: 1, flash: 8, trail: [] }
    render(ctx, view({ kind: 'montage', events: 1 }, lvl1(), { montage, reducedMotion: true }), pal)
    expect(calls.some((c) => c.name === 'fillRect' && c.fill === pal.text && c.args[2] === VIEW_W)).toBe(false)
  })
```

(import `VIEW_W` from `../engine/types`.)

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/render/canvas.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`RenderView` gains `montage?: { events: number; flash: number; trail: number[] } | null`. In `render()`, after `drawPlayer` in the single-track branch (inside the shaken block):

```ts
    if (view.montage) drawTrail(ctx, view.montage.trail, pal, view.pose ?? NEUTRAL)
```

and at the end:

```ts
  if (phase.kind === 'montage' && view.montage) drawMontage(ctx, view, pal, view.montage)
```

```ts
/** Ghost hats behind the player at earlier replayed heights, fading out. */
function drawTrail(ctx: CanvasRenderingContext2D, trail: readonly number[], pal: Palette, pose: Pose): void {
  trail.slice(1).forEach((y, i) => {
    ctx.save()
    ctx.globalAlpha = 0.35 * (1 - (i + 1) / trail.length)
    drawHat(ctx, { x: PLAYER_X - (i + 1) * 10, y: y - PLAYER_H, w: PLAYER_W, h: PLAYER_H }, pal, pose)
    ctx.restore()
  })
}

function drawMontage(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette, m: { events: number; flash: number }): void {
  if (m.flash > 0 && !view.reducedMotion) {
    ctx.save()
    ctx.globalAlpha = 0.5 * (m.flash / 8)
    ctx.fillStyle = pal.text
    ctx.fillRect(0, 0, VIEW_W, VIEW_H)
    ctx.restore()
  }
  banner(ctx, `LEVEL COMPLETE · replaying ${m.events} events`, 70, pal.glitch, BIG_FONT)
}
```

`Replay.tsx` already spreads `game.view()` into the render view, so `montage` flows through.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Playtest check and commit**

Finish level 1 in the dev server. The montage should replay the whole level in about 4 s with a ghost trail, and `Enter` should skip it.

```bash
git add web/src/pages/replay
git commit -m "feat(replay): draw the level montage with a ghost trail and segment flashes"
```

---

# Phase 5 — Daily seed, run tape, share a run

### Task 14: Daily seed

**Files:**
- Create: `engine/seed.ts`, `engine/seed.test.ts`, `runtime/daily.ts`, `runtime/daily.test.ts`
- Modify: `runtime/game.ts` (`GameDeps`, `newRun`, the `'lost'` branch, `gameOver`), `runtime/persistence.ts` (daily best, `Save.date`), `runtime/types.ts` (`Save`), `Overlay.tsx` (title card), `Replay.tsx` (deps, Overlay props), `runtime/game.test.ts` (`deps()`), `web/src/styles/theme.css` (nothing new yet)
- Test: `engine/seed.test.ts`, `runtime/daily.test.ts`, `runtime/game.test.ts`, `runtime/persistence.test.ts`, `Overlay.test.tsx`

**Interfaces:**
- Produces:
  - `seedForDate(date: string): number` (uint32, pure)
  - `utcDate(now?: Date): string` (`YYYY-MM-DD`)
  - `GameDeps.today: () => string` replaces `newSeed`
  - `Game.runDate: string`, `Game.dailyBest: number`
  - `SaveStore.loadDailyBest(date: string): number`, `SaveStore.saveDailyBest(date: string, score: number): void`, `DAILY_KEY = 'devdash.replay.daily'`
  - `Save.date: string`
  - Overlay props `date: string`, `dailyBest: number`

- [ ] **Step 1: Write the failing tests**

`engine/seed.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { seedForDate } from './seed'

describe('seedForDate', () => {
  it('is a stable uint32 per date and differs between dates', () => {
    const a = seedForDate('2026-09-30')
    expect(seedForDate('2026-09-30')).toBe(a)
    expect(Number.isInteger(a) && a >= 0 && a <= 0xffffffff).toBe(true)
    expect(seedForDate('2026-10-01')).not.toBe(a)
  })
})
```

`runtime/daily.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { utcDate } from './daily'

describe('utcDate', () => {
  it('uses the UTC calendar day, whatever the local time zone', () => {
    expect(utcDate(new Date('2026-09-30T23:59:59Z'))).toBe('2026-09-30')
    expect(utcDate(new Date('2026-10-01T00:00:00+02:00'))).toBe('2026-09-30')
  })
})
```

`runtime/game.test.ts`: in `deps()`, replace `newSeed: () => 42` with `today: () => '2026-09-30'`, and extend `memoryStore()`:

```ts
type MemoryStore = SaveStore & { saved: Save | null; best: number; daily: { date: string; best: number } | null }

function memoryStore(): MemoryStore {
  const s: MemoryStore = {
    saved: null,
    best: 0,
    daily: null,
    // ...load, save, clear, loadBest, saveBest unchanged
    loadDailyBest: (date) => (s.daily && s.daily.date === date ? s.daily.best : 0),
    saveDailyBest: (date, best) => { s.daily = { date, best } },
  }
  return s
}
```

Then:

```ts
import { seedForDate } from '../engine/seed'
import { seedFrom } from '../engine/rng'

  it("seeds every run from today's UTC date", () => {
    const game = new Game(deps({ today: () => '2026-12-24' }))
    play(game)
    expect(game.start.seed).toBe(seedForDate('2026-12-24'))
    expect(game.runDate).toBe('2026-12-24')
  })

  it('derives the level-1 seed after "Progress lost" from the run seed', () => {
    const game = new Game(deps({ levels: makeLevels({}, { 0: { durable: false, scriptedCrashAt: 120 } }) }))
    play(game)
    runUntil(game, is('lost'))
    game.command('confirm')
    expect(game.start.seed).toBe(seedFrom(seedForDate('2026-09-30')))
  })

  it("records today's best next to the all-time best", () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    // Direct poke: a score of 5 and a rack on the hat (makeLevels has no retries).
    game.state = { ...game.state, score: 5, entities: [{ id: 999, kind: 'low', x: PLAYER_X + 4, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase.kind).toBe('over')
    expect(store.daily).toEqual({ date: '2026-09-30', best: 5 })
    expect(store.best).toBe(5)
    expect(game.dailyBest).toBe(5)
  })
```

`runtime/persistence.test.ts`:

```ts
  it("round-trips today's best and reads another day's as 0", () => {
    const store = localSaveStore()
    expect(store.loadDailyBest('2026-09-30')).toBe(0)
    store.saveDailyBest('2026-09-30', 12)
    expect(store.loadDailyBest('2026-09-30')).toBe(12)
    expect(store.loadDailyBest('2026-10-01')).toBe(0)
    localStorage.setItem(DAILY_KEY, '{nope')
    expect(store.loadDailyBest('2026-09-30')).toBe(0)
  })
```

Add `date: '2026-09-30'` to `sample`, plus a rejection test for `date: 'yesterday'`.

`Overlay.test.tsx`: every `<Overlay>` gains `date="2026-09-30" dailyBest={0}`, and:

```tsx
  it("names today's daily run and shows today's best on the title card", () => {
    render(<Overlay phase={{ kind: 'title' }} stats={stats} best={40} score={0} level={0} date="2026-09-30" dailyBest={7} />)
    expect(screen.getByText('Daily run · 2026-09-30 (UTC)')).toBeInTheDocument()
    expect(screen.getByText("Today's best: 7 · Best: 40")).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement**

`engine/seed.ts`:

```ts
/** FNV-1a over `replay:<date>`: everyone gets the same levels on the same UTC day. */
export function seedForDate(date: string): number {
  const text = `replay:${date}`
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i) & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}
```

(`date` is lower-case, so the purity guard's `\bDate\b` doesn't match.)

`runtime/daily.ts`:

```ts
/** Today's UTC calendar date as YYYY-MM-DD: the daily seed's key. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
```

`runtime/persistence.ts`:

```ts
export const DAILY_KEY = 'devdash.replay.daily'
export const isDate = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
```

`SaveStore` gains the two methods; `localSaveStore` implements them:

```ts
    loadDailyBest: (date) =>
      attempt((s) => {
        const data: unknown = JSON.parse(s.getItem(DAILY_KEY) ?? 'null')
        return isObj(data) && data.date === date && isNum(data.best) && data.best > 0 ? Math.floor(data.best) : 0
      }, 0),
    saveDailyBest: (date, score) => attempt((s) => s.setItem(DAILY_KEY, JSON.stringify({ date, best: score })), undefined),
```

(`attempt` already swallows the `JSON.parse` error.) `isSave`: `if (!isDate(v.date)) return false`. `Save` gains `date: string`.

`runtime/game.ts`:

```ts
export interface GameDeps {
  impure: () => number
  chaosRand: () => number
  /** Today's UTC date (YYYY-MM-DD); the run's seed comes from it. */
  today: () => string
  store: SaveStore
  levels?: LevelTable
}

  runDate: string
  dailyBest: number
```

In the constructor: `this.runDate = deps.today()` and `this.dailyBest = deps.store.loadDailyBest(this.runDate)`. `newRun`:

```ts
    this.runDate = this.deps.today()
    this.dailyBest = this.deps.store.loadDailyBest(this.runDate)
    this.beginSegment({ level: 0, seed: seedForDate(this.runDate), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[0].retries, shield: 0 }, true)
```

`'lost'` branch: `seed: seedFrom(seedForDate(this.runDate))`. `save()`: `date: this.runDate`. `resumeSaved()`: `this.runDate = save.date; this.dailyBest = this.deps.store.loadDailyBest(save.date)`. `gameOver()` adds:

```ts
    if (this.state.score > this.dailyBest) {
      this.dailyBest = this.state.score
      this.deps.store.saveDailyBest(this.runDate, this.dailyBest)
    }
```

`Overlay.tsx`: props `date: string; dailyBest: number`. The title card:

```tsx
        <Card>
          <h2>Press Enter to start</h2>
          <p>Guide a workflow through a datacenter full of chaos. It will crash. Dapr will replay it.</p>
          <p className="replay-keys">Daily run · {date} (UTC)</p>
          <p className="replay-keys">Space / ↑ jump (hold for higher) · ↓ slide · Esc pause</p>
          {(best > 0 || dailyBest > 0) && <p className="replay-keys">Today's best: {dailyBest} · Best: {best}</p>}
        </Card>
```

`Replay.tsx`: replace `newSeed` with `today: () => utcDate()` in `createGame`, and pass `date={game.runDate} dailyBest={game.dailyBest}` to `Overlay`.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): daily seed from the UTC date, with today's best score"
```

---

### Task 15: Run tape: record the outside world, play a run back

**Files:**
- Create: `runtime/tape.ts`, `runtime/tape.test.ts`
- Modify: `runtime/game.ts`, `runtime/types.ts` (`Save.tape`), `runtime/persistence.ts` (`isSave`), `testing.ts` (`lcg` helper)
- Test: `runtime/tape.test.ts`, `runtime/game.test.ts`, `runtime/persistence.test.ts`

**Interfaces:**
- Consumes: Task 14 `runDate`, `seedForDate`
- Produces:
  - `interface Tape { v: 1; date: string; inputs: [liveTick: number, command: PlayerInput][]; impure: number[]; chaos: number[]; restarts: [liveTick: number, impureAt: number, chaosAt: number][]; liveTick: number }`
  - `quantise(v: number): number` (uint32), `toUnit(u: number): number`, `emptyTape(date: string): Tape`, `isTape(v: unknown): v is Tape`
  - `interface Source { impure(): number; chaos(): number; readonly exhausted: boolean }`, `class TapeRecorder implements Source`, `class TapePlayer implements Source { seek(impureAt: number, chaosAt: number): void }`
  - `Game.tape: Tape`, `Game.playback: boolean`, `Game.liveTicks: number` (getter), `Game.watch(tape: Tape): boolean`, `GameView.playbackDate: string | null`
  - `Save.tape: Tape`
  - `lcg(seed: number): () => number` in `testing.ts`

- [ ] **Step 1: Write the failing tape unit tests**

`runtime/tape.test.ts`:

```ts
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
```

- [ ] **Step 2: Write the failing Game playback tests**

`testing.ts`:

```ts
/** A small seeded generator in [0, 1): a stand-in for Math.random in determinism tests. */
export function lcg(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0
    return x / 4294967296
  }
}
```

`runtime/game.test.ts`:

```ts
import { lcg } from '../testing'

describe('run tape', () => {
  const WANT: readonly EntityKind[] = ['coin', 'orb', 'crate']
  const tapeLevels = () =>
    makeLevels({
      weights: { low: 2, coin: 3, orb: 1, crate: 1 }, retries: 3, shieldEnabled: true,
      crashAfterPickup: ['orb', 'crate'], firstCrashTicks: [200, 260], chaosMeanTicks: 600, length: 3000,
    })
  const noWorld = (): number => {
    throw new Error('playback must not read the outside world')
  }

  /** Jumps low racks (unless careless) and otherwise steers toward pickups. */
  function drive(g: Game, careless: boolean): void {
    if (g.phase.kind === 'tip') g.command('confirm')
    if (g.phase.kind !== 'playing') return
    const s = g.state
    const gap = (x: number) => x - (PLAYER_X + 30)
    const rack = !careless && s.player.y >= GROUND_Y && s.entities.some((e) => e.kind === 'low' && !e.taken && gap(e.x) > 0 && gap(e.x) <= 24)
    for (const c of rack ? (['jump'] as const) : autopilot(s, WANT)) g.command(c)
  }

  /** A live run with crashes, retries and a tab-close resume in the middle. */
  function recordRun(): Game {
    const store = memoryStore()
    const live = new Game(deps({ store, levels: tapeLevels(), impure: lcg(1), chaosRand: lcg(2) }))
    play(live)
    for (let f = 0; f < 6000 && !(live.stats.replays >= 1 && live.phase.kind === 'playing' && live.liveTicks > 300); f++) {
      drive(live, false)
      live.frame(1)
    }
    live.suspend()
    const resumed = new Game(deps({ store, levels: tapeLevels(), impure: lcg(3), chaosRand: lcg(4) }))
    resumed.command('confirm')
    for (let f = 0; f < 5000 && resumed.phase.kind !== 'over'; f++) {
      drive(resumed, f > 500 && f < 900)
      resumed.frame(1)
    }
    for (let f = 0; f < 600 && resumed.phase.kind !== 'playing' && resumed.phase.kind !== 'over'; f++) resumed.frame(1)
    return resumed
  }

  it('plays a recorded run back exactly, across crashes, retries and a tab-close resume', () => {
    const live = recordRun()
    expect(live.tape.restarts).toHaveLength(1)
    expect(live.stats.replays).toBeGreaterThanOrEqual(2)
    expect(live.stats.retriesUsed).toBeGreaterThan(0)
    const viewer = new Game(deps({ levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    expect(viewer.watch(live.tape)).toBe(true)
    expect(viewer.playback).toBe(true)
    const L = live.liveTicks
    for (let f = 0; f < 60_000 && !(viewer.liveTicks === L && viewer.phase.kind === live.phase.kind); f++) viewer.frame(1)
    expect(viewer.liveTicks).toBe(L)
    expect(viewer.stats).toEqual(live.stats)
    expect(viewer.history).toEqual(live.history)
    expect(hashState(viewer.state)).toBe(hashState(live.state))
  })

  it('stops with "Run code ended early" on a truncated tape and writes nothing', () => {
    const live = recordRun()
    const store = memoryStore()
    const viewer = new Game(deps({ store, levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    viewer.watch({ ...live.tape, chaos: live.tape.chaos.slice(0, 1), impure: [] })
    for (let f = 0; f < 60_000 && viewer.phase.kind !== 'over'; f++) viewer.frame(1)
    expect(viewer.phase).toEqual({ kind: 'over', reason: 'Run code ended early' })
    expect(store.saved).toBeNull()
    expect(store.best).toBe(0)
    expect(store.daily).toBeNull()
  })

  it('ignores game keys during playback; Esc returns to the title', () => {
    const live = recordRun()
    const viewer = new Game(deps({ levels: tapeLevels(), impure: noWorld, chaosRand: noWorld }))
    viewer.watch(live.tape)
    const L = live.liveTicks
    for (let f = 0; f < 60_000 && !(viewer.liveTicks === L && viewer.phase.kind === live.phase.kind); f++) {
      // Mashing keys must not change the run being played back.
      viewer.command('jump')
      viewer.command(f % 2 ? 'slideStart' : 'slideEnd')
      viewer.frame(1)
    }
    expect(viewer.history).toEqual(live.history)
    viewer.command('cancel')
    expect(viewer.phase.kind).toBe('title')
    expect(viewer.playback).toBe(false)
  })

  it('refuses a malformed tape', () => {
    const viewer = new Game(deps())
    expect(viewer.watch({ ...emptyTape('2026-09-30'), v: 2 } as unknown as Tape)).toBe(false)
    expect(viewer.phase.kind).toBe('title')
  })
})
```

(import `emptyTape`, `Tape` from `./tape`.) If `recordRun()` is slow, share one recording across the four tests with a lazy module-level `let recorded: Game | null`.

`runtime/persistence.test.ts`: add `tape: { ...emptyTape('2026-09-30'), liveTick: 31 }` to `sample`, and a rejection test for a save whose `tape` fails `isTape`.

- [ ] **Step 3: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: FAIL.

- [ ] **Step 4: Implement `runtime/tape.ts`**

```ts
import type { PlayerInput } from '../engine/types'

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
  /** A saved run was resumed at this live tick; the cursors are where its values start. */
  restarts: [liveTick: number, impureAt: number, chaosAt: number][]
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
  const restartsOk = t.restarts.every((x) => Array.isArray(x) && x.length === 3 && x.every(isTick))
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
```

- [ ] **Step 5: Implement the Game side**

`runtime/types.ts`: `Save.tape: Tape`. `runtime/persistence.ts` `isSave`: `if (!isTape(v.tape)) return false`.

`runtime/game.ts`: all outside-world reads go through `this.source`.

```ts
import { TapePlayer, TapeRecorder, emptyTape, isTape, type Source, type Tape } from './tape'

  tape: Tape
  playback = false
  private source: Source
  private liveTick = 0
  private inputCursor = 0
  private restartCursor = 0

  get liveTicks(): number {
    return this.liveTick
  }
```

- Constructor: `this.tape = emptyTape(this.runDate)`, `this.source = new TapeRecorder(this.tape, deps)`, and `this.chaos = new ChaosScheduler(() => this.source.chaos(), this.levels)`.
- `tick()`: the `impure` wrapper from Task 12 calls `this.source.impure()` instead of `this.deps.impure()`. The inputs come from the tape during playback:

```ts
    const L = this.liveTick++
    let player: PlayerInput[]
    if (this.playback) {
      player = []
      const ins = this.tape.inputs
      while (this.inputCursor < ins.length && ins[this.inputCursor][0] === L) player.push(ins[this.inputCursor++][1])
    } else {
      player = this.pending
      for (const kind of player) this.tape.inputs.push([L, kind])
      this.tape.liveTick = this.liveTick
    }
    this.pending = []
    // then: history.push Input events for `player` and add them to `inputs`, as before
```

- `startReplay()`: pass `() => this.source.impure()` to `createReplayer` instead of `this.deps.impure`.
- A shared restart path for save resumes and their playback:

```ts
  /** The process restarted on a saved history: rebuild it by replay, then resume. */
  private restartFromHistory(tick: number): void {
    this.montage = null
    this.crashTick = tick
    this.pending = []
    this.queued = []
    this.notice = null
    this.chaos.start(this.start.level, false, this.start.elapsed)
    this.startReplay()
  }

  private resumeSaved(save: Save): void {
    this.savedRun = null
    this.start = save.start
    this.history = save.history
    this.stats = save.stats
    this.divergedAt = save.divergedAt
    this.segments = save.segments
    this.orbValues = new Map(save.orbValues)
    this.runDate = save.date
    this.dailyBest = this.deps.store.loadDailyBest(save.date)
    this.tape = save.tape
    this.liveTick = save.tape.liveTick
    this.source = new TapeRecorder(this.tape, this.deps)
    this.tape.restarts.push([this.liveTick, this.tape.impure.length, this.tape.chaos.length])
    this.restartFromHistory(save.tick)
  }
```

- Starting a run. Refactor `newRun` into a shared `startRun()` so live runs and playback start the same way:

```ts
  private newRun(): void {
    this.playback = false
    this.runDate = this.deps.today()
    this.dailyBest = this.deps.store.loadDailyBest(this.runDate)
    this.tape = emptyTape(this.runDate)
    this.source = new TapeRecorder(this.tape, this.deps)
    this.deps.store.clear()
    this.startRun()
  }

  /** Plays a recorded run back. Returns false (and changes nothing) for a malformed tape. */
  watch(tape: Tape): boolean {
    if (!isTape(tape)) return false
    this.playback = true
    this.runDate = tape.date
    this.tape = tape
    this.source = new TapePlayer(tape)
    this.startRun()
    return true
  }

  private startRun(): void {
    this.stats = emptyStats()
    this.divergedAt = null
    this.segments = []
    this.liveTick = 0
    this.inputCursor = 0
    this.restartCursor = 0
    this.beginSegment({ level: 0, seed: seedForDate(this.runDate), score: 0, elapsed: 0, distance: 0, boss: false, retries: this.levels[0].retries, shield: 0 }, true)
  }
```

- Playback drives itself at the start of `frame()`:

```ts
  frame(liveTicks: number): void {
    if (this.playback) this.autoplay()
    // ...existing phase switch
    if (this.playback && this.source.exhausted && this.phase.kind !== 'over') this.gameOver('Run code ended early')
  }

  /** Playback confirms cards by itself and repeats the recorded tab-close resumes. */
  private autoplay(): void {
    const k = this.phase.kind
    if (k === 'tip' || k === 'lost') this.confirm()
    const r = this.tape.restarts[this.restartCursor]
    if (r && r[0] === this.liveTick && k !== 'over' && k !== 'title') {
      this.restartCursor += 1
      ;(this.source as TapePlayer).seek(r[1], r[2])
      this.restartFromHistory(k === 'crashing' || k === 'replaying' ? this.crashTick : this.state.tick)
    }
  }
```

  Pull the existing `'tip'` and `'lost'` confirm branches of `command()` into a `private confirm()` that both call.

- `command()` during playback:

```ts
    if (this.playback) {
      if (c === 'cancel' && this.phase.kind !== 'paused') {
        this.playback = false
        this.setPhase({ kind: 'title' })
        return
      }
      if (c !== 'pause' && c !== 'cancel') return
    }
```

  (`pause`/`cancel` still toggle the pause card.) The `over` card's `confirm` starts a fresh live run through `newRun()`, which resets `playback`.

- No storage writes in playback: `save()`, and the store calls in `gameOver()`, start with `if (this.playback) return` (in `gameOver()`, wrap only the store and best-score part; the phase change still happens).
- `view()`: add `playbackDate: this.playback ? this.runDate : null` to the returned object (and `playbackDate: string | null` to `GameView`).
- `save()`: add `tape: this.tape` (its `liveTick` field is kept current by `tick()`).

Why the restart cursors matter: a tab closed mid-crash leaves values on the tape that the live run never used after the resume, and the replay that playback runs at that point may use a different number of them. Seeking to the recorded cursors makes the resume consume exactly what the live resume did.

- [ ] **Step 6: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS. If the playback test fails, compare `viewer.history` with `live.history` to find the first differing event. That's the first place a value didn't come from the tape (a leftover `this.deps.impure` or `deps.chaosRand` call).

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): record a run tape and play recorded runs back exactly"
```

---

### Task 16: Run codes

**Files:**
- Create: `runtime/share.ts`, `runtime/share.test.ts`
- Test: `runtime/share.test.ts`

**Interfaces:**
- Consumes: Task 15 `Tape`, `isTape`
- Produces:
  - `RUN_CODE_PREFIX = 'RPL1.'`, `MAX_RUN_CODE = 256 * 1024`, `MAX_TAPE_JSON = 4 * 1024 * 1024`
  - `encodeRun(tape: Tape): Promise<string>`, `decodeRun(code: string): Promise<Tape | null>`
  - `copyRunCode(code: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<'copied' | 'manual'>`

- [ ] **Step 1: Check the test environment has the streams API**

Run: `cd web && npx vitest run --environment jsdom -t never 2>/dev/null; node -e "console.log(typeof CompressionStream, typeof DecompressionStream)"`
Expected: `function function` (Node 18+). If a test later reports `CompressionStream is not defined` under jsdom, add this to `web/src/test/setup.ts`:

```ts
import { CompressionStream, DecompressionStream } from 'node:stream/web'
Object.assign(globalThis, { CompressionStream, DecompressionStream })
```

- [ ] **Step 2: Write the failing tests**

`runtime/share.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { MAX_RUN_CODE, RUN_CODE_PREFIX, copyRunCode, decodeRun, encodeRun } from './share'
import { emptyTape, type Tape } from './tape'

const tape: Tape = {
  ...emptyTape('2026-09-30'),
  inputs: Array.from({ length: 400 }, (_, i) => [i * 7, i % 2 ? 'jump' : 'jumpEnd'] as [number, 'jump' | 'jumpEnd']),
  impure: [1, 2, 3, 4294967295],
  chaos: [9, 8, 7],
  restarts: [[100, 1, 2]],
  liveTick: 2900,
}

describe('run codes', () => {
  it('round-trips a tape through a compact, prefixed, URL-safe code', async () => {
    const code = await encodeRun(tape)
    expect(code.startsWith(RUN_CODE_PREFIX)).toBe(true)
    expect(code).toMatch(/^RPL1\.[A-Za-z0-9_-]+$/)
    expect(code.length).toBeLessThan(JSON.stringify(tape).length)
    expect(await decodeRun(code)).toEqual(tape)
  })

  it('ignores whitespace and line breaks added when the code was pasted', async () => {
    const code = await encodeRun(tape)
    const wrapped = `  ${code.slice(0, 20)}\n${code.slice(20, 50)} \r\n${code.slice(50)}\n`
    expect(await decodeRun(wrapped)).toEqual(tape)
  })

  it.each([
    ['empty', ''],
    ['wrong prefix', 'RPL2.abc'],
    ['not base64', 'RPL1.***'],
    ['not deflate', `RPL1.${btoa('hello world')}`],
  ])('rejects a %s code', async (_name, code) => {
    expect(await decodeRun(code)).toBeNull()
  })

  it('rejects a well-formed code whose content is not a tape', async () => {
    const code = await encodeRun({ nope: true } as unknown as Tape)
    expect(await decodeRun(code)).toBeNull()
  })

  it('rejects codes over MAX_RUN_CODE without decoding them', async () => {
    expect(await decodeRun(RUN_CODE_PREFIX + 'A'.repeat(MAX_RUN_CODE))).toBeNull()
  })
})

describe('copyRunCode', () => {
  it('copies to the clipboard when it can', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyRunCode('RPL1.x', { writeText })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith('RPL1.x')
  })

  it('falls back to manual copy when the clipboard is missing or refuses', async () => {
    expect(await copyRunCode('RPL1.x', undefined)).toBe('manual')
    expect(await copyRunCode('RPL1.x', { writeText: async () => { throw new Error('denied') } })).toBe('manual')
  })
})
```

- [ ] **Step 3: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime/share.test.ts`
Expected: FAIL (`./share` doesn't exist).

- [ ] **Step 4: Implement `runtime/share.ts`**

```ts
import { isTape, type Tape } from './tape'

export const RUN_CODE_PREFIX = 'RPL1.'
/** Longest code we try to decode. */
export const MAX_RUN_CODE = 256 * 1024
/** Longest decompressed tape we accept (guards against a deflate bomb). */
export const MAX_TAPE_JSON = 4 * 1024 * 1024

/** Runs bytes through a (de)compression stream, giving up past `limit` output bytes. */
async function pipe(bytes: Uint8Array<ArrayBuffer>, stream: CompressionStream | DecompressionStream, limit: number): Promise<Uint8Array<ArrayBuffer>> {
  const writer = stream.writable.getWriter()
  // Not awaited: the readable side must drain concurrently. Errors surface on read().
  writer.write(bytes).catch(() => {})
  writer.close().catch(() => {})
  const reader = stream.readable.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) {
      await reader.cancel()
      throw new Error('too large')
    }
    chunks.push(value)
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

function toBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0))
}

/** A tape as a shareable run code: RPL1. + base64url(deflate-raw(JSON)). */
export async function encodeRun(tape: Tape): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(tape))
  return RUN_CODE_PREFIX + toBase64Url(await pipe(json, new CompressionStream('deflate-raw'), Number.POSITIVE_INFINITY))
}

/** The tape inside a run code, or null for anything that isn't a valid code. Whitespace is ignored. */
export async function decodeRun(code: string): Promise<Tape | null> {
  const clean = code.replace(/\s+/g, '')
  if (!clean.startsWith(RUN_CODE_PREFIX) || clean.length > MAX_RUN_CODE) return null
  try {
    const bytes = fromBase64Url(clean.slice(RUN_CODE_PREFIX.length))
    const json = new TextDecoder().decode(await pipe(bytes, new DecompressionStream('deflate-raw'), MAX_TAPE_JSON))
    const data: unknown = JSON.parse(json)
    return isTape(data) ? data : null
  } catch {
    return null
  }
}

/** Copies a run code; 'manual' means the page should show it for the player to copy. */
export async function copyRunCode(code: string, clipboard: Pick<Clipboard, 'writeText'> | undefined): Promise<'copied' | 'manual'> {
  if (!clipboard) return 'manual'
  try {
    await clipboard.writeText(code)
    return 'copied'
  } catch {
    return 'manual'
  }
}
```

If the installed TypeScript doesn't know `Uint8Array<ArrayBuffer>` (it was added in 5.7), use plain `Uint8Array` throughout.

- [ ] **Step 5: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/replay
git commit -m "feat(replay): encode and decode run codes"
```

---

### Task 17: Copy run code, Watch a run, playback HUD

**Files:**
- Modify: `Overlay.tsx`, `Replay.tsx`, `render/canvas.ts` (playback HUD), `web/src/styles/theme.css` (`.replay-watch`, `.replay-code`)
- Test: `Overlay.test.tsx`, `Replay.test.tsx`, `render/canvas.test.ts`

**Interfaces:**
- Consumes: Task 15 `Game.watch`, `Game.tape`, `Game.playback`, `GameView.playbackDate`; Task 16 `encodeRun`, `decodeRun`, `copyRunCode`
- Produces: Overlay props `playback?: boolean`, `onCopyRun?: () => void`, `copied?: boolean`, `runCode?: string | null`, `onWatch?: (code: string) => void`, `watchError?: string | null`; `RenderView.playbackDate?: string | null`

- [ ] **Step 1: Write the failing tests**

`Overlay.test.tsx`:

```tsx
const common = { stats, best: 40, score: 12, level: 3, date: '2026-09-30', dailyBest: 0 }

  it('offers Copy run code next to Share on the end-of-run card, but not in playback', () => {
    const onCopyRun = vi.fn()
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onShare={vi.fn()} onCopyRun={onCopyRun} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy run code' }))
    expect(onCopyRun).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Copy run code' })).toHaveClass('tbtn')
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={onCopyRun} playback />)
    expect(screen.queryByRole('button', { name: 'Copy run code' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'Playback finished' })).toBeInTheDocument()
  })

  it('confirms a copy, and shows the code pre-selected when it could not be copied', () => {
    const { rerender } = render(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={vi.fn()} copied />)
    expect(screen.getByRole('button', { name: '✓ Copied' })).toBeInTheDocument()
    rerender(<Overlay phase={{ kind: 'over', reason: 'x' }} {...common} onCopyRun={vi.fn()} runCode="RPL1.abc" />)
    const box = screen.getByRole('textbox', { name: 'Run code' }) as HTMLTextAreaElement
    expect(box).toHaveAttribute('readonly')
    expect(box.value).toBe('RPL1.abc')
    expect(document.activeElement).toBe(box)
    expect(box.selectionStart).toBe(0)
    expect(box.selectionEnd).toBe('RPL1.abc'.length)
  })

  it('submits a pasted code from the title card and shows an error', () => {
    const onWatch = vi.fn()
    render(<Overlay phase={{ kind: 'title' }} {...common} onWatch={onWatch} watchError="That run code isn't valid." />)
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a run code' }), { target: { value: ' RPL1.xyz ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Watch a run' }))
    expect(onWatch).toHaveBeenCalledWith(' RPL1.xyz ')
    expect(screen.getByText("That run code isn't valid.")).toBeInTheDocument()
  })
```

`render/canvas.test.ts`:

```ts
  it('marks playback in the HUD', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, lvl1(), { playbackDate: '2026-09-30' }), pal)
    expect(texts(calls)).toContain('▶ PLAYBACK · 2026-09-30')
  })
```

`Replay.test.tsx`:

```tsx
  it('rejects an invalid run code from the title card', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a run code' }), { target: { value: 'not a code' } })
    fireEvent.click(screen.getByRole('button', { name: 'Watch a run' }))
    expect(await screen.findByText("That run code isn't valid.")).toBeInTheDocument()
    expect(trackAction).toHaveBeenCalledWith('replay_watch')
  })

  it('starts playback from a valid run code', async () => {
    const code = await encodeRun({ ...emptyTape('2026-09-30'), liveTick: 0 })
    renderAt('/replay')
    await gameReady('Press Enter to start')
    fireEvent.change(screen.getByRole('textbox', { name: 'Paste a run code' }), { target: { value: code } })
    fireEvent.click(screen.getByRole('button', { name: 'Watch a run' }))
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Press Enter to start' })).toBeNull())
  })

  it('does not start the game when Enter is pressed in the run-code field', async () => {
    renderAt('/replay')
    await gameReady('Press Enter to start')
    const field = screen.getByRole('textbox', { name: 'Paste a run code' })
    field.focus()
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
  })
```

(import `encodeRun` from `./runtime/share`, `emptyTape` from `./runtime/tape`. With an empty tape, playback runs out of values at once; the test only checks that the title card is gone.)

- [ ] **Step 2: Run to check they fail**

Run: `cd web && npx vitest run src/pages/replay`
Expected: FAIL.

- [ ] **Step 3: Implement the Overlay**

`Overlay.tsx`: new optional props (see Interfaces). Title card, below the key hints:

```tsx
          {onWatch && <WatchForm onWatch={onWatch} error={watchError ?? null} />}
```

```tsx
function WatchForm({ onWatch, error }: { onWatch: (code: string) => void; error: string | null }) {
  const [code, setCode] = useState('')
  return (
    <form
      className="replay-watch"
      onSubmit={(e) => {
        e.preventDefault()
        onWatch(code)
      }}
    >
      <input className="input" aria-label="Paste a run code" placeholder="Paste a run code" value={code} onChange={(e) => setCode(e.target.value)} />
      <button type="submit" className="tbtn">Watch a run</button>
      {error && <p className="replay-error">{error}</p>}
    </form>
  )
}
```

Check `web/STYLEGUIDE.md` for the text-input class the dashboard uses (for example the search field on the Workflows page) and use that class instead of `input` if it differs.

The `over` card: the heading reads `Playback finished` when `playback`, otherwise `Workflow FAILED` as today. `replay-foot` holds the hint, then `Copy run code` (only `!playback && onCopyRun`, label `✓ Copied` when `copied`), then Share. Below the stats:

```tsx
          {runCode && <RunCodeBox code={runCode} />}
```

```tsx
function RunCodeBox({ code }: { code: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    ref.current?.focus()
    ref.current?.select()
  }, [code])
  return <textarea ref={ref} className="replay-code" aria-label="Run code" readOnly value={code} rows={3} />
}
```

`web/src/styles/theme.css`, next to the other `.replay-*` rules:

```css
.replay-watch { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.replay-watch .input { flex: 1 1 180px; min-width: 0; }
.replay-error { width: 100%; color: var(--fail-fg) !important; }
.replay-code { width: 100%; font-family: var(--mono); font-size: 11px; color: var(--text); background: var(--surface-2); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; resize: none; word-break: break-all; }
```

- [ ] **Step 4: Implement the page wiring and HUD**

`Replay.tsx`:

```tsx
  const [copied, setCopied] = useState(false)
  const [runCode, setRunCode] = useState<string | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)

  // A new end-of-run card starts without the previous run's copy state.
  useEffect(() => {
    if (game.phase.kind !== 'over') {
      setCopied(false)
      setRunCode(null)
    }
  }, [game.phase.kind])

  const onCopyRun = async () => {
    trackAction('replay_share_copy')
    const code = await encodeRun(game.tape)
    if ((await copyRunCode(code, navigator.clipboard)) === 'copied') setCopied(true)
    else setRunCode(code)
  }

  const onWatch = async (code: string) => {
    trackAction('replay_watch')
    const tape = await decodeRun(code)
    if (!tape || !game.watch(tape)) {
      setWatchError("That run code isn't valid.")
      return
    }
    setWatchError(null)
    stageRef.current?.focus()
  }
```

Pass `playback={game.playback} copied={copied} runCode={runCode} watchError={watchError} onCopyRun={() => void onCopyRun()} onWatch={(c) => void onWatch(c)}` to `Overlay`.

`render/canvas.ts`: `RenderView.playbackDate?: string | null`. In `drawHud`:

```ts
  if (view.playbackDate) banner(ctx, `▶ PLAYBACK · ${view.playbackDate}`, VIEW_H - 8, pal.glitch, FONT)
```

(`drawHud` takes the whole `view`: change its signature to `drawHud(ctx, view, pal)` and read `const state = view.state` at the top, so Task 8's retry and circuit-breaker rows keep working.)

- [ ] **Step 5: Run tests and typecheck**

Run: `cd web && npx vitest run src/pages/replay && npx tsc -b && npm run lint`
Expected: PASS, lint clean.

- [ ] **Step 6: Playtest check**

Run `cd web && npm run dev`, play a run to game over and click **Copy run code**. Open `/replay` in a private window (a second "machine"), paste the code into **Watch a run**, and check that the playback matches your run (score, crashes, retries) and shows `▶ PLAYBACK`. Esc should return to the title. Then block clipboard permission in the site settings and check that the code appears pre-selected in the textarea.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/replay web/src/styles/theme.css
git commit -m "feat(replay): copy a run code at game over and watch shared runs"
```

---

### Task 18: Final gates, docs and playtest

**Files:**
- Modify: `ARCHITECTURE.md` (the REPLAY paragraph), `docs/superpowers/specs/2026-09-30-replay-gameplay-v2-design.md` (status)

- [ ] **Step 1: Update the docs**

In `ARCHITECTURE.md`, extend the REPLAY paragraph (around line 572) with one sentence and the new spec link:

```markdown
v2 adds safety layers (circuit breaker, ×3 boost, a RetryPolicy rewind), a fan-out level, level montages, a daily seed and shareable run codes: a run is reproducible from its *tape* (inputs by live tick plus the quantised random values), which is what a run code carries. Design: `docs/superpowers/specs/2026-09-30-replay-gameplay-v2-design.md`.
```

Set the spec's `**Status:**` to `Implemented`.

- [ ] **Step 2: Run every gate**

Run: `make test`
Expected: Go and web tests PASS.

Run: `cd web && npm run lint && npm run build`
Expected: lint clean; the build succeeds and `dist/assets/` still has a separate `Replay-*.js` chunk (`ls web/dist/assets | grep -i replay`).

- [ ] **Step 3: Full playtest**

Play levels 0–5 in `cd web && npm run dev`, with reduced motion both off and on (macOS: System Settings → Accessibility → Display → Reduce motion), in light and dark theme. Check each of these:

- Tapping jump clears low racks, holding clears tall racks, jumps near a pit edge still work (coyote time), and early presses fire on landing (jump buffer).
- Each safety layer shows and behaves as specified. A tab close during a rewind, a montage and a boss phase resumes cleanly.
- The daily seed gives the same first obstacles after a reload on the same day.

Note any tuning changes (speeds, weights, grace) in the commit message.

- [ ] **Step 4: Commit**

```bash
git add ARCHITECTURE.md docs/superpowers/specs/2026-09-30-replay-gameplay-v2-design.md web/src/pages/replay
git commit -m "docs(replay): describe gameplay v2 and mark the spec implemented"
```



