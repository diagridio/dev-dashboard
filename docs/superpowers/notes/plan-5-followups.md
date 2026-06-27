# Plan 5 (Logs SSE + News / Resources Sidebar) — Deferred Follow-ups

Minor items deferred during Plan 5's subagent-driven implementation (per-task reviews + the
whole-branch review). The whole-branch review found **no Critical or Important** issues and cleared
the branch to merge. One per-task Important finding was fixed during the run (the `pkg/logs` tailer:
single file open + unrecoverable-read-error handling + buffer reuse, commit `a5bfd15`). Everything
below is a legitimate fast-follow.

## Note on a false-positive review finding
A per-task reviewer flagged `useNews` calling `fetchJSON('/news')` as a "Critical" `/news` vs
`/api/news` mismatch. This was a **false positive**, confirmed by the whole-branch review and by the
passing tests: `web/src/lib/api.ts` sets `base = BASE_URL + '/api'`, so `fetchJSON('/news')` →
`/api/news` (every hook uses bare paths: `/apps`, `/workflows`, `/resources`). No bug; no change.

## Frontend cleanups
- **`ResourcesSidebar.tsx` `void seenVersion` re-render trigger.** `hasUnseen(news)`/`showBell` read
  `localStorage` during render and rely on a bumped `seenVersion` counter to re-evaluate after
  `markSeen`. It works (bell-hide tests pass) but reading localStorage in render + a throwaway state
  bump is fragile — refactor to a `useMemo`/derived-state (or a small `useSyncExternalStore`) for the
  seen set.
- **Collapsed bell is a `<button>` nested inside a clickable `<div onClick={toggle}>`** (`stopPropagation`
  keeps behavior correct, but nested interactive controls are an a11y/structure smell). Consider making
  the collapsed rail a `<button>` and pulling the bell out as a sibling.
- **`markSeen(newsUrls(news))` is duplicated** between `NewsSection`'s bell/link handlers and the
  collapsed-rail bell handler — extract one shared handler.
- **Sidebar link hover uses inline `onMouseEnter/Leave`** (no `:focus-visible`) — keyboard-focus users
  get no hover affordance. Move to a CSS class with `:hover, :focus-visible`.
- **Logs `document.title` sequencing** (Logs.tsx): when `appId` goes set→empty there's a brief
  intermediate title from the `LogsWithApp` cleanup before the outer effect resets it. Cosmetic.
- **Logs follow doesn't auto-re-enable on manual scroll-to-bottom** — only the "Jump to latest" button
  re-enables follow. Within spec ("scroll-up pauses") but a common UX nicety to add.
- **`useLogStream` `max` is in the effect dep array** — harmless today (stable `2000` default; a caller
  passing a new inline `opts` each render would churn the connection). If `opts.max` ever becomes
  caller-controlled, memoize it or drop it from deps.
- **`App.test.tsx` nav assertion loosened** to `getAllByRole('navigation').length > 0` (TopNav + sidebar
  both expose `role=navigation`); could assert exactly 2 / check `aria-label`. Redundant
  `data-testid` alongside `data-cy` on the sidebar toggle + news bell.

## Frontend test depth
- `useLogStream` has one happy-path test; no buffer-cap/drop-oldest or status-transition
  (`connecting`/`error`) assertions. `parseLogLevel` logfmt regex is slightly over-constrained
  (trailing `\b`) — fine for space-delimited logfmt.

## Backend
- **`pkg/news` fetches under the cache mutex** — serializes concurrent callers behind one in-flight
  HTTP request. Fine at this scale (one local SPA, hourly); refactor to read-check → unlock → fetch →
  re-lock → write if it ever serves many concurrent clients.
- **Log virtualization deferred (per Global Constraints).** The Logs viewer uses a bounded client
  buffer (cap ~2000 lines, drop-oldest) rendered directly instead of TanStack Virtual. If the cap
  proves too large in practice, add list virtualization. Native `EventSource` auto-reconnects; a
  custom backoff/cap was not added (not needed at this scale).
- **`pkg/logs` tailer does not handle file rotation/truncation** — if a log is rotated (renamed +
  recreated) or truncated, the offset-based poll won't follow the new file. Rare in local `dapr run`;
  add inode/rotation detection (or `fsnotify`) if it becomes an issue.

## Carry-forward from earlier plans (still open)
- **Discovery perf** (Plan 2 / Plan 4 follow-up, STILL not done): `discovery.service.enrich` probes
  each sidecar sequentially and `Get` enriches all instances. Now that Logs/Actors/Subscriptions/
  Components all depend on discovery, a bounded-concurrency `enrich` is increasingly worthwhile.
- **`copyText`/`legacyCopy` duplicated across AppDetail/WorkflowDetail/ResourceDetail** (Plan 4
  follow-up) — extract `web/src/lib/clipboard.ts`.
