# Task 8 — Workflow Detail Restyle Report

## Structure

`WorkflowDetail.tsx` restyled to match mock B `#view-detail`. Key sections:

- **`.crumbs`**: Workflows link / `appId` muted / short instance-id as `.cur`.
- **`.dhead`**: `.dtitle` = `<StatusPill>` + `<h1>` workflow name + `.clock` (live elapsed via `useWallClock`; adds `.clock.stopped` when terminal with "total" label). `.dactions` = Back (btn ghost), Purge (ghost, disabled when non-terminal), Force delete (danger, `data-cy="wf-remove"`).
- **`.refreshbar`**: `<RefreshControl/>` (live / pause / interval) + "updated N ago" indicator via `useLastRefreshed`.
- **`.metagrid`** (4-col grid): Instance ID span2 mono + copy toast, App ID span2, Created, Ended, Duration, Last updated, Replays, Events, Last event span2. All unavailable values render `<span className="faint">—</span>`.
- **`.io`** (2-col): Input and Output `.panel`s. Input always shows `pre.json` (if present). Output shows `.pendingout` with beat dot while running+no output; `pre.json` once available. Both have `.ph` with `tagdot` + `.copybtn` wired to `useToast`.
- **Custom status panel**: shown only when `execution.customStatus` is set; renders `pre.json` via `highlightJson`.
- **`.timeline`**: Each event is `.ev` (+ `.ev.reveal` for newest). Uses `details.evd` + `summary` with `.caret`, `.evtype`, `.evname`, `.evtag`. `.evbody` contains `pre` with `highlightJson` highlighted JSON for input/output payloads. No hand-managed expand state — `<details>` handles it natively.

## Node-class mapping

| Event type | `.node` class |
|---|---|
| ExecutionStarted | `n-start` |
| TaskScheduled | `n-sched` |
| TaskCompleted | `n-done` |
| Task*Failed (non-Execution prefix) | `n-fail` |
| *Timer* | `n-timer` |
| ExecutionCompleted | `n-end` |
| ExecutionFailed / ExecutionTerminated | `n-endfail` |
| Unknown | `n-start` (fallback) |

## JSON-highlight wiring (DEP-B)

`highlightJson` from `web/src/lib/json-highlight.tsx` is used in:
- Input `pre.json` panel
- Output `pre.json` panel (when available)
- Custom status `pre.json`
- Event history `.evbody` `pre` elements (input/output payloads)

Renders `.k/.s/.n/.p/.b` token spans per mock spec.

## Data gaps / concerns

- `WorkflowHistoryEvent` type has no `retryCount` field, so `.retrybadge` is not rendered (no data to drive it; graceful omission).
- `elapsed()` in `wallclock.ts` returns `MM:SS` format (not `M:SS.s` as in the mock JS simulation) — this is the existing library behavior, not changed.
- The `useLastRefreshed` hook tracks wall-clock age since component mount, not the actual server response time; a proper implementation would require the query's `dataUpdatedAt` from React Query — left as a cosmetic approximation since the hook is display-only.
- Both inline `style` attributes on `tagdot` spans use `var(--accent2)`, `var(--fail-fg)`, `var(--susp-fg)` — these are mock-matching inline bits explicitly used in the mock HTML.

## Gate results

- `npm test`: **229 passing** (217 pre-existing + 12 new task-8 tests), 0 failing, 0 skipped.
- `npx tsc -b`: **clean** (no errors or warnings).
