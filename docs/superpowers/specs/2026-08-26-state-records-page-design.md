# State Records Page — Design

**Date:** 2026-08-26
**Status:** Design — awaiting review
**Area:** `pkg/statestore`, new `pkg/state`, `pkg/server`, `cmd`, `web/src/pages/State.tsx`

## Problem

The dashboard already connects to Dapr state stores — the connection registry
(`server.StoreRegistry`), the identity-keyed connection pool (`cmd/connpool.go`),
and four embedded components-contrib backends (`pkg/statestore/store.go`) exist
and are exercised by the Workflows pages. But that machinery is used for exactly
one thing: decoding workflow history.

A developer running a Dapr app locally has no way to see the state their app
actually wrote. To answer "did my handler persist that order?" they drop out of
the dashboard into `redis-cli`, `psql`, or `sqlite3` — a different tool per
backend, each with its own way of spelling the key.

Everything needed to answer that question in the dashboard is already
connected. This design adds a **State** page: a paginated, read-only table of
state records for the selected store, with multi-select record removal.

## Goals

- List state records for any registry-connected store: key, raw value, version,
  TTL.
- Paginate over stores far too large to load at once, using the backend's own
  key cursor.
- Filter by app and search by key, pushed into the backend rather than
  post-filtered in Go.
- Hide runtime-managed keys (workflow history, actor state) by default, without
  making them unreachable.
- Multi-select bulk deletion with per-key success/failure reporting.
- Match the Workflows overview page visually by reusing its structure and
  classes, not by re-implementing them.

## Non-goals

- Editing or creating records. The page is read-only; editing is a plausible
  future extension and the API is shaped so adding it does not require
  restructuring.
- Value search (matching on record *contents* rather than keys).
- Dapr's alpha Query API.
- TTL editing, bulk export, or a per-record history/audit view.

## Background: what the store layer can and cannot tell us

Three constraints from the existing code and from components-contrib v1.18.0
shape everything below. They were verified against the module source, not
inferred from the Dapr docs.

**1. Access is direct, not through the Dapr HTTP State API.** `pkg/statestore`
embeds the contrib backends (redis, sqlite, postgresql/v2, mongodb) and reaches
them over their native protocols. This is what makes the page possible at all:
Dapr's HTTP State API can get, bulk-get, delete, and query — but it **cannot
enumerate keys**. Key listing exists only on the contrib
`state.KeysLiker` interface, which all four supported backends implement, and
which `Store.Keys` already wraps with SQL-LIKE patterns and an opaque
continuation cursor.

**2. The available per-record metadata is narrower than the Dapr docs imply.**
A contrib `Get` yields `state.GetResponse{Data, ETag, Metadata, ContentType}`.
Checking each backend's implementation:

| Backend | ETag | `Metadata` | ContentType |
|---|---|---|---|
| redis | `version` field; absent for pre-etag entries written via `directGet`'s path | — | — |
| sqlite | yes | `ttlExpireTime` when a TTL is set | — |
| postgresql/v2 | yes | `ttlExpireTime` when a TTL is set | — |
| mongodb | yes | `ttlExpireTime` when a TTL is set | — |

So the honest per-record metadata set is **key, raw value, etag, TTL expiry**.
`ContentType` is nil for all four today; it is carried through anyway because it
costs nothing and the contrib interface may start populating it.

**There is no created/last-modified timestamp.** The sqlite and postgres tables
physically store one, but contrib never surfaces it, and reaching past the
interface into raw SQL would mean forking the store layer per backend. The page
therefore ships **without a timestamp column** rather than with a fabricated or
backend-dependent one. The etag is shown as **Version** with a tooltip stating
what it is: a revision counter that tells you *that* a record changed, not
*when*.

**3. `Store.Get` discards the etag** (`store.go:136`) and `Store.BulkGet` loops
over `Get` one key at a time (`store.go:147`). Both need a companion read path.

## Chosen approach

**A new `pkg/state` package mirroring `pkg/workflow`**: a `Service` interface
with a store-backed implementation, per-store instances built in
`cmd/workflow.go:buildStoreEntry`, resolved by a backend interface, served by a
`pkg/server/state.go` router. Classification, paging and filtering are all
unit-testable against a fake store with no HTTP involved.

