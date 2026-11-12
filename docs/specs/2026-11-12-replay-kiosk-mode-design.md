# REPLAY kiosk mode — design

Date: 2026-11-12
Status: draft, awaiting approval

## Intent

The REPLAY game (`/replay`, see `web/REPLAY.md`) is shown at the Dapr project
kiosk at conferences. Between visitors, the screen should not sit on a static
title card. Kiosk mode makes the game play itself on a large monitor, so people
walking past see a real game: jumps, slides, chaos crashes, Dapr replaying the
workflow, the non-determinism boss and the level montages. When a visitor
steps up and presses anything, auto play stops at once and they get the start
screen so they can play themselves.

Success: booth staff press Ctrl+K once, walk away, and the monitor loops a
convincing, readable game for hours; any visitor key press hands the game over
cleanly, without leftovers from the bot's run.

## Goals

1. **Start:** pressing **Ctrl+K** starts kiosk mode while any of these cards
   is showing: the title card (start screen), the end card (`over`), the pause
   card (`paused`) or "Resume your run?" (`resume`). Starting kiosk mode
   discards the previous visitor's unfinished run (decided by the user), so
   booth staff never need to reload the page.
2. **Hint label:** the title card shows a small label:
   `press CTRL+K to start kiosk mode`.
3. **Real game, played by a bot:** auto play drives the real game through the
   same input commands a player uses (`jump`, `jumpEnd`, `slideStart`,
   `slideEnd`). All game mechanics run for real: obstacles, pickups, chaos
   crashes, crash replay, the boss, montages, tip cards.
4. **Levels 0 → 3, then loop:** auto play plays level 0 (including its scripted
   "progress lost" crash), then levels 1, 2 and 3. After level 3 ends
   (after its montage), it starts again at level 0.
5. **Fully deterministic:** every loop is identical — same levels, same
   crashes, same bot moves. Deterministic is fine and preferred (decided by the
   user).
6. **Stop on any input:** while kiosk mode is on, any key press (and any
   pointer/touch press on the game stage) stops auto play
   immediately and shows the title card. The pressed key does *not* also act
   as a game command (so Enter doesn't immediately start a run, the visitor
   sees the start screen first).
7. **On-screen banner:** while auto play runs, a banner shows it is auto play
   and how to take over, e.g. `AUTO PLAY · press any key to play`.

## Non-goals

- **No automatic return to kiosk mode.** After a visitor plays, booth staff
  press Ctrl+K again (decided by the user). No idle timer.
- No curated / recorded runs or execution IDs as the kiosk content.
- No levels 4 and 5 in auto play.
- No browser fullscreen handling, no new settings UI, no URL flag or CLI flag
  for kiosk mode. (Ctrl+B already hides the sidebar, which suits the booth.)
- No change to normal play, saves, playback or the engine's game rules.

## Anti-goals (would make this a failure even if it "works")

- The bot's run leaks into the visitor's experience: a "Resume your run?"
  prompt from the bot's game, a bot score in Today's best / Best, or the bot's
  tape becoming the visitor's execution ID.
- The kiosk stalls: stuck on a card, paused, or dead on an end card with
  nobody around to press a key.
- The bot looks broken: dying constantly, or obviously jittering.
- Breaking the game's determinism rule (`web/REPLAY.md`, "The one rule"):
  no `Math.random`/`Date` in `engine/`, all outside-world values through
  `Game.source`.

## Constraints

- All code stays in `web/src/pages/replay/` (plus tests). Frontend only; no Go
  changes.
- `engine/` stays pure (`engine/purity.test.ts`). The bot policy is a pure
  function of `GameState` and may live in `engine/` or `runtime/`.
- Colours only via palette slots / theme tokens (`web/STYLEGUIDE.md`,
  `render/palette.ts`); works in light and dark themes and with reduced motion.
- Gates: `npx vitest run src/pages/replay`, `npx tsc -b`, `npm run lint`,
  `npm run build` from `web/`, plus `make test`. Vitest does not typecheck, so
  `tsc -b` is mandatory.
- Update `web/REPLAY.md` (phases/controls/code map) for the new mode.

## How it works

### Entering kiosk mode

- `Replay.tsx`'s window `keydown` handler currently drops every key pressed with
  Ctrl/Meta/Alt. Add an explicit exception before that filter: `Ctrl+K`
  (`e.ctrlKey && key.toLowerCase() === 'k'`, no Meta/Alt) while
  `game.phase.kind === 'title'` → `preventDefault()` (browsers bind Ctrl+K to
  the address/search bar on some platforms) and call `game.startKiosk()`.
