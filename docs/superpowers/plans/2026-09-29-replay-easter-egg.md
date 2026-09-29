# REPLAY Easter Egg Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build REPLAY, a hidden side-scrolling runner at `/replay` in the dashboard SPA that teaches Dapr workflow replay and determinism through a genuinely event-sourced game engine.

**Architecture:** A pure, tick-based TypeScript engine (`step`, `replay`, seeded RNG, state hash) with exactly one impure port. A runtime layer (game controller state machine, chaos scheduler, rAF loop, localStorage persistence) drives it. A Canvas 2D renderer and a lazy-loaded React route draw it. A Konami-code hook in the App shell opens it. Everything runs in the browser only.

**Tech Stack:** React 19, react-router-dom 6.26 (`lazy` routes), TypeScript 5 (strict, `noUnusedLocals`), Vite 8, Vitest 4 + Testing Library + jsdom, Canvas 2D. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-29-replay-easter-egg-design.md`

## Global Constraints

- **Browser-only.** Nothing under `web/src/pages/replay/` calls the dashboard API, `fetch`, daprd or any state store. The only write is the game's own `localStorage` keys (`devdash.replay.save`, `devdash.replay.best`).
- **No new npm dependencies.**
- **The engine is pure.** Files in `web/src/pages/replay/engine/` (not their tests) must not reference `Math.random`, `Date`, `performance`, `window`, `document` or `localStorage` in code (comments and string literals are fine). Task 1 adds a guard test for this.
- **No hex colour literals in TS/TSX.** Canvas colours come from `theme.css` tokens read at runtime, and the existing `src/test/styleguide.test.ts` enforces this. Watch for strings like `#abc` in UI copy. `#${n}` and `#{n}` are fine.
- **No `className` template literal starting with an interpolation.** Use a static prefix, e.g. `` `node ${cls}` `` (also styleguide-enforced).
- **Code style:** no semicolons, single quotes, 2-space indent, matching `web/src`.
- **Out of scope for v1:** sound, touch/mobile controls, online leaderboard, timers/external events/fan-out/sagas, standalone build.
- **Discovery:** Konami code `↑ ↑ ↓ ↓ ← → ← → B A` (ignored while typing in input/textarea/select/contenteditable), or the direct URL `/replay`. Not linked from the sidebar, TopNav or command palette.
- **Commits:** the user's global CLAUDE.md forbids state-changing git commands unless the user explicitly asked in the current conversation. Before each "Commit" step, ask the user, unless they have already authorised commits for this execution run.
- **Worktree setup:** `web/node_modules` is not installed in this worktree. Run `cd web && npm install` once before the first test (Task 1, Step 0).
- **Test commands:** single file `cd web && npx vitest run src/pages/replay/engine/rng.test.ts`; whole web suite `make test-web`; full gate `make test`. On Windows, five `cmd`/`pkg/discovery` Go unit tests already fail on every branch (path separator and file mode). Don't count them as regressions.

## Review Focus

These are five inputs or conditions the spec implies but doesn't spell out, and a person playing would expect them to just work. Each one has a pinned test in the task that owns the code.

1. **A crash deep into a long level-4 run.** The fast-forward must not make the player wait (tens of thousands of ticks at 8× would take over a minute). Replay finishes within `REPLAY_MAX_FRAMES` (~2 s). Pinned in Task 6: *keeps any replay under REPLAY_MAX_FRAMES frames*.
2. **Holding a key down.** OS key auto-repeat must not queue a jump per repeat event or re-trigger Enter on overlays. Pinned in Task 7: *ignores auto-repeat keydowns*.
3. **Returning to a background tab after minutes**, or a slow frame. The loop must not simulate thousands of ticks at once. Pinned in Task 7: *clamps a long gap to MAX_TICKS_PER_FRAME*.
4. **Leaving the page mid-run** (back button, sidebar link). The loop must stop and the run must be saved so it can be resumed. Pinned in Task 9: *saves the run and stops the loop when the page unmounts mid-run*.
5. **Toggling the theme mid-game.** Canvas colours must follow without restarting the run. Pinned in Task 8: *watchTheme calls back when the root data-theme changes*.

---

## File map

```
web/src/pages/replay/
  engine/
    types.ts          constants, GameState, StartInput, HistoryEvent, Ports, ReplayResult
    rng.ts            mulberry32 nextRandom, mix, seedFrom
    hash.ts           hashState (FNV-1a over canonical state)
    levels.ts         LevelConfig, LevelTable, LEVELS, speedAt, chaosMeanTicks, CRASH_AFTER_PICKUP
    step.ts           physics/spawn/collision step, initialState, continueAsNew, constants
    replay.ts         createReplayer (incremental), replay
    purity.test.ts    guard: engine has no impure globals
  runtime/
    types.ts          Phase, Command, RunStats, Save
    persistence.ts    SaveStore, localSaveStore, parseSave/isSave, keys
    chaos.ts          ChaosScheduler
    game.ts           Game controller state machine
    keys.ts           keyToCommand
    loop.ts           startLoop (rAF fixed-timestep accumulator)
  render/
    palette.ts        readPalette, watchTheme, SLOT_TOKENS
    canvas.ts         render(ctx, view, palette)
  testing.ts          test helpers: makeLevels, counter, autopilot (imported only by tests)
  HistoryPanel.tsx    event list in the WorkflowDetail history look
  Overlay.tsx         title / resume / tip / paused / lost / over cards
  Replay.tsx          lazy route module, exports `Component`
web/src/lib/isEditableTarget.ts    shared "is the user typing" check
web/src/hooks/useKonami.ts         Konami-code hook, mounted in App
web/src/router.tsx                 + lazy 'replay' route
web/src/App.tsx                    + useKonami → navigate('/replay')
web/src/styles/theme.css           + .replay-* layout rules
ARCHITECTURE.md                    + one paragraph in §7 Routing
```

---

### Task 1: Engine foundations — types, RNG, hash, purity guard

**Files:**
- Create: `web/src/pages/replay/engine/types.ts`
- Create: `web/src/pages/replay/engine/rng.ts`
- Create: `web/src/pages/replay/engine/hash.ts`
- Test: `web/src/pages/replay/engine/rng.test.ts`, `web/src/pages/replay/engine/hash.test.ts`, `web/src/pages/replay/engine/purity.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - Constants `TICK_HZ = 60`, `VIEW_W = 480`, `VIEW_H = 270`, `GROUND_Y = 230`, `PLAYER_X = 80`, `SPAWN_X = 490`.
  - Types `Level`, `InputKind`, `EntityKind`, `Entity`, `Player`, `StartInput`, `GameState`, `HistoryEvent`, `OutcomeEvent`, `Ports`, `ReplayResult`.
  - `nextRandom(s: number): { state: number; value: number }`, `mix(s: number, v: number): number`, `seedFrom(s: number): number`.
  - `hashState(s: GameState): number` (uint32).

- [ ] **Step 0: Install web dependencies (once per worktree)**

Run: `cd web && npm install`
Expected: completes, `web/node_modules` exists.

- [ ] **Step 1: Write the types module** (types only, nothing to test by itself)

`web/src/pages/replay/engine/types.ts`:

```ts
// Engine data model. Everything in engine/ is pure: the same state, inputs and
// port values always produce the same result (enforced by purity.test.ts).

export const TICK_HZ = 60
export const VIEW_W = 480
export const VIEW_H = 270
/** y of the ground line; the player's feet rest here. */
export const GROUND_Y = 230
/** Fixed screen x of the player's left edge. */
export const PLAYER_X = 80
/** Screen x where new entities appear (just off the right edge). */
export const SPAWN_X = 490

export type Level = 0 | 1 | 2 | 3 | 4
export type InputKind = 'jump' | 'slideStart' | 'slideEnd'
export type EntityKind = 'low' | 'high' | 'coin' | 'orb' | 'crate'

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
}

export interface Player {
  /** Feet position; GROUND_Y when standing. */
  y: number
  vy: number
  sliding: boolean
}

/** The input a history segment starts from (a new run, a level, continue-as-new). */
export interface StartInput {
  level: Level
  seed: number
  score: number
  /** Ticks already spent in this level, drives the level-4 speed ramp. */
  elapsed: number
  /** True when this segment is the NonDeterministicError boss phase. */
  boss: boolean
}

export interface GameState {
  level: Level
  /** Ticks since this segment's StartInput. */
  tick: number
  elapsed: number
  /** mulberry32 state (uint32). */
  rng: number
  score: number
  multiplier: number
  multUntil: number
  player: Player
  /** World distance travelled this segment, px. */
  scroll: number
  nextSpawnAt: number
  nextId: number
  entities: Entity[]
  /** Tick at which the boss phase ends; 0 when not in a boss phase. */
  bossUntil: number
  status: 'running' | 'failed' | 'levelDone'
}

export type HistoryEvent =
  | { type: 'Input'; tick: number; kind: InputKind }
  | { type: 'ActivityCompleted'; tick: number; id: number; hash: number; result?: number }
  | { type: 'OrbTaken'; tick: number; id: number; hash: number }

/** Events produced by step() itself (everything except recorded inputs). */
export type OutcomeEvent = Exclude<HistoryEvent, { type: 'Input' }>

/**
 * The only way non-determinism reaches the engine.
 * - impure(): an outside value (Math.random at runtime). Orbs use it unrecorded.
 * - crateValue(id): the activity result for a crate. Live play calls impure();
 *   replay reads the recorded result from history.
 */
export interface Ports {
  impure: () => number
  crateValue: (id: number) => number
}

export type ReplayResult =
  | { ok: true; state: GameState }
  | { ok: false; divergedAt: number; state: GameState }
```

- [ ] **Step 2: Write failing tests for RNG and hash**

`web/src/pages/replay/engine/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { mix, nextRandom, seedFrom } from './rng'

function sequence(seed: number, n: number): number[] {
  const out: number[] = []
  let s = seed
  for (let i = 0; i < n; i++) {
    const r = nextRandom(s)
    s = r.state
    out.push(r.value)
  }
  return out
}

describe('rng', () => {
  it('produces the same sequence for the same seed', () => {
    expect(sequence(42, 20)).toEqual(sequence(42, 20))
  })

  it('produces values in [0, 1)', () => {
    for (const v of sequence(7, 1000)) {
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })

  it('diverges for different seeds', () => {
    expect(sequence(1, 5)).not.toEqual(sequence(2, 5))
  })

  it('returns uint32 states', () => {
    const { state } = nextRandom(0xffffffff)
    expect(Number.isInteger(state)).toBe(true)
    expect(state).toBeGreaterThanOrEqual(0)
    expect(state).toBeLessThanOrEqual(0xffffffff)
  })

  it('mix folds an outside value into the state deterministically', () => {
    expect(mix(123, 0.5)).toBe(mix(123, 0.5))
    expect(mix(123, 0.5)).not.toBe(mix(123, 0.25))
    expect(mix(123, 0.5)).toBeGreaterThanOrEqual(0)
  })

  it('seedFrom derives a different uint32 seed', () => {
    const s = seedFrom(99)
    expect(s).toBe(seedFrom(99))
    expect(s).not.toBe(99)
    expect(Number.isInteger(s) && s >= 0 && s <= 0xffffffff).toBe(true)
  })
})
```

`web/src/pages/replay/engine/hash.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashState } from './hash'
import { GROUND_Y, type GameState } from './types'

function state(): GameState {
  return {
    level: 1, tick: 10, elapsed: 10, rng: 12345, score: 3, multiplier: 1, multUntil: 0,
    player: { y: GROUND_Y, vy: 0, sliding: false },
    scroll: 40, nextSpawnAt: 240, nextId: 2,
    entities: [{ id: 1, kind: 'coin', x: 300, y: GROUND_Y - 30, w: 10, h: 10, taken: false }],
    bossUntil: 0, status: 'running',
  }
}

describe('hashState', () => {
  it('is stable for equal states', () => {
    expect(hashState(state())).toBe(hashState(state()))
  })

  it('returns a uint32', () => {
    const h = hashState(state())
    expect(Number.isInteger(h) && h >= 0 && h <= 0xffffffff).toBe(true)
  })

  it.each([
    ['tick', (s: GameState) => { s.tick += 1 }],
    ['rng', (s: GameState) => { s.rng += 1 }],
    ['score', (s: GameState) => { s.score += 1 }],
    ['player y', (s: GameState) => { s.player.y -= 0.5 }],
    ['sliding', (s: GameState) => { s.player.sliding = true }],
    ['entity x', (s: GameState) => { s.entities[0].x -= 0.25 }],
    ['entity taken', (s: GameState) => { s.entities[0].taken = true }],
    ['boss', (s: GameState) => { s.bossUntil = 900 }],
    ['status', (s: GameState) => { s.status = 'failed' }],
  ])('changes when %s changes', (_name, mutate) => {
    const a = state()
    const b = state()
    mutate(b)
    expect(hashState(b)).not.toBe(hashState(a))
  })
})
```

`web/src/pages/replay/engine/purity.test.ts`:

```ts
/**
 * The engine must be a pure function of (state, inputs, ports). This guard
 * fails if an engine source file reaches for an impure global directly.
 * Comments and string literals are ignored: docs and tip copy may name them.
 */
import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
const banned = /\b(Math\.random|Date|performance|window|document|localStorage)\b/

