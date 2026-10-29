# REPLAY gameplay v2 — safety layers, fan-out, daily seed, shared runs — design

**Date:** 2026-09-30
**Status:** Implemented
**Builds on:** `2026-09-29-replay-easter-egg-design.md` (v1). Everything in v1
stays true unless this document changes it.

## Purpose

v1 teaches replay and determinism well, but the game underneath is a
one-hit-death runner: the only way to lose (hitting an obstacle) has nothing
to do with durability, crashes never threaten anything, and the controls are
stiff. v2 makes the game more fun and puts more Dapr concepts into the
mechanics:

- Getting hit is survivable through three safety layers, each named after a
  real resiliency concept (circuit breaker, retry policy) or a classic runner
  mechanic (Sonic-style: losing a boost instead of a life).
- A retry **rewinds** the run to a safe spot about half a screen back.
- Fan-out/fan-in becomes a level: the hat splits into two parallel lanes
  (originally three; reduced to two after playtesting, 2026-10-01).
- Each completed level ends with a **montage** that really replays the level's
  history.
- Movement gets modern runner feel: variable jump height, coyote time, jump
  buffering, and grace after a resume.
- New obstacles: pits, falling racks, double-height racks.
- A **daily seed**: everyone plays the same levels on a given UTC day.
- **Share a run**: a run code that plays the run back exactly on another
  machine. This works because the game is deterministic.

Success criteria:

- All v1 success criteria still hold. Replay stays honest: every new
  mechanic lives in `step()`/`GameState`, is covered by the state hash, and
  replays exactly.
- A shared run code played back on another machine reproduces the run's
  final score, stats and state hash exactly.
- A player who hits an obstacle in levels 1–5 usually gets another try, so
  runs last longer and deaths feel fair.

## Scope

In scope: the nine features above, their HUD/overlay/history-panel
presentation, save format v2, and tests.

Out of scope: sound, touch controls, online leaderboards, per-branch
drop-out in fan-out (a failed branch fails the fan-in), lane switching, and
a random-seed mode (daily replaces random).

The v1 constraints are unchanged: browser-only, no new dependencies, theme
tokens for colours, `localStorage` as the only write.

## Decisions (agreed 2026-09-30)

| Question | Decision |
|---|---|
| Hit order | Circuit breaker → ×3 boost → retry → FAILED. The circuit breaker triggers on contact. |
| Rewind | History after the rewind tick is dropped; coins collected in that span come back. 3 retries per level. |
| Fan-out | 2 mirrored hats on 2 stacked lanes (first 3; 3 proved too hard). A hit in any lane runs the hit chain for the whole workflow (`WhenAll` fails if any task fails). |
| Daily seed | Every run uses the seed derived from the UTC date; there is no random-seed mode. |
| Share | A copyable run code; a "Watch a run" field on the title card plays it back. |

## Engine changes (`engine/`, pure)

### State additions

```ts
type Level = 0 | 1 | 2 | 3 | 4 | 5
type InputKind = 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd' | 'resume' | 'retry'
type EntityKind = 'low' | 'high' | 'tall' | 'falling' | 'pit' | 'coin' | 'orb' | 'crate' | 'fanout'

interface Entity { /* v1 fields */ vy: number }        // only 'falling' uses vy
interface Player {
  y: number; vy: number; sliding: boolean
  jumpHeld: boolean       // for the variable-height cut
  coyoteUntil: number     // tick; can still jump while tick < coyoteUntil
  jumpBufferUntil: number // tick; a jump pressed in the air fires on landing before this
}
interface Lane { player: Player; entities: Entity[]; nextSpawnAt: number; coins: number }

interface StartInput { /* v1 fields */ retries: number; shield: number }
interface GameState {
  /* v1 fields, and: */
  retries: number         // retries left this level
  shield: number          // circuit-breaker charge 0..SHIELD_FULL
  graceUntil: number      // tick; hits are ignored while tick < graceUntil
  fan: { until: number; lanes: Lane[] } | null
  nextGateAt: number      // world distance of the next fan-out gate; Infinity if none
  status: 'running' | 'failed' | 'levelDone' | 'retry'
  failedAt: number        // tick of the hit that caused status 'retry' (0 otherwise)
}
```

`hashState` covers every new field: lanes in order, then each lane's
entities. `Entity.vy` is quantised like the other floats.

### History events