The alternative considered was a thin `pkg/server/state.go` handler talking to
`statestore.Store` directly — fewer files, but it puts key classification and
loop-fill paging in the HTTP layer, which is the one place this repo has
consistently kept them out of.

## Part 1 — Widening `pkg/statestore`

A new record type and an **optional interface**:

```go
// Record is one state entry with the metadata the four supported backends
// actually expose.
type Record struct {
    Key         string
    Value       []byte
    ETag        string     // "" when the backend has none for this entry
    TTLExpire   *time.Time // from state.GetRespMetaKeyTTLExpireTime, nil when no TTL
    ContentType string     // nil for all four backends today; carried anyway
}

// RecordReader is the metadata-preserving bulk read path. Implemented by
// ccStore; asserted for by the state service.
type RecordReader interface {
    Records(ctx context.Context, keys []string) ([]Record, error)
}
```

`ccStore.Records` delegates to `s.inner.(state.BulkStore).BulkGet` — a **real**
bulk call in one round-trip, not the sequential loop `BulkGet` does today.
`state.Store` embeds `BulkStore`, so all four backends have it. Missing keys are
omitted from the result rather than returned as zero-valued records, so a key
deleted between the key-scan and the value fetch simply vanishes from the page
instead of rendering as an empty row. A per-key `Error` in the contrib bulk
response is surfaced as a record whose value could not be read (see the UI's
`—` handling), not as a failure of the whole page.

### Why an optional interface rather than a method on `Store`

Six test fakes implement `statestore.Store` (`cmd/reconciler_test.go`,
`cmd/connpool_test.go`, `cmd/workflow_test.go`, `pkg/workflow/service_test.go`,
and the two openers). Adding a method to the interface forces a stub into every
one of them, in test files that have nothing to do with this feature.

More importantly, this mirrors the pattern the store layer already uses:
`ccStore.Keys` type-asserts `s.inner.(state.KeysLiker)` and returns a clear
error when the backend lacks the capability (`store.go:109`). Record reading
gets the same treatment one level up.

The cost is that the capability is not compile-time-checked at the seam. It is
paid down by making the seam a **single** assertion in `buildStoreEntry`, and by
mapping the failure to an explicit API error rather than a nil-pointer panic.

## Part 2 — `pkg/state`

```go
var (
    ErrNoStore          = errors.New("no state store configured")
    ErrStoreUnreachable = errors.New("could not connect to state store")
    // ErrNotBrowsable: the store opened, but cannot enumerate keys or read
    // record metadata (no KeysLiker / no RecordReader).
    ErrNotBrowsable = errors.New("state store cannot be browsed")
)

type ListQuery struct {
    AppID           string
    Search          string
    PageToken       string
    PageSize        int
    IncludeInternal bool
}

type Service interface {
    List(ctx context.Context, q ListQuery) (ListResult, error)
    // Record returns one record's full value, capped at maxValueBytes.
    Record(ctx context.Context, key string) (Record, error)
    // AppIDs returns every distinct key prefix in the store, sorted.
    AppIDs(ctx context.Context) ([]string, error)
    Delete(ctx context.Context, keys []string) []DeleteResult
}
```

`New(store statestore.Store, rr statestore.RecordReader) Service`. A nil store
yields `ErrNoStore` from every method — matching `workflow.New(nil, …)`, which
the degraded entry at `cmd/reconciler.go:86` relies on. A non-nil store with a
nil `RecordReader` yields `ErrNotBrowsable`.

### Key classification

Dapr composes state keys from `||`-joined segments. Splitting on
`statestore.KeyDelimiter`:

| Segments | Example | Kind |
|---|---|---|
| 1 | `order-42` (component sets `keyPrefix: none`) | `app` |
| 2 | `myapp‖order-42` | `app` |
| ≥3, `seg[1]` starts with `dapr.internal.` | `myapp‖dapr.internal.default.myapp.workflow‖<id>‖history-000001` | `workflow` |
| ≥3, otherwise | `myapp‖MyActor‖actor-7‖balance` | `actor` |

`IncludeInternal: false` — the default — keeps only `app`.

