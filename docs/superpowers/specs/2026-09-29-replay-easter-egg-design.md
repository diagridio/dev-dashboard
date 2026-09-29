# REPLAY — durable-execution easter egg game — design

**Date:** 2026-09-29
**Status:** Draft, awaiting review

## Purpose

A hidden, single-player retro game inside the dashboard that a developer
discovers on their own machine. It must be fun to play and, above all, teach
**workflow replay and determinism** — the core of Dapr durable execution —
through mechanics rather than text. Players are self-paced, so short tip cards
are acceptable.

Success criteria:

- A player who finishes levels 0–3 can explain, in their own words, that
  (1) a workflow's state is rebuilt by replaying its history after a crash,
  (2) completed activities are not re-executed on replay, and (3) workflow code
  must be deterministic, with non-deterministic work moved into activities.
- The mechanics survive scrutiny from a Dapr expert: the game really is
  event-sourced and really diverges on non-determinism; nothing is faked.
- Zero cost for users who never find it: lazy-loaded chunk, no backend calls.

## Scope

In scope (v1): the five levels below, chaos crashes with visible replay, the
non-determinism orb and activity crate, the `NonDeterministicError` boss,
tab-close resume, end-of-run summary, local high score, Konami-code trigger.

Out of scope (v1): sound, touch/mobile controls, online leaderboard, other
workflow concepts (timers, external events, fan-out/fan-in, sagas), standalone
build outside the dashboard.

Constraints:

- **Browser-only.** No calls to the dashboard API, daprd or any state store.
  The dashboard's read-only product surface (AGENTS.md) is unchanged; the only
  write is the game's own `localStorage` key.
- **No new dependencies.** Plain TypeScript + Canvas 2D.
- **Style guide.** Canvas colours come from `theme.css` tokens, not hardcoded
  values; UI chrome (tip cards, end screen, history panel) composes the existing
  class vocabulary per `web/STYLEGUIDE.md`.

## Gameplay

A side-scrolling runner. The player is a small workflow-instance sprite
running through a datacenter.

- **Controls:** `Space` / `↑` jump, `↓` slide, `Esc` pause, `Enter` dismiss
  tip cards / confirm.
- **Obstacles** (cables, racks, dropped packets) are generated from a seeded
  RNG held in game state. Hitting one ends the run: workflow status **FAILED**.
  This is the only way to lose.
- **Activity coins.** Collecting one appends
  `ActivityCompleted(#id, result)` to the history panel. Score = activities
  completed. Best score persists in `localStorage`.
- **Chaos crash.** At random wall-clock times: glitch effect, banner
  `daprd: signal: killed`, the live state is discarded, and the engine replays
  the history at 8× speed (8 `step`s per rendered frame). Coins that were
  already collected show a "✓ from history" badge instead of being collected
  again. Control returns at the exact tick of the crash. A crash never costs
  the player anything — that is the point.
- **Non-determinism orbs** — glowing pickups labelled `Math.random()`,
  `Date.now()` or `fetch()`. Picking one up grants a ×3 score multiplier for
  10 s and mixes a value from the engine's impure source into the level RNG
  (see *Engine* below). The value is **not** recorded in history, so the next
  replay diverges.
- **Activity crates** — `callActivity(random)`. Same ×3 multiplier, same RNG
  mixing, but the impure value is recorded in the history event, so replay
  reads it back and stays in sync.
- **Tab-close resume.** Closing the tab mid-run and reopening `/replay` offers
  "Resume at tick N?"; accepting replays the saved history (with the same
  fast-forward effect) and continues.

### `NonDeterministicError` boss

Triggered when a replay detects divergence. A 15 s phase: screen corruption,
and obstacles spawn from the *diverged* RNG, so the level ahead no longer
matches what the player saw before the crash.

- **Survive:** "hotfix & redeploy". The multiplier is lost and the run
  continues via *continue-as-new*: a fresh history starts from a snapshot of
  the current state (score, level, position, a derived seed). This mirrors
  Dapr's `ContinueAsNew` and drops the tainted history.
- **Die:** run ends **FAILED** with reason
  `non-determinism detected at event #n`.

## Levels and teaching flow