| Event | Recorded by | Fed to `step` as | Effect |
|---|---|---|---|
| `Input {tick, kind: 'jump'|'jumpEnd'|'slideStart'|'slideEnd'}` | runtime (keys) | input | Player controls. `jumpEnd` is new (a jump key released). |
| `OrchestratorStarted {tick}` | runtime, on every resume | input `resume` | `graceUntil = tick + GRACE_RESUME`. Mirrors Dapr, where each replay episode starts with `OrchestratorStarted`. |
| `RetryAttempt {tick, attempt, failedAt}` | runtime, after a rewind | input `retry` | `retries -= 1`, `graceUntil = tick + GRACE_RETRY`. |
| `ActivityCoinCollected`, `ActivityCrateCollected`, `OrbTaken` | `step` | outcome (hash-checked) | As in v1. |
| `CircuitBreakerTripped {tick, id, hash}` | `step` | outcome | The shield absorbed a hit on entity `id`. |
| `BoostLost {tick, id, hash}` | `step` | outcome | The ×3 boost absorbed a hit. |
| `FanOut {tick, hash}` / `FanIn {tick, hash, results: [n, n]}` | `step` | outcome | Lanes split / merge; `results` = coins per lane. |

Replay feeds `OrchestratorStarted` and `RetryAttempt` to `step` at their
ticks, together with the `Input` events, as inputs. It checks every outcome
event exactly as in v1.

### Movement

Constants (ticks at 60 Hz): `COYOTE_TICKS = 6`, `JUMP_BUFFER_TICKS = 6`,
`JUMP_CUT_VY = -3`.

- **Support.** The player is *supported* when their feet are at `GROUND_Y`
  and the foot centre `PLAYER_X + PLAYER_W / 2` is not over an untaken
  `pit`. An unsupported player falls (gravity applies below `GROUND_Y` too).
  A falling player lands only when moving down (`vy >= 0`), crossing
  `GROUND_Y` from above, and supported.
- **Coyote time.** When the player loses support without jumping,
  `coyoteUntil = tick + COYOTE_TICKS`. A `jump` while `tick < coyoteUntil`
  (and `y <= GROUND_Y`) jumps as if grounded.
- **Jump buffer.** A `jump` that can't fire (in the air, outside coyote time)
  sets `jumpBufferUntil = tick + JUMP_BUFFER_TICKS`. On landing, if
  `tick < jumpBufferUntil`, the jump fires in that same tick.
- **Variable height.** `jump` sets `jumpHeld = true`; `jumpEnd` sets it to
  false and, if `vy < JUMP_CUT_VY`, sets `vy = JUMP_CUT_VY`. A full hold
  still reaches v1's ~81 px apex; a tap reaches about 25 px.
- `keys.ts` maps the release of a jump key (`Space`, `↑`, `w`) to a
  `jumpEnd` command. Releases always get through, like `slideEnd`.

### Obstacles

| Kind | Size (w×h) | Placement | Behaviour |
|---|---|---|---|
| `low`, `high` | v1 | v1 | Unchanged. |
| `tall` | 16×44 | on the ground | Needs a (nearly) full-height jump. |
| `pit` | 30–60 × 0 (from `yRoll`) | in the ground | Not an overlap hazard. Falling to `y >= GROUND_Y + PIT_HIT_DEPTH` (14) is a hit. |
| `falling` | 18×24 | spawns with its bottom at `y = 0` | Starts dropping (`vy += RACK_GRAVITY`, 1) once `x - PLAYER_X <= FALL_LEAD_TICKS * speed` (one second before it would reach the hat), so it lands well ahead of the player. Stops with its bottom at `GROUND_Y`, then behaves like a `low` rack. |

The spawner keeps the v1 gap logic, so hazards never overlap. Coins never
spawn at ground height directly above a pit (they move to the high height
instead).

### The hit chain

When the player overlaps an untaken rack (`low`, `high`, `tall`,
`falling`), or falls to pit-hit depth, `step` resolves the hit:

0. **Grace** (`tick < graceUntil`): a rack is ignored. In a pit the player
   is *bounced* (`vy = JUMP_VY`), with no event.
1. **Circuit breaker armed** (`shield === SHIELD_FULL`, 10): a rack is
   smashed (`taken = true`, drawn as debris); a pit bounces the player.
   `shield = 0`, `graceUntil = tick + GRACE_BARGE` (30), emits
   `CircuitBreakerTripped`.
2. **Boost active** (`multiplier > 1`): `multiplier = 1`, `multUntil = tick`,
   `graceUntil = tick + GRACE_BOOST` (60); a pit bounces the player. Emits
   `BoostLost`.
