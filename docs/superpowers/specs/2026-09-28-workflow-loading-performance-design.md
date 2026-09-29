# Workflow loading performance — design

**Issue:** [#93 — Dashboard hangs when loading workflows from the state store](https://github.com/diagridio/dev-dashboard/issues/93)
**Date:** 2026-09-28
**Status:** Draft, awaiting review

## Problem

The Workflows page hangs on state stores holding many workflow instances. The
issue asks for pagination, but `GET /workflows` is already paged over the
store's metadata-key cursor (50 per page, Prev/Next in the UI — the same
pattern the State page uses). The hang comes from how each page and the stats
are *built*, not from a missing pager.

### Where the time goes today

On page load the SPA fires three queries, each re-polled at the refresh
interval (default 3 s):

| Request | Backend work (`pkg/workflow/service.go`) |
|---|---|
| `GET /workflows` | 1 `Keys` for a page of metadata keys, then `load()` per instance, sequentially |
| `GET /workflows/stats` | 1 `Keys` for **all** metadata keys, then `load()` for **every** instance |
| `GET /workflows/appids` | 1 `Keys` for all metadata keys (keys only) |

`load()` issues one `Keys(<instance>||%)` to discover the history keys and then
one `Get` per key (`ccStore.BulkGet` is a sequential loop).

Per-backend cost of a single `Keys` call (components-contrib v1.18.0):

| Backend | `KeysLike` implementation | Cost per call |
|---|---|---|
| Redis | `SCAN MATCH` over the **entire keyspace**, sort, slice by offset | O(total keys), regardless of page size |
| PostgreSQL v2 | `key LIKE $1 ORDER BY row_id` | seq scan for leading-`%` patterns; prefix patterns need a `text_pattern_ops`/C-collation index to avoid one |
| SQLite | `key LIKE ? ESCAPE '\'` (case-insensitive LIKE) | table scan — LIKE can't use the key index |
| MongoDB | anchored `$regex` on `_id` | prefix patterns use the `_id` index; `%`-leading patterns scan |

So a single list page costs ~51 `Keys` calls + ~50×H sequential `Get`s
(H = history events per instance), and Stats costs N+1 `Keys` calls + N×H
`Get`s. On Redis that is O(N × total keys) per stats poll, every 3 s. On
SQL backends it is N+1 table scans. Additionally:

- `fetchJSON` passes no `AbortSignal`, so superseded requests (filter change,
  navigation) keep consuming the store server-side.
- The status tabs render `0` until Stats returns, and the table blanks to
  "Loading…" on every filter change.

## Goals

1. The Workflows page stays responsive with thousands of instances on **all
   four supported stores: Redis, PostgreSQL, SQLite, MongoDB**.
2. Steady-state polling of a store whose workflows are mostly finished costs
   close to nothing.
3. No change to the API shapes (`ListResult`, `StatsResult`, `Execution`) or
   to the page's pagination model.
4. Behaviour is identical to today for every record shape the dashboard
   currently decodes (including legacy JSON metadata and the `{}` fixtures in
   existing tests).

## Non-goals

- Global `CreatedAt` ordering across pages (key-order paging limitation stays).
- Infinite scroll / "Load more" (a UX preference, not a performance fix).
- Changing the sidecar-gRPC path (`SidecarService`, `composite`), beyond it
  continuing to work unchanged.
- Adding database indexes to the user's state store (read-only product surface).

## Design

Three backend changes remove the per-instance scans and make repeated polls
cheap; three frontend changes stop wasted work and keep the UI stable.

### 1. Derive history keys from the metadata record (no per-instance scan)

Dapr writes an instance's state as `<prefix>metadata`, `<prefix>history-NNNNNN`
(zero-padded to 6), `<prefix>inbox-NNNNNN`, and `<prefix>customStatus`, where
the metadata value is a `backend.BackendWorkflowStateMetadata` proto carrying
`HistoryLength` (Dapr 1.16+), or a legacy JSON object
`{"inboxLength","historyLength","generation"}` (earlier versions). Dapr itself
loads state this way (`pkg/runtime/wfengine/state/state.go`: reads metadata,
then bulk-gets `history-0..HistoryLength-1` + `customStatus`).

New `load()` flow:

1. `Get(<prefix>metadata)`.
2. Decode as proto; on failure try legacy JSON (same order as Dapr).
3. If decoding succeeded **and** `HistoryLength > 0` **and**
   `HistoryLength <= maxHistoryEntries` (1 000 000 — Dapr's own
   `maxStateEntries` bound on inflated values): build the key list `history-000000 … history-(L-1)` plus
   `customStatus` and fetch them with one `BulkGet`.
4. Otherwise (metadata missing, undecodable, zero length, or over the bound):
   fall back to today's `Keys(<instance>||%)` scan. This keeps existing
   fixtures (`metadata = "{}"`) and not-yet-started instances working, and is
   rare for real data.
