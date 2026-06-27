# Plan 4 (Resources / Actors / Subscriptions) — Deferred Follow-ups

Minor items deferred during Plan 4's subagent-driven implementation (per-task reviews + the
whole-branch review). None block merge; the one whole-branch/per-task "fix before merge" item
was applied (the duplicate **Runtime version** row on App detail — removed from the new Metadata
section, kept in Dapr sidecar). The whole-branch review found **no Critical or Important** issues;
everything below is a legitimate fast-follow.

## Cross-cutting (highest value)
- **`copyText`/`legacyCopy` is now duplicated in 3 pages** (`AppDetail.tsx`, `WorkflowDetail.tsx`,
  `ResourceDetail.tsx`). Extract a shared `web/src/lib/clipboard.ts` and import it in all three.
- **Discovery perf (carried from Plan 2, now more relevant).** `discovery.service.enrich` probes
  each sidecar's `/v1.0/healthz` + `/v1.0/metadata` sequentially, and `service.Get` enriches ALL
  instances. Actors/Subscriptions/Components now all poll through discovery, so several unreachable
  sidecars stack the 2 s timeouts. Add a bounded worker pool to `enrich` (~8 concurrent) and an
  optional single-app `Get` path. (This was the Plan-2 follow-up earmarked "fold into Plan 4" — it
  was not done in Plan 4; carry to Plan 5 or a perf pass.)

## Backend
- **`loadedByIndex` rebuilds the full app index on the detail path** (`pkg/server/resources.go`) —
  calls `apps.List` + walks all instances to look up one component's apps. Negligible locally;
  optimize (pass the name, short-circuit) if it ever matters.
- **`filepath.Walk` errors silently discarded** in both `pkg/resources/resources.go` and
  `pkg/statestore/detect.go` — a non-existent/inaccessible scan path produces no signal. Spec'd
  "skip silently" behavior, but consider a debug log for observability.
- **`/api/resources` detail trusts the `{kind}` URL param** — an invalid kind falls through to
  `ErrNotFound`→404 via the loader scan (correct), but an explicit 400 for an unrecognized kind
  (matching the list endpoint) would be more consistent.

## Backend tests
- `pkg/server` `actors_test` asserts a loose `"OrderActor"` substring rather than `"type":"OrderActor"`
  and doesn't assert the `appId:"cart"` pairing in the full-list case (the `?appId` filter sub-case
  already proves per-app association).
- `pkg/resources` `resources_test` has no explicit `kind: Subscription`/pubsub exclusion fixture
  (exclusion holds by construction since `kindFromString` only admits Component/Configuration); the
  `kind=configuration` list path is covered by the frontend `ResourceList` test rather than a Go test.
- `cmd` resources-path wiring has no unit test (thin glue).

## Frontend
- **`document.title` set without an unmount restore** across Actors/Subscriptions/ResourceList/
  ResourceDetail (and pre-existing pages) — navigating away leaves the last title until another page
  sets it. Cross-page pattern; fix globally (a small `useDocumentTitle` hook with cleanup) if desired.
- **Filter badge hidden during `isLoading`** on Actors/Subscriptions (the loading early-return runs
  before the badge renders) — minor flicker on poll-driven refetch when `?appId=` is set.
- **`ResourceDetail.tsx` uses an inline `import('../types/resources').ResourceKind` type cast** where
  a top-level `import type { ResourceKind }` would read cleaner.
- **DRY:** `ResourceList.tsx` repeats the kind→{title,empty} ternary three times (a small lookup map
  would make a future third kind a one-liner); `ResourceList.test.tsx`'s two render helpers are
  near-identical.
- **Nav-icon polish:** the `logs` glyph path style differs slightly from the others; the `Icon`
  `size` prop is untested (sane default, currently unused by callers).

## Process note (carry forward)
- The deferred Plan-1/Plan-2 cleanups remain as recorded in `plan-1-followups.md` /
  `plan-2-followups.md` (the cheap mechanical ones were cleared in the 2026-06-27 cleanup pass; the
  discovery-perf item is re-flagged above).
