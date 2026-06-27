# Plan 3 (Workflows + State Store + Terminate/Purge) — Deferred Follow-ups

Minor items deferred during Plan 3's subagent-driven implementation (per-task reviews + the
whole-branch review). None block merge; all whole-branch "fix before merge" items were applied
(the duplicate `/api/workflows/statestores` route removed; the `App.test.tsx` MSW pristine-output
gap fixed; the WorkflowDetail Remove button wired; `data-cy` selectors on the dialog; and — per
explicit user decision — the multi-store **picker** was fully wired, not deferred). Good candidates
for a fast-follow / early Plan 4 cleanup.

> **Cleanup pass 2026-06-27 (commit `4c08021`):** ✅ `TestWorkflowUnknownStore` now covers the
> single-instance `/terminate` + `/purge` 404 verbs; ✅ `decode_test` asserts `ReplayCount` +
> `History[0].Type` (+ a 2-`WorkflowStarted` case); ✅ `ParseInstanceID` empty-segment test;
> ✅ `WorkflowsParams.status` → `WorkflowStatus[]`; ✅ redundant inner `key` removed; ✅
> `log.Printf`→`fmt.Printf`; ✅ `Detect` dedup by `filepath.Abs`; ✅ `StatusPill` 2nd-status test.
> **Still open** (behavior/judgment, not mechanical): bulk-purge dropped-target reporting,
> single-route verb semantics (+`?non_recursive=false`), list-paging cursor, `Get` heuristic,
> 500 `err.Error()` leak, the missing Running→Completed merge test, the frontend
> `setSearchParams`/debounce nits, remaining cosmetics, and the RR v7 future-flag warnings.

## Backend
- **Bulk purge silently drops unresolvable targets.** `workflowsRouter` `POST /purge` skips any
  ref whose `TargetResolver.Resolve` fails, so the returned `RemoveResult[]` omits them and the SPA
  summary reports e.g. "Removed 3" after selecting 5. Return a failed `RemoveResult` per dropped id
  so the count reconciles.
- **Single-instance `/terminate` route re-selects the mechanism.** Both `POST .../terminate` and
  `.../purge` go through `removeOneViaBackend` → `RemoveMany` → `SelectMechanism`, so `/terminate`
  on a terminal workflow actually purges. These two single routes are **SPA-dead** (the UI only
  calls bulk `/workflows/purge` + GET detail), so it's latent — either drop the unused routes or
  honor the verb. Related: the terminate URL omits `?non_recursive=false` that the plan specified
  (behavior-neutral — Dapr's default is recursive — but a spec divergence).
- **`Detect` dedup keyed by raw walk path.** The same component file reachable via two `scanPaths`
  roots in differing path forms (symlink / `.`-relative) could be listed twice. Add
  `filepath.Abs`/`EvalSymlinks` before the `seen` check. (Absolute-distinct-roots case is fine.)
- **List paging collapses the cursor across apps.** `service.List` sends the same `q.PageToken` to
  every app's `Keys` and overwrites `next` with the last app's token, then concatenates + caps.
  Multi-app cursor paging is unreliable; acceptable given small local key counts. Revisit if paging
  matters (Plan 5 / perf).
- **`Get` not-found heuristic is structural.** `Get` returns `ErrNotFound` when
  `len(History)==0 && Status==Pending && Name==""` (in addition to `load`'s zero-keys check). If a
  future task makes `DecodeExecution` populate `Name` from a metadata key, a genuinely-pending
  instance could be misread; tighten then.
- **500 responses include `err.Error()`** (matches the existing `appsRouter` pattern; localhost-only
  binding). Consider a generic message + server-side log if this ever binds non-loopback.
- **Cosmetic:** `cmd/workflow.go` store-init warning uses `log.Printf` while other startup output
  uses `fmt.Printf`; the degraded (nil-store) backend entry is always built even when stores exist
  (benign safety net — add a clarifying comment).

## Backend tests
- `pkg/server` `TestWorkflowUnknownStore` covers GET list, GET detail, and bulk `POST /purge` for the
  `?store=unknown` → 404 path, but **not** the two single-instance POST verbs (`/terminate`,
  `/purge` with a path id). The reviewer supplied the exact two assertions to add.
- `pkg/workflow` `decode_test` doesn't assert `ReplayCount` or `History[0].Type` (code verified
  correct; add `==0` plus a 2-`WorkflowStarted` `==1` case).
- `pkg/statestore` `ParseInstanceID` has no empty-instance-id-segment (`"a||b||||metadata"`) case.
- `cmd` `targetResolver` has no unit test (thin glue; logic is in the tested Remover/Service).

## Frontend
- **`WorkflowsParams.status` typed `string[]` not `WorkflowStatus[]`** in `useWorkflows.ts` — loses
  discriminated-union safety; tighten.
- **Spurious `setSearchParams` on first render** in `Workflows.tsx` (`replace:true`, so no history
  pollution — harmless); the URL-mirror effect's deps couple to `urlStore` derived from
  `searchParams` rather than `searchParams` itself (works, slightly indirect).
- **`onChange` reads stale `debouncedSearch`** when changing the store mid-debounce (pre-existing
  debounce design) — a typed-but-not-yet-debounced term could briefly drop from the URL.
- **Missing Running→Completed history-merge regression test** for `WorkflowDetail` (the brief asked
  for it; merge is correct because the server returns the full ordered snapshot and rows key on
  `sequenceId`, so no client merge code exists — the guard is just absent).
- **Cosmetic:** redundant inner `key={sequenceId}` on a non-list `<div>` in `HistoryRow`
  (`WorkflowDetail.tsx`); dialog backdrop uses `role="presentation"` (a11y is sound via the inner
  `role="dialog"`/`aria-modal`); single-item summary reads "All 1 will be…" grammar; `StatusPill`
  test exercises only the `Failed` status.

## Process note (carry forward)
- **Pre-existing React Router v6→v7 future-flag warnings** still print during the web test suite
  (inherited from Plans 1–2, not introduced here). Set the `v7_startTransition` /
  `v7_relativeSplatPath` future flags in the test router helpers to silence them (a global cleanup,
  out of scope for a single plan).
- One implementer subagent **stalled at the commit step** (Task 19); the work was complete on disk
  and the controller verified (build/vet/unit/integration/smoke) + committed it. Reinforces the
  value of the `.superpowers/sdd/progress.md` ledger + `git log` as the recovery map.