This is a **heuristic, not a parse**: a Dapr key may itself contain `||`, in
which case an app record with two delimiters in its name is misclassified as
actor state. The consequences are bounded (the record hides behind the "Show
internal keys" toggle rather than disappearing) and the alternative — a
maintained allowlist of Dapr-internal actor types — would rot against Dapr
releases. The rule and its limitation are documented in the package comment.

Note the asymmetry with `keyPrefix`: because a component may set `keyPrefix` to
`none`, `name`, or a literal, `seg[0]` is **not** guaranteed to be an app-id.
It is treated as an opaque prefix that is *usually* an app-id, and the UI labels
the column "App" because that is what it is in the default configuration.

### List: order of operations

This ordering is what keeps the page cheap, and it is the main structural
difference from `workflow.List`.

1. **Key page.** `store.Keys(pattern, token, pageSize)` where
   `pattern = <escapedAppID>‖%<escapedSearch>%`, or `%<escapedSearch>%` with no
   app filter, or `%` with neither. Both the app filter and the key search are
   pushed into the backend.
2. **Classify on keys alone.** Drop internals unless `IncludeInternal`. No
   values have been fetched yet, so a store that is 99% workflow history costs
   only key bytes to skip.
3. **Loop-fill** if the page is under-filled, reusing the workflow guard rails:
   at most `10 × pageSize` keys scanned, hard-capped at 2000. As in
   `workflow.List`, `NextToken` always points past the last fully-scanned key
   page, so a capped page may return fewer than `pageSize` items *with* a
   non-empty token; clients treat that as "keep paging".
4. **One `Records()` call** for the surviving keys of the final page.

`workflow.List` must load each instance *in order to* filter it; here the filter
is satisfied by the key text, so exactly one bulk value fetch happens per
request, for the rows actually returned.

Loop-fill is needed even though search is pushed down, because the
internal-key exclusion — on by default — cannot be expressed in `KeysLike`,
which takes a single positive pattern with no negation.

### LIKE escaping

All four backends translate the LIKE pattern to their native matcher
(`likeToRedisGlob` for redis, `likeToRegex` for mongodb, native LIKE for
sqlite/postgres) and all four honor `\` escapes for `%`, `_`, and `\`.

User-supplied text — **both** the search needle and the app-id, which is itself
derived from key text and may contain `_` — is backslash-escaped before being
interpolated into the pattern. Without this, searching for `order_42` silently
matches `order-42`, and an app named `my_app` matches `myXapp`.

An invalid pattern makes contrib return an error; that maps to a 400, not a 500.

### Per-backend cost notes

Redis's `KeysLike` completes a **full keyspace `SCAN`** on every call before
paging the collected keys in memory (`redis.go:611`). Paging a large redis store
is therefore O(keyspace) per request. This is not new — the Workflows page has
always paid it — but it is written down here so the next person reading a slow
page has the explanation.

### AppIDs

`AppIDs` scans keys only — `store.Keys("%", "", 0)`, no values — and returns the
sorted distinct `seg[0]` of every key with at least two segments. Keys with no
prefix contribute nothing, so a store holding only unprefixed keys yields an
empty list and the dropdown offers just "All apps"; those records are still
listed and are reachable that way.

It ignores `Search` and `AppID`, so selecting an app never collapses the option
list to that one app. It does, however, honour **`IncludeInternal`**: a prefix
is offered only if at least one of its keys survives that filter.

> **Revised after first use (2026-08-27).** This section originally called
> `AppIDs` fully filter-independent, reasoning that "both `app` and `workflow`
> keys share the same `seg[0]`, so the prefix set is the same either way". That
> is only true of an app that has *both* kinds of key. A real local store is
> mostly *finished workflow apps* with no plain records left, so the default
> (internal keys hidden) dropdown filled up with prefixes whose every row was
> filtered out — pick one and the table is empty. The filter is applied per
> key, so an app with plain records *and* workflow history still appears under
> either setting, which is the case the original reasoning had in mind.

### Delete

A per-key `store.Delete` loop returning `[]DeleteResult{Key, OK, Error}`, so a
partial failure names exactly which keys survived. There is deliberately **no**
second mechanism: unlike a workflow instance, a state record has no lifecycle
to terminate, nothing to purge, and no sidecar involvement. Deleting through the
owning app's sidecar was considered and rejected — it would require resolving
key → app → HTTP port and stripping the `keyPrefix`, and it fundamentally cannot
touch records whose app is stopped, which is the main cleanup case.

## Part 3 — API

Served by `pkg/server/state.go`, mounted at `/api/state`, gated on a new
`caps.State`.

```
GET  /api/state?store=&appId=&search=&page=&limit=&includeInternal=
GET  /api/state/record?store=&key=
GET  /api/state/appids?store=
POST /api/state/delete?store=      { "keys": ["myapp||order-42", …] }
```

`limit` is capped at 500, reusing the `maxListPageSize` rationale. `key` is a
query parameter, not a path segment, so `||` and arbitrary key characters
round-trip through `encodeURIComponent` without path-escaping games.

**List item** (no full value):

```json
{
  "key": "myapp||order-42",
  "appId": "myapp",
  "logicalKey": "order-42",
  "kind": "app",
  "preview": "{\"id\":42,\"total\":19.99,\"items\":[{\"sku\":\"A…",
  "encoding": "text",
  "size": 1284,
  "etag": "3",
  "ttlExpiresAt": "2026-08-26T14:02:11Z",
  "contentType": ""
}
```

**Record response** adds `"value"` and `"truncated"`, and omits `preview`.

### Value encoding and size caps

- Values that are valid UTF-8 are returned as text (`"encoding": "text"`);
  anything else is base64 with `"encoding": "base64"`, so a protobuf blob or a
  gzip payload cannot corrupt the JSON response.
- **List previews are capped at 200 characters** (of the rendered text or
  base64), with `size` always reporting the true byte length.
- **`/state/record` caps the value at 1 MB** with `"truncated": true`.

> **Refinement from the reviewed design.** The reviewed version returned values
> inline in the list, capped at 64 KB each. At `limit=50` that is a ~3 MB
> response — re-fetched on every tick of the global `RefreshControl` interval.
> Splitting the full value onto `/state/record`, fetched only when a row is
> expanded, keeps list pages small under auto-refresh. The list still carries
> `size` and `etag`, so the Value / Size / Version columns are unaffected.

### Error mapping

| Condition | Status | Body |
|---|---|---|
| unknown `store` | 404 | `{"error":"unknown state store"}` |
| `ErrNoStore` | 503 | `{"error":"no state store detected"}` |
| `ErrStoreUnreachable` | 503 | wrapped message with store name + connection |
| `ErrNotBrowsable` | 503 | `{"error":"this state store cannot be browsed"}` |
| key not found (`/record`) | 404 | `{"error":"record not found"}` |

There is deliberately **no 400 row for an invalid search pattern**. Because
every piece of user text is backslash-escaped before interpolation (see *LIKE
escaping*), the pattern handed to `KeysLike` is valid by construction — there is
no input that can make contrib's pattern parser fail. A residual pattern error
would mean a bug in our escaping, not bad input, so it correctly falls through
to 500 rather than being reported to the user as their mistake.

The 503 shapes match the existing workflow responses so the SPA's
`String(error).includes('503')` banner extraction (`Workflows.tsx:341`) works
unchanged.

## Part 4 — Wiring

- **`server.Capabilities`** gains `State bool`. `FullCapabilities()` sets it
  true. The aspire/container branch at `cmd/root.go:147` sets
  `State: settings.StateStore != ""`, exactly mirroring `Workflows` — both
  features need a connected store. It is a separate flag rather than a reuse of
  `caps.Workflows` because the two are semantically distinct: a store with no
  workflow data still has state worth browsing.
- **`cmd.storeEntry`** gains a `state state.Service` field, built in
  `buildStoreEntry`. This is the single seam where the optional interface is
  asserted:

  ```go
  var rr statestore.RecordReader
  if st != nil {
      rr, _ = st.(statestore.RecordReader)   // nil when unsupported
  }
  entry.state = state.New(st, rr)
  ```

  A nil `st` (the degraded entry) or a nil `rr` produces a service that returns
  `ErrNoStore` / `ErrNotBrowsable` from every method — no nil-pointer path.
- **`server.StateBackend`** is a new one-method interface,
  `StateFor(store string) (state.Service, bool)`, satisfied by the same
  reconciler type that already implements `WorkflowBackend`. It is passed as its
  own `Options.StateBackend` field rather than widening `ServiceFor`'s
  already-four-value return, and rather than type-asserting the existing
  backend.
- **`apiRouter`** mounts `/state` when `caps.State`, alongside the existing
  `caps.Workflows` gate.

## Part 5 — Frontend

New page `web/src/pages/State.tsx`, types in `web/src/types/state.ts`, hooks in
`web/src/hooks/useStateRecords.ts` (`useStateRecords`, `useStateRecord`,
`useStateAppIds`, `useDeleteStateRecords`).

Nav: **State** inserted directly after Workflows in `NAV_ITEMS`
(`components/TopNav.tsx`), gated `cap: 'state'`. Route
`{ path: 'state', element: <State />, handle: { rumView: 'State' } }` inside the
`caps.state` branch of `router.tsx`, mirroring the workflows branch.

### Structure

Copied from `Workflows.tsx` so it matches by construction rather than by
resemblance. Follow `web/STYLEGUIDE.md`; no new CSS primitives.

- **`.phead`** — `<h1>State records</h1>`, a `.sub` line, then a `.ctrlset`
  holding the store `<select>` (`dedupeStores`, `data-testid="store-select"`,
  persisted under `devdash.stateStore`) and the `component` chip linking to
  `/components/<name>`. Store-selection logic — the null-sentinel
  `selectedStore`, the persisted-then-active fallback, `onStoreChange` resetting
  paging — is lifted verbatim.
- **`.filters`** — app `<select>` (from `/state/appids`, "All apps" default),
  `.search` box with placeholder `Search key…` and the same 250 ms debounce, and
  a `.childtoggle` checkbox labelled **Show internal keys** with the hint
  *workflow history and actor state*.
- **`.card`** > **`.selbar`** (`N selected` + one `btn danger` **Delete…**) >
  **`.tablewrap`** > **`table.wf`**.

### Columns

| Column | Content |
|---|---|
| `.cbx` | select checkbox; header selects all rows on the page |
| Key | `logicalKey`, `mono`, with a `▸`/`▾` expand affordance; `kind` shown as a `.typechip` when it is not `app` |
| App | `appId`, or `—` for an unprefixed key |
| Value | `preview`, `mono`, single-line ellipsis; `base64` marked with a `.typechip` |
| Size | byte count, `mono tabnum`, humanized (`1.3 KB`) |
| Version | `etag`, `mono tabnum`, `—` when absent, `title` explaining it is a revision counter |
| TTL | `DateTimeCell`, `—` when no TTL |

`DateTimeCell` is currently a private function inside `Workflows.tsx:24`; it
moves to `web/src/components/DateTimeCell.tsx` and both pages import it. That is
the one piece of incidental refactoring in this design, and it is confined to a
move plus two import lines.

### Row expansion

Row click toggles an expanded `<tr>` beneath the row (`colSpan` across the
table) rather than navigating — unlike Workflows, there is no detail route to
navigate *to*, and keys are not URL-shaped. The expanded panel:

- fetches `/state/record` for that key (a `useStateRecord` query, enabled only
  while expanded), showing `Loading…` then the value;
- renders it through the existing `highlightJson` helper
  (`lib/json-highlight.tsx:105`), which pretty-prints valid JSON and falls back
  to raw text without throwing;
- offers a **Copy** button for the full value, and shows a
  *truncated at 1 MB* note when `truncated`;
- shows `key` in full (including the prefix), plus `etag`, `size`, `contentType`
  and TTL, since the table abbreviates them.

One row is expanded at a time. Expansion state is keyed by the full key and
cleared on any filter/store/page change.

### Deletion

The selection bar's **Delete…** opens the generic `ConfirmDialog`
(`components/ConfirmDialog.tsx`) directly — **not** `ConfirmRemoveDialog`, which
is workflow-specific (force checkbox, terminate/purge mechanism copy) and would
have to be gutted to be reused. The dialog body states the count, lists up to
five keys, and says plainly that deletion is immediate and cannot be undone.

On confirm, `POST /state/delete`; on success, a result banner in the same style
as `removeStatus` (`Workflows.tsx:419`) reporting `Deleted N records` plus
`, M failed` when any failed, with a Dismiss link. The mutation invalidates the
`state-records` and `state-appids` query keys — the app dropdown derives from the
same keyspace and goes stale too, and with auto-refresh paused it would never
catch up on its own.

### Pager and empty states

`.pager` with the `X–Y loaded` label and the same Prev-history-stack /
`nextToken` logic, including clearing the selection on every page change
(selection is scoped to the visible page).

No status-segment counters: state records have no status, and a total count
would mean a full keyspace scan on every render.

Empty and error states mirror Workflows: full-page guidance when the store list
itself is empty; otherwise a `load-error-banner` above the filters with the page
chrome left intact so the user can switch stores, plus
`Couldn't load state records from this store.` inside the table area.

### Stores that cannot be browsed

A store that cannot be opened directly — the in-memory / testcontainers case —
has **no fallback**. The sidecar-gRPC path that rescues the Workflows page
(`pkg/workflow/composite.go`) has no analogue here, because Dapr's HTTP State
API cannot enumerate keys. Such a store surfaces the `ErrNotBrowsable` 503 in
the standard banner: *this state store cannot be browsed — select another
store*. This is a stated limitation, not a bug to be worked around later.

## Testing

TDD throughout: each behavior below gets its failing test before the
implementation.

**`pkg/statestore`**
- `Records` added to the four-backend `runStoreContract`
  (`store_integration_test.go`): etag present, TTL surfaced when set and nil
  when not, a missing key omitted from the result, a mixed present/missing batch.
- `ccStore` satisfies `RecordReader` (compile-time assertion in the test).

**`pkg/state`** (fake store, no containers)
- Classification table: 1/2/3/4-segment keys, `dapr.internal.*.workflow`,
  `dapr.internal.*.activity`, a user actor type, a key containing `||` in its
  logical name (documents the misclassification).
- Pattern construction: no filter, app only, search only, both; escaping of
  `%`, `_`, `\` in both the needle and the app-id.
- Paging: unfiltered one-key-page-per-call; loop-fill reaching `pageSize`;
  scan-cap firing with a short page and a non-empty token; token passthrough.
- Exactly one `Records()` call per `List`, for the final page's keys only
  (counted on the fake).
- Value encoding: UTF-8 → text, invalid UTF-8 → base64, preview truncation at
  200 chars with `size` reporting true length, `/record` truncation at 1 MB.
- `Delete` partial failure returns per-key results.
- Nil store → `ErrNoStore`; nil `RecordReader` → `ErrNotBrowsable`.

**`pkg/server`** (`state_test.go`, following `workflows_test.go`)
- Query-param parsing including the 500 limit cap and `includeInternal`.
- Each row of the error-mapping table.
- `key` round-trips through the query param with `||` and unicode.
- Route absent when `caps.State` is false.

**`cmd`**
- `buildStoreEntry` with a store that implements `RecordReader`, one that does
  not, and `nil` — asserting the service returned degrades rather than panics.

**`web`** (`State.test.tsx`)
- Filters → query params: app, debounced search, `includeInternal`, store.
- Row expand fetches `/state/record` once and renders the value; collapse and
  re-expand does not refetch (query cache); expansion clears on filter change.
- Select-all / per-row select; Delete… → confirm → POST body; result banner for
  full and partial success.
- Pager Prev/Next with token history; selection cleared on page change.
- 503 → banner rendered with chrome intact; not-browsable message.
- Store selection persisted to and restored from `localStorage`.

**Build gate:** `make build` (which runs `tsc -b`) after every `.ts`/`.tsx`
change, test files included — vitest alone does not typecheck.

## Files touched

**New**
- `pkg/state/{service.go,classify.go,pattern.go,types.go}` + tests
- `pkg/server/state.go` + `state_test.go`
- `web/src/pages/State.tsx` + `State.test.tsx`
- `web/src/types/state.ts`
- `web/src/hooks/useStateRecords.ts` + tests
- `web/src/components/DateTimeCell.tsx` (moved out of `Workflows.tsx`)

**Modified**
- `pkg/statestore/store.go` — `Record`, `RecordReader`, `ccStore.Records`
- `pkg/statestore/store_integration_test.go` — contract additions
- `pkg/server/server.go` — `Capabilities.State`, `FullCapabilities`,
  `Options.StateBackend`
- `pkg/server/api.go` — mount `/state` under the `caps.State` gate
- `cmd/root.go` — set `State` in the aspire branch
- `cmd/workflow.go` — `storeEntry.state`, `buildStoreEntry` assertion,
  `StateFor`
- `cmd/serve.go` — pass `StateBackend` through `assembleOptions`
- `web/src/components/TopNav.tsx` — `State` nav item
- `web/src/router.tsx` — gated route
- `web/src/lib/capabilities.ts` — `state` flag
- `web/src/pages/Workflows.tsx` — import the moved `DateTimeCell`
- `README.md` / `ARCHITECTURE.md` — document the page and its limitations