Each level is a *continue-as-new* boundary (new history seeded from the
previous level's end state), which also keeps histories short. Between levels
a tip card shows one or two sentences plus a "Learn more" link to the relevant
Dapr docs page; `Enter` skips it.

| # | Name | Content | Lesson |
|---|---|---|---|
| 0 | No Safety Net | Durability off. Scripted crash at ~15 s resets to level start. Then banner "Dapr Workflow enabled". | Without durable execution a crash means starting over. |
| 1 | Replay | Coins + random chaos crashes (mean interval ~20 s); every crash replays and resumes. | History *is* the state; replay rebuilds it; completed activities are not re-run. |
| 2 | Temptation | Orbs appear. Picking one up guarantees a crash within 5 s so the divergence always surfaces. | Workflow code must be deterministic. |
| 3 | Wrap It | Activity crates appear alongside orbs, same reward, replay-safe. | Put non-deterministic work in activities. |
| 4 | Production | Endless. Speed ramps, all mechanics mixed, chaos interval shrinks toward ~8 s. High-score mode. | All of it, fast. |

Chaos crashes never fire during a replay, the boss phase, a tip card, or while
paused.

### End-of-run screen

Styled like a workflow summary: final status (FAILED), score, best score,
replays survived, activities *served from history* vs *executed*,
non-determinism incidents, and the level reached. The history panel stays
scrollable. `Enter` starts a new run.

## Discovery

- **Konami code** `↑ ↑ ↓ ↓ ← → ← → B A` anywhere in the dashboard navigates to
  `/replay`. Keys are ignored while focus is in an input, textarea, select or
  contenteditable element. A wrong key resets the sequence.
- Direct URL `/replay` (respecting the router `basename`).
- Not in the sidebar, TopNav or command palette.

## Architecture

All game code lives in `web/src/pages/replay/`. Outside it, only the router
entry and the trigger hook reference it.

```
web/src/pages/replay/
  engine/                pure TS: no DOM, no Math.random, no Date, no I/O
    types.ts             GameState, Input, HistoryEvent, StartInput, ReplayResult
    rng.ts               seeded PRNG (mulberry32); its state is a field of GameState
    step.ts              step(state, inputs, impure) → { state, events }
    levels.ts            level configs and scripted moments
    replay.ts            replay(start, history, toTick, impure) → ReplayResult
    hash.ts              FNV-1a over a canonical serialisation of GameState
  runtime/
    loop.ts              rAF + fixed-timestep accumulator (60 Hz); pauses on visibilitychange
    chaos.ts             crash scheduler — uses real randomness on purpose (chaos is the outside world)
    persistence.ts       versioned localStorage save/load; every access in try/catch
  render/
    canvas.ts            draws GameState at a fixed logical resolution (480×270), scaled, pixelated
    palette.ts           reads theme.css custom properties; re-reads when the theme changes
  Replay.tsx             route component: canvas + HistoryPanel + overlays
  HistoryPanel.tsx       event list reusing the WorkflowDetail history look
  overlays/              TipCard, BossBanner, EndScreen, ResumePrompt
web/src/hooks/useKonami.ts   mounted once in App; navigates to /replay
```

### Engine

- **Tick-based and pure.** `step` advances exactly one 1/60 s tick. Given the
  same state, inputs and impure values it always returns the same result.
- **History events:**
  - `Input { tick, kind: 'jump' | 'slideStart' | 'slideEnd' }`
  - `ActivityCompleted { tick, id, result?, hash }` — `result` is set only for
    activity crates (the recorded impure value).
  - `OrbTaken { tick, id, hash }` — records *that* it happened, not the value.
  - `hash` is the state hash after the event's tick is applied.
- **Start input.** Every history begins from a `StartInput`
  `{ level, seed, score, x, … }` so levels and the boss hotfix can
  continue-as-new.
- **The impure port.** `step` receives one function, `impure(): number`, and is
  the only way non-determinism can enter the engine.
  - Orb pickup: `rng = mix(rng, impure())` — value unrecorded.
  - Crate pickup: `v = impure()`, `rng = mix(rng, v)`, `v` recorded in the event.
  - During replay, the crate branch reads `v` from the history event instead of
    calling `impure`; the orb branch has nothing to read and calls `impure`
    again, getting a different value.
  - At runtime `impure` is `Math.random`; in tests it is a stubbed sequence.
- **Replay** folds `step` from the start input to `toTick`, applying recorded
  inputs at their ticks, and compares the hash at every recorded event. It
  returns `{ ok: true, state }` or
  `{ ok: false, divergedAt: eventIndex, state }` where `state` is the diverged
  state the boss phase then runs on.

### Runtime

- The loop holds `{ start, history, state, tick }`. Live play calls `step` once
  per accumulated tick and appends emitted events to `history`.
- A crash sets `state = undefined`, then runs `replay` incrementally (8 ticks
  per frame) so the fast-forward is visible, then resumes live play.
- Level 0 is special-cased: its crash restarts from the level's `StartInput`
  with an empty history.
- **Persistence:** save `{ version, start, history, tick, best }` on each new
  event, on `visibilitychange` → hidden and on `pagehide`. A missing, corrupt
  or wrong-version save is treated as "no save". Storage exceptions are
  swallowed; the game still runs, just without resume.

### Rendering

- Canvas at a fixed logical 480×270, scaled by an integer factor with
  `image-rendering: pixelated`. Sprites are drawn from small in-code pixel maps
  that reference palette slots, not colours.
- The palette maps slots to `theme.css` tokens (e.g. `--bg`, `--text`,
  `--accent`, status colours) via `getComputedStyle`, refreshed when the
  theme attribute on `<html>` changes.
- `prefers-reduced-motion: reduce` disables screen shake and glitch flicker;
  the crash/replay is still shown with a static banner and fast-forward.

### Routing

Inside the App shell's gated children, so TopNav and sidebar stay usable:

```ts
{ path: 'replay', lazy: () => import('./pages/replay/Replay'), handle: { rumView: 'Replay' } }
```

This is the first lazy route in the SPA; `Replay.tsx` exports `Component` as
react-router's `lazy` expects, and Vite emits it as a separate chunk.

## Testing

Vitest, co-located `*.test.ts(x)` files:

- **Determinism:** same start input + inputs → same final hash across runs.
- **Replay equivalence:** a live run's final state equals `replay()` over its
  history.
- **Divergence:** a history containing `OrbTaken` replays to
  `{ ok: false, divergedAt }` at the first event after the orb, with a stubbed
  `impure` that returns a different sequence.
- **Crate safety:** a history containing a crate pickup replays `ok` with the
  same stub.
- **Continue-as-new:** a level transition and a boss hotfix produce a fresh
  history whose replay reproduces the snapshot state.
- **Persistence:** round-trip; load returns "no save" when storage throws, the
  JSON is corrupt, or the version differs; save swallows exceptions.
- **useKonami:** full sequence navigates to `/replay`; a wrong key resets;
  keys typed in an input are ignored.
- **Route:** `/replay` renders the game page inside the shell.
- Existing styleguide test must stay green (no hardcoded colours).

Gate: `make test`. No Go changes. `npm run build` output is checked to confirm
the replay code lands in its own chunk.