/** A source line with its string literals and comments removed. */
function code(line: string): string {
  if (/^\s*(\/\*|\*)/.test(line)) return ''
  return line
    .replace(/'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, "''")
    .replace(/\/\/.*$/, '')
}

describe('engine purity', () => {
  it('engine sources reference no impure globals', () => {
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    expect(files.length).toBeGreaterThan(0)
    const offenders: string[] = []
    for (const f of files) {
      readFileSync(path.join(dir, f), 'utf8').split('\n').forEach((line, i) => {
        if (banned.test(code(line))) offenders.push(`${f}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders, `impure globals in engine/:\n${offenders.join('\n')}`).toEqual([])
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/engine`
Expected: FAIL. `rng.test.ts` and `hash.test.ts` can't resolve `./rng` / `./hash`. `purity.test.ts` passes, since only types.ts exists.

- [ ] **Step 4: Implement RNG and hash**

`web/src/pages/replay/engine/rng.ts`:

```ts
// mulberry32: tiny, fast, good enough for level generation. The state lives in
// GameState so a replay regenerates exactly the same level.

export function nextRandom(s: number): { state: number; value: number } {
  const state = (s + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { state, value: ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

/** Folds an outside value in [0, 1) into the generator state. */
export function mix(s: number, v: number): number {
  return (s ^ Math.floor(v * 4294967296)) >>> 0
}

/** Derives a fresh seed for a continue-as-new segment. */
export function seedFrom(s: number): number {
  return Math.floor(nextRandom(s).value * 4294967296) >>> 0
}
```

`web/src/pages/replay/engine/hash.ts`:

```ts
import type { EntityKind, GameState } from './types'

const KIND: Record<EntityKind, number> = { low: 1, high: 2, coin: 3, orb: 4, crate: 5 }
const STATUS: Record<GameState['status'], number> = { running: 0, failed: 1, levelDone: 2 }

/** Quantises a float so equal-by-simulation values hash identically. */
function q(n: number): number {
  return Math.round(n * 100)
}

/** FNV-1a over a canonical serialisation of the state. Recorded with each event. */
export function hashState(s: GameState): number {
  const parts: number[] = [
    s.level, s.tick, s.elapsed, s.rng, q(s.score), s.multiplier, s.multUntil,
    q(s.player.y), q(s.player.vy), s.player.sliding ? 1 : 0,
    q(s.scroll), q(s.nextSpawnAt), s.nextId, s.bossUntil, STATUS[s.status], s.entities.length,
  ]
  for (const e of s.entities) parts.push(e.id, KIND[e.kind], q(e.x), q(e.y), e.taken ? 1 : 0)
  let h = 0x811c9dc5
  for (const p of parts) {
    const v = p | 0
    for (let i = 0; i < 4; i++) {
      h ^= (v >>> (i * 8)) & 0xff
      h = Math.imul(h, 0x01000193)
    }
  }
  return h >>> 0
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay/engine`
Expected: PASS (rng 6, hash 11, purity 1).

- [ ] **Step 6: Commit** (ask first, see Global Constraints)

```bash
git add web/src/pages/replay/engine
git commit -m "feat(replay): add engine types, seeded RNG and state hash"
```

---

### Task 2: Levels and the pure `step` function

**Files:**
- Create: `web/src/pages/replay/engine/levels.ts`
- Create: `web/src/pages/replay/engine/step.ts`
- Create: `web/src/pages/replay/testing.ts`
- Test: `web/src/pages/replay/engine/step.test.ts`

**Interfaces:**
- Consumes (Task 1): all of `types.ts`, `nextRandom`, `mix`, `seedFrom`, `hashState`.
- Produces:
  - `levels.ts`: `interface LevelConfig`, `type LevelTable = Record<Level, LevelConfig>`, `LEVELS: LevelTable`, `speedAt(cfg: LevelConfig, elapsed: number): number`, `chaosMeanTicks(cfg: LevelConfig, elapsed: number): number | null`, `CRASH_AFTER_PICKUP: readonly [number, number]`.
  - `step.ts`: constants `GRAVITY`, `JUMP_VY`, `PLAYER_W`, `PLAYER_H`, `SLIDE_H`, `BOOST_TICKS`, `BOSS_TICKS`; `initialState(start: StartInput): GameState`; `continueAsNew(s: GameState, patch?: Partial<StartInput>): StartInput`; `interface StepResult { state: GameState; events: OutcomeEvent[] }`; `step(prev: GameState, inputs: readonly InputKind[], ports: Ports, levels?: LevelTable): StepResult`.
  - `testing.ts`: `makeLevels(overrides?, perLevel?): LevelTable`, `counter(): () => number`, `autopilot(state: GameState, want: readonly EntityKind[]): InputKind[]`.

- [ ] **Step 1: Write the level table**

`web/src/pages/replay/engine/levels.ts`:

```ts
import type { EntityKind, Level } from './types'

export interface LevelConfig {
  name: string
  /** Scroll distance (px) that completes the level; Infinity for endless. */
  length: number
  /** px per tick at the start of the level. */
  speed: number
  /** Extra px per tick for every 60 s spent in the level. */
  ramp: number
  maxSpeed: number
  weights: Partial<Record<EntityKind, number>>
  /** What the NonDeterministicError boss phase spawns. */
  bossWeights: Partial<Record<EntityKind, number>>
  /** false: a crash loses everything (level 0). */
  durable: boolean
  /** Mean ticks between chaos crashes; null for no random chaos. */
  chaosMeanTicks: number | null
  /** Lower bound the mean shrinks toward with elapsed time (level 4). */
  chaosFloorTicks?: number
  /** Window for the first crash of the level, so the lesson always shows. */
  firstCrashTicks?: readonly [number, number]
  /** A fixed crash tick (level 0). */
  scriptedCrashAt?: number
  /** Pickups that guarantee a crash CRASH_AFTER_PICKUP ticks later. */
  crashAfterPickup?: readonly EntityKind[]
  tip: { body: string; href: string }
}

export type LevelTable = Record<Level, LevelConfig>

/** A listed pickup forces a crash this many ticks later (1–5 s). */
export const CRASH_AFTER_PICKUP: readonly [number, number] = [60, 300]

const DOCS = 'https://docs.dapr.io/developing-applications/building-blocks/workflow'
const BOSS: LevelConfig['bossWeights'] = { low: 3, high: 3 }

export const LEVELS: LevelTable = {
  0: {
    name: 'No Safety Net',
    length: Number.POSITIVE_INFINITY, speed: 3, ramp: 0, maxSpeed: 3,
    weights: { low: 2, coin: 3 }, bossWeights: BOSS,
    durable: false, chaosMeanTicks: null, scriptedCrashAt: 900,
    tip: {
      body: 'Your workflow keeps its progress in memory. Collect activities and see what happens when the process dies.',
      href: `${DOCS}/workflow-overview/`,
    },
  },
  1: {
    name: 'Replay',
    length: 6300, speed: 3.5, ramp: 0, maxSpeed: 3.5,
    weights: { low: 3, high: 2, coin: 4 }, bossWeights: BOSS,
    durable: true, chaosMeanTicks: 1200, firstCrashTicks: [480, 720],
    tip: {
      body: 'Dapr Workflow is enabled. Every step is written to history. After a crash the workflow replays that history to rebuild its state, and completed activities are not run again.',
      href: `${DOCS}/workflow-architecture/`,
    },
  },
  2: {
    name: 'Temptation',
    length: 8000, speed: 4, ramp: 0, maxSpeed: 4,
    weights: { low: 3, high: 2, coin: 3, orb: 2 }, bossWeights: BOSS,
    durable: true, chaosMeanTicks: 1200, crashAfterPickup: ['orb'],
    tip: {
      body: 'Glowing orbs give a ×3 boost, but they are Math.random(), Date.now() and fetch() called straight from workflow code. Replay gets a different answer.',
      href: `${DOCS}/workflow-features-concepts/#workflow-determinism-and-code-restraints`,
    },
  },
  3: {
    name: 'Wrap It',
    length: 9000, speed: 4.5, ramp: 0, maxSpeed: 4.5,
    weights: { low: 3, high: 2, coin: 3, orb: 1, crate: 2 }, bossWeights: BOSS,
    durable: true, chaosMeanTicks: 1200, crashAfterPickup: ['orb', 'crate'],
    tip: {
      body: 'Crates give the same boost through callActivity(). The activity result is saved to history, so replay reads it back instead of calling it again.',
      href: `${DOCS}/workflow-features-concepts/#workflow-determinism-and-code-restraints`,
    },
  },
  4: {
    name: 'Production',
    length: Number.POSITIVE_INFINITY, speed: 5, ramp: 0.5, maxSpeed: 9,
    weights: { low: 3, high: 3, coin: 3, orb: 1, crate: 1 }, bossWeights: BOSS,
    durable: true, chaosMeanTicks: 1200, chaosFloorTicks: 480,
    tip: {
      body: 'Everything at once, faster, with more chaos. How far can your workflow get?',
      href: `${DOCS}/workflow-patterns/`,
    },
  },
}

export function speedAt(cfg: LevelConfig, elapsed: number): number {
  return Math.min(cfg.maxSpeed, cfg.speed + cfg.ramp * (elapsed / 3600))
}

export function chaosMeanTicks(cfg: LevelConfig, elapsed: number): number | null {
  if (cfg.chaosMeanTicks === null) return null
  if (cfg.chaosFloorTicks === undefined) return cfg.chaosMeanTicks
  return Math.max(cfg.chaosFloorTicks, cfg.chaosMeanTicks - elapsed / 10)
}
```

- [ ] **Step 2: Write the test helpers**

`web/src/pages/replay/testing.ts` (imported only by tests; it holds no secrets or colours, so the styleguide scan is fine with it):

```ts
// Shared helpers for REPLAY tests. Not imported by production code.
import type { LevelConfig, LevelTable } from './engine/levels'
import { PLAYER_H, PLAYER_W } from './engine/step'
import { GROUND_Y, PLAYER_X, type EntityKind, type GameState, type InputKind, type Level } from './engine/types'

const BASE: LevelConfig = {
  name: 'Test',
  length: Number.POSITIVE_INFINITY, speed: 4, ramp: 0, maxSpeed: 4,
  weights: { coin: 1 }, bossWeights: { coin: 1 },
  durable: true, chaosMeanTicks: null,
  tip: { body: 'Test level', href: 'https://docs.dapr.io/' },
}

/** A level table where every level is BASE + overrides + its own perLevel patch. */
export function makeLevels(
  overrides: Partial<LevelConfig> = {},
  perLevel: Partial<Record<Level, Partial<LevelConfig>>> = {},
): LevelTable {
  const lv = (l: Level): LevelConfig => ({ ...BASE, ...overrides, ...perLevel[l] })
  return { 0: lv(0), 1: lv(1), 2: lv(2), 3: lv(3), 4: lv(4) }
}

/** A deterministic "impure" source that returns a different value on every call. */
export function counter(): () => number {
  let i = 0
  return () => ((++i) * 0.37) % 1
}

/**
 * Jumps when a wanted pickup that is out of standing reach is 0–24 px ahead.
 * With speed 4 and JUMP_VY -9 that reaches pickups 48–70 px above the ground;
 * low coins are collected by running through them, so it doesn't jump for those.
 */
export function autopilot(state: GameState, want: readonly EntityKind[]): InputKind[] {
  if (state.player.y < GROUND_Y) return []
  const ahead = state.entities.some((e) => {
    const gap = e.x - (PLAYER_X + PLAYER_W)
    const overhead = e.y + e.h <= GROUND_Y - PLAYER_H
    return !e.taken && overhead && want.includes(e.kind) && gap > 0 && gap <= 24
  })
  return ahead ? ['jump'] : []
}
```

- [ ] **Step 3: Write the failing step tests**

`web/src/pages/replay/engine/step.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { makeLevels } from '../testing'
import { hashState } from './hash'
import { LEVELS, chaosMeanTicks, speedAt } from './levels'
import { BOOST_TICKS, BOSS_TICKS, continueAsNew, initialState, step } from './step'
import { GROUND_Y, PLAYER_X, type Entity, type GameState, type InputKind, type Ports, type StartInput } from './types'

const start: StartInput = { level: 1, seed: 7, score: 0, elapsed: 0, boss: false }
const levels = makeLevels()
const ports = (over: Partial<Ports> = {}): Ports => ({ impure: () => 0.25, crateValue: () => 0.5, ...over })

/** A state with one entity that overlaps the player after this tick's scroll (speed 4). */
function withEntity(kind: Entity['kind'], y: number, w: number, h: number): GameState {
  const s = initialState(start)
  return { ...s, entities: [{ id: 99, kind, x: PLAYER_X + 4, y, w, h, taken: false }] }
}

function run(ticks: number, plan: (s: GameState) => InputKind[]): GameState {
  let s = initialState(start)
  for (let i = 0; i < ticks; i++) s = step(s, plan(s), ports(), levels).state
  return s
}

describe('initialState', () => {
  it('starts on the ground at tick 0', () => {
    const s = initialState(start)
    expect(s).toMatchObject({ tick: 0, level: 1, score: 0, status: 'running', bossUntil: 0 })
    expect(s.player).toEqual({ y: GROUND_Y, vy: 0, sliding: false })
  })

  it('arms the boss timer for a boss segment', () => {
    expect(initialState({ ...start, boss: true }).bossUntil).toBe(BOSS_TICKS)
  })
})

describe('step', () => {
  it('does not mutate the previous state', () => {
    const prev = withEntity('coin', GROUND_Y - 30, 10, 10)
    const snapshot = JSON.stringify(prev)
    step(prev, ['jump'], ports(), levels)
    expect(JSON.stringify(prev)).toBe(snapshot)
  })

  it('is deterministic for the same inputs', () => {
    const plan = (s: GameState): InputKind[] => (s.tick % 50 === 0 ? ['jump'] : [])
    expect(hashState(run(600, plan))).toBe(hashState(run(600, plan)))
  })

  it('jumps, rises and lands again', () => {
    let s = step(initialState(start), ['jump'], ports(), levels).state
    expect(s.player.y).toBeLessThan(GROUND_Y)
    let air = 1
    while (s.player.y < GROUND_Y) {
      s = step(s, [], ports(), levels).state
      air++
    }
    expect(air).toBeGreaterThanOrEqual(30)
    expect(air).toBeLessThanOrEqual(40)
    expect(s.player.vy).toBe(0)
  })

  it('ignores a jump while airborne', () => {
    const up = step(initialState(start), ['jump'], ports(), levels).state
    const a = step(up, [], ports(), levels).state
    const b = step(up, ['jump'], ports(), levels).state
    expect(b.player).toEqual(a.player)
  })

  it('fails on a high obstacle when standing, passes under it when sliding', () => {
    const high = withEntity('high', GROUND_Y - 44, 22, 30)
    expect(step(high, [], ports(), levels).state.status).toBe('failed')
    expect(step(high, ['slideStart'], ports(), levels).state.status).toBe('running')
  })

  it('fails on a low obstacle', () => {
    expect(step(withEntity('low', GROUND_Y - 20, 14, 20), [], ports(), levels).state.status).toBe('failed')
  })

  it('collects a coin as an ActivityCompleted event hashed with the new state', () => {
    const { state, events } = step(withEntity('coin', GROUND_Y - 30, 10, 10), [], ports(), levels)
    expect(state.score).toBe(1)
    expect(state.entities[0].taken).toBe(true)
    expect(events).toEqual([{ type: 'ActivityCompleted', tick: 0, id: 99, hash: hashState(state) }])
  })

  it('mixes an unrecorded impure value into the RNG on an orb pickup', () => {
    const impure = vi.fn(() => 0.25)
    const orb = withEntity('orb', GROUND_Y - 30, 12, 12)
    const a = step(orb, [], ports({ impure }), levels)
    const b = step(orb, [], ports({ impure: () => 0.75 }), levels)
    expect(impure).toHaveBeenCalledTimes(1)
    expect(a.events).toEqual([{ type: 'OrbTaken', tick: 0, id: 99, hash: hashState(a.state) }])
    expect(a.state.multiplier).toBe(3)
    expect(a.state.rng).not.toBe(b.state.rng)
  })

  it('takes a crate result from crateValue and records it', () => {
    const impure = vi.fn(() => 0.25)
    const crateValue = vi.fn(() => 0.5)
    const { state, events } = step(withEntity('crate', GROUND_Y - 30, 14, 14), [], ports({ impure, crateValue }), levels)
    expect(crateValue).toHaveBeenCalledWith(99)
    expect(impure).not.toHaveBeenCalled()
    expect(events).toEqual([{ type: 'ActivityCompleted', tick: 0, id: 99, hash: hashState(state), result: 0.5 }])
    expect(state.multiplier).toBe(3)
    expect(state.score).toBe(3)
  })

  it('drops the multiplier after BOOST_TICKS', () => {
    let s = step(withEntity('orb', GROUND_Y - 30, 12, 12), [], ports(), levels).state
    for (let i = 0; i < BOOST_TICKS; i++) s = step(s, [], ports(), levels).state
    expect(s.multiplier).toBe(1)
  })

  it('finishes the level at its length and then stops advancing', () => {
    const short = makeLevels({ length: 40 })
    let s = initialState(start)
    for (let i = 0; i < 10; i++) s = step(s, [], ports(), short).state
    expect(s.status).toBe('levelDone')
    expect(step(s, [], ports(), short).state).toBe(s)
  })

  it('spawns only the kinds the level weights allow', () => {
    const crates = makeLevels({ weights: { crate: 1 } })
    let s = initialState(start)
    for (let i = 0; i < 400; i++) s = step(s, [], ports(), crates).state
    expect(s.entities.length).toBeGreaterThan(0)
    expect(s.entities.every((e) => e.kind === 'crate')).toBe(true)
  })

  it('spawns from bossWeights during a boss segment', () => {
    const table = makeLevels({ weights: { coin: 1 }, bossWeights: { high: 1 } })
    let s = initialState({ ...start, boss: true })
    for (let i = 0; i < 120; i++) s = step(s, ['slideStart'], ports(), table).state
    expect(s.entities.length).toBeGreaterThan(0)
    expect(s.entities.every((e) => e.kind === 'high')).toBe(true)
  })
})

describe('continueAsNew', () => {
  it('carries level, score and elapsed time with a derived seed', () => {
    const s = { ...initialState(start), score: 12, elapsed: 500 }
    const next = continueAsNew(s)
    expect(next).toMatchObject({ level: 1, score: 12, elapsed: 500, boss: false })
    expect(next.seed).not.toBe(s.rng)
    expect(continueAsNew(s, { boss: true, level: 2 })).toMatchObject({ boss: true, level: 2 })
  })

  it('a continued segment starts from a reproducible state', () => {
    const next = continueAsNew({ ...initialState(start), score: 4 })
    expect(hashState(initialState(next))).toBe(hashState(initialState(next)))
  })
})

describe('levels', () => {
  it('ramps speed with elapsed time up to the cap', () => {
    const cfg = LEVELS[4]
    expect(speedAt(cfg, 0)).toBe(5)
    expect(speedAt(cfg, 3600)).toBeCloseTo(5.5)
    expect(speedAt(cfg, 10_000_000)).toBe(9)
  })

  it('shrinks the level-4 chaos mean toward its floor', () => {
    expect(chaosMeanTicks(LEVELS[4], 0)).toBe(1200)
    expect(chaosMeanTicks(LEVELS[4], 100_000)).toBe(480)
    expect(chaosMeanTicks(LEVELS[0], 0)).toBeNull()
  })

  it('only level 0 is non-durable and every tip links to the Dapr docs', () => {
    expect(LEVELS[0].durable).toBe(false)
    for (const l of [1, 2, 3, 4] as const) expect(LEVELS[l].durable).toBe(true)
    for (const l of [0, 1, 2, 3, 4] as const) expect(LEVELS[l].tip.href).toMatch(/^https:\/\/docs\.dapr\.io\//)
  })
})
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/engine/step.test.ts`
Expected: FAIL, cannot resolve `./step`.

- [ ] **Step 5: Implement `step.ts`**

`web/src/pages/replay/engine/step.ts`:

```ts
import { hashState } from './hash'
import { LEVELS, speedAt, type LevelConfig, type LevelTable } from './levels'
import { mix, nextRandom, seedFrom } from './rng'
import {
  GROUND_Y, PLAYER_X, SPAWN_X, TICK_HZ,
  type EntityKind, type GameState, type InputKind, type OutcomeEvent, type Ports, type StartInput,
} from './types'

export const GRAVITY = 0.5
export const JUMP_VY = -9
export const PLAYER_W = 16
export const PLAYER_H = 24
export const SLIDE_H = 12
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

export function initialState(start: StartInput): GameState {
  return {
    level: start.level,
    tick: 0,
    elapsed: start.elapsed,
    rng: start.seed >>> 0,
    score: start.score,
    multiplier: 1,
    multUntil: 0,
    player: { y: GROUND_Y, vy: 0, sliding: false },
    scroll: 0,
    nextSpawnAt: FIRST_SPAWN_AT,
    nextId: 1,
    entities: [],
    bossUntil: start.boss ? BOSS_TICKS : 0,
    status: 'running',
  }
}

/** Snapshot input for a fresh history segment (Dapr's ContinueAsNew). */
export function continueAsNew(s: GameState, patch: Partial<StartInput> = {}): StartInput {
  return { level: s.level, seed: seedFrom(s.rng), score: s.score, elapsed: s.elapsed, boss: false, ...patch }
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
    case 'high': return GROUND_Y - 44
    case 'coin': return r < 0.5 ? GROUND_Y - 30 : GROUND_Y - 70
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
      events.push({ type: 'ActivityCompleted', tick: s.tick, id: e.id, hash: 0 })
    } else if (e.kind === 'orb') {
      s.rng = mix(s.rng, ports.impure())
      boost(s)
      events.push({ type: 'OrbTaken', tick: s.tick, id: e.id, hash: 0 })
    } else {
      const result = ports.crateValue(e.id)
      s.rng = mix(s.rng, result)
      boost(s)
      s.score += s.multiplier
      events.push({ type: 'ActivityCompleted', tick: s.tick, id: e.id, hash: 0, result })
    }
  }

  if (s.status === 'running' && s.scroll >= cfg.length) s.status = 'levelDone'
  s.tick += 1
  s.elapsed += 1
  const hash = hashState(s)
  return { state: s, events: events.map((e) => ({ ...e, hash })) }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay`
Expected: PASS, including `purity.test.ts` (levels.ts and step.ts reference no banned globals).

- [ ] **Step 7: Commit** (ask first)

```bash
git add web/src/pages/replay
git commit -m "feat(replay): add level table and pure step function"
```

---

### Task 3: Replay with divergence detection

**Files:**
- Create: `web/src/pages/replay/engine/replay.ts`
- Test: `web/src/pages/replay/engine/replay.test.ts`

**Interfaces:**
- Consumes: `step`, `initialState` (Task 2); `LEVELS`, `LevelTable` (Task 2); types (Task 1); test helpers `makeLevels`, `counter`, `autopilot` (Task 2).
- Produces:
  - `interface Replayer { readonly state: GameState; readonly done: boolean; advance(maxTicks: number): void; result(): ReplayResult }`
  - `createReplayer(start: StartInput, history: readonly HistoryEvent[], toTick: number, impure: () => number, levels?: LevelTable): Replayer`
  - `replay(start, history, toTick, impure, levels?): ReplayResult`
  - `divergedAt` is the index into `history` of the first recorded event that didn't match. If the replay produced an event the history lacks, or died, it's the index of the next unconsumed history event. The replay continues past the divergence to `toTick`, so the returned `state` is the diverged world the boss phase runs on. It stops early, one tick before, if the diverged replay would hit an obstacle.

- [ ] **Step 1: Write the failing tests**

`web/src/pages/replay/engine/replay.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { autopilot, counter, makeLevels } from '../testing'
import { hashState } from './hash'
import type { LevelTable } from './levels'
import { createReplayer, replay } from './replay'
import { initialState, step } from './step'
import type { EntityKind, GameState, HistoryEvent, StartInput } from './types'

const start: StartInput = { level: 1, seed: 42, score: 0, elapsed: 0, boss: false }

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
    expect(live.history.some((e) => e.type === 'ActivityCompleted')).toBe(true)
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
    expect(live.history.some((e) => e.type === 'ActivityCompleted' && e.result !== undefined)).toBe(true)
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/engine/replay.test.ts`
Expected: FAIL, cannot resolve `./replay`.

- [ ] **Step 3: Implement `replay.ts`**

`web/src/pages/replay/engine/replay.ts`:

```ts
import { LEVELS, type LevelTable } from './levels'
import { initialState, step } from './step'
import type { GameState, HistoryEvent, InputKind, OutcomeEvent, Ports, ReplayResult, StartInput } from './types'

export interface Replayer {
  readonly state: GameState
  readonly done: boolean
  /** Runs up to maxTicks more ticks (or until done). */
  advance(maxTicks: number): void
  result(): ReplayResult
}

function matches(expected: readonly OutcomeEvent[], actual: readonly OutcomeEvent[]): boolean {
  return (
    expected.length === actual.length &&
    expected.every((e, i) => e.type === actual[i].type && e.id === actual[i].id && e.hash === actual[i].hash)
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
    if (e.type === 'ActivityCompleted' && e.result !== undefined) crateResults.set(e.id, e.result)
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
          if (e.type === 'Input') inputs.push(e.kind)
          else expected.push(e)
          cursor++
        }
        const next = step(state, inputs, ports, levels)
        if (divergedAt === null && !matches(expected, next.events)) {
          const firstOutcome = history.slice(firstIndex, cursor).findIndex((e) => e.type !== 'Input')
          divergedAt = firstOutcome >= 0 ? firstIndex + firstOutcome : cursor
        }
        if (next.state.status === 'failed') {
          // A replay that dies has diverged from a run that didn't: stop just before.
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/pages/replay/engine
git commit -m "feat(replay): replay history with non-determinism detection"
```

---

### Task 4: Runtime types and persistence

**Files:**
- Create: `web/src/pages/replay/runtime/types.ts`
- Create: `web/src/pages/replay/runtime/persistence.ts`
- Test: `web/src/pages/replay/runtime/persistence.test.ts`

**Interfaces:**
- Consumes: `HistoryEvent`, `StartInput`, `Level` (Task 1).
- Produces:
  - `runtime/types.ts`: `RunStats { replays; fromHistory; executed; incidents }` (numbers); `Phase` union; `Command = 'jump' | 'slideStart' | 'slideEnd' | 'pause' | 'confirm' | 'cancel'`; `Save { version: 1; start; history; tick; stats; divergedAt: number | null }`.
  - `persistence.ts`: `SAVE_KEY`, `BEST_KEY`, `SAVE_VERSION = 1`, `interface SaveStore { load(): Save | null; save(save: Save): void; clear(): void; loadBest(): number; saveBest(score: number): void }`, `localSaveStore(storage?: () => Storage): SaveStore`, `parseSave(raw: string | null): Save | null`, `isSave(v: unknown): v is Save`.

- [ ] **Step 1: Write the runtime types**

`web/src/pages/replay/runtime/types.ts`:

```ts
import type { HistoryEvent, Level, StartInput } from '../engine/types'

export interface RunStats {
  /** Crash recoveries (and resumes) that replayed history. */
  replays: number
  /** Activities served from history during replays. */
  fromHistory: number
  /** Activities actually executed in live play. */
  executed: number
  /** Non-determinism incidents (boss phases). */
  incidents: number
}

export type Phase =
  | { kind: 'title' }
  | { kind: 'resume'; tick: number }
  | { kind: 'tip'; level: Level }
  | { kind: 'playing' }
  | { kind: 'paused' }
  | { kind: 'crashing'; framesLeft: number }
  | { kind: 'replaying' }
  | { kind: 'lost' }
  | { kind: 'over'; reason: string }

export type Command = 'jump' | 'slideStart' | 'slideEnd' | 'pause' | 'confirm' | 'cancel'

export interface Save {
  version: 1
  start: StartInput
  history: HistoryEvent[]
  /** The tick to replay to on resume. */
  tick: number
  stats: RunStats
  divergedAt: number | null
}
```

- [ ] **Step 2: Write the failing persistence tests**

`web/src/pages/replay/runtime/persistence.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import { BEST_KEY, SAVE_KEY, localSaveStore, parseSave } from './persistence'
import type { Save } from './types'

const sample: Save = {
  version: 1,
  start: { level: 2, seed: 99, score: 5, elapsed: 0, boss: false },
  history: [
    { type: 'Input', tick: 3, kind: 'jump' },
    { type: 'ActivityCompleted', tick: 10, id: 4, hash: 123 },
    { type: 'OrbTaken', tick: 20, id: 5, hash: 456 },
    { type: 'ActivityCompleted', tick: 30, id: 6, hash: 789, result: 0.5 },
  ],
  tick: 31,
  stats: { replays: 1, fromHistory: 2, executed: 3, incidents: 0 },
  divergedAt: null,
}

describe('localSaveStore', () => {
  beforeEach(() => localStorage.clear())

  it('round-trips a save', () => {
    const store = localSaveStore()
    store.save(sample)
    expect(store.load()).toEqual(sample)
  })

  it('returns null when there is no save, and after clear()', () => {
    const store = localSaveStore()
    expect(store.load()).toBeNull()
    store.save(sample)
    store.clear()
    expect(store.load()).toBeNull()
  })

  it('round-trips the best score and ignores garbage', () => {
    const store = localSaveStore()
    expect(store.loadBest()).toBe(0)
    store.saveBest(42)
    expect(store.loadBest()).toBe(42)
    localStorage.setItem(BEST_KEY, 'lots')
    expect(store.loadBest()).toBe(0)
    localStorage.setItem(BEST_KEY, '-3')
    expect(store.loadBest()).toBe(0)
  })

  it('never throws when storage is unavailable', () => {
    const store = localSaveStore(() => {
      throw new Error('denied')
    })
    expect(store.load()).toBeNull()
    expect(() => store.save(sample)).not.toThrow()
    expect(() => store.clear()).not.toThrow()
    expect(store.loadBest()).toBe(0)
    expect(() => store.saveBest(1)).not.toThrow()
  })

  it('never throws when storage methods throw (quota, private mode)', () => {
    const broken = {
      getItem: () => { throw new Error('x') },
      setItem: () => { throw new Error('x') },
      removeItem: () => { throw new Error('x') },
    } as unknown as Storage
    const store = localSaveStore(() => broken)
    expect(store.load()).toBeNull()
    expect(() => store.save(sample)).not.toThrow()
  })

  it('stores under the versioned key', () => {
    localSaveStore().save(sample)
    expect(localStorage.getItem(SAVE_KEY)).not.toBeNull()
  })
})

describe('parseSave', () => {
  const mutate = (fn: (s: Record<string, unknown>) => void): string => {
    const s = JSON.parse(JSON.stringify(sample)) as Record<string, unknown>
    fn(s)
    return JSON.stringify(s)
  }

  it.each([
    ['null', null],
    ['corrupt JSON', 'not json{'],
    ['another version', mutate((s) => { s.version = 2 })],
    ['a bad level', mutate((s) => { (s.start as Record<string, unknown>).level = 7 })],
    ['an unknown event type', mutate((s) => { (s.history as unknown[]).push({ type: 'Nope', tick: 30 }) })],
    ['out-of-order events', mutate((s) => { (s.history as unknown[]).push({ type: 'Input', tick: 1, kind: 'jump' }) })],
    ['an event at or after the save tick', mutate((s) => { s.tick = 30 })],
    ['missing stats', mutate((s) => { delete s.stats })],
  ])('rejects %s', (_name, raw) => {
    expect(parseSave(raw as string | null)).toBeNull()
  })

  it('accepts a valid save', () => {
    expect(parseSave(JSON.stringify(sample))).toEqual(sample)
  })
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime/persistence.test.ts`
Expected: FAIL, cannot resolve `./persistence`.

- [ ] **Step 4: Implement persistence**

`web/src/pages/replay/runtime/persistence.ts`:

```ts
import type { HistoryEvent, StartInput } from '../engine/types'
import type { RunStats, Save } from './types'

export const SAVE_KEY = 'devdash.replay.save'
export const BEST_KEY = 'devdash.replay.best'
export const SAVE_VERSION = 1

export interface SaveStore {
  load(): Save | null
  save(save: Save): void
  clear(): void
  loadBest(): number
  saveBest(score: number): void
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function isStart(v: unknown): v is StartInput {
  return (
    isObj(v) && [0, 1, 2, 3, 4].includes(v.level as number) &&
    isNum(v.seed) && isNum(v.score) && isNum(v.elapsed) && typeof v.boss === 'boolean'
  )
}

function isEvent(v: unknown): v is HistoryEvent {
  if (!isObj(v) || !isNum(v.tick) || v.tick < 0) return false
  switch (v.type) {
    case 'Input': return v.kind === 'jump' || v.kind === 'slideStart' || v.kind === 'slideEnd'
    case 'OrbTaken': return isNum(v.id) && isNum(v.hash)
    case 'ActivityCompleted': return isNum(v.id) && isNum(v.hash) && (v.result === undefined || isNum(v.result))
    default: return false
  }
}

function isStats(v: unknown): v is RunStats {
  return isObj(v) && isNum(v.replays) && isNum(v.fromHistory) && isNum(v.executed) && isNum(v.incidents)
}

export function isSave(v: unknown): v is Save {
  if (!isObj(v) || v.version !== SAVE_VERSION || !isStart(v.start) || !isStats(v.stats)) return false
  if (!isNum(v.tick) || v.tick < 0) return false
  if (!(v.divergedAt === null || isNum(v.divergedAt))) return false
  if (!Array.isArray(v.history) || !v.history.every(isEvent)) return false
  const history = v.history as HistoryEvent[]
  // Ordered by tick, and every event happened before the tick we replay to.
  return history.every((e, i) => (i === 0 || history[i - 1].tick <= e.tick) && e.tick < (v.tick as number))
}

export function parseSave(raw: string | null): Save | null {
  if (!raw) return null
  try {
    const data: unknown = JSON.parse(raw)
    return isSave(data) ? data : null
  } catch {
    return null
  }
}

/** localStorage-backed store. Every access is guarded: the game runs without storage. */
export function localSaveStore(storage: () => Storage = () => localStorage): SaveStore {
  function attempt<T>(fn: (s: Storage) => T, fallback: T): T {
    try {
      return fn(storage())
    } catch {
      return fallback
    }
  }
  return {
    load: () => attempt((s) => parseSave(s.getItem(SAVE_KEY)), null),
    save: (save) => attempt((s) => s.setItem(SAVE_KEY, JSON.stringify(save)), undefined),
    clear: () => attempt((s) => s.removeItem(SAVE_KEY), undefined),
    loadBest: () =>
      attempt((s) => {
        const n = Number(s.getItem(BEST_KEY))
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
      }, 0),
    saveBest: (score) => attempt((s) => s.setItem(BEST_KEY, String(score)), undefined),
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: PASS.

- [ ] **Step 6: Commit** (ask first)

```bash
git add web/src/pages/replay/runtime
git commit -m "feat(replay): add runtime types and guarded save storage"
```

---

### Task 5: Chaos scheduler

**Files:**
- Create: `web/src/pages/replay/runtime/chaos.ts`
- Test: `web/src/pages/replay/runtime/chaos.test.ts`

**Interfaces:**
- Consumes: `LEVELS`, `LevelTable`, `chaosMeanTicks`, `CRASH_AFTER_PICKUP` (Task 2); `EntityKind`, `Level` (Task 1); `makeLevels` (Task 2).
- Produces: `class ChaosScheduler { constructor(rand: () => number, levels?: LevelTable); readonly nextCrashAt: number | null; start(level: Level, firstOfLevel: boolean): void; scheduleNext(level: Level, tick: number, elapsed: number): void; onPickup(level: Level, kind: EntityKind, tick: number): void; isDue(tick: number): boolean }`. All ticks are segment ticks (`GameState.tick`). Every segment starts at tick 0.

- [ ] **Step 1: Write the failing tests**

`web/src/pages/replay/runtime/chaos.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime/chaos.test.ts`
Expected: FAIL, cannot resolve `./chaos`.

- [ ] **Step 3: Implement the scheduler**

`web/src/pages/replay/runtime/chaos.ts`:

```ts
import { CRASH_AFTER_PICKUP, LEVELS, chaosMeanTicks, type LevelTable } from '../engine/levels'
import type { EntityKind, Level } from '../engine/types'

/**
 * Decides when the "process" dies. Chaos is the outside world, so this uses
 * real randomness on purpose; crashes are never part of the history.
 */
export class ChaosScheduler {
  private dueAt: number | null = null

  constructor(
    private readonly rand: () => number,
    private readonly levels: LevelTable = LEVELS,
  ) {}

  get nextCrashAt(): number | null {
    return this.dueAt
  }

  /** Called at tick 0 of every segment. */
  start(level: Level, firstOfLevel: boolean): void {
    const cfg = this.levels[level]
    if (cfg.scriptedCrashAt !== undefined) this.dueAt = cfg.scriptedCrashAt
    else if (firstOfLevel && cfg.firstCrashTicks) this.dueAt = this.between(cfg.firstCrashTicks)
    else this.scheduleNext(level, 0, 0)
  }

  scheduleNext(level: Level, tick: number, elapsed: number): void {
    const mean = chaosMeanTicks(this.levels[level], elapsed)
    this.dueAt = mean === null ? null : tick + Math.round(mean * (0.5 + this.rand()))
  }

  onPickup(level: Level, kind: EntityKind, tick: number): void {
    if (!this.levels[level].crashAfterPickup?.includes(kind)) return
    const at = tick + this.between(CRASH_AFTER_PICKUP)
    if (this.dueAt === null || at < this.dueAt) this.dueAt = at
  }

  isDue(tick: number): boolean {
    return this.dueAt !== null && tick >= this.dueAt
  }

  private between([lo, hi]: readonly [number, number]): number {
    return lo + Math.round(this.rand() * (hi - lo))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay/runtime`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/pages/replay/runtime
git commit -m "feat(replay): add chaos crash scheduler"
```

---

### Task 6: Game controller

**Files:**
- Create: `web/src/pages/replay/runtime/game.ts`
- Test: `web/src/pages/replay/runtime/game.test.ts`

**Interfaces:**
- Consumes: `step`, `initialState`, `continueAsNew`, `BOSS_TICKS` (Task 2); `createReplayer`, `Replayer` (Task 3); `LEVELS`, `LevelTable` (Task 2); `ChaosScheduler` (Task 5); `SaveStore` (Task 4); `Phase`, `Command`, `RunStats`, `Save` (Task 4); test helpers (Task 2).
- Produces:
  - Constants `CRASH_FRAMES = 36`, `REPLAY_MIN_TICKS_PER_FRAME = 8`, `REPLAY_MAX_FRAMES = 120`, `NOTICE_TICKS = 180`.
  - `interface GameDeps { impure: () => number; chaosRand: () => number; newSeed: () => number; store: SaveStore; levels?: LevelTable }`.
  - `interface GameView { state: GameState; phase: Phase; notice: string | null; divergedAt: number | null }`.
  - `class Game`:
    - public fields `phase: Phase`, `start: StartInput`, `history: HistoryEvent[]`, `state: GameState`, `stats: RunStats`, `best: number`, `divergedAt: number | null`
    - methods `subscribe(fn): () => void` and `getVersion(): number` (arrow properties, for `useSyncExternalStore`), `view(): GameView`, `command(c: Command): void`, `frame(liveTicks: number): void`, `suspend(): void`, `save(): void`

**Phase flow:**
- `title` → Enter → `tip(0)` → Enter → `playing`.
- `playing` → chaos due → `crashing` (36 frames) → `replaying` → `playing`.
  - On a non-durable level it goes → `lost` instead of `replaying`.
  - On a divergence it goes → boss segment in `playing` with `state.bossUntil > 0`.
- boss survived → hotfix: continue-as-new → `playing`.
- `failed` → `over`.
- `levelDone` → continue-as-new → `tip(level+1)`.
- `lost` → Enter → `tip(1)` with a fresh run.
- `resume` appears at construction when a save exists. Enter → `replaying`. Esc discards the save → `title`.
- Esc or `p` in `playing` → `paused`.

- [ ] **Step 1: Write the failing tests**

`web/src/pages/replay/runtime/game.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { hashState } from '../engine/hash'
import { BOSS_TICKS } from '../engine/step'
import { GROUND_Y, PLAYER_X, type EntityKind } from '../engine/types'
import { autopilot, counter, makeLevels } from '../testing'
import { CRASH_FRAMES, Game, REPLAY_MAX_FRAMES, type GameDeps } from './game'
import type { SaveStore } from './persistence'
import type { Save } from './types'

type MemoryStore = SaveStore & { saved: Save | null; best: number }

function memoryStore(): MemoryStore {
  const s: MemoryStore = {
    saved: null,
    best: 0,
    load: () => (s.saved ? (JSON.parse(JSON.stringify(s.saved)) as Save) : null),
    save: (x) => { s.saved = JSON.parse(JSON.stringify(x)) as Save },
    clear: () => { s.saved = null },
    loadBest: () => s.best,
    saveBest: (n) => { s.best = n },
  }
  return s
}

function deps(overrides: Partial<GameDeps> = {}): GameDeps {
  return { impure: counter(), chaosRand: () => 0.5, newSeed: () => 42, store: memoryStore(), levels: makeLevels(), ...overrides }
}

/** title → tip(0) → playing */
function play(game: Game): void {
  game.command('confirm')
  game.command('confirm')
}

/** Advances one tick per frame, steering toward `want` pickups outside the boss phase. */
function runUntil(game: Game, done: (g: Game) => boolean, want: readonly EntityKind[] = [], max = 20_000): number {
  for (let frames = 0; frames < max; frames++) {
    if (done(game)) return frames
    if (game.phase.kind === 'playing' && game.state.bossUntil === 0) {
      for (const input of autopilot(game.state, want)) game.command(input)
    }
    game.frame(1)
  }
  throw new Error('condition not reached')
}

const is = (kind: string) => (g: Game) => g.phase.kind === kind

describe('Game', () => {
  it('goes from the title screen to the level-0 tip to playing', () => {
    const game = new Game(deps())
    expect(game.phase.kind).toBe('title')
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 0 })
    game.command('confirm')
    expect(game.phase.kind).toBe('playing')
  })

  it('records inputs in the history at the tick they are applied', () => {
    const game = new Game(deps())
    play(game)
    game.frame(3)
    game.command('jump')
    game.frame(1)
    expect(game.history[0]).toEqual({ type: 'Input', tick: 3, kind: 'jump' })
  })

  it('crashes, replays the history and resumes on the exact same tick and state', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [300, 300] }) }))
    play(game)
    runUntil(game, is('crashing'), ['coin'])
    const tick = game.state.tick
    const hash = hashState(game.state)
    expect(tick).toBe(300)
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.tick).toBe(tick)
    expect(hashState(game.state)).toBe(hash)
    const activities = game.history.filter((e) => e.type === 'ActivityCompleted').length
    expect(activities).toBeGreaterThan(0)
    expect(game.stats).toMatchObject({ replays: 1, fromHistory: activities, executed: activities, incidents: 0 })
    expect(game.view().notice).toMatch(/resumed at tick 300/)
  })

  it('keeps any replay under REPLAY_MAX_FRAMES frames, however long the history', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [6000, 6000] }) }))
    play(game)
    runUntil(game, is('crashing'), ['coin'])
    const frames = runUntil(game, is('playing'))
    expect(frames).toBeLessThanOrEqual(CRASH_FRAMES + REPLAY_MAX_FRAMES + 1)
    expect(game.state.tick).toBe(6000)
  })

  it('ignores input while crashing or replaying', () => {
    const game = new Game(deps({ levels: makeLevels({ firstCrashTicks: [100, 100] }) }))
    play(game)
    runUntil(game, is('crashing'))
    const before = game.history.length
    game.command('jump')
    runUntil(game, is('playing'))
    game.frame(1)
    expect(game.history.length).toBe(before)
  })

  it('loses all progress on a crash in a non-durable level, then enables durability on level 1', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: makeLevels({}, { 0: { durable: false, scriptedCrashAt: 120 } }) }))
    play(game)
    runUntil(game, is('lost'), ['coin'])
    expect(store.saved).toBeNull()
    expect(game.stats.replays).toBe(0)
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 1 })
    expect(game.state.score).toBe(0)
    expect(game.history).toEqual([])
    expect(game.view().notice).toBe('Dapr Workflow enabled')
  })

  it('moves to the next level via continue-as-new, carrying the score', () => {
    const game = new Game(deps({ levels: makeLevels({ length: 1200 }) }))
    play(game)
    runUntil(game, (g) => g.phase.kind === 'tip' && g.phase.level === 1, ['coin'])
    expect(game.start.level).toBe(1)
    expect(game.start.score).toBeGreaterThan(0)
    expect(game.state.score).toBe(game.start.score)
    expect(game.history).toEqual([])
    expect(game.state.tick).toBe(0)
  })

  it('detects non-determinism after an orb pickup and enters the boss phase', () => {
    const game = new Game(deps({ levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    const orbIndex = game.history.findIndex((e) => e.type === 'OrbTaken')
    expect(orbIndex).toBeGreaterThanOrEqual(0)
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.bossUntil).toBe(BOSS_TICKS)
    expect(game.start.boss).toBe(true)
    expect(game.divergedAt).toBe(orbIndex)
    expect(game.history).toEqual([])
    expect(game.stats.incidents).toBe(1)
    expect(game.view().notice).toBe(`NonDeterministicError at event #${orbIndex + 1}`)
  })

  it('replays crate pickups without divergence', () => {
    const game = new Game(deps({ levels: makeLevels({ weights: { crate: 1 }, crashAfterPickup: ['crate'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['crate'])
    runUntil(game, is('replaying'))
    runUntil(game, is('playing'))
    expect(game.state.bossUntil).toBe(0)
    expect(game.divergedAt).toBeNull()
    expect(game.stats).toMatchObject({ replays: 1, incidents: 0 })
  })

  function bossGame(): { game: Game; orbIndex: number } {
    const game = new Game(deps({ levels: makeLevels({ weights: { orb: 1 }, crashAfterPickup: ['orb'] }) }))
    play(game)
    runUntil(game, is('crashing'), ['orb'])
    const orbIndex = game.history.findIndex((e) => e.type === 'OrbTaken')
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil > 0)
    return { game, orbIndex }
  }

  it('hotfixes after surviving the boss: fresh history, divergence cleared', () => {
    const { game } = bossGame()
    runUntil(game, (g) => g.phase.kind === 'playing' && g.state.bossUntil === 0)
    expect(game.divergedAt).toBeNull()
    expect(game.start.boss).toBe(false)
    expect(game.state.tick).toBeLessThan(5)
    expect(game.view().notice).toBe('Hotfix deployed · continue-as-new')
  })

  it('fails with the non-determinism reason when the player dies during the boss', () => {
    const { game, orbIndex } = bossGame()
    // Direct poke: drop an obstacle on the player (the boss segment never replays here).
    game.state = { ...game.state, entities: [{ id: 999, kind: 'low', x: PLAYER_X, y: GROUND_Y - 20, w: 14, h: 20, taken: false }] }
    game.frame(1)
    expect(game.phase).toEqual({ kind: 'over', reason: `non-determinism detected at event #${orbIndex + 1}` })
  })

  it('ends the run on an obstacle, clears the save and records the best score', () => {
    const store = memoryStore()
    const game = new Game(deps({ store, levels: makeLevels({ weights: { low: 1 } }) }))
    play(game)
    game.state = { ...game.state, score: 7 }
    runUntil(game, is('over'))
    expect(game.phase).toEqual({ kind: 'over', reason: 'hit an obstacle' })
    expect(store.saved).toBeNull()
    expect(store.best).toBe(7)
    expect(game.best).toBe(7)
    game.command('confirm')
    expect(game.phase).toEqual({ kind: 'tip', level: 0 })
    expect(game.state.score).toBe(0)
  })

  it('pauses and continues; paused frames do not advance the game', () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    game.frame(10)
    game.command('cancel')
    expect(game.phase.kind).toBe('paused')
    expect(store.saved?.tick).toBe(10)
    game.frame(10)
    expect(game.state.tick).toBe(10)
    game.command('confirm')
    game.frame(1)
    expect(game.state.tick).toBe(11)
  })

  it('suspend() pauses a running game and saves it', () => {
    const store = memoryStore()
    const game = new Game(deps({ store }))
    play(game)
    game.frame(5)
    store.saved = null
    game.suspend()
    expect(game.phase.kind).toBe('paused')
    expect(store.saved).not.toBeNull()
  })

  it('offers to resume a saved run and replays it to the same state', () => {
    const store = memoryStore()
    const first = new Game(deps({ store }))
    play(first)
    runUntil(first, (g) => g.state.tick >= 250, ['coin'])
    first.save()
    const second = new Game(deps({ store }))
    expect(second.phase).toEqual({ kind: 'resume', tick: 250 })
    second.command('confirm')
    expect(second.phase.kind).toBe('replaying')
    runUntil(second, is('playing'))
    expect(second.state.tick).toBe(250)
    expect(hashState(second.state)).toBe(hashState(first.state))
    expect(second.stats.replays).toBe(1)
  })

  it('discards the saved run on cancel', () => {
    const store = memoryStore()
    const first = new Game(deps({ store }))
    play(first)
    first.frame(20)
    first.save()
    const second = new Game(deps({ store }))
    second.command('cancel')
    expect(second.phase.kind).toBe('title')
    expect(store.saved).toBeNull()
  })

  it('notifies subscribers and bumps the version on phase changes', () => {
    const game = new Game(deps())
    let calls = 0
    const unsubscribe = game.subscribe(() => { calls++ })
    const v = game.getVersion()
    game.command('confirm')
    expect(calls).toBeGreaterThan(0)
    expect(game.getVersion()).toBeGreaterThan(v)
    unsubscribe()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/runtime/game.test.ts`
Expected: FAIL, cannot resolve `./game`.

- [ ] **Step 3: Implement the controller**

`web/src/pages/replay/runtime/game.ts`:

```ts
import { LEVELS, type LevelTable } from '../engine/levels'
import { createReplayer, type Replayer } from '../engine/replay'
import { continueAsNew, initialState, step } from '../engine/step'
import type { GameState, HistoryEvent, InputKind, Level, StartInput } from '../engine/types'
import { ChaosScheduler } from './chaos'
import type { SaveStore } from './persistence'
import type { Command, Phase, RunStats, Save } from './types'

/** Frames the crash glitch shows before the replay starts. */
export const CRASH_FRAMES = 36
/** Replay runs at least this many ticks per frame (8×)… */
export const REPLAY_MIN_TICKS_PER_FRAME = 8
/** …and fast enough to finish within this many frames (~2 s). */
export const REPLAY_MAX_FRAMES = 120
/** How long an on-screen notice stays up. */
export const NOTICE_TICKS = 180

export interface GameDeps {
  /** The one deliberate source of non-determinism (Math.random at runtime). */
  impure: () => number
  /** Chaos timing (the outside world). */
  chaosRand: () => number
  newSeed: () => number
  store: SaveStore
  levels?: LevelTable
}

export interface GameView {
  state: GameState
  phase: Phase
  notice: string | null
  divergedAt: number | null
}

const emptyStats = (): RunStats => ({ replays: 0, fromHistory: 0, executed: 0, incidents: 0 })
const nextLevel = (l: Level): Level => (l >= 4 ? 4 : ((l + 1) as Level))

export class Game {
  phase: Phase = { kind: 'title' }
  start: StartInput = { level: 0, seed: 1, score: 0, elapsed: 0, boss: false }
  history: HistoryEvent[] = []
  state: GameState
  stats: RunStats = emptyStats()
  best: number
  /** History index of the non-deterministic event behind the current boss phase. */
  divergedAt: number | null = null

  private notice: { text: string; untilTick: number } | null = null
  private pending: InputKind[] = []
  private replayer: Replayer | null = null
  private replayTicksPerFrame = REPLAY_MIN_TICKS_PER_FRAME
  private crashTick = 0
  private savedRun: Save | null
  private version = 0
  private readonly listeners = new Set<() => void>()
  private readonly levels: LevelTable
  private readonly chaos: ChaosScheduler

  constructor(private readonly deps: GameDeps) {
    this.levels = deps.levels ?? LEVELS
    this.chaos = new ChaosScheduler(deps.chaosRand, this.levels)
    this.best = deps.store.loadBest()
    this.state = initialState(this.start)
    this.savedRun = deps.store.load()
    if (this.savedRun) this.phase = { kind: 'resume', tick: this.savedRun.tick }
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  getVersion = (): number => this.version

  view(): GameView {
    const n = this.notice
    return {
      state: this.state,
      phase: this.phase,
      divergedAt: this.divergedAt,
      notice: n && this.state.tick < n.untilTick ? n.text : null,
    }
  }

  command(c: Command): void {
    switch (this.phase.kind) {
      case 'title':
      case 'over':
        if (c === 'confirm') this.newRun()
        return
      case 'resume':
        if (c === 'confirm' && this.savedRun) this.resumeSaved(this.savedRun)
        else if (c === 'cancel') {
          this.savedRun = null
          this.deps.store.clear()
          this.setPhase({ kind: 'title' })
        }
        return
      case 'tip':
        if (c === 'confirm') this.setPhase({ kind: 'playing' })
        return
      case 'lost':
        if (c === 'confirm') {
          this.stats = emptyStats()
          this.beginSegment({ level: 1, seed: this.deps.newSeed() >>> 0, score: 0, elapsed: 0, boss: false }, true)
          this.setNotice('Dapr Workflow enabled')
        }
        return
      case 'playing':
        if (c === 'cancel' || c === 'pause') {
          this.setPhase({ kind: 'paused' })
          this.save()
        } else if (c === 'jump' || c === 'slideStart' || c === 'slideEnd') {
          this.pending.push(c)
        }
        return
      case 'paused':
        if (c === 'cancel' || c === 'pause' || c === 'confirm') this.setPhase({ kind: 'playing' })
        return
      default:
        // crashing / replaying: input is ignored, like a restarting process.
        return
    }
  }

  /** Called once per animation frame with the number of whole 60 Hz ticks elapsed. */
  frame(liveTicks: number): void {
    const p = this.phase
    if (p.kind === 'playing') {
      for (let i = 0; i < liveTicks && this.phase.kind === 'playing'; i++) this.tick()
    } else if (p.kind === 'crashing') {
      // Per-frame countdown only drives the glitch effect; no re-render needed.
      if (p.framesLeft > 1) this.phase = { kind: 'crashing', framesLeft: p.framesLeft - 1 }
      else this.startReplay()
    } else if (p.kind === 'replaying') {
      this.advanceReplay()
    }
  }

  /** Tab hidden or page left: pause a running game and persist it. */
  suspend(): void {
    if (this.phase.kind === 'playing') this.setPhase({ kind: 'paused' })
    this.save()
  }

  save(): void {
    const k = this.phase.kind
    if (k === 'title' || k === 'resume' || k === 'over' || k === 'lost') return
    const tick = k === 'crashing' || k === 'replaying' ? this.crashTick : this.state.tick
    this.deps.store.save({
      version: 1, start: this.start, history: this.history, tick, stats: this.stats, divergedAt: this.divergedAt,
    })
  }

  private tick(): void {
    const inputs = this.pending
    this.pending = []
    const t = this.state.tick
    for (const kind of inputs) this.history.push({ type: 'Input', tick: t, kind })
    const ports = { impure: this.deps.impure, crateValue: () => this.deps.impure() }
    const { state, events } = step(this.state, inputs, ports, this.levels)
    this.state = state
    for (const e of events) {
      this.history.push(e)
      if (e.type === 'OrbTaken') {
        this.chaos.onPickup(state.level, 'orb', state.tick)
      } else {
        this.stats.executed += 1
        if (e.result !== undefined) this.chaos.onPickup(state.level, 'crate', state.tick)
      }
    }

    if (state.status === 'failed') {
      const reason = state.bossUntil > 0 && this.divergedAt !== null
        ? `non-determinism detected at event #${this.divergedAt + 1}`
        : 'hit an obstacle'
      this.gameOver(reason)
      return
    }
    if (state.status === 'levelDone') {
      this.beginSegment(continueAsNew(state, { level: nextLevel(state.level), elapsed: 0 }), true)
      return
    }
    if (state.bossUntil > 0) {
      if (state.tick >= state.bossUntil) this.hotfix()
      else if (events.length > 0 || inputs.length > 0) this.touch()
      return
    }
    if (this.chaos.isDue(state.tick)) {
      this.crash()
      return
    }
    if (events.length > 0) this.save()
    if (events.length > 0 || inputs.length > 0) this.touch()
  }

  private newRun(): void {
    this.stats = emptyStats()
    this.divergedAt = null
    this.deps.store.clear()
    this.beginSegment({ level: 0, seed: this.deps.newSeed() >>> 0, score: 0, elapsed: 0, boss: false }, true)
  }

  private beginSegment(start: StartInput, showTip: boolean): void {
    this.start = start
    this.history = []
    this.state = initialState(start)
    this.pending = []
    this.notice = null
    this.chaos.start(start.level, showTip)
    this.setPhase(showTip ? { kind: 'tip', level: start.level } : { kind: 'playing' })
    this.save()
  }

  private crash(): void {
    this.crashTick = this.state.tick
    this.setPhase({ kind: 'crashing', framesLeft: CRASH_FRAMES })
    this.save()
  }

  private startReplay(): void {
    if (!this.levels[this.start.level].durable) {
      this.deps.store.clear()
      this.setPhase({ kind: 'lost' })
      return
    }
    this.stats.replays += 1
    this.replayer = createReplayer(this.start, this.history, this.crashTick, this.deps.impure, this.levels)
    this.replayTicksPerFrame = Math.max(REPLAY_MIN_TICKS_PER_FRAME, Math.ceil(this.crashTick / REPLAY_MAX_FRAMES))
    this.state = this.replayer.state
    this.setPhase({ kind: 'replaying' })
  }

  private advanceReplay(): void {
    const r = this.replayer
    if (!r) return
    r.advance(this.replayTicksPerFrame)
    this.state = r.state
    if (!r.done) return
    this.replayer = null
    const result = r.result()
    const served = this.history.slice(0, result.ok ? this.history.length : result.divergedAt)
    this.stats.fromHistory += served.filter((e) => e.type === 'ActivityCompleted').length
    if (result.ok) {
      this.state = result.state
      this.chaos.scheduleNext(this.state.level, this.state.tick, this.state.elapsed)
      this.setNotice(`Replayed ${this.history.length} events · resumed at tick ${this.state.tick}`)
      this.setPhase({ kind: 'playing' })
      return
    }
    this.stats.incidents += 1
    this.divergedAt = result.divergedAt
    this.beginSegment(continueAsNew(result.state, { boss: true }), false)
    this.setNotice(`NonDeterministicError at event #${result.divergedAt + 1}`)
  }

  private hotfix(): void {
    this.divergedAt = null
    this.beginSegment(continueAsNew(this.state), false)
    this.setNotice('Hotfix deployed · continue-as-new')
  }

  private resumeSaved(save: Save): void {
    this.savedRun = null
    this.start = save.start
    this.history = save.history
    this.stats = save.stats
    this.divergedAt = save.divergedAt
    this.crashTick = save.tick
    this.pending = []
    this.notice = null
    this.chaos.start(save.start.level, false)
    this.startReplay()
  }

  private gameOver(reason: string): void {
    this.deps.store.clear()
    if (this.state.score > this.best) {
      this.best = this.state.score
      this.deps.store.saveBest(this.best)
    }
    this.setPhase({ kind: 'over', reason })
  }

  private setNotice(text: string): void {
    this.notice = { text, untilTick: this.state.tick + NOTICE_TICKS }
    this.touch()
  }

  private setPhase(phase: Phase): void {
    this.phase = phase
    this.touch()
  }

  private touch(): void {
    this.version += 1
    for (const fn of this.listeners) fn()
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay`
Expected: PASS. If the level-transition test's `start.score > 0` fails, the first coin didn't arrive within 1200 px at seed 42. Raise `length` to 2000 in that test only. Don't change the engine.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/pages/replay/runtime
git commit -m "feat(replay): add game controller state machine"
```

---

### Task 7: Input mapping, editable-target check and the frame loop

**Files:**
- Create: `web/src/lib/isEditableTarget.ts`
- Create: `web/src/pages/replay/runtime/keys.ts`
- Create: `web/src/pages/replay/runtime/loop.ts`
- Test: `web/src/lib/isEditableTarget.test.ts`, `web/src/pages/replay/runtime/keys.test.ts`, `web/src/pages/replay/runtime/loop.test.ts`

**Interfaces:**
- Consumes: `Command` (Task 4); `TICK_HZ` (Task 1).
- Produces:
  - `isEditableTarget(t: EventTarget | null): boolean`
  - `keyToCommand(e: Pick<KeyboardEvent, 'key' | 'repeat'>, down: boolean): Command | null`
  - `MAX_TICKS_PER_FRAME = 5`, `interface Loop { stop(): void }`, `startLoop(onFrame: (ticks: number) => void, raf?: (cb: FrameRequestCallback) => number, caf?: (id: number) => void): Loop`

- [ ] **Step 1: Write the failing tests**

`web/src/lib/isEditableTarget.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { isEditableTarget } from './isEditableTarget'

describe('isEditableTarget', () => {
  it.each(['input', 'textarea', 'select'])('is true for <%s>', (tag) => {
    expect(isEditableTarget(document.createElement(tag))).toBe(true)
  })

  it('is true for contenteditable elements', () => {
    const div = document.createElement('div')
    div.setAttribute('contenteditable', 'true')
    expect(isEditableTarget(div)).toBe(true)
  })

  it('is false for other elements, the window and null', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false)
    expect(isEditableTarget(window)).toBe(false)
    expect(isEditableTarget(null)).toBe(false)
  })
})
```

`web/src/pages/replay/runtime/keys.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { keyToCommand } from './keys'

const down = (key: string, repeat = false) => keyToCommand({ key, repeat }, true)
const up = (key: string) => keyToCommand({ key, repeat: false }, false)

describe('keyToCommand', () => {
  it.each([
    [' ', 'jump'], ['ArrowUp', 'jump'], ['w', 'jump'], ['W', 'jump'],
    ['ArrowDown', 'slideStart'], ['s', 'slideStart'],
    ['Enter', 'confirm'], ['Escape', 'cancel'], ['p', 'pause'],
  ])('maps keydown %j to %s', (key, command) => {
    expect(down(key)).toBe(command)
  })

  it('ends a slide on keyup of the slide keys only', () => {
    expect(up('ArrowDown')).toBe('slideEnd')
    expect(up('s')).toBe('slideEnd')
    expect(up(' ')).toBeNull()
  })

  it('ignores auto-repeat keydowns', () => {
    expect(down(' ', true)).toBeNull()
    expect(down('Enter', true)).toBeNull()
    expect(down('ArrowDown', true)).toBeNull()
  })

  it('ignores unrelated keys', () => {
    expect(down('x')).toBeNull()
    expect(down('Tab')).toBeNull()
  })
})
```

`web/src/pages/replay/runtime/loop.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { MAX_TICKS_PER_FRAME, startLoop } from './loop'

function fakeRaf() {
  const queue: FrameRequestCallback[] = []
  return {
    raf: (cb: FrameRequestCallback) => queue.push(cb),
    caf: vi.fn(),
    fire(now: number) {
      queue.shift()?.(now)
    },
  }
}

describe('startLoop', () => {
  it('turns elapsed time into whole 60 Hz ticks, carrying the remainder', () => {
    const f = fakeRaf()
    const seen: number[] = []
    startLoop((t) => seen.push(t), f.raf, f.caf)
    for (const now of [0, 20, 60, 62, 70]) f.fire(now)
    expect(seen).toEqual([0, 1, 2, 0, 1])
  })

  it('clamps a long gap to MAX_TICKS_PER_FRAME and drops the backlog', () => {
    const f = fakeRaf()
    const seen: number[] = []
    startLoop((t) => seen.push(t), f.raf, f.caf)
    f.fire(0)
    f.fire(5000)
    f.fire(5020)
    expect(seen).toEqual([0, MAX_TICKS_PER_FRAME, 1])
  })

  it('stop() cancels the pending frame and ignores late callbacks', () => {
    const f = fakeRaf()
    const onFrame = vi.fn()
    const loop = startLoop(onFrame, f.raf, f.caf)
    f.fire(0)
    loop.stop()
    expect(f.caf).toHaveBeenCalled()
    f.fire(20)
    expect(onFrame).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/isEditableTarget.test.ts src/pages/replay/runtime/keys.test.ts src/pages/replay/runtime/loop.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement the three modules**

`web/src/lib/isEditableTarget.ts`:

```ts
/** True when a key event comes from somewhere the user is typing text. */
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false
  if (t.isContentEditable || t.getAttribute('contenteditable') === 'true') return true
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT'
}
```

`web/src/pages/replay/runtime/keys.ts`:

```ts
import type { Command } from './types'

/** Maps a key event to a game command. Auto-repeat keydowns are dropped. */
export function keyToCommand(e: Pick<KeyboardEvent, 'key' | 'repeat'>, down: boolean): Command | null {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
  if (!down) return key === 'ArrowDown' || key === 's' ? 'slideEnd' : null
  if (e.repeat) return null
  switch (key) {
    case ' ':
    case 'ArrowUp':
    case 'w':
      return 'jump'
    case 'ArrowDown':
    case 's':
      return 'slideStart'
    case 'Enter':
      return 'confirm'
    case 'Escape':
      return 'cancel'
    case 'p':
      return 'pause'
    default:
      return null
  }
}
```

`web/src/pages/replay/runtime/loop.ts`:

```ts
import { TICK_HZ } from '../engine/types'

/** A long gap (background tab, debugger) never simulates more than this per frame. */
export const MAX_TICKS_PER_FRAME = 5
const TICK_MS = 1000 / TICK_HZ

export interface Loop {
  stop(): void
}

/** requestAnimationFrame loop with a fixed-timestep accumulator. */
export function startLoop(
  onFrame: (ticks: number) => void,
  raf: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): Loop {
  let last: number | null = null
  let acc = 0
  let stopped = false
  let id = 0
  const frame = (now: number) => {
    if (stopped) return
    acc += last === null ? 0 : now - last
    last = now
    let ticks = Math.floor(acc / TICK_MS)
    acc -= ticks * TICK_MS
    if (ticks > MAX_TICKS_PER_FRAME) {
      ticks = MAX_TICKS_PER_FRAME
      acc = 0
    }
    onFrame(ticks)
    if (!stopped) id = raf(frame)
  }
  id = raf(frame)
  return {
    stop() {
      stopped = true
      caf(id)
    },
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/lib/isEditableTarget.test.ts src/pages/replay/runtime`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/lib/isEditableTarget.ts web/src/lib/isEditableTarget.test.ts web/src/pages/replay/runtime
git commit -m "feat(replay): add key mapping and fixed-timestep frame loop"
```

---

### Task 8: Palette and canvas renderer

**Files:**
- Create: `web/src/pages/replay/render/palette.ts`
- Create: `web/src/pages/replay/render/canvas.ts`
- Test: `web/src/pages/replay/render/palette.test.ts`, `web/src/pages/replay/render/canvas.test.ts`

**Interfaces:**
- Consumes: types and constants (Task 1); `PLAYER_W`, `PLAYER_H`, `SLIDE_H`, `initialState` (Task 2); `LEVELS` (Task 2); `Phase` (Task 4).
- Produces:
  - `type Slot = 'bg' | 'ground' | 'player' | 'obstacle' | 'coin' | 'orb' | 'crate' | 'text' | 'muted' | 'glitch' | 'fail'`, `type Palette = Record<Slot, string>`, `SLOT_TOKENS: Record<Slot, string>`, `readPalette(el: Element): Palette`, `watchTheme(onChange: () => void): () => void`.
  - `interface RenderView { state: GameState; phase: Phase; notice: string | null; reducedMotion: boolean; frame: number }`, `render(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void`.

The theme tokens are defined on `.app[data-theme=…]`, not on `:root`. So `readPalette` must be passed an element inside `.app` (the canvas). `App.tsx` mirrors `data-theme` onto `<html>` in an effect that runs after `.app` re-renders, so watching `<html>` is enough for `watchTheme`.

- [ ] **Step 1: Write the failing tests**

`web/src/pages/replay/render/palette.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SLOT_TOKENS, readPalette, watchTheme } from './palette'

afterEach(() => {
  vi.restoreAllMocks()
  document.documentElement.removeAttribute('data-theme')
})

describe('readPalette', () => {
  it('reads each slot from its theme token, trimmed', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--accent-bright' ? ' lime ' : name === '--surface' ? 'white' : ''),
    } as unknown as CSSStyleDeclaration)
    const pal = readPalette(document.createElement('canvas'))
    expect(pal.player).toBe('lime')
    expect(pal.bg).toBe('white')
  })

  it('falls back to a neutral colour when a token is missing', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration)
    expect(readPalette(document.createElement('canvas')).coin).toBe('gray')
  })

  it('maps every slot to a CSS custom property', () => {
    for (const token of Object.values(SLOT_TOKENS)) expect(token).toMatch(/^--[a-z-]+$/)
  })
})

describe('watchTheme', () => {
  it('calls back when the root data-theme changes, until disposed', async () => {
    const onChange = vi.fn()
    const dispose = watchTheme(onChange)
    document.documentElement.setAttribute('data-theme', 'dark')
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    dispose()
    document.documentElement.setAttribute('data-theme', 'light')
    await new Promise((r) => setTimeout(r, 0))
    expect(onChange).toHaveBeenCalledTimes(1)
  })
})
```

`web/src/pages/replay/render/canvas.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { BOSS_TICKS, initialState } from '../engine/step'
import { GROUND_Y, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import { render, type RenderView } from './canvas'
import type { Palette } from './palette'

const pal: Palette = {
  bg: 'white', ground: 'gray', player: 'green', obstacle: 'red', coin: 'gold', orb: 'purple',
  crate: 'blue', text: 'black', muted: 'gray', glitch: 'cyan', fail: 'red',
}

/** A recording stand-in for CanvasRenderingContext2D: every method call is logged. */
function mockCtx() {
  const calls: { name: string; args: unknown[] }[] = []
  const props: Record<string, unknown> = {}
  const ctx = new Proxy(props, {
    get: (target, prop: string) =>
      prop in target ? target[prop] : (...args: unknown[]) => { calls.push({ name: prop, args }) },
    set: (target, prop: string, value) => {
      target[prop] = value
      return true
    },
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls }
}

function view(phase: Phase, state: GameState = initialState({ level: 1, seed: 1, score: 5, elapsed: 0, boss: false }), extra: Partial<RenderView> = {}): RenderView {
  return { state, phase, notice: null, reducedMotion: false, frame: 3, ...extra }
}

const texts = (calls: { name: string; args: unknown[] }[]) => calls.filter((c) => c.name === 'fillText').map((c) => c.args[0])

describe('render', () => {
  it('draws the HUD with level, score and multiplier', () => {
    const { ctx, calls } = mockCtx()
    const state = { ...initialState({ level: 1, seed: 1, score: 5, elapsed: 0, boss: false }), multiplier: 3 }
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('LEVEL 1 · REPLAY')
    expect(texts(calls).some((t) => String(t).startsWith('SCORE 5 ×3'))).toBe(true)
  })

  it('shows the crash banner and shakes the screen while crashing', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'crashing', framesLeft: 10 }), pal)
    expect(texts(calls)).toContain('daprd: signal: killed')
    expect(calls.some((c) => c.name === 'translate')).toBe(true)
  })

  it('keeps the crash banner but drops the shake with reduced motion', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'crashing', framesLeft: 10 }, undefined, { reducedMotion: true }), pal)
    expect(texts(calls)).toContain('daprd: signal: killed')
    expect(calls.some((c) => c.name === 'translate')).toBe(false)
  })

  it('badges activities served from history only while replaying', () => {
    const state = {
      ...initialState({ level: 1, seed: 1, score: 1, elapsed: 0, boss: false }),
      entities: [{ id: 1, kind: 'coin' as const, x: 200, y: GROUND_Y - 30, w: 10, h: 10, taken: true }],
    }
    const replaying = mockCtx()
    render(replaying.ctx, view({ kind: 'replaying' }, state), pal)
    expect(texts(replaying.calls)).toContain('✓ from history')
    expect(texts(replaying.calls).some((t) => String(t).includes('REPLAYING HISTORY'))).toBe(true)
    const live = mockCtx()
    render(live.ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(live.calls)).not.toContain('✓ from history')
  })

  it('shows the boss countdown during a boss segment', () => {
    const { ctx, calls } = mockCtx()
    const state = initialState({ level: 2, seed: 1, score: 0, elapsed: 0, boss: true })
    expect(state.bossUntil).toBe(BOSS_TICKS)
    render(ctx, view({ kind: 'playing' }, state), pal)
    expect(texts(calls)).toContain('NonDeterministicError · survive 15s')
  })

  it('draws the notice when there is one', () => {
    const { ctx, calls } = mockCtx()
    render(ctx, view({ kind: 'playing' }, undefined, { notice: 'Dapr Workflow enabled' }), pal)
    expect(texts(calls)).toContain('Dapr Workflow enabled')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/render`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement palette and renderer**

`web/src/pages/replay/render/palette.ts`:

```ts
// Canvas colours come from the dashboard's theme tokens, so the game follows
// light/dark mode. Never put colour literals here (styleguide rule).

export type Slot = 'bg' | 'ground' | 'player' | 'obstacle' | 'coin' | 'orb' | 'crate' | 'text' | 'muted' | 'glitch' | 'fail'
export type Palette = Record<Slot, string>

export const SLOT_TOKENS: Record<Slot, string> = {
  bg: '--surface',
  ground: '--line',
  player: '--accent-bright',
  obstacle: '--fail-fg',
  coin: '--gold',
  orb: '--purple',
  crate: '--run-fg',
  text: '--text',
  muted: '--muted',
  glitch: '--dapr',
  fail: '--fail-fg',
}

const FALLBACK = 'gray'

/** Reads the palette from an element inside `.app` (tokens are scoped there). */
export function readPalette(el: Element): Palette {
  const cs = getComputedStyle(el)
  const entries = Object.entries(SLOT_TOKENS).map(([slot, token]) => [slot, cs.getPropertyValue(token).trim() || FALLBACK])
  return Object.fromEntries(entries) as Palette
}

/** Calls back when the theme toggles (App mirrors data-theme onto <html>). */
export function watchTheme(onChange: () => void): () => void {
  const observer = new MutationObserver(() => onChange())
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
  return () => observer.disconnect()
}
```

`web/src/pages/replay/render/canvas.ts`:

```ts
import { LEVELS } from '../engine/levels'
import { PLAYER_H, PLAYER_W, SLIDE_H } from '../engine/step'
import { GROUND_Y, PLAYER_X, TICK_HZ, VIEW_H, VIEW_W, type Entity, type GameState } from '../engine/types'
import type { Phase } from '../runtime/types'
import type { Palette } from './palette'

export interface RenderView {
  state: GameState
  phase: Phase
  notice: string | null
  reducedMotion: boolean
  /** Monotonic frame counter; drives the (deterministic) glitch patterns. */
  frame: number
}

const FONT = '10px ui-monospace, Menlo, Consolas, monospace'
const BIG_FONT = 'bold 14px ui-monospace, Menlo, Consolas, monospace'
const LABEL: Partial<Record<Entity['kind'], string>> = { orb: 'rand()', crate: 'activity' }

function banner(ctx: CanvasRenderingContext2D, text: string, y: number, color: string, font: string): void {
  ctx.font = font
  ctx.textAlign = 'center'
  ctx.fillStyle = color
  ctx.fillText(text, VIEW_W / 2, y)
}

function drawGround(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  ctx.fillStyle = pal.ground
  ctx.fillRect(0, GROUND_Y, VIEW_W, 2)
  const offset = state.scroll % 24
  for (let x = -offset; x < VIEW_W; x += 24) ctx.fillRect(x, GROUND_Y + 10, 10, 2)
}

function drawEntity(ctx: CanvasRenderingContext2D, e: Entity, pal: Palette, replaying: boolean): void {
  if (e.taken) {
    // During a replay, recorded activities are served from history, not re-run.
    if (!replaying || e.kind === 'orb') return
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillStyle = pal.coin
    ctx.fillText('✓ from history', e.x + e.w / 2, e.y - 4)
    return
  }
  const kind = e.kind
  ctx.fillStyle = kind === 'low' || kind === 'high' ? pal.obstacle : pal[kind]
  if (kind === 'orb') {
    ctx.beginPath()
    ctx.arc(e.x + e.w / 2, e.y + e.h / 2, e.w / 2, 0, Math.PI * 2)
    ctx.fill()
  } else {
    ctx.fillRect(e.x, e.y, e.w, e.h)
  }
  const label = LABEL[kind]
  if (label) {
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.fillText(label, e.x + e.w / 2, e.y - 4)
  }
}

function drawPlayer(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  const p = state.player
  const h = p.sliding && p.y >= GROUND_Y ? SLIDE_H : PLAYER_H
  ctx.fillStyle = pal.player
  ctx.fillRect(PLAYER_X, p.y - h, PLAYER_W, h)
  ctx.fillStyle = pal.bg
  ctx.fillRect(PLAYER_X + 9, p.y - h + 4, 5, 3)
}

function drawHud(ctx: CanvasRenderingContext2D, state: GameState, pal: Palette): void {
  ctx.font = FONT
  ctx.fillStyle = pal.muted
  ctx.textAlign = 'left'
  ctx.fillText(`LEVEL ${state.level} · ${LEVELS[state.level].name.toUpperCase()}`, 10, 18)
  ctx.textAlign = 'right'
  const mult = state.multiplier > 1 ? ` ×${state.multiplier}` : ''
  ctx.fillText(`SCORE ${state.score}${mult} · TICK ${state.tick}`, VIEW_W - 10, 18)
}

function drawCrash(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  if (!view.reducedMotion) {
    ctx.save()
    ctx.globalAlpha = 0.35
    ctx.fillStyle = pal.glitch
    for (let i = 0; i < 12; i++) {
      const y = (view.frame * 37 + i * 53) % VIEW_H
      const w = 40 + ((view.frame * 13 + i * 29) % 200)
      ctx.fillRect((i * 71 + view.frame * 11) % VIEW_W, y, w, 3 + (i % 4))
    }
    ctx.restore()
  }
  banner(ctx, 'daprd: signal: killed', VIEW_H / 2, pal.fail, BIG_FONT)
}

function drawBoss(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  const left = Math.max(0, Math.ceil((view.state.bossUntil - view.state.tick) / TICK_HZ))
  ctx.save()
  ctx.globalAlpha = 0.08
  ctx.fillStyle = pal.fail
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  if (!view.reducedMotion) {
    ctx.globalAlpha = 0.18
    for (let y = (view.frame * 3) % 6; y < VIEW_H; y += 6) ctx.fillRect(0, y, VIEW_W, 1)
  }
  ctx.restore()
  banner(ctx, `NonDeterministicError · survive ${left}s`, 64, pal.fail, BIG_FONT)
}

export function render(ctx: CanvasRenderingContext2D, view: RenderView, pal: Palette): void {
  const { state, phase } = view
  const crashing = phase.kind === 'crashing'
  const replaying = phase.kind === 'replaying'
  ctx.save()
  ctx.fillStyle = pal.bg
  ctx.fillRect(0, 0, VIEW_W, VIEW_H)
  if (crashing && !view.reducedMotion) ctx.translate(((view.frame * 7) % 9) - 4, ((view.frame * 5) % 7) - 3)
  drawGround(ctx, state, pal)
  for (const e of state.entities) drawEntity(ctx, e, pal, replaying)
  drawPlayer(ctx, state, pal)
  ctx.restore()
  drawHud(ctx, state, pal)
  if (view.notice) banner(ctx, view.notice, 44, pal.text, FONT)
  if (state.bossUntil > 0 && phase.kind === 'playing') drawBoss(ctx, view, pal)
  if (crashing) drawCrash(ctx, view, pal)
  if (replaying) banner(ctx, `⏩ REPLAYING HISTORY · tick ${state.tick}`, 70, pal.glitch, BIG_FONT)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay/render src/test/styleguide.test.ts`
Expected: PASS. The styleguide test confirms there are no hex literals.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/pages/replay/render
git commit -m "feat(replay): add theme-token palette and canvas renderer"
```

---

### Task 9: Replay page — history panel, overlays, styles, lazy route

**Files:**
- Create: `web/src/pages/replay/HistoryPanel.tsx`
- Create: `web/src/pages/replay/Overlay.tsx`
- Create: `web/src/pages/replay/Replay.tsx`
- Modify: `web/src/router.tsx` (add the lazy route at the end of `gatedChildren`)
- Modify: `web/src/styles/theme.css` (append the `.replay-*` block)
- Test: `web/src/pages/replay/HistoryPanel.test.tsx`, `web/src/pages/replay/Replay.test.tsx`

**Interfaces:**
- Consumes: `Game` (Task 6); `localSaveStore`, `SAVE_KEY` (Task 4); `keyToCommand`, `startLoop` (Task 7); `isEditableTarget` (Task 7); `render`, `readPalette`, `watchTheme` (Task 8); `LEVELS` (Task 2); `VIEW_W`, `VIEW_H`, `HistoryEvent` (Task 1); existing `useDocumentTitle` (`web/src/lib/useDocumentTitle.ts`).
- Produces:
  - `HistoryPanel({ history }: { history: readonly HistoryEvent[] })`
  - `Overlay({ phase, stats, best, score })`
  - `Replay.tsx` exports only `Component` (react-router `lazy` convention).
  - Route `{ path: 'replay', lazy: () => import('./pages/replay/Replay'), handle: { rumView: 'Replay' } }`

- [ ] **Step 1: Write the failing tests**

`web/src/pages/replay/HistoryPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { HistoryPanel } from './HistoryPanel'

describe('HistoryPanel', () => {
  it('shows an empty state', () => {
    render(<HistoryPanel history={[]} />)
    expect(screen.getByText('No events yet.')).toBeInTheDocument()
  })

  it('lists events newest first, numbered by history position', () => {
    const { container } = render(
      <HistoryPanel
        history={[
          { type: 'Input', tick: 0, kind: 'jump' },
          { type: 'ActivityCompleted', tick: 10, id: 3, hash: 1, result: 0.25 },
          { type: 'OrbTaken', tick: 20, id: 4, hash: 2 },
        ]}
      />,
    )
    const types = [...container.querySelectorAll('.evtype')].map((n) => n.textContent)
    expect(types).toEqual(['#3 NonDeterministicCall', '#2 ActivityCompleted', '#1 Input'])
    expect(screen.getByText('crate 3 · result 0.250')).toBeInTheDocument()
    expect(screen.getByText('orb 4 · value not recorded')).toBeInTheDocument()
    expect(screen.getByText('3 events')).toBeInTheDocument()
  })
})
```

`web/src/pages/replay/Replay.test.tsx`:

```tsx
import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { server } from '../../test/setup'
import { routes } from '../../router'
import { QueryProvider, makeQueryClient } from '../../lib/query'
import { RefreshProvider } from '../../lib/refresh'
import { ConnectionContext } from '../../lib/connection'
import { SAVE_KEY } from './runtime/persistence'

vi.mock('../../lib/telemetry', () => ({ trackAction: vi.fn(), trackView: vi.fn(), setTelemetryContext: vi.fn(), trackError: vi.fn() }))

beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: true, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
  vi.stubGlobal('cancelAnimationFrame', vi.fn())
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
  server.use(
    http.get('/api/version', () => HttpResponse.json({ version: '9.9.9', commit: 'abc1234', date: '2026-01-01' })),
    http.get('/api/health', () => HttpResponse.json({ status: 'ok' })),
    http.get('/api/apps', () => HttpResponse.json([])),
    http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    http.get('/api/statestores', () => HttpResponse.json([])),
    http.get('/api/news', () => HttpResponse.json({ blog: null, report: null, webinar: null, event: null })),
    http.get('/api/update-check', () => HttpResponse.json({ current: '9.9.9', latest: '9.9.9', updateAvailable: false, releaseUrl: '' })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path], future: { v7_relativeSplatPath: true } })
  return render(
    <QueryProvider client={makeQueryClient()}>
      <RefreshProvider>
        <ConnectionContext value={{ online: true }}>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </ConnectionContext>
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('Replay page', () => {
  it('lazy-loads at /replay and shows the title card', async () => {
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'REPLAY' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Press Enter to start' })).toBeInTheDocument()
    expect(screen.getByLabelText('REPLAY game screen')).toBeInTheDocument()
  })

  it('Enter opens the level-0 tip with a docs link', async () => {
    renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter' })
    expect(await screen.findByRole('heading', { name: 'Level 0 · No Safety Net' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Learn more ↗' })).toHaveAttribute('target', '_blank')
  })

  it('saves the run and stops the loop when the page unmounts mid-run', async () => {
    const { unmount } = renderAt('/replay')
    await screen.findByRole('heading', { name: 'Press Enter to start' })
    fireEvent.keyDown(window, { key: 'Enter' })
    fireEvent.keyDown(window, { key: 'Enter' })
    localStorage.removeItem(SAVE_KEY)
    unmount()
    expect(cancelAnimationFrame).toHaveBeenCalled()
    expect(localStorage.getItem(SAVE_KEY)).not.toBeNull()
  })

  it('offers to resume when a saved run exists', async () => {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      version: 1,
      start: { level: 1, seed: 5, score: 2, elapsed: 0, boss: false },
      history: [{ type: 'Input', tick: 3, kind: 'jump' }],
      tick: 40,
      stats: { replays: 0, fromHistory: 0, executed: 0, incidents: 0 },
      divergedAt: null,
    }))
    renderAt('/replay')
    expect(await screen.findByRole('heading', { name: 'Resume your run?' })).toBeInTheDocument()
    expect(screen.getByText(/tick 40/)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/replay/HistoryPanel.test.tsx src/pages/replay/Replay.test.tsx`
Expected: FAIL. HistoryPanel is not found. The Replay tests time out on `findByRole('heading', { name: 'REPLAY' })` because no route matches `/replay`.

- [ ] **Step 3: Implement the history panel and overlays**

`web/src/pages/replay/HistoryPanel.tsx`:

```tsx
import type { HistoryEvent } from './engine/types'

const SHOWN = 60
const NODE: Record<HistoryEvent['type'], string> = { Input: 'n-sched', ActivityCompleted: 'n-done', OrbTaken: 'n-fail' }

function describeEvent(e: HistoryEvent): { type: string; detail: string } {
  switch (e.type) {
    case 'Input':
      return { type: 'Input', detail: e.kind }
    case 'OrbTaken':
      return { type: 'NonDeterministicCall', detail: `orb ${e.id} · value not recorded` }
    case 'ActivityCompleted':
      return {
        type: 'ActivityCompleted',
        detail: e.result === undefined ? `coin ${e.id}` : `crate ${e.id} · result ${e.result.toFixed(3)}`,
      }
  }
}

/** The run's event history, in the WorkflowDetail history look, newest first. */
export function HistoryPanel({ history }: { history: readonly HistoryEvent[] }) {
  const first = Math.max(0, history.length - SHOWN)
  const rows = history.slice(first).map((e, i) => ({ e, index: first + i })).reverse()
  return (
    <div className="panel">
      <div className="ph">
        History <span className="replay-count">{history.length} events</span>
      </div>
      {rows.length === 0 ? (
        <p className="replay-empty">No events yet.</p>
      ) : (
        <div className="replay-hist">
          {rows.map(({ e, index }) => {
            const d = describeEvent(e)
            return (
              <div key={index} className="ev">
                <div className="t">
                  <span className="off">t{e.tick}</span>
                </div>
                <div className="rail">
                  <span className={`node ${NODE[e.type]}`} />
                </div>
                <div className="c">
                  <div className="evd evstatic">
                    <div className="evstatic-head">
                      <span className="caretspace" aria-hidden="true">▸</span>
                      <span className="evtype">#{index + 1} {d.type}</span>
                      <div className="evnamecell">
                        <span className="evname">{d.detail}</span>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

`web/src/pages/replay/Overlay.tsx`:

```tsx
import type { ReactNode } from 'react'
import { LEVELS } from './engine/levels'
import type { Phase, RunStats } from './runtime/types'

interface Props {
  phase: Phase
  stats: RunStats
  best: number
  score: number
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="replay-overlay">
      <div className="card replay-card">{children}</div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="stat">
      <div className="n">{value}</div>
      <div className="l">{label}</div>
    </div>
  )
}

/** DOM cards over the canvas for every phase that waits on the player. */
export function Overlay({ phase, stats, best, score }: Props) {
  switch (phase.kind) {
    case 'title':
      return (
        <Card>
          <h2>Press Enter to start</h2>
          <p>Guide a workflow through a datacenter full of chaos. It will crash. Dapr will replay it.</p>
          <p className="replay-keys">Space / ↑ jump · ↓ slide · Esc pause</p>
          {best > 0 && <p className="replay-keys">Best score: {best}</p>}
        </Card>
      )
    case 'resume':
      return (
        <Card>
          <h2>Resume your run?</h2>
          <p>A saved history was found (tick {phase.tick}). Replaying it rebuilds your run exactly where you left it.</p>
          <p className="replay-keys">Enter resume · Esc discard</p>
        </Card>
      )
    case 'tip': {
      const cfg = LEVELS[phase.level]
      return (
        <Card>
          <h2>Level {phase.level} · {cfg.name}</h2>
          <p>{cfg.tip.body}</p>
          <a className="replay-link" href={cfg.tip.href} target="_blank" rel="noreferrer">Learn more ↗</a>
          <p className="replay-keys">Enter to start</p>
        </Card>
      )
    }
    case 'paused':
      return (
        <Card>
          <h2>Paused</h2>
          <p className="replay-keys">Esc or Enter to continue</p>
        </Card>
      )
    case 'lost':
      return (
        <Card>
          <h2>Progress lost</h2>
          <p>The process crashed and its state lived only in memory, so the workflow starts over from zero. Let's fix that.</p>
          <p className="replay-keys">Enter to enable Dapr Workflow</p>
        </Card>
      )
    case 'over':
      return (
        <Card>
          <h2>Workflow <span className="pill s-fail">FAILED</span></h2>
          <p>Reason: {phase.reason}</p>
          <div className="stats replay-stats">
            <Stat label="Score" value={score} />
            <Stat label="Best" value={best} />
            <Stat label="Replays" value={stats.replays} />
            <Stat label="From history" value={stats.fromHistory} />
            <Stat label="Executed" value={stats.executed} />
            <Stat label="Non-determinism" value={stats.incidents} />
          </div>
          <p className="replay-keys">Enter to play again</p>
        </Card>
      )
    default:
      return null
  }
}
```

- [ ] **Step 4: Implement the page module**

`web/src/pages/replay/Replay.tsx`:

```tsx
import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { isEditableTarget } from '../../lib/isEditableTarget'
import { useDocumentTitle } from '../../lib/useDocumentTitle'
import { VIEW_H, VIEW_W } from './engine/types'
import { HistoryPanel } from './HistoryPanel'
import { Overlay } from './Overlay'
import { render } from './render/canvas'
import { readPalette, watchTheme, type Palette } from './render/palette'
import { Game } from './runtime/game'
import { keyToCommand } from './runtime/keys'
import { startLoop } from './runtime/loop'
import { localSaveStore } from './runtime/persistence'

function createGame(): Game {
  return new Game({
    impure: Math.random, // the one deliberate source of non-determinism
    chaosRand: Math.random, // chaos is the outside world
    newSeed: () => Math.floor(Math.random() * 0x100000000),
    store: localSaveStore(),
  })
}

/** REPLAY easter egg. Lazy route module: react-router's `lazy` expects `Component`. */
export function Component() {
  useDocumentTitle('Replay')
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [game] = useState(createGame)
  useSyncExternalStore(game.subscribe, game.getVersion)

  useEffect(() => {
    const handler = (down: boolean) => (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      const command = keyToCommand(e, down)
      if (!command) return
      e.preventDefault()
      game.command(command)
    }
    const onKeyDown = handler(true)
    const onKeyUp = handler(false)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [game])

  useEffect(() => {
    const canvas = canvasRef.current
    const ctx = canvas?.getContext('2d') ?? null
    let palette: Palette | null = canvas ? readPalette(canvas) : null
    const unwatch = watchTheme(() => {
      if (canvas) palette = readPalette(canvas)
    })
    const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    let frame = 0
    const loop = startLoop((ticks) => {
      game.frame(ticks)
      frame += 1
      if (ctx && palette) render(ctx, { ...game.view(), reducedMotion, frame }, palette)
    })
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') game.suspend()
    }
    const onPageHide = () => game.save()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      loop.stop()
      unwatch()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      game.suspend()
    }
  }, [game])

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>REPLAY</h1>
          <div className="sub">A durable execution game. Crash as often as you like.</div>
        </div>
      </div>
      <div className="replay-grid">
        <div className="replay-stage">
          <canvas ref={canvasRef} width={VIEW_W} height={VIEW_H} aria-label="REPLAY game screen" />
          <Overlay phase={game.phase} stats={game.stats} best={game.best} score={game.state.score} />
        </div>
        <HistoryPanel history={game.history} />
      </div>
    </div>
  )
}
```

- [ ] **Step 5: Register the lazy route**

In `web/src/router.tsx`, append to the end of the `gatedChildren` array, right after the `...(caps.logs ? … : [])` line:

```tsx
  // Hidden easter egg (Konami code / direct URL); its own lazy chunk.
  { path: 'replay', lazy: () => import('./pages/replay/Replay'), handle: { rumView: 'Replay' } },
```

- [ ] **Step 6: Add the page styles**

Append to the end of `web/src/styles/theme.css`:

```css
/* ============================================================
   REPLAY easter egg (pages/replay)
   ============================================================ */
.replay-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 14px; align-items: start; }
.replay-stage { position: relative; max-width: 960px; }
.replay-stage canvas { display: block; width: 100%; height: auto; image-rendering: pixelated; border: 1px solid var(--line); border-radius: 13px; background: var(--surface); box-shadow: var(--shadow); }
.replay-overlay { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; border-radius: 13px; background: color-mix(in srgb, var(--bg) 55%, transparent); }
.replay-card { max-width: 440px; padding: 18px 20px; display: grid; gap: 10px; }
.replay-card h2 { margin: 0; font-size: 17px; font-weight: 680; display: flex; align-items: center; gap: 8px; }
.replay-card p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.5; }
.replay-card .replay-keys { font-family: var(--mono); font-size: 11px; color: var(--faint); }
.replay-link { color: var(--link); font-size: 12.5px; text-decoration: none; }
.replay-link:hover { text-decoration: underline; }
.replay-stats { margin: 4px 0 0; grid-template-columns: repeat(3, 1fr); }
.replay-count { margin-left: auto; font-family: var(--mono); font-size: 11px; font-weight: 400; color: var(--muted); }
.replay-empty { margin: 0; padding: 14px; color: var(--faint); font-size: 12.5px; }
.replay-hist { max-height: 540px; overflow: auto; padding: 8px 12px; }
@media (max-width: 1100px) { .replay-grid { grid-template-columns: 1fr; } }
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/replay src/App.test.tsx src/test/styleguide.test.ts`
Expected: PASS. Then type-check: `cd web && npx tsc -b`. Expected: no errors. If `lazy`'s return type complains, check that `Replay.tsx` exports nothing but `Component`.

- [ ] **Step 8: Commit** (ask first)

```bash
git add web/src/pages/replay web/src/router.tsx web/src/styles/theme.css
git commit -m "feat(replay): add lazy /replay page with history panel and overlays"
```

---

### Task 10: Konami-code trigger in the App shell

**Files:**
- Create: `web/src/hooks/useKonami.ts`
- Modify: `web/src/App.tsx` (import `useNavigate` and `useKonami`, call it inside `App`)
- Modify: `web/src/App.test.tsx` (add one test)
- Test: `web/src/hooks/useKonami.test.tsx`

**Interfaces:**
- Consumes: `isEditableTarget` (Task 7); the `/replay` route (Task 9).
- Produces: `KONAMI: readonly string[]` (lower-cased keys), `useKonami(onMatch: () => void): void`.

- [ ] **Step 1: Write the failing tests**

`web/src/hooks/useKonami.test.tsx`:

```tsx
import { fireEvent, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useKonami } from './useKonami'

const CODE = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']

function press(keys: string[], target: EventTarget = window) {
  for (const key of keys) fireEvent.keyDown(target, { key })
}

describe('useKonami', () => {
  it('fires once on the full sequence', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press(CODE)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('accepts upper-case B A', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press([...CODE.slice(0, 8), 'B', 'A'])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('a wrong key in the middle resets the sequence', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press([...CODE.slice(0, 5), 'x', ...CODE.slice(5)])
    expect(cb).not.toHaveBeenCalled()
    press(CODE)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('tolerates extra leading presses', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    press(['ArrowUp', ...CODE])
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('ignores keys typed into form fields', () => {
    const cb = vi.fn()
    renderHook(() => useKonami(cb))
    const input = document.createElement('input')
    document.body.appendChild(input)
    press(CODE, input)
    expect(cb).not.toHaveBeenCalled()
    input.remove()
  })

  it('stops listening after unmount', () => {
    const cb = vi.fn()
    const { unmount } = renderHook(() => useKonami(cb))
    unmount()
    press(CODE)
    expect(cb).not.toHaveBeenCalled()
  })
})
```

Add to `web/src/App.test.tsx` inside `describe('App shell', …)`. That file already imports `fireEvent`, `vi`, `renderApp` and the matchMedia stub:

```tsx
  it('opens the REPLAY easter egg on the Konami code', async () => {
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1))
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null)
    renderApp('/')
    const code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ArrowLeft', 'ArrowRight', 'b', 'a']
    for (const key of code) fireEvent.keyDown(window, { key })
    expect(await screen.findByRole('heading', { name: 'REPLAY' })).toBeInTheDocument()
    getContext.mockRestore()
    vi.unstubAllGlobals()
    // matchMedia was stubbed in beforeAll; unstubAllGlobals removed it, so restore it.
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: true, media: query, onchange: null,
      addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
    }))
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/hooks/useKonami.test.tsx src/App.test.tsx`
Expected: FAIL. `./useKonami` is not found, and the App test times out waiting for the REPLAY heading.

- [ ] **Step 3: Implement the hook and mount it**

`web/src/hooks/useKonami.ts`:

```ts
import { useEffect, useRef } from 'react'
import { isEditableTarget } from '../lib/isEditableTarget'

export const KONAMI: readonly string[] = [
  'arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a',
]

/** Calls onMatch when the Konami code is typed anywhere outside a form field. */
export function useKonami(onMatch: () => void): void {
  const latest = useRef(onMatch)
  useEffect(() => {
    latest.current = onMatch
  }, [onMatch])

  useEffect(() => {
    let recent: string[] = []
    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return
      recent = [...recent, e.key.toLowerCase()].slice(-KONAMI.length)
      if (recent.length === KONAMI.length && recent.every((k, i) => k === KONAMI[i])) {
        recent = []
        latest.current()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
}
```

In `web/src/App.tsx`:

- change the router import to `import { Outlet, useMatches, useNavigate, useSearchParams } from 'react-router-dom'`
- add `import { useKonami } from './hooks/useKonami'` after the `useDiscoveryTelemetry` import
- inside `App()`, directly after the `useDiscoveryTelemetry()` call, add:

```tsx
  // Easter egg: ↑↑↓↓←→←→BA opens the REPLAY game (pages/replay).
  const navigate = useNavigate()
  useKonami(() => navigate('/replay'))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/useKonami.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit** (ask first)

```bash
git add web/src/hooks/useKonami.ts web/src/hooks/useKonami.test.tsx web/src/App.tsx web/src/App.test.tsx
git commit -m "feat(replay): open the REPLAY easter egg with the Konami code"
```

---

### Task 11: Docs note, full gate, build check and a manual playtest

**Files:**
- Modify: `ARCHITECTURE.md` (§7 Frontend → *Routing*, add one paragraph after the pages list)

**Interfaces:**
- Consumes: everything above.
- Produces: verified, playable feature.

- [ ] **Step 1: Add the architecture note**

In `ARCHITECTURE.md`, after the paragraph under `### Routing (\`router.tsx\`)` that ends with "see *Capabilities* in §5.", add:

```markdown
`/replay` is a hidden easter egg: REPLAY, a small runner game that teaches workflow
replay and determinism (Konami code or direct URL; not linked in the nav). It is the one
lazy route (`lazy: () => import('./pages/replay/Replay')`), so it ships as its own chunk.
It is browser-only: a pure, event-sourced engine in `pages/replay/engine/` (guarded by
`purity.test.ts`), a runtime state machine in `pages/replay/runtime/`, and its only
persistence is `localStorage` (`devdash.replay.*`). Design: `docs/superpowers/specs/2026-09-29-replay-easter-egg-design.md`.
```

- [ ] **Step 2: Run the full gate**

Run: `make test`
Expected: web suite PASS. Go unit PASS, except the known Windows-only `cmd`/`pkg/discovery` failures (see Global Constraints), which also fail on `main`. Paste the summary lines into the task report.

- [ ] **Step 3: Lint and type-check**

Run: `cd web && npm run lint && npx tsc -b`
Expected: no errors (warnings from pre-existing files are fine; there are no new warnings in `pages/replay`, `hooks/useKonami.ts` or `lib/isEditableTarget.ts`).

- [ ] **Step 4: Confirm the separate chunk**

Run: `cd web && npm run build && ls dist/assets | grep -i replay`
Expected: at least one `Replay-*.js` file. `dist/` is gitignored, so don't commit it.

- [ ] **Step 5: Manual playtest** (use the `run` skill, or `make build && ./bin/diagrid-dev-dashboard --no-open` and open `http://localhost:9090/`)

Check each item and report what you saw:
- Typing ↑↑↓↓←→←→BA on the Applications page opens `/replay`. The same keys typed into a search/filter input do not.
- Level 0: the crash at ~15 s shows the glitch and "daprd: signal: killed", then "Progress lost". Enter shows the level-1 tip and a "Dapr Workflow enabled" notice.
- Level 1: a crash within ~8–12 s fast-forwards with "⏩ REPLAYING HISTORY" and "✓ from history" badges. Play resumes where it stopped. The history panel lists events.
- Level 2: taking an orb forces a crash. The replay diverges into the boss ("NonDeterministicError · survive Ns"). Surviving shows "Hotfix deployed · continue-as-new".
- Level 3: taking a crate, then the forced crash, replays cleanly (no boss).
- Theme toggle mid-run recolours the canvas without restarting.
- Closing the tab mid-run and reopening `/replay` offers "Resume your run?", and Enter replays to the same spot.
- Holding Space doesn't auto-jump repeatedly.
- With OS "reduce motion" on, crashes show the banner without shake or flicker.
- Tuning is a judgement call. If jumps feel wrong or the boss is unfair, adjust only the constants in `engine/step.ts` (`MIN_GAP`, `GAP_RANGE`, `BOSS_GAP_SCALE`, `JUMP_VY`, `GRAVITY`) and `LEVELS`. Then re-run `cd web && npx vitest run src/pages/replay`.

- [ ] **Step 6: Commit** (ask first)

```bash
git add ARCHITECTURE.md
git commit -m "docs: note the REPLAY easter egg in ARCHITECTURE"
```
