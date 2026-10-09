# REPLAY — game mechanics and how to change them

REPLAY is the hidden runner game at `/replay` (Konami code or direct URL). It
teaches Dapr workflow replay and determinism through its mechanics: the game
really is event-sourced, and it really diverges when workflow code is
non-deterministic. This file explains how it works so you can change it
safely. Design history: `docs/superpowers/specs/2026-09-29-replay-easter-egg-design.md`
(v1) and `docs/superpowers/specs/2026-09-30-replay-gameplay-v2-design.md` (v2).

All code lives in `src/pages/replay/`. Outside it, only the lazy route in
`src/router.tsx` and the Konami hook reference the game.

## The one rule: determinism

Everything below depends on this. Break it and crash replay, rewinds,
montages and shared execution IDs all go out of sync.

- **`engine/` is pure.** `step(state, inputs, ports, levels)` advances one
  60 Hz tick and returns a new state plus outcome events. Same inputs give the
  same result. `engine/purity.test.ts` fails the build if engine code mentions
  `Math.random`, `Date`, `performance`, `window`, `document` or `localStorage`.
- **Every piece of state that affects play lives in `GameState` and is
  hashed** in `engine/hash.ts`. Each outcome event carries the state hash, and
  replay compares it. A new field that isn't hashed can drift unnoticed.
- **`step` never mutates its input.** `clone()` deep-copies the state first.
  The rewind buffer keeps references to old states, so mutation would corrupt it.
- **All outside-world values go through `Game.source`** (`runtime/tape.ts`):
  - the orb `impure()` value, also used live for crate results;
  - chaos crash timing;
  - player inputs, recorded by live tick.

  Live play records them on the run *tape*, and playback reads them back.
  Never call `Math.random` or `this.deps.impure` directly in `runtime/game.ts`.

## Code map

| Path | Responsibility |
|---|---|
| `engine/types.ts` | `GameState`, `Player`, `Entity`, `Lane`, `StartInput`, `HistoryEvent`, view constants (`VIEW_W` 480 × `VIEW_H` 270, `GROUND_Y` 230, `PLAYER_X` 80) |
| `engine/step.ts` | One tick: movement, spawning, obstacles, hit chain, pickups, fan-out/fan-in. All gameplay constants live here |
| `engine/levels.ts` | The level table (`LEVELS`), speed ramp, chaos rate |
| `engine/replay.ts` | `createReplayer` / `replay`: re-runs `step` over a history and detects divergence |
| `engine/hash.ts`, `rng.ts`, `seed.ts` | State hash (FNV-1a), seeded RNG (mulberry32), `seedForDate` |
| `runtime/game.ts` | The `Game` state machine: phases, crash/replay, retry rewind, boss, montage, saves, tape recording and playback |
| `runtime/rewind.ts` | Rewind ring buffer and the "safe spot" picker |
| `runtime/montage.ts` | Level-end montage replayer |
| `runtime/chaos.ts` | When the "process" crashes (outside-world randomness, via the tape) |
| `runtime/tape.ts`, `share.ts` | Run tape, `TapeRecorder`/`TapePlayer`, `RPL1.` run codes (shown to players as the *execution ID*) |
| `runtime/persistence.ts`, `validate.ts` | `localStorage` saves (v2) and their shape validators |
| `runtime/keys.ts`, `loop.ts`, `daily.ts` | Key mapping, fixed-timestep rAF loop, `utcDate()` |
| `render/*` | Canvas drawing: `canvas.ts` (scene, HUD, overlays), `props.ts` (obstacles, pickups, gate), `sprites.ts` (the Dapr hat), `palette.ts` (theme tokens) |
| `Replay.tsx`, `Overlay.tsx`, `HistoryPanel.tsx` | React page, DOM cards over the canvas, history list |

## Game loop and phases

`startLoop` calls `Game.frame(ticks)` once per animation frame, with the number
of whole 60 Hz ticks that elapsed (at most 5). Only the `playing` phase runs
ticks. Every other phase is frame-driven and consumes no ticks.