- Allowed phases: `title`, `over`, `paused`, `resume` — in live play and in
  playback (watching an execution ID). Ctrl+K in any other phase (`playing`,
  `tip`, `crashing`, `replaying`, `rewinding`, `montage`, `lost`) does nothing
  and is not prevented.
- **Discarding the previous run:** `startKiosk()` clears the stored save
  (`store.clear()`) and drops `savedRun`, an in-progress or finished live run,
  or a playback (`leavePlayback()`-style reset). Best and today's-best scores
  already recorded by visitors are kept. This is the one store write kiosk mode
  makes, and it happens once, at start.
- Ctrl+K typed while focus is in the title card's Execution ID field is ignored,
  like other game keys (`isInteractiveTarget`). Normally focus is on the stage.
- Telemetry: `trackAction('replay_kiosk_start')`.

### The kiosk run inside `Game`

Kiosk mode is a third run mode next to live and playback. Add a `kiosk` flag
(or a `mode: 'live' | 'playback' | 'kiosk'`) to `Game`. In kiosk mode:

- **Seed:** a fixed constant seed (e.g. `KIOSK_SEED`) instead of
  `seedForDate(runDate)`, both for level 0 and for the level-1 start in
  `confirm()` (which currently derives it from `seedForDate(this.runDate)`).
  Pick a constant for which the bot reaches the end of level 3 (see tests).
- **Outside world:** `this.source` is a kiosk source implementing `Source`
  (`runtime/tape.ts`) backed by two fixed-seed PRNGs (e.g. mulberry32 from
  `engine/rng.ts` or an equivalent) for `impure()` and `chaos()`, re-seeded on
  every loop. `exhausted` is always false. No tape is recorded or kept.
- **Inputs:** each live tick, before `step`, the bot policy computes inputs from
  the current state and they enter through the same path as player inputs
  (`pending` → `Input` history events), so crash replay re-feeds them exactly
  like a human's. Player key commands are not accepted as game input in kiosk
  mode (any key stops kiosk mode instead, below).
- **No persistence:** after the one-time clear at `startKiosk()`, `save()`,
  `store.clear()`, `saveBest` and `saveDailyBest` are all no-ops for the kiosk
  run. `best`/`dailyBest` are not changed by the bot.
- **No auto-pause:** `suspend()` (window blur / tab hidden) does not pause a
  kiosk run. (A hidden tab simply stops getting animation frames.)
- **Cards confirm themselves after a dwell:** in kiosk mode the `tip` and `lost`
  cards stay up for `KIOSK_CARD_FRAMES` (about 4 s at 60 fps) so passers-by can
  read them, then confirm. Montages play out fully (not skipped).
- **The loop:** when level 3's montage ends (where `endMontage()` would show the
  level-4 tip), the kiosk instead starts a new kiosk run from level 0 with the
  same seed and freshly seeded PRNGs, so the loop is identical every time.
- **Bot failure fallback:** if the kiosk run ever reaches `over` anyway, the end
  card shows for `KIOSK_OVER_FRAMES` (about 6 s), then a new kiosk run starts
  at level 0. The end card in kiosk mode hides the execution-ID / copy / share /
  replay controls (there is no tape).
- **Retries/rewinds, crashes, boss, hotfix, montages:** unchanged; they happen
  because the game makes them happen.

### The bot

A pure policy, e.g. `kioskBot(state: GameState, held: BotHold): { inputs, held }`
(it needs a little memory: whether jump/slide is currently held and since
when). It looks at entities ahead of the hat (`PLAYER_X`) and:

- **low / falling racks:** tap jump at the right distance (scales with speed);
- **tall racks:** held jump (release later via `jumpEnd`);
- **high racks:** `slideStart` before, `slideEnd` after passing;
- **pits:** jump at the right distance (coyote time helps);
- **coins and crates:** steer toward them when safe (crates show the "recorded
  impure value" lesson);
- **orbs:** avoid, **except one deliberately taken orb in level 2**, so the
  crash that follows replays to a different value and the non-determinism boss
  (`NonDeterministicError`) appears — the game's core lesson. Then survive the
  15 s boss segment and the hotfix continues.

The existing `autopilot()` in `testing.ts` is a starting point only. The bot
reads only `GameState` (it may read hidden spawn info that is in state; it is a
demo, not a fair player). It must look natural: no rapid jitter of inputs
(e.g. no more than one new press per few ticks unless an obstacle requires it).

Because everything is deterministic, "the bot clears levels 0–3" is a fact that
a test can check, not a hope.

### Stopping kiosk mode

- In `Replay.tsx`, while `game.kiosk` is on, the **first** `keydown` of any key
  (including modifiers and Ctrl+K itself, but excluding auto-repeat), and any
  `pointerdown` on the game stage, call `game.stopKiosk()`, `preventDefault()`, and
  return before normal key handling. **Ctrl+B is
  exempt** — it is the app shell's sidebar/logo toggle (`hooks/useCtrlKeyToggle.ts`)
  that booth staff may use to hide the sidebar; it must not stop kiosk mode.
  Clicks outside the stage (sidebar, top bar, CLI drawer, history panel) do not
  stop kiosk mode either; they work as usual. The matching `keyup` is harmless (release
  commands are ignored on the title card).
- `stopKiosk()` drops the kiosk run, restores live-mode state (today's
  `runDate`, `dailyBest`/`best` from the store, a fresh empty tape and a
  `TapeRecorder` source, like `leavePlayback()`), and sets the phase to
  `title` with no saved run (it was discarded at `startKiosk()`), so the
  visitor never sees "Resume your run?". Pressing Enter then starts a normal
  daily run.
- Keyboard focus moves to the stage so the next Enter starts the game.
- Telemetry: `trackAction('replay_kiosk_stop')`.

### On screen

- **Title card** (`Overlay.tsx`, `case 'title'`): add the hint
  `press CTRL+K to start kiosk mode` as a small, muted line in the existing
  `replay-keys replay-start-meta` style, near the key-help line. The hint is
  shown on the title card only (Claude's call); Ctrl+K also works on the other cards
  listed above but is staff knowledge there.
- **Banner:** while kiosk mode runs, the canvas HUD shows a banner in the same
  style and position as the playback banner (`render/canvas.ts`, the
  `view.playbackDate` branch): `AUTO PLAY · press any key to play`. Expose it
  via `GameView` (e.g. `kiosk: boolean`). It must stay readable on all phases,
  including cards and montages (cards are DOM overlays; make sure the banner
  is not hidden behind them, or repeat the hint on the card).
- Cards shown during kiosk mode drop their "Enter to start" key hints (nobody
  should press Enter mid-demo), or replace them with the kiosk hint.
- The playback speed control (`.segs`) is not shown in kiosk mode.

## Tests (TDD)

- `Overlay.test.tsx`: title card renders the Ctrl+K hint; kiosk cards hide
  execution-ID controls.
- `runtime/game.test.ts`:
  - `startKiosk()` from `title`, `over`, `paused` and `resume` (live and
    playback) starts level 0 with the kiosk seed and clears the stored save; it
    is ignored in every other phase.
  - **Golden loop:** drive frames until level 3's montage ends; assert levels
    0 → 1 → 2 → 3 were reached, at least one chaos crash replay happened, the
    boss phase happened in level 2, the run never reached `over`, and the next
    phase is the level-0 tip of a new loop.
  - **Determinism:** two kiosk loops (and two separate `Game` instances)
    produce identical stats, history and state hash at the same frame.
  - Frame-size independence like the existing tape tests (1 vs several ticks
    per frame give the same result).
  - After the one-time clear at start, no store writes during a kiosk loop
    (spy store); best scores are untouched; after `stopKiosk()` the phase is
    `title`, not `resume`.
  - `suspend()` doesn't pause a kiosk run.
  - `stopKiosk()` from every phase (playing, crashing, replaying, rewinding,
    montage, tip, lost, over) lands on `title` with live-mode state.
- Bot unit tests: given crafted states, the bot jumps a low rack, holds for a
  tall rack, slides under a high rack, jumps a pit.
- `Replay.test.tsx`: Ctrl+K on the title / end / pause / resume card starts
  kiosk mode and is `preventDefault`ed; any key or a stage pointer press during
  kiosk shows the title and does not start a run; Ctrl+B and clicks outside the
  stage do not stop kiosk; Ctrl+K during play is ignored.

## Calls made by Claude (not decided by the user)

- The bot deliberately takes one orb in level 2 to show the non-determinism
  boss (user approved the overall behaviour description).
- Pointer presses stop kiosk only on the game stage; Ctrl+B is exempt.
- The Ctrl+K hint appears on the title card only.
- Kiosk cards dwell ~4 s; a failed kiosk run shows its end card ~6 s.
- Kiosk mode does not pause on window blur.
- Telemetry events `replay_kiosk_start` / `replay_kiosk_stop`.

## Left to the builder

- Exact names (`startKiosk`/`stopKiosk`, flag vs. mode enum), constants
  (`KIOSK_SEED`, dwell frames) and the bot's internal heuristics.
- Whether the bot lives in `engine/` (pure) or `runtime/`.
- Exact banner placement, as long as it is readable on a large monitor in both
  themes and doesn't cover the hat or HUD.