3. **Retries left** (`retries > 0`): `status = 'retry'`, `failedAt = tick`.
   `step` does nothing else. The runtime rewinds (see *Retry rewind*).
4. **Otherwise** `status = 'failed'`, as in v1.

Only one hit resolves per tick. Coins charge the circuit breaker
(`shield = min(SHIELD_FULL, shield + 1)`); crates and orbs don't. Grace
constants: `GRACE_RESUME = GRACE_RETRY = GRACE_BOOST = 60`,
`GRACE_BARGE = 30`.

### Fan-out / fan-in

- Levels with `fanOut: { everyPx, ticks }` spawn a `fanout` gate entity when
  `distance + scroll` reaches `nextGateAt`. Nothing else spawns from 200 px
  before the gate to 200 px after it. When the gate's `x <= PLAYER_X`:
  `fan = { until: tick + ticks, lanes: FAN_LANES (2) × { player: copy of player, entities: [], nextSpawnAt, coins: 0 } }`,
  the main entity list is cleared, and `FanOut` is emitted.
- While `fan` is set, every lane gets the same inputs and physics, and lanes
  spawn from the shared RNG in lane order (0, 1) using the level's
  `laneWeights` (`low`, `pit`, `coin` only, which fit the lane
  strips). Lane spawns start at `LANE_SPAWN_X = VIEW_W / LANE_SCALE + 10`, because
  lanes are drawn at `LANE_SCALE` 0.75 (see *Rendering*). A lane coin adds to
  `score` (× multiplier), to `lane.coins` and to the shield charge.
- A hit in any lane runs the hit chain once for the workflow. A smash marks
  that lane's entity; a bounce bounces that lane's player.
- Lanes stop spawning 200 px before `until`. At `until`: the main player
  becomes lane `MERGE_LANE` (0)'s player, `fan = null`, `FanIn {results}` is emitted, and
  `nextGateAt` = the merge distance + `everyPx` (so fan-outs never follow each other directly).
- `levelDone` is deferred while `fan` is set. Continue-as-new does not carry
  `fan` (like on-screen entities in v1), so a boss phase that starts during
  fan-out starts with a single hat.

### Levels

| # | Name | New in this level | Retries | Circuit breaker | Fan-out |
|---|---|---|---|---|---|
| 0 | No Safety Net | v1 content, plus the new movement | 0 | off | — |
| 1 | Replay | `pit`; RetryPolicy + circuit breaker introduced | 3 | on | — |
| 2 | Temptation | `falling` | 3 | on | — |
| 3 | Wrap It | `tall` | 3 | on | — |
| 4 | Fan Out (new) | fan-out gates, `everyPx: 2500`, `ticks: 600` | 3 | on | yes |
| 5 | Production (was 4) | everything; endless, speed ramp | 3 | on | `everyPx: 4000` |

`LevelConfig` gains `retries`, `shieldEnabled`, `laneWeights` and an optional
`fanOut`. Retries reset to the level's `retries` at every level transition;
the boss and hotfix continue-as-new segments carry `retries` and `shield` in
`StartInput`. The shield charge carries across levels. Tip cards get one
extra sentence where a concept is introduced (level 1: RetryPolicy and the
circuit breaker; level 4: fan-out/fan-in and `WhenAll`). Speeds and weights
are tuning knobs, set during implementation by playtesting.

## Runtime changes (`runtime/`)

### Retry rewind

- The `Game` keeps a **rewind buffer**: the states of the last
  `REWIND_BUFFER_TICKS` (180) ticks of the current segment, plus the
  segment's tick-0 state as a fallback anchor. Live ticks and replayed ticks
  both fill it; the replayer steps one tick at a time for this. Segment
  starts clear it.
- On `status: 'retry'`: `minBack = ceil(REWIND_PX / speed)` with
  `REWIND_PX = 240` (half a screen). Take the latest buffered state with
  `tick <= failedAt - minBack` that is *safe*: every hat (all lanes during
  fan-out) is supported on the ground with `vy = 0`, and no untaken hazard
  overlaps `[PLAYER_X - 10, PLAYER_X + PLAYER_W + 120]`. If none is safe,
  take the oldest buffered state.