| Phase | What happens | Leaves on |
|---|---|---|
| `title` | Title card; below a divider, an Execution ID field replays a run someone shared or you copied | Enter → new run |
| `resume` | A saved run was found | Enter → replay it · Esc → discard |
| `tip` | Level tip card | Enter → `playing` |
| `playing` | Ticks run; input recorded | crash, hit, level end, pause |
| `paused` | Esc/p, tab hidden or window blur | Esc/Enter/p |
| `crashing` | "game suddenly crashed, not your fault!" glitch, plus "Dapr Workflow will now replay." from level 1 on, `CRASH_FRAMES` (90, 1.5 s, long enough to read both lines) | → `replaying` |
| `replaying` | History fast-forwarded (≥ 8 ticks/frame, done within ~120 frames) | → `playing`, or boss on divergence |
| `rewinding` | ◀◀ RetryPolicy rewind effect, `REWIND_FRAMES` (30) | → `playing` |
| `montage` | Level-end replay of the level's history (~4 s) | Enter skips → `tip` |
| `lost` | Level 0 crash: progress lost | Enter → level 1 |
| `over` | Workflow FAILED (or Playback finished) card: stats, the run's execution ID with a `⧉ Copy` button and a line saying it can be shared (live runs only), Replay entire run, Share | Enter → new run |

## History events

Each history segment (a level, a boss phase, a hotfix) starts from a
`StartInput` and records events in tick order. **Input events** are fed back
to `step` as inputs during replay. **Outcome events** come from `step` and are
checked by type, id and hash.

| Event | Kind | Meaning |
|---|---|---|
| `Input {kind}` | input | `jump`, `jumpEnd`, `slideStart`, `slideEnd` |
| `OrchestratorStarted` | input (`resume`) | Recorded by the runtime whenever a replay resumes play, and at the start of a boss segment. Grants `GRACE_RESUME` (1 s) |
| `RetryAttempt {attempt, failedAt}` | input (`retry`) | Recorded at the rewind tick. Spends a retry and grants `GRACE_RETRY` |
| `ActivityCoinCollected` | outcome | Coin collected (score, circuit-breaker charge) |
| `ActivityCrateCollected {result}` | outcome | Crate: an impure value *recorded* in history, so replay reads it back |
| `OrbTaken` | outcome | Orb: an impure value *not* recorded, so a replay diverges |
| `CircuitBreakerTripped {id}` | outcome | Shield absorbed a hit (id 0 = pit) |
| `BoostLost {id}` | outcome | ×3 boost absorbed a hit |
| `FanOut` / `FanIn {results}` | outcome | Lanes split / merge; `results` = coins per lane |

The runtime appends input events to the history the moment they happen
(`recordInput`). The *next* tick applies them. That way a save taken in
between keeps them. An input event may sit exactly on the save tick; outcome
events are always before it (enforced by `isSaveBody`).

## Movement

Tune these in `engine/step.ts`. `movePlayer` handles one hat; during fan-out
it runs once per lane.

- **Jump:** `JUMP_VY` −9, `GRAVITY` 0.5 → a full hold rises about 76 px.
  Releasing early (`jumpEnd`) caps upward speed at `JUMP_CUT_VY` (−3). A tap of
  about 6 ticks clears a low rack; tall racks need a held jump.
- **Coyote time:** `COYOTE_TICKS` (6). A jump still works for 6 ticks after
  walking off an edge, including on the edge tick itself.
- **Jump buffer:** `JUMP_BUFFER_TICKS` (6). A jump pressed in the air fires on
  landing if it was pressed within the last 6 ticks.
- **Slide:** `SLIDE_H` 9 px instead of `PLAYER_H` 16 px. It passes under `high`
  racks.
- **Support:** the hat stands only when its foot centre
  (`PLAYER_X + PLAYER_W / 2`) is not over a pit. Falling `PIT_HIT_DEPTH`
  (14 px) below the ground counts as a hit.

## Obstacles and pickups

Spawned by `spawnMain`/`spawnLanes` from the level's weights, using the seeded
RNG in state. Spacing scales with speed, so reaction time stays constant.