5. A constructed key that comes back empty (e.g. history truncated by a
   concurrent continue-as-new) is skipped, exactly as an undecodable event is
   skipped today.

The key-name helper lives in `pkg/statestore/keys.go` next to the existing
constants (`HistoryKey(i uint64) string`), and the metadata decoder in
`pkg/workflow/decode.go`. `Get` (the detail page) uses the same path, so it
gets faster too.

**Cost after:** 1 `Get` + 1 `BulkGet` per instance, zero `Keys` calls.

### 2. Real bulk reads and bounded fan-out

**`ccStore.BulkGet`** delegates to the backend's `state.BulkStore.BulkGet`
instead of looping over `Get`:

| Backend | Native `BulkGet` in contrib v1.18.0 |
|---|---|
| PostgreSQL v2 | single query (`key = ANY`) |
| SQLite | single query (`IN (...)`) |
| MongoDB | single query (`$in`) |
| Redis | `DefaultBulkStore` — parallel `Get`s; pass `BulkGetOpts{Parallelism: 16}` so it isn't unbounded |

Requests are chunked at `bulkGetChunk = 100` keys, keeping SQLite well under its
bound-parameter limit and PostgreSQL/MongoDB queries small. The `Store`
contract stays the same: the returned map has an entry for every requested key,
with `nil` for a missing key; a per-key `BulkGetResponse.Error` becomes a
returned error (same as a failing `Get` today). Callers are unchanged.

**Parallel instance loads:** `List` and `Stats` load instances through a
bounded worker pool (`instanceLoadConcurrency = 8`), collecting results by
index so output order stays deterministic before the existing
`CreatedAt` sort. Workers stop on `ctx.Err()`, so a cancelled request stops
touching the store (see §5).

### 3. Summary cache keyed on the metadata record

The list and stats only need `ExecutionSummary`, which can change only when the
instance's metadata record changes (every Dapr save rewrites metadata with the
new `HistoryLength`/`Generation`, in the same transaction as the history keys,
on all four backends).

- The store-backed `service` gets a `summaryCache`:
  `map[ns/appID/instanceID]{metaRaw []byte, summary ExecutionSummary}`,
  guarded by a mutex.
- `List`/`Stats`, after listing metadata keys, `BulkGet` the **metadata values
  for all listed keys** (chunked). For each instance: if the cache holds the
  same `metaRaw` bytes, reuse the summary; otherwise run the §1 load (reusing
  the metadata value already in hand) and store the result.
- `Stats` sees the full key set, so it drops cache entries for that namespace
  (and app-id, when app-scoped) that are no longer present — purged and
  force-deleted instances age out on the next stats call. `List` never
  prunes (it only sees one page).
- Bound: `maxCachedSummaries = 20 000`; when exceeded, the cache is cleared
  (simple and correct; a local store over that size is already an outlier).