- The history is truncated to events with `tick < R` (R = the chosen
  state's tick). `state` becomes the buffered state, the buffer drops states
  newer than R, and `RetryAttempt {tick: R, attempt, failedAt}` is queued as
  the next tick's input. The chaos scheduler reschedules from R.
- **Phase `rewinding`** (render-only, `REWIND_FRAMES = 30`): plays the
  buffered states from `failedAt` back to R in reverse, evenly sampled,
  under the banner `◀◀ RetryPolicy · attempt n/3`. Input is ignored. Then
  the phase returns to `playing`.
- In a replay, a step that returns `'retry'` counts as divergence, the same
  way `'failed'` does in v1.

### Grace after a resume

After every successful crash replay, save resume, and the first tick of a
boss segment, the runtime queues the `resume` input. It is recorded as
`OrchestratorStarted` and gives 1 s of grace.

### Montage

- The `Game` keeps the current level's **segments**:
  `{ start, history, endTick, orbValues: Map<orbId, number> }`. `orbValues`
  holds the live `impure()` value of each orb pickup. Runtime only, never in
  history: the "value not recorded" lesson stays intact. A segment ends at a
  level end, a crash that diverges (`endTick = crashTick`), or a hotfix.
  Rewinds just truncate the current segment.
- On `levelDone` in a durable level, phase **`montage`**: each segment is
  replayed with `createReplayer`. Its `impure` returns that segment's orb
  values in `OrbTaken` history order. Ticks per frame =
  `max(8, ceil(totalTicks / MONTAGE_FRAMES))` with `MONTAGE_FRAMES = 240`
  (~4 s). Continue-as-new boundaries flash. Banner:
  `LEVEL COMPLETE · replaying N events`. `Enter` skips. Then the next tip
  card appears. Level 0 (not durable) and endless level 5 have no montage.
- The montage consumes nothing from `deps`, so playback stays deterministic.

### Daily seed

- `GameDeps.newSeed` is replaced by `today: () => string` (UTC
  `YYYY-MM-DD`). `seedForDate(date)` is FNV-1a over `replay:${date}` (in
  `engine/`, pure). A run's seed is `seedForDate(runDate)`, taken at
  `newRun`. The level-1 seed after "Progress lost" is `seedFrom(runSeed)`.
  A run that crosses midnight keeps its date.
- The title card shows `Daily run · <date> (UTC)`.
- Best scores: the all-time `devdash.replay.best` stays; a new
  `devdash.replay.daily` stores `{ date, best }` ("Today's best"). A stored
  date other than today reads as 0.

### Run tape (determinism of the whole `Game`)

With a fixed seed, a `Game` is fully deterministic given four things:

```ts
interface Tape {
  v: 1
  date: string
  inputs: [liveTick: number, command: 'jump' | 'jumpEnd' | 'slideStart' | 'slideEnd'][]
  impure: number[]  // uint32; value = u / 2^32
  chaos: number[]   // uint32; value = u / 2^32
  restarts: { liveTick: number; impureAt: number; chaosAt: number; save: Omit<Save, 'tape'> }[] // save resumes: tape cursors plus the snapshot resumed from
  liveTick: number   // live ticks recorded so far
}
```

A save resume replays history, and that replay can consume `impure` values
(orbs). So the tape records each resume in `restarts`: the live tick, where the
impure and chaos values of the resume start, and a snapshot of the save it
resumed from (the save body, never nesting the tape). At that live tick,
whatever phase it is in, playback restores the snapshot exactly as a resume does,
seeks to those cursors and runs the same replay-and-resume path, with the same
`OrchestratorStarted`.

- `liveTick` counts `Game.tick()` calls in the run (live ticks only; frames
  spent crashing, replaying, rewinding, paused or in a montage don't count).
  Inputs are recorded when `tick()` consumes them.
- `deps.impure` and `deps.chaosRand` are quantised at the source
  (`Math.floor(Math.random() * 2**32) / 2**32`), so the values on the tape
  reproduce exactly. A `TapeRecorder` wraps both and logs each value.
- The tape, including its `liveTick` counter, is part of the save (v2), so
  a resumed run can still be shared. Resume appends to `restarts` and keeps
  recording.
- The `resume` and `retry` inputs are generated by the runtime itself, so
  they're reproduced by playback and never stored on the tape.
- **Playback:** a `Game` built with `deps` that read from the tape. The live
  keys are ignored except `Esc` (leave) and pause. Tip and "Progress lost"
  cards confirm automatically; montages play in full. Nothing is saved and
  no best score changes. The HUD shows `▶ PLAYBACK · <date>`. When
  `impure` or `chaos` values run out, playback stops with "Run code ended
  early".

### Share a run

- Encoding: `JSON` → UTF-8 → `CompressionStream('deflate-raw')` → base64url,
  prefixed with `RPL1.`. Decoding reverses this and validates the shape
  (like `isSave`). Codes longer than 256 KB are rejected. Anything invalid
  shows "That run code isn't valid."
- Game-over card: a **Copy run code** button next to Share (same `tbtn`
  class). It uses `navigator.clipboard.writeText`. If that fails, the code
  appears in a read-only, pre-selected textarea.
- Title card: a **Watch a run** text field and button. Game keys already
  ignore interactive targets, so typing and pasting are safe.
- Telemetry: `trackAction('replay_share_copy')` and
  `trackAction('replay_watch')`, like the existing `share_open`.

### Stats and save

- `RunStats` gains `retriesUsed`, `circuitTrips` and `boostsLost`, all shown
  on the end card.
- The save becomes `version: 2` with the new `StartInput` fields, the new
  event types, `segments` and `tape`. A v1 save reads as "no save".

## Rendering and UI

- **HUD second row:** `RETRY` as small hat icons (filled = left) and
  `CB 7/10` as a 10-cell bar that reads `ARMED` when full.
- **Grace:** the hat blinks (every 4 ticks). With reduced motion it gets a
  steady outline instead.
- **New sprites** in `props.ts`: pit (a gap in the ground line over a shaft
  that fades from dark red, the darkened obstacle colour, to transparent), falling rack (a rack plus a warning ground shadow that grows as it
  drops), tall rack, smashed-rack debris, fan-out/fan-in gates (a `WhenAll`
  arch).
- **Fan-out:** two stacked strips of `VIEW_H / FAN_LANES`. Each lane is drawn with
  `ctx.scale(0.75, 0.75)` into its strip, so lane physics stay in full-size
  world coordinates.
- **Rewind:** a VHS look (scanline offset, `◀◀`). Reduced motion keeps only
  the banner.
- **Montage:** a ghost trail (the last 6 sampled hat positions, fading).
- **New palette slots** map to existing `theme.css` tokens only.
- **History panel:** descriptions and node classes for the new events:
  `OrchestratorStarted` / `RetryAttempt` / `FanOut` / `FanIn` → `n-sched`,
  `CircuitBreakerTripped` → `n-done`, `BoostLost` → `n-fail`.

## Testing

Vitest, co-located, same style as v1:

- **Engine:** coyote, buffer and jump cut, including tap vs hold heights;
  pit support and pit hits; falling-rack trigger and landing; each layer of
  the hit chain and its order; grace pass-through and bounce; shield charge
  and cap; fan-out split/merge and `FanIn` results; deferred `levelDone`;
  `seedForDate` is stable and differs by date; the purity test still passes.
- **Replay:** histories containing `OrchestratorStarted`, `RetryAttempt`,
  `CircuitBreakerTripped`, `BoostLost`, `FanOut`/`FanIn` replay `ok`, and a
  live run's final hash equals `replay()` of its history.
- **Game:** the rewind picks a safe tick at least `minBack` back, truncates
  history, restores coins and spends a retry; the rewind phase ends back in
  `playing`; grace follows a crash resume; a montage plays the level's
  segments and then shows the tip; the level-1 seed after "Progress lost"
  comes from the run seed.
- **Tape:** play a run with stubbed random sources and scripted inputs
  (crashes, an orb divergence and boss, a rewind, a save resume), then play
  the tape back.
  Final score, stats and `hashState` must be identical. Playback also stops
  cleanly on a truncated tape.
- **Share:** encode/decode round-trip; invalid, oversized and wrong-prefix
  codes are rejected.
- **Persistence:** a v2 round-trip; a v1 save and a corrupt save read as "no
  save"; the daily best resets on a new date.
- **UI:** Overlay renders Copy run code and Watch a run; the HistoryPanel
  labels the new events; the canvas smoke tests cover the new sprites, HUD
  row, fan-out strips and rewind.
- Gates: `make test` and `tsc -b` (vitest does not typecheck), and
  `npm run build` still emits the replay code in its own chunk.

## Delivery

One spec and one plan, in five phases. Each phase leaves the game playable
and all gates green:

1. Movement feel and new obstacles.
2. Grace, the hit chain (circuit breaker, boost, retry) and rewind.
3. Fan-out level and the level renumbering.
4. Montage.
5. Daily seed, run tape and share a run.