| Kind | Size | Behaviour |
|---|---|---|
| `low` | 14×20 | Jump over |
| `high` | 22×30, hangs | Slide under |
| `tall` | 16×44 | Needs a held jump |
| `falling` | 18×24 | Hangs until `FALL_LEAD_TICKS` (1 s) before reaching the hat, then drops with `RACK_GRAVITY`. It then behaves like `low` |
| `pit` | 30–60 wide | A gap in the ground; see Support above |
| `coin` | 10×10 | +score × multiplier; +1 circuit-breaker charge |
| `orb` | 12×12, at the coin heights | To avoid: ×3 for `BOOST_TICKS` (10 s) but mixes an unrecorded impure value into the RNG. A low orb is dodged by sliding, a high one by not jumping. Only the orb's box collides, never its label |
| `crate` | 14×14 | Same boost; the impure value is recorded, so replay stays in sync |
| `fanout` | gate | Starts fan-out when it reaches the hat (never randomly spawned) |

`RACKS` and `HAZARDS` in `step.ts` group the kinds for collisions and for the
rewind's safe-spot check. Racks collide with the hat's box shrunk by
`HAZARD_INSET_X` (3 px) on the left and right, so a graze is forgiven; pickups
use the full box.

## The hit chain

When a rack overlaps the hat, or the hat falls too deep into a pit,
`resolveHit` applies the first layer that can absorb it. Only one hit resolves
per tick.

1. **Grace** (`tick < graceUntil`): racks are ignored; in a pit the hat is
   bounced out.
2. **Circuit breaker** (level has `shieldEnabled` and `shield === SHIELD_FULL`,
   10 coins): the rack is smashed and drawn as debris, or the pit is bounced
   out of. The charge goes to 0, with `GRACE_BARGE` (0.5 s) of grace.
3. **Boost** (`multiplier > 1`): the ×3 is lost, with `GRACE_BOOST` (1 s) of
   grace.
4. **Retry** (`retries > 0`): `status = 'retry'`. The runtime rewinds (below).
5. Otherwise `status = 'failed'`, which ends the run.

### RetryPolicy rewind (`runtime/rewind.ts`, `Game.retry`)

The game keeps the last `REWIND_BUFFER_TICKS` (180) states of the segment,
plus its tick-0 state. On a retry it picks the latest state that meets all of
these:

- at least `REWIND_PX` (240 px, half a screen) before the hit;
- after the previous `RetryAttempt`, so a retry can never be refunded;
- *safe*: every hat is on solid ground and nothing hazardous is within about
  120 px ahead.

History after that tick is cut off, so coins collected in the rewound span
come back. `RetryAttempt` is recorded, and the ◀◀ effect plays the buffered
frames in reverse. A pending chaos crash survives a retry. Retries reset to
the level's `retries` at every level start. The boss and hotfix segments carry
`retries` and `shield` over.

## Crashes, replay and the boss

- **Chaos** (`runtime/chaos.ts`) schedules crashes from the level's
  `chaosMeanTicks` (shrinking toward `chaosFloorTicks` in level 5), a
  guaranteed `firstCrashTicks` window, a `scriptedCrashAt`, or
  `CRASH_AFTER_PICKUP` (1–5 s after an orb or crate in levels 2–3). Crashes are
  never part of history.
- **A crash** throws the live state away and replays the segment's history up
  to the crash tick. Completed activities show "✓ from history". When the
  replay matches, `OrchestratorStarted` is recorded and play resumes at the
  same tick, with 1 s of grace.