- Entries are only written after a successful load; a fallback-scan result
  (§1 step 4) is cached the same way, keyed on its metadata bytes (or on
  `nil` when there is no metadata record, which then isn't cached).
- `Get` (detail) never reads the cache: it needs full history and must always
  be fresh.
- Scope: the cache lives on the store-backed `service`, which
  `buildStoreEntry` (`cmd/workflow.go`) builds once per opened store and
  `cmd/connpool.go` reuses, so it's per store connection and goes away when
  the pool evicts or closes that connection. The sidecar path and
  `unreachableService` get no cache.

**Steady-state cost of a Stats poll after:** 1 `Keys` + ⌈N/100⌉ `BulkGet`s +
a full load only for instances whose metadata changed. For a store of finished
workflows that is one scan plus a few bulk reads.

### 4. Stats polling cadence

With §3, Stats is cheap, but it's still the only store-wide read on the page.
`useWorkflowStats` polls at `max(refresh interval, 10 s)`; pause and "off"
behave as today. The list keeps the user's interval. The counts will visibly
lag new instances by up to 10 s, which is acceptable for tab badges.

### 5. Cancel superseded requests

`fetchJSON(path, init?)` accepts an optional `RequestInit` (for the `signal`);
every workflow hook passes React Query's `signal` through. The Go handlers
already pass `req.Context()` into the service, and the contrib stores honour
the context, so an aborted fetch ends the store work. Existing `fetchJSON`
callers are unaffected (the parameter is optional).

### 6. Stable UI while loading

- `useWorkflows` and `useWorkflowStats` use
  `placeholderData: keepPreviousData`. When filters change, the previous rows
  and counts stay visible, marked as updating (the existing `Spinner`
  component plus an "Updating…" label in the pager; no new styles) until the
  new page arrives. The full "Loading…" state is
  kept for the very first load only.
- Status tabs show `…` instead of `0` while stats have never loaded.
- When the list errors, today's behaviour (treat as empty, disable Next) is
  kept; placeholder data must not mask the error state.

Styling follows `web/STYLEGUIDE.md`; no new colors or primitives.

## Cross-backend requirements

All four backends must pass the same behavioural suite; any backend-specific
difference lives only in `pkg/statestore`.

| Concern | Redis | PostgreSQL | SQLite | MongoDB |
|---|---|---|---|---|
| `Keys` calls per list page | 51 → 1 | 51 → 1 | 51 → 1 | 51 → 1 |
| `Keys` calls per stats poll | N+1 → 1 | N+1 → 1 | N+1 → 1 | N+1 → 1 |
| `BulkGet` mechanism | parallel `Get` (bounded 16) | `ANY` query | `IN` query | `$in` query |
| Value parity to verify | `BulkGet` bytes == `Get` bytes (hash `data` field) | `BulkGet` bytes == `Get` bytes (bytea/JSON value column) | same | same (BSON-stored value) |
| Missing key in `BulkGet` | `nil` entry | `nil` entry | `nil` entry | `nil` entry |

Value parity is the main risk: contrib's native `BulkGet` may encode values
differently from `Get` on some backends. The integration suite (below) asserts
parity per backend. If a backend fails it, `ccStore.BulkGet` keeps the
sequential/parallel-`Get` path **for that backend only**, and the spec's
performance goals still hold via §1 and §3.

## Testing

**Unit (`-tags unit`)**

- `pkg/statestore`: `HistoryKey` formatting (padding, >999 999).
- `pkg/workflow`:
  - metadata decode: proto, legacy JSON, `{}`, garbage, over-bound length.
  - `load()` via a counting fake `Store`: proto metadata → 0 `Keys`,
    1 `Get`, 1 `BulkGet`; each fallback condition → exactly one `Keys`.
  - Constructed history key missing → event skipped, no error.
  - `List`/`Stats` issue exactly one `Keys` for an unfiltered page.
  - Cache: unchanged metadata → no reload; changed metadata → reload; key gone
    → pruned by Stats, not by List; overflow clears; `Get` bypasses it.
  - Concurrency: results identical to sequential load (run with `-race`);
    cancelled context stops further store calls.
  - Existing golden tests stay unchanged (`-update` must not be needed).
- `pkg/server`: handlers are unchanged; add a test that a cancelled request
  context on `/workflows/stats` returns promptly and stops store calls.

**Integration (`-tags integration`, testcontainers + temp SQLite — the
existing harness in `pkg/statestore/store_integration_test.go`)**

- Store contract, per backend: `BulkGet` of present + missing keys returns
  byte-identical values to `Get` and `nil` for the missing key; chunking
  across >100 keys.
- Workflow read path, per backend: seed M = 200 realistic instances (proto
  metadata, 5–30 history events, some with `customStatus`, a few children, a
  few legacy-JSON metadata, one `{}`), then assert `List` (paged to the end),
  `Stats`, and `Get` equal the results of the legacy scan-based loader over
  the same data. The legacy loader is kept as a test-only helper for this
  parity check.

**Benchmark (not a CI gate)**

- `BenchmarkListStats` under `-tags integration` per backend with 2 000
  instances; report cold and warm (cached) Stats and one List page, before vs
  after, in the PR description.

**Web (Vitest) + typecheck**

- Hooks pass `signal` to `fetch` (MSW request is aborted on unmount/filter
  change).
- Filter change keeps previous rows visible with the updating state, then
  swaps in new rows.
- Tabs show `…` before stats load, counts after.
- Stats refetch interval is ≥ 10 s at a 3 s global interval.
- `tsc -b` / `make build` must pass (Vitest doesn't typecheck).

Gates before done: `make test`, `make test-integration`, `make build`.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Native `BulkGet` value encoding differs from `Get` on a backend | Per-backend parity integration test; per-backend fallback to `Get` |
| Future Dapr changes the metadata/history key layout | Any decode/length failure falls back to the key scan; parity tests pin today's layout |
| Cache serves a stale summary | Keyed on exact metadata bytes, which Dapr rewrites on every save; detail page never cached |
| Memory growth on huge stores | Hard cap with clear-on-overflow |
| More concurrent load on a small local store | Bounded (8 instances × ≤16 Redis gets); SQL/Mongo use one query per chunk |

## Decisions to confirm in review

1. `maxHistoryEntries = 1 000 000` (Dapr's bound) before falling back to a scan.
2. `instanceLoadConcurrency = 8`, `bulkGetChunk = 100`, Redis `Parallelism = 16`.
3. Cache cap 20 000 summaries with clear-on-overflow (no LRU).
4. Stats polls at `max(interval, 10 s)`.
5. `Spinner` + "Updating…" in the pager while placeholder rows are shown.
