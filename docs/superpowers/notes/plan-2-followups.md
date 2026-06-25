# Plan 2 (Discovery + Applications) — Deferred Follow-ups

Minor items deferred during Plan 2's subagent-driven implementation (per-task reviews + the
whole-branch review). None block merge; the whole-branch "fix before merge" item (gofmt) was
applied. Good candidates for a fast-follow / early Plan 3 cleanup.

## Performance (same root cause — do together)
- **`discovery.service` enriches sequentially.** `List` probes each sidecar's `/v1.0/healthz`
  + `/v1.0/metadata` in a plain loop. With several **unreachable** sidecars the 2 s client
  timeouts stack, slowing `/api/apps`. Make `enrich` run with a small **bounded worker pool**
  (e.g. 8 concurrent) — bounds total latency to ~one timeout regardless of count.
- **`service.Get(appID)` calls `List` and enriches ALL instances** just to return one. On the
  App-detail page (polling every 1–10 s) this re-probes every sidecar each tick. Fixing the
  bounded-concurrency enrich above mitigates it; optionally add a `Get` path that scans for
  the one matching `appID` and enriches only it.

## Tests
- **`service_test` Get-miss uses `require.Error`**, not `require.ErrorIs(err, ErrNotFound)`.
  Production code wraps the sentinel correctly and the server-level 404 test covers the path;
  tighten the unit assertion to `require.ErrorIs`.

## Determinism / style
- **`sort.Slice` → `sort.SliceStable`** in `service.List` for fully deterministic order
  (AppIDs are unique in practice, so currently moot).
- **`query.tsx` `staleTime: 30_000` is ineffective** for these views since `refetchInterval`
  drives polling regardless — harmless; remove or keep intentionally.
- **RefreshContext persists paused as `'true'/'false'`** (the plan example used `'1'/'0'`).
  Internally consistent; only matters if other code assumes the `'1'/'0'` sentinel.

## Process note (carry to later web plans)
- **Vitest does not type-check.** Run `cd web && npm run build` (`tsc -b` + vite) in each
  web task's verification — CI's web job runs the build, so type errors that `npm test` misses
  will still fail CI.