- **Divergence** (an orb's value differs on replay) starts the
  `NonDeterministicError` boss phase. It is a *continue-as-new* segment from
  the diverged state, lasting `BOSS_TICKS` (15 s) with denser `bossWeights`.
  - Survive it and a hotfix continues as new again.
  - Die during it and the reason is "non-determinism detected at event #n".
- **Continue-as-new** (`continueAsNew`) carries level, score, elapsed,
  distance, retries and shield, with a derived seed. It does not carry
  on-screen entities or fan-out lanes.

## Fan-out / fan-in

Levels with `fanOut: { everyPx, ticks }` (level 4 Fan Out, level 5 Production)
work like this:

1. Normal spawns stop `FAN_CLEAR_PX` (200 px) before the next gate. A
   `fanout` gate appears at `nextGateAt`.
2. When the gate reaches the hat, `state.fan` holds `FAN_LANES` (2) lanes. Each
   lane has its own hat, entities and coin count.
3. Every lane gets the same inputs. Lanes spawn only `laneWeights` kinds
   (`low`, `pit`, `coin`) at `LANE_SPAWN_X`.
4. A hit in any lane runs the hit chain once for the whole workflow, because
   `WhenAll` fails if any task fails.
5. After `ticks`, the lanes merge (`FanIn`). The main hat becomes the hat of
   `MERGE_LANE`, and the next gate is `everyPx` past the merge point.
   `levelDone` waits for the merge.

While fanned out, `state.player` is frozen at its pre-gate value. Read the live
hat with `livePlayer(state)`. Each lane is drawn in its own strip,
`VIEW_H / FAN_LANES` tall, scaled by `LANE_SCALE` (0.75). If you change
`FAN_LANES`, check that the strip height divided by `LANE_SCALE` still covers
the 180 px of world a lane shows (`LANE_TOP` in `canvas.ts`), and keep
`LANE_SPAWN_X = VIEW_W / LANE_SCALE + 10`.

## Levels (`engine/levels.ts`)

| # | Name | Length | Adds | Retries / breaker | Chaos |
|---|---|---|---|---|---|
| 0 | No Safety Net | endless | low racks, coins; **not durable** | 0 / off | scripted crash at 900 → "Progress lost" |
| 1 | Replay | 6300 | high racks, pits | 3 / on | first crash in 480–720 |
| 2 | Temptation | 8000 | orbs, falling racks | 3 / on | crash 1–5 s after an orb |
| 3 | Wrap It | 9000 | crates, tall racks | 3 / on | crash after an orb or crate |
| 4 | Fan Out | 9000 | fan-out every 2500 px | 3 / on | mean 1200 ticks |
| 5 | Production | endless | everything, speed ramp to 9, fan-out every 4000 px | 3 / on | mean shrinking toward 480 |

Speeds and weights are tuning knobs. Change them freely, but note the
run-code caveat below.

## Montage (`runtime/montage.ts`)

At the end of a durable, finite level, the game replays every segment of that
level back to back in about `MONTAGE_FRAMES` (240) frames:

- live play, the boss phase and the hotfix are each a segment;
- a brief flash (the theme's text colour) marks each continue-as-new boundary;
- a ghost trail follows the hat.

Orbs get the values live play saw, which are kept in `orbValues` (runtime only,
never in history), so the montage shows what really happened. The montage
reads nothing from the outside world. The next level has already started and
been saved, so a tab closed mid-montage resumes at tick 0 of that level.

## Saves, daily seed, best scores

- **Save** (`devdash.replay.save`, `version: 2`) holds the segment's start
  input, history and tick, plus stats, montage segments, orb values, date and
  the tape. It is written on every event, on pause and on tab hide. A v1 or
  malformed save reads as "no save".
- **Daily seed:** every run is seeded with `seedForDate(utcDate())`, so
  everyone plays the same levels on the same UTC day. A resumed save keeps its
  own date.
- **Best scores:** all-time is `devdash.replay.best`. Today's best is
  `devdash.replay.daily` (`{date, best}`), updated only when the run's date is
  today.

## Run tape, playback and execution IDs

The tape (`runtime/tape.ts`) holds everything the outside world fed a run:

- player inputs by live tick;
- every impure and chaos value, quantised to uint32 so it reproduces exactly;
- one restart entry per tab-close resume, holding the resumed save snapshot
  and the tape cursors at that moment.

`Game.watch(tape)` plays a run back exactly. Tip cards confirm themselves,
restarts restore their snapshot in any phase, and the tick loop never steps
past a pending restart. Nothing is written to storage during playback.

**Playback speed:** 1×, 2×, 5× or 10× (`PLAYBACK_SPEEDS`,
`Game.setPlaybackSpeed`), chosen with the `.segs` control under the canvas,
which is shown only while watching. At N× each animation frame runs N frame
steps, so crash replays, rewinds and montages speed up too. Playback stays
exact because it doesn't depend on frame size. Live runs always run at 1×,
and leaving playback resets the speed. The HUD banner shows it
(`▶ PLAYBACK · <date> · 5×`). Telemetry: `replay_speed` with `{ speed }`.

A run's **execution ID** is its run code: `RPL1.` + base64url(deflate-raw(JSON))
(`runtime/share.ts`). After every game the end card shows it with the
standard `.copybtn` (`copyText()` from `lib/clipboard.ts`). **Replay entire
run** decodes that ID and plays it back. The title card's Execution ID field
does the same for an ID someone shared or one copied earlier. Telemetry:
`replay_share_copy` (copy), `replay_rerun` (Replay entire run), `replay_watch`
(title card).


Decoding strips whitespace, rejects codes over 256 KB, caps the inflated JSON
at 4 MB, and validates the shape. **Caveat:** a code replays against the
*current* level table and engine. After you retune a level or change physics,
older codes replay differently. There is no version check yet.

## Rendering

- The canvas has a fixed logical size of 480×270. It is scaled to device
  pixels, and `render/interpolate.ts` blends between ticks for smooth motion.
- **Colours come only from palette slots** (`render/palette.ts`, mapped to
  `theme.css` tokens), so light and dark themes work. The only colour
  literals are the black/white `rgba(...)` shading constants in `props.ts`,
  `shading.ts` and `sprites.ts`.
  - `withAlpha()` makes a faded copy of a palette colour. The pit shaft uses
    it to fade from dark red to transparent.
- **Reduced motion** turns off screen shake, glitch flicker, the VHS rewind
  lines, the montage flash and the grace blink (the hat gets a steady outline
  instead).
- The HUD shows level, score and multiplier. A second row shows RETRY hats and
  the circuit-breaker bar (`CB n/10` or `CB ARMED`).

## Recipes

**Add an obstacle or pickup kind:**

1. `engine/types.ts`: add it to `EntityKind`.
2. `engine/hash.ts`: add it to `KIND`, with a new number.
3. `engine/step.ts`:
   - add it to `SIZE`, `spawnY` and `ORDER` (append at the end, so existing
     weights keep their meaning);
   - add it to `RACKS` or `HAZARDS` if it hurts;
   - add its collision or pickup behaviour.
4. `render/canvas.ts` `drawEntity` and `render/props.ts`: draw it.
   `drawEntity` indexes `pal[kind]`, so `tsc` fails until you route it.
5. `engine/levels.ts`: give it weight in the levels where it should appear.
6. Tests: `step.test.ts` for behaviour, `props.test.ts` / `canvas.test.ts`
   for drawing, and a hash row in `hash.test.ts` if it adds state.

**Add a history event:**

1. `engine/types.ts`: add it to `HistoryEvent`. If it's an input, also add it
   to `InputEvent`, `isInputEvent` and `inputOf` (`engine/replay.ts`).
2. `runtime/validate.ts` `isEvent`: validate it (saves and run codes carry it).
3. `HistoryPanel.tsx`: add it to `NODE` and `describeEvent`. Both are
   exhaustive, so `tsc` fails otherwise.
4. If the runtime records it, use `recordInput` (inputs) and make sure replay
   produces the same event.

**Add state that affects play:** add the field to `GameState`, set it in
`initialState`, deep-copy it in `clone()` if it's an object, hash it in
`hashState`, and add a row to the `hash.test.ts` mutation table. If it must
survive continue-as-new, add it to `StartInput`, `continueAsNew` and
`isStart`.

**Add a level or change the level count:** update the `Level` union,
`LEVELS`, `makeLevels` in `testing.ts`, `nextLevel` in `game.ts`, and `isStart`
in `validate.ts`.

**Change the save shape:** keep `isSaveBody` in step with `Save`. Bump
`SAVE_VERSION` if old saves can no longer be read correctly; old versions then
read as "no save".

## Testing and gates

- Run `npx vitest run src/pages/replay` and `npx tsc -b` from `web/`. Vitest
  does not typecheck, so `tsc -b` is required, test files included.
- `npm run lint` and `npm run build` (the game ships as its own `Replay-*.js`
  chunk).
- The TypeScript lib is ES2021: no `Array.prototype.at` or `findLast`.
- Useful test helpers in `testing.ts`:
  - `makeLevels(overrides, perLevel)` builds small level tables;
  - `autopilot(state, kinds)` steers toward pickups;
  - `counter()` and `lcg(seed)` are deterministic random sources.
- The strongest checks are the tape tests in `runtime/game.test.ts`. They
  record a run with crashes, retries and a tab-close resume, then play it back
  at several frame sizes and require identical stats, history and state hash.
  If a change breaks them, compare `viewer.history` with `live.history`. The
  first difference points at the value that bypassed the tape.
