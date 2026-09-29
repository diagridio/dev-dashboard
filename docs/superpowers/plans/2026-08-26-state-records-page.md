# State Records Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only, paginated **State** page that lists state-store records (key, value, version, TTL) for any registry-connected store, with multi-select record deletion.

**Architecture:** A new `pkg/state` package mirrors `pkg/workflow`: a `Service` interface with a store-backed implementation, one instance per opened store built in `cmd/workflow.go:buildStoreEntry`, resolved through a new `server.StateBackend`, served by `pkg/server/state.go`. `pkg/statestore` gains a `Record` type and an optional `RecordReader` interface that preserves etag and TTL (which the existing `Get`/`BulkGet` discard). The frontend page is built from the Workflows overview page's structure and CSS classes.

**Tech Stack:** Go 1.26 (chi router, components-contrib v1.18.0, testify), React 19 + TypeScript (react-router-dom v6, TanStack Query v5, Vitest + MSW + Testing Library).

**Spec:** `docs/superpowers/specs/2026-08-26-state-records-page-design.md` — read it before Task 1. It records *why* the metadata set is this narrow and why there is no timestamp column; the plan below does not repeat that argument.

## Global Constraints

- **Go test build tags are mandatory.** Unit test files start with `//go:build unit`; integration test files with `//go:build integration`. An untagged test file is silently never run. Run unit tests with `go test -tags unit ./...`, integration with `make test-integration`.
- **`gofmt` must be clean** — `make lint-go` fails the build on any unformatted file. Run `gofmt -w` on every Go file you touch.
- **`make build` after every `.ts`/`.tsx` change, test files included.** Vitest does not typecheck; `make build` runs `tsc -b`. This has bitten the repo before (PR #42).
- **No hex color literals in `.ts`/`.tsx`.** Colors come from theme tokens (`var(--line)`, `var(--fail-fg)`, …). Enforced by `web/src/test/styleguide.test.ts`.
- **No template-literal `className` without a static prefix.** `` className={`led ${x}`} `` is fine; `` className={`${x}`} `` is not. Enforced by the same test.
- **Follow `web/STYLEGUIDE.md`.** Add no new CSS primitives; every class used below already exists in `web/src/styles/theme.css`.
- **Key delimiter is `statestore.KeyDelimiter` (`"||"`)** — never a literal `"||"` in new Go code.
- **Value size limits:** list previews 200 characters; `/state/record` values 1 MiB (`1 << 20`).
- **Page size:** default 50, client limit capped at 500 (`maxListPageSize`, already defined in `pkg/server/workflows.go:193`).
- **Commit messages** use conventional prefixes (`feat:`, `test:`, `docs:`, `refactor:`) and end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

---

## File Structure

**New — Go**

| File | Responsibility |
|---|---|
| `pkg/statestore/record.go` | `Record` type, `RecordReader` interface, `ccStore.Records`, pure `recordsFromBulk` conversion |
| `pkg/state/types.go` | Wire types (`Item`, `Record`, `ListResult`, `DeleteResult`, `Kind`), sentinel errors, tuning constants |
| `pkg/state/classify.go` | Key → (appID, logicalKey, kind) classification |
| `pkg/state/pattern.go` | LIKE escaping and `KeysLike` pattern construction |
| `pkg/state/value.go` | Value rendering (UTF-8 vs base64), preview truncation |
| `pkg/state/service.go` | `Service` interface, store-backed impl (`List`/`Record`/`AppIDs`/`Delete`), unreachable impl |
| `pkg/server/state.go` | `StateBackend` interface, `/api/state` router, query parsing, error mapping |

**New — web**

| File | Responsibility |
|---|---|
| `web/src/types/state.ts` | Wire types mirroring `pkg/state` JSON |
| `web/src/hooks/useStateRecords.ts` | `useStateRecords`, `useStateRecord`, `useStateAppIds`, `useDeleteStateRecords` |
| `web/src/components/DateTimeCell.tsx` | Extracted from `Workflows.tsx` so both pages share it |
| `web/src/pages/State.tsx` | The page |

**Modified:** `pkg/statestore/store_integration_test.go`, `pkg/server/server.go`, `pkg/server/api.go`, `cmd/root.go`, `cmd/workflow.go`, `cmd/reconciler.go`, `cmd/serve.go`, `web/src/components/TopNav.tsx`, `web/src/router.tsx`, `web/src/lib/capabilities.ts`, `web/src/pages/Workflows.tsx`, `web/STYLEGUIDE.md`, `README.md`, `ARCHITECTURE.md`.

---

### Task 0: Isolated worktree

No tests — this task only creates the workspace every later task runs in.

**Files:** none (workspace setup)

**Interfaces:**
- Consumes: nothing
- Produces: an absolute worktree path `$WT` and a branch, used by every later task

- [ ] **Step 1: Create the worktree via the using-git-worktrees skill**

Invoke `superpowers:using-git-worktrees`. This session has the native `EnterWorktree` tool, so the skill will use it — do **not** run `git worktree add` by hand, which creates state the harness cannot see.

Branch **off `feat/state-records-page`**, not `main`: that branch carries the spec and this plan, and the main checkout already has it checked out (git refuses to check out the same branch in two worktrees). Suggested new branch name, matching this repo's convention: `worktree-state-records-page`.

- [ ] **Step 2: Record the worktree path and verify the branch**

```bash
git rev-parse --show-toplevel   # -> the worktree path; call this $WT
git branch --show-current       # -> worktree-state-records-page
git log --oneline -2            # -> the spec + plan commits are present
```

> **Footgun — read this before dispatching any subagent.** A subagent starts in the **main repo's** working directory, not the worktree. Every subagent prompt must state the absolute worktree path and instruct the agent to `cd` there first, and every task must run `git branch --show-current` before committing. Work committed to `main` by accident has happened in this repo before.

- [ ] **Step 3: Confirm the toolchain works in the worktree**

```bash
cd $WT && go build ./... && cd web && npm install
```
Expected: both succeed. `npm install` in a fresh worktree takes a minute; do it now rather than mid-task.

---

### Task 1: `statestore.Record` and `RecordReader`

Gives the store layer a read path that preserves etag and TTL. `Get` discards the etag (`store.go:136`) and `BulkGet` loops one key at a time (`store.go:147`); this adds a real bulk call alongside them without touching either.

**Files:**
- Create: `pkg/statestore/record.go`
- Create: `pkg/statestore/record_test.go`
- Modify: `pkg/statestore/store_integration_test.go` (extend `runStoreContract`)

**Interfaces:**
- Consumes: `statestore.ccStore` (existing, unexported), `state.BulkStore` from components-contrib
- Produces:
  - `statestore.Record{Key string; Value []byte; ETag string; TTLExpire *time.Time; ContentType string}`
  - `statestore.RecordReader` interface with `Records(ctx context.Context, keys []string) ([]Record, error)`
  - unexported `recordsFromBulk([]state.BulkGetResponse) []Record`

- [ ] **Step 1: Write the failing unit test**

Create `pkg/statestore/record_test.go`:

```go
//go:build unit

package statestore

import (
	"testing"
	"time"

	"github.com/dapr/components-contrib/state"
	"github.com/stretchr/testify/require"
)

func strPtr(s string) *string { return &s }

func TestRecordsFromBulk(t *testing.T) {
	t.Run("maps value, etag and content type", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:         "app||order-1",
			Data:        []byte(`{"id":1}`),
			ETag:        strPtr("7"),
			ContentType: strPtr("application/json"),
		}})
		require.Len(t, got, 1)
		require.Equal(t, "app||order-1", got[0].Key)
		require.Equal(t, `{"id":1}`, string(got[0].Value))
		require.Equal(t, "7", got[0].ETag)
		require.Equal(t, "application/json", got[0].ContentType)
		require.Nil(t, got[0].TTLExpire)
	})

	t.Run("parses ttlExpireTime into TTLExpire", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:  "app||k",
			Data: []byte("v"),
			Metadata: map[string]string{
				state.GetRespMetaKeyTTLExpireTime: "2026-08-26T14:02:11Z",
			},
		}})
		require.Len(t, got, 1)
		require.NotNil(t, got[0].TTLExpire)
		require.Equal(t, time.Date(2026, 8, 26, 14, 2, 11, 0, time.UTC), got[0].TTLExpire.UTC())
	})

	t.Run("ignores an unparseable ttlExpireTime rather than failing the record", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{{
			Key:      "app||k",
			Data:     []byte("v"),
			Metadata: map[string]string{state.GetRespMetaKeyTTLExpireTime: "not-a-time"},
		}})
		require.Len(t, got, 1)
		require.Nil(t, got[0].TTLExpire)
	})

	t.Run("omits missing keys so a racing delete does not render an empty row", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||present", Data: []byte("v")},
			{Key: "app||gone"}, // backends fill in not-found keys with a bare Key
		})
		require.Len(t, got, 1)
		require.Equal(t, "app||present", got[0].Key)
	})

	t.Run("omits per-key errors", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||bad", Error: "decode failed"},
			{Key: "app||ok", Data: []byte("v")},
		})
		require.Len(t, got, 1)
		require.Equal(t, "app||ok", got[0].Key)
	})

	t.Run("keeps an empty-but-present value", func(t *testing.T) {
		got := recordsFromBulk([]state.BulkGetResponse{
			{Key: "app||empty", Data: []byte{}, ETag: strPtr("1")},
		})
		require.Len(t, got, 1)
		require.Empty(t, got[0].Value)
	})
}

// ccStore must satisfy RecordReader — the type assertion in
// cmd.buildStoreEntry silently degrades to "not browsable" if it ever stops.
func TestCCStoreImplementsRecordReader(t *testing.T) {
	var _ RecordReader = (*ccStore)(nil)
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT && go test -tags unit ./pkg/statestore/ -run 'TestRecordsFromBulk|TestCCStoreImplementsRecordReader' -v
```
Expected: FAIL — build error, `undefined: recordsFromBulk`, `undefined: RecordReader`.

- [ ] **Step 3: Write the implementation**

Create `pkg/statestore/record.go`:

```go
package statestore

import (
	"context"
	"fmt"
	"time"

	"github.com/dapr/components-contrib/state"
)

// Record is one state entry with the metadata the four supported backends
// actually expose. There is deliberately no created/modified timestamp:
// components-contrib never surfaces one, even for the SQL backends whose
// tables physically store it (see the design spec).
type Record struct {
	Key       string
	Value     []byte
	ETag      string     // "" when the backend has none for this entry
	TTLExpire *time.Time // nil when the entry has no TTL
	// ContentType is nil for all four supported backends today; it is carried
	// through so it starts working for free if contrib begins populating it.
	ContentType string
}

// RecordReader is the metadata-preserving bulk read path. ccStore implements
// it; consumers type-assert for it rather than it being part of Store, mirroring
// how ccStore.Keys asserts for state.KeysLiker.
type RecordReader interface {
	Records(ctx context.Context, keys []string) ([]Record, error)
}

// recordsFromBulk converts a contrib bulk-get response into Records.
//
// Entries the backend could not read (non-empty Error) and entries that do not
// exist (backends fill those in with just a Key) are omitted: a key deleted
// between the key scan and the value fetch should vanish from the page rather
// than render as an empty row. A present-but-empty value is kept, which is why
// the existence check tests Data == nil rather than len(Data) == 0.
func recordsFromBulk(resp []state.BulkGetResponse) []Record {
	out := make([]Record, 0, len(resp))
	for _, r := range resp {
		if r.Error != "" || (r.Data == nil && r.ETag == nil) {
			continue
		}
		rec := Record{Key: r.Key, Value: r.Data}
		if r.ETag != nil {
			rec.ETag = *r.ETag
		}
		if r.ContentType != nil {
			rec.ContentType = *r.ContentType
		}
		if ts, ok := r.Metadata[state.GetRespMetaKeyTTLExpireTime]; ok {
			// A malformed timestamp costs the TTL column, not the record.
			if t, err := time.Parse(time.RFC3339, ts); err == nil {
				rec.TTLExpire = &t
			}
		}
		out = append(out, rec)
	}
	return out
}

// Records reads multiple keys in a single backend round-trip, preserving etag
// and TTL. state.Store embeds state.BulkStore, so all four supported backends
// satisfy the assertion; the error path is defensive.
func (s *ccStore) Records(ctx context.Context, keys []string) ([]Record, error) {
	if len(keys) == 0 {
		return nil, nil
	}
	bs, ok := s.inner.(state.BulkStore)
	if !ok {
		return nil, fmt.Errorf("store %q does not support bulk reads", s.storeType)
	}
	reqs := make([]state.GetRequest, len(keys))
	for i, k := range keys {
		reqs[i] = state.GetRequest{Key: k}
	}
	resp, err := bs.BulkGet(ctx, reqs, state.BulkGetOpts{})
	if err != nil {
		return nil, err
	}
	return recordsFromBulk(resp), nil
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

```bash
cd $WT && gofmt -w pkg/statestore/ && go test -tags unit ./pkg/statestore/ -v
```
Expected: PASS, including the pre-existing `keys_test.go` / `conninfo_test.go` tests.

- [ ] **Step 5: Extend the four-backend integration contract**

In `pkg/statestore/store_integration_test.go`, append to `runStoreContract` (after the existing delete assertions). **Add no imports** — the appended code uses only `statestore`, `require` and `context`, all already imported. (An earlier draft of this step said to add `state` and `time`; that would be an unused-import build failure.)

```go
	// Records: metadata-preserving bulk read across every backend.
	rr, ok := store.(statestore.RecordReader)
	require.True(t, ok, "backend must implement RecordReader")

	recs, err := rr.Records(ctx, []string{histKey, "k||a||1||absent"})
	require.NoError(t, err)
	require.Len(t, recs, 1, "a missing key must be omitted, not returned empty")
	require.Equal(t, histKey, recs[0].Key)
	require.Equal(t, "v2", string(recs[0].Value))
	require.NotEmpty(t, recs[0].ETag, "all four backends return an etag for a written key")
	require.Nil(t, recs[0].TTLExpire, "no TTL was set on this key")

	require.Empty(t, mustRecords(t, rr, nil), "an empty key list is a no-op")
```

And add the helper at file scope:

```go
func mustRecords(t *testing.T, rr statestore.RecordReader, keys []string) []statestore.Record {
	t.Helper()
	recs, err := rr.Records(context.Background(), keys)
	require.NoError(t, err)
	return recs
}
```

> Redis note: `require.NotEmpty` on the etag holds because `Set` goes through the etag-bearing hash path. If redis alone fails this assertion, relax it to `require.NotNil(t, recs[0])` **for redis only** and leave a comment — do not weaken it for all four.

- [ ] **Step 6: Run the integration contract**

```bash
cd $WT && make test-integration
```
Expected: PASS for sqlite, redis, postgres and mongodb. Requires a running container runtime (docker or podman) for the last three. If no runtime is available, run `go test -tags integration ./pkg/statestore/ -run TestSQLiteStoreContract -v` and note in the commit body that the container-backed backends were not exercised locally.

- [ ] **Step 7: Commit**

```bash
cd $WT && git branch --show-current   # must be worktree-state-records-page
git add pkg/statestore/record.go pkg/statestore/record_test.go pkg/statestore/store_integration_test.go
git commit -m "$(cat <<'EOF'
feat(statestore): add Record and RecordReader

Get discards the etag and BulkGet loops one key at a time. Records reads
a batch in a single backend round-trip and preserves etag + TTL expiry,
the only per-record metadata the four supported backends expose.

Optional interface rather than a Store method: six test fakes implement
Store, and this mirrors how ccStore.Keys asserts for state.KeysLiker.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Key classification and LIKE patterns

The two pure functions the rest of `pkg/state` is built on. Both are total functions over strings, so they get thorough table tests and no fakes.

**Files:**
- Create: `pkg/state/types.go`, `pkg/state/classify.go`, `pkg/state/pattern.go`
- Create: `pkg/state/classify_test.go`, `pkg/state/pattern_test.go`

**Interfaces:**
- Consumes: `statestore.KeyDelimiter`
- Produces:
  - `state.Kind` with `KindApp` / `KindWorkflow` / `KindActor` (values `"app"`, `"workflow"`, `"actor"`)
  - `keyParts{AppID, LogicalKey string; Kind Kind}` (unexported) and `classify(key string) keyParts`
  - `escapeLike(s string) string`, `listPattern(appID, search string) string`
  - constants `defaultPageSize = 50`, `previewChars = 200`, `maxValueBytes = 1 << 20`, `filteredScanPageMultiple = 10`, `maxFilteredScanKeys = 2000`
  - encoding constants `EncodingText = "text"`, `EncodingBase64 = "base64"`

- [ ] **Step 1: Write the failing classification test**

Create `pkg/state/classify_test.go`:

```go
//go:build unit

package state

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestClassify(t *testing.T) {
	tests := []struct {
		name    string
		key     string
		appID   string
		logical string
		kind    Kind
	}{
		{
			name: "bare key (component sets keyPrefix: none)",
			key:  "order-42", appID: "", logical: "order-42", kind: KindApp,
		},
		{
			name: "app-prefixed key",
			key:  "myapp||order-42", appID: "myapp", logical: "order-42", kind: KindApp,
		},
		{
			name: "workflow metadata key",
			key:  "myapp||dapr.internal.default.myapp.workflow||abc123||metadata",
			appID: "myapp", logical: "dapr.internal.default.myapp.workflow||abc123||metadata",
			kind: KindWorkflow,
		},
		{
			name: "workflow history key",
			key:  "myapp||dapr.internal.default.myapp.workflow||abc123||history-000001",
			appID: "myapp", logical: "dapr.internal.default.myapp.workflow||abc123||history-000001",
			kind: KindWorkflow,
		},
		{
			name: "activity actor key is also runtime-internal",
			key:  "myapp||dapr.internal.default.myapp.activity||abc123::0||metadata",
			appID: "myapp", logical: "dapr.internal.default.myapp.activity||abc123::0||metadata",
			kind: KindWorkflow,
		},
		{
			name: "user actor state",
			key:  "myapp||MyActor||actor-7||balance",
			appID: "myapp", logical: "MyActor||actor-7||balance", kind: KindActor,
		},
		{
			name: "app key whose logical name contains the delimiter is misclassified (documented heuristic)",
			key:  "myapp||weird||name",
			appID: "myapp", logical: "weird||name", kind: KindActor,
		},
		{
			name: "empty prefix segment yields no app id",
			key:  "||order-42", appID: "", logical: "order-42", kind: KindApp,
		},
		{
			name: "empty key",
			key:  "", appID: "", logical: "", kind: KindApp,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := classify(tc.key)
			require.Equal(t, tc.appID, got.AppID)
			require.Equal(t, tc.logical, got.LogicalKey)
			require.Equal(t, tc.kind, got.Kind)
		})
	}
}
```

- [ ] **Step 2: Write the failing pattern test**

Create `pkg/state/pattern_test.go`:

```go
//go:build unit

package state

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestEscapeLike(t *testing.T) {
	require.Equal(t, `order\_42`, escapeLike("order_42"))
	require.Equal(t, `100\%`, escapeLike("100%"))
	require.Equal(t, `a\\b`, escapeLike(`a\b`))
	require.Equal(t, "plain-key", escapeLike("plain-key"))
	require.Equal(t, "", escapeLike(""))
	// A trailing backslash must not leave a dangling escape in the pattern.
	require.Equal(t, `a\\`, escapeLike(`a\`))
}

func TestListPattern(t *testing.T) {
	t.Run("no filters matches every key", func(t *testing.T) {
		// KeysLike rejects an empty pattern, so the unfiltered case is "%".
		require.Equal(t, "%", listPattern("", ""))
	})
	t.Run("app filter becomes a prefix pattern", func(t *testing.T) {
		require.Equal(t, "myapp||%", listPattern("myapp", ""))
	})
	t.Run("search becomes a contains pattern", func(t *testing.T) {
		require.Equal(t, "%order%", listPattern("", "order"))
	})
	t.Run("app and search combine", func(t *testing.T) {
		require.Equal(t, "myapp||%order%", listPattern("myapp", "order"))
	})
	t.Run("search metacharacters are escaped so they match literally", func(t *testing.T) {
		require.Equal(t, `%order\_42%`, listPattern("", "order_42"))
	})
	t.Run("app id metacharacters are escaped too", func(t *testing.T) {
		// App ids come from parsed key text and can contain underscores.
		require.Equal(t, `my\_app||%`, listPattern("my_app", ""))
	})
}
```

- [ ] **Step 3: Run both tests to verify they fail**

```bash
cd $WT && go test -tags unit ./pkg/state/ -v
```
Expected: FAIL — no non-test Go files / undefined `classify`, `Kind`, `escapeLike`, `listPattern`.

- [ ] **Step 4: Write `types.go`**

```go
// Package state reads and deletes records from a Dapr state store.
//
// It is the read model behind the dashboard's State page, and is deliberately
// separate from pkg/workflow: that package decodes one known key shape into
// executions, while this one browses the whole keyspace without interpreting
// what it finds.
package state

import (
	"context"
	"errors"
	"time"
)

var (
	// ErrNoStore: no store is configured (or the degraded no-store entry).
	ErrNoStore = errors.New("no state store configured")
	// ErrStoreUnreachable: a known store that could not be opened.
	ErrStoreUnreachable = errors.New("could not connect to state store")
	// ErrNotBrowsable: the store opened but cannot enumerate keys or read
	// record metadata. Dapr's HTTP State API cannot list keys, so there is no
	// fallback for such a store — the page reports it rather than degrading.
	ErrNotBrowsable = errors.New("state store cannot be browsed")
	// ErrNotFound: the requested key does not exist.
	ErrNotFound = errors.New("record not found")
)

// Kind is how a key was produced: app code, the workflow engine, or an actor.
type Kind string

const (
	KindApp      Kind = "app"
	KindWorkflow Kind = "workflow"
	KindActor    Kind = "actor"
)

// Encoding labels how Value/Preview represent the raw bytes.
const (
	EncodingText   = "text"
	EncodingBase64 = "base64"
)

const (
	defaultPageSize = 50
	// previewChars bounds the single-line preview carried in a list item.
	previewChars = 200
	// maxValueBytes bounds a single record's value on the detail read.
	maxValueBytes = 1 << 20 // 1 MiB
	// Guard rails for the loop-fill in List: excluding runtime-internal keys
	// cannot be expressed in a KeysLike pattern (it takes a single positive
	// pattern with no negation), so a page can under-fill and must be refilled
	// — but never by scanning more than this many keys.
	filteredScanPageMultiple = 10
	maxFilteredScanKeys      = 2000
)

// ListQuery is one page request. IncludeInternal false — the default — keeps
// only KindApp records.
type ListQuery struct {
	AppID           string
	Search          string
	PageToken       string
	PageSize        int
	IncludeInternal bool
}

// Item is one row in a listing: metadata plus a bounded preview, never the
// full value. The full value comes from Service.Record so that list pages stay
// small under the dashboard's auto-refresh.
type Item struct {
	Key          string     `json:"key"`
	AppID        string     `json:"appId"`
	LogicalKey   string     `json:"logicalKey"`
	Kind         Kind       `json:"kind"`
	Preview      string     `json:"preview"`
	Encoding     string     `json:"encoding"`
	Size         int        `json:"size"`
	ETag         string     `json:"etag,omitempty"`
	TTLExpiresAt *time.Time `json:"ttlExpiresAt,omitempty"`
	ContentType  string     `json:"contentType,omitempty"`
}

// Record is one record's full value plus metadata.
type Record struct {
	Key          string     `json:"key"`
	AppID        string     `json:"appId"`
	LogicalKey   string     `json:"logicalKey"`
	Kind         Kind       `json:"kind"`
	Value        string     `json:"value"`
	Encoding     string     `json:"encoding"`
	Size         int        `json:"size"`
	Truncated    bool       `json:"truncated"`
	ETag         string     `json:"etag,omitempty"`
	TTLExpiresAt *time.Time `json:"ttlExpiresAt,omitempty"`
	ContentType  string     `json:"contentType,omitempty"`
}

// ListResult is one page. A non-empty NextToken means "keep paging" even when
// Items is short: the token has already advanced past every scanned key.
type ListResult struct {
	Items     []Item `json:"items"`
	NextToken string `json:"nextToken,omitempty"`
}

// DeleteResult reports one key's outcome, so a partial failure names exactly
// which keys survived.
type DeleteResult struct {
	Key   string `json:"key"`
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

// Service is the read + delete surface the API needs.
type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Record(ctx context.Context, key string) (Record, error)
	AppIDs(ctx context.Context) ([]string, error)
	Delete(ctx context.Context, keys []string) []DeleteResult
}
```

- [ ] **Step 5: Write `classify.go`**

```go
package state

import (
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// internalActorPrefix marks the actor types Dapr's runtime creates for
// workflows and activities.
const internalActorPrefix = "dapr.internal."

// keyParts is a classified state key.
type keyParts struct {
	AppID      string
	LogicalKey string
	Kind       Kind
}

// classify splits a Dapr state key into its prefix, its logical remainder, and
// what produced it.
//
// This is a heuristic, not a parse. A Dapr key may itself contain the "||"
// delimiter, in which case an app record with two delimiters in its name is
// classified as actor state and hides behind the UI's "Show internal keys"
// toggle. The alternative — a maintained allowlist of Dapr-internal actor
// types — would rot against Dapr releases, so the misclassification is
// accepted and documented.
//
// Note also that the leading segment is only an app-id under the default
// keyPrefix. A component may set keyPrefix to none, name, or a literal, so
// treat AppID as an opaque prefix that is usually an app-id.
func classify(key string) keyParts {
	segs := strings.Split(key, statestore.KeyDelimiter)
	switch {
	case len(segs) < 2:
		return keyParts{LogicalKey: key, Kind: KindApp}
	case len(segs) == 2:
		return keyParts{AppID: segs[0], LogicalKey: segs[1], Kind: KindApp}
	default:
		kind := KindActor
		if strings.HasPrefix(segs[1], internalActorPrefix) {
			kind = KindWorkflow
		}
		return keyParts{
			AppID:      segs[0],
			LogicalKey: strings.Join(segs[1:], statestore.KeyDelimiter),
			Kind:       kind,
		}
	}
}
```

- [ ] **Step 6: Write `pattern.go`**

```go
package state

import (
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// escapeLike escapes the SQL-LIKE metacharacters so user-supplied text matches
// literally. All four supported backends translate the LIKE pattern to their
// native matcher (redis glob, mongo regex, native LIKE for the SQL pair) and
// all four honor backslash escapes for %, _ and \.
//
// Without this, searching for "order_42" silently also matches "order-42", and
// an app named "my_app" matches "myXapp".
func escapeLike(s string) string {
	var b strings.Builder
	b.Grow(len(s) + 8)
	for _, r := range s {
		if r == '\\' || r == '%' || r == '_' {
			b.WriteRune('\\')
		}
		b.WriteRune(r)
	}
	return b.String()
}

// listPattern builds the KeysLike pattern for a query, pushing both the app
// filter and the key search into the backend. Because every interpolated
// fragment is escaped, the result is always a valid pattern — there is no user
// input that can make the backend's pattern parser fail.
//
// KeysLike rejects an empty pattern, so the unfiltered case is "%".
func listPattern(appID, search string) string {
	prefix := "%"
	if appID != "" {
		prefix = escapeLike(appID) + statestore.KeyDelimiter + "%"
	}
	if search == "" {
		return prefix
	}
	return prefix + escapeLike(search) + "%"
}
```

- [ ] **Step 7: Run the tests to verify they pass**

```bash
cd $WT && gofmt -w pkg/state/ && go test -tags unit ./pkg/state/ -v
```
Expected: PASS, all sub-tests of `TestClassify`, `TestEscapeLike`, `TestListPattern`.

- [ ] **Step 8: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/state/
git commit -m "$(cat <<'EOF'
feat(state): add key classification and LIKE pattern building

classify splits a Dapr state key into prefix, logical key and origin
(app / workflow / actor). Documented as a heuristic: a key containing
the || delimiter in its own name is misclassified as actor state.

listPattern pushes the app filter and key search into KeysLike, with
both fragments backslash-escaped so a literal _ or % in user input does
not become a wildcard.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Value rendering and preview

Turns raw bytes into something JSON-safe and table-sized. Pure functions, no fakes.

**Files:**
- Create: `pkg/state/value.go`, `pkg/state/value_test.go`

**Interfaces:**
- Consumes: constants from Task 2 (`previewChars`, `maxValueBytes`, `EncodingText`, `EncodingBase64`)
- Produces:
  - `renderValue(b []byte) (rendered string, encoding string)`
  - `preview(s string) string`
  - `truncateValue(s string) (string, bool)`

- [ ] **Step 1: Write the failing test**

Create `pkg/state/value_test.go`:

```go
//go:build unit

package state

import (
	"encoding/base64"
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/stretchr/testify/require"
)

func TestRenderValue(t *testing.T) {
	t.Run("valid utf-8 is returned as text", func(t *testing.T) {
		got, enc := renderValue([]byte(`{"id":1,"name":"café"}`))
		require.Equal(t, `{"id":1,"name":"café"}`, got)
		require.Equal(t, EncodingText, enc)
	})
	t.Run("invalid utf-8 is base64 so it cannot corrupt the JSON response", func(t *testing.T) {
		raw := []byte{0x00, 0xff, 0xfe, 0x01}
		got, enc := renderValue(raw)
		require.Equal(t, base64.StdEncoding.EncodeToString(raw), got)
		require.Equal(t, EncodingBase64, enc)
	})
	t.Run("empty value is text", func(t *testing.T) {
		got, enc := renderValue([]byte{})
		require.Equal(t, "", got)
		require.Equal(t, EncodingText, enc)
	})
}

func TestPreview(t *testing.T) {
	t.Run("short values pass through", func(t *testing.T) {
		require.Equal(t, `{"id":1}`, preview(`{"id":1}`))
	})
	t.Run("whitespace runs collapse so a multi-line blob stays on one row", func(t *testing.T) {
		require.Equal(t, `{ "id": 1 }`, preview("{\n  \"id\": 1\n}"))
	})
	t.Run("long values are truncated with an ellipsis", func(t *testing.T) {
		got := preview(strings.Repeat("a", previewChars+50))
		require.Equal(t, previewChars+1, utf8.RuneCountInString(got))
		require.True(t, strings.HasSuffix(got, "…"))
	})
	t.Run("truncation counts runes, not bytes, so multibyte text is not split", func(t *testing.T) {
		got := preview(strings.Repeat("é", previewChars+10))
		require.True(t, utf8.ValidString(got))
		require.Equal(t, previewChars+1, utf8.RuneCountInString(got))
	})
}

func TestTruncateValue(t *testing.T) {
	t.Run("under the cap is untouched", func(t *testing.T) {
		got, cut := truncateValue("small")
		require.Equal(t, "small", got)
		require.False(t, cut)
	})
	t.Run("over the cap is cut and flagged", func(t *testing.T) {
		got, cut := truncateValue(strings.Repeat("a", maxValueBytes+10))
		require.True(t, cut)
		require.Len(t, got, maxValueBytes)
	})
	t.Run("cut never splits a multibyte rune", func(t *testing.T) {
		// "é" is two bytes, so a byte-boundary cut at an odd cap would split it.
		got, cut := truncateValue(strings.Repeat("é", maxValueBytes))
		require.True(t, cut)
		require.True(t, utf8.ValidString(got), "truncated value must stay valid UTF-8")
		require.LessOrEqual(t, len(got), maxValueBytes)
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT && go test -tags unit ./pkg/state/ -run 'TestRenderValue|TestPreview|TestTruncateValue' -v
```
Expected: FAIL — `undefined: renderValue`, `undefined: preview`, `undefined: truncateValue`.

- [ ] **Step 3: Write the implementation**

Create `pkg/state/value.go`:

```go
package state

import (
	"encoding/base64"
	"strings"
	"unicode/utf8"
)

// renderValue turns raw bytes into a JSON-safe string. Valid UTF-8 passes
// through as text; anything else (a protobuf blob, a gzip payload) is base64
// encoded so it cannot corrupt the response.
func renderValue(b []byte) (string, string) {
	if utf8.Valid(b) {
		return string(b), EncodingText
	}
	return base64.StdEncoding.EncodeToString(b), EncodingBase64
}

// preview reduces a rendered value to one short table-row line: whitespace runs
// collapse to single spaces, then the result is cut to previewChars runes with
// a trailing ellipsis. Counting runes rather than bytes keeps multibyte text
// intact.
func preview(s string) string {
	s = strings.Join(strings.Fields(s), " ")
	if utf8.RuneCountInString(s) <= previewChars {
		return s
	}
	r := []rune(s)
	return string(r[:previewChars]) + "…"
}

// truncateValue caps a rendered value at maxValueBytes, backing off to the
// previous rune boundary so the result stays valid UTF-8. The bool reports
// whether anything was cut.
func truncateValue(s string) (string, bool) {
	if len(s) <= maxValueBytes {
		return s, false
	}
	s = s[:maxValueBytes]
	for len(s) > 0 && !utf8.ValidString(s) {
		s = s[:len(s)-1]
	}
	return s, true
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd $WT && gofmt -w pkg/state/ && go test -tags unit ./pkg/state/ -v
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/state/value.go pkg/state/value_test.go
git commit -m "$(cat <<'EOF'
feat(state): render values as text or base64 with bounded previews

Valid UTF-8 passes through; anything else is base64 so a binary value
cannot corrupt the JSON response. Previews collapse whitespace and cut
at 200 runes; detail values cut at 1 MiB, both on rune boundaries.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Service skeleton, degradation, and `AppIDs`

Establishes the service type and its two degraded forms before any real read path, then implements the simplest one.

**Files:**
- Create: `pkg/state/service.go`, `pkg/state/service_test.go`

**Interfaces:**
- Consumes: `statestore.Store`, `statestore.RecordReader`, `classify` (Task 2)
- Produces:
  - `New(store statestore.Store, rr statestore.RecordReader) Service`
  - `NewUnreachable(name, conn string) Service`
  - unexported `service` struct with `ready() error`
  - test fake `fakeStore` implementing both `statestore.Store` and `statestore.RecordReader`

- [ ] **Step 1: Write the failing test (fake + degradation + AppIDs)**

Create `pkg/state/service_test.go`:

```go
//go:build unit

package state

import (
	"context"
	"errors"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

// fakeStore is an in-memory statestore.Store + RecordReader for unit tests.
// It translates the LIKE pattern to a regexp the same way the real backends
// translate it to their native matcher, including backslash escapes, so
// pattern-construction bugs surface here.
type fakeStore struct {
	kv map[string][]byte
	// etags is optional per-key etag data.
	etags map[string]string
	// recordCalls counts Records invocations, to assert one bulk read per List.
	recordCalls int
	// keyCalls counts Keys invocations, to assert loop-fill behavior.
	keyCalls int
	// pages, when non-nil, makes Keys return cursor pages of this size.
	pageLimit int
	// patterns records every pattern Keys was called with.
	patterns []string
	// deleteErr, when set for a key, makes Delete fail for it.
	deleteErr map[string]error
}

func newFakeStore() *fakeStore {
	return &fakeStore{kv: map[string][]byte{}, etags: map[string]string{}, deleteErr: map[string]error{}}
}

func (f *fakeStore) set(key, value string) { f.kv[key] = []byte(value) }

// likeToRegexp mirrors the backends' LIKE translation: % is any run, _ is any
// single character, and a backslash escapes the next character.
func likeToRegexp(pattern string) *regexp.Regexp {
	var b strings.Builder
	b.WriteString("^")
	escaped := false
	for _, r := range pattern {
		switch {
		case escaped:
			b.WriteString(regexp.QuoteMeta(string(r)))
			escaped = false
		case r == '\\':
			escaped = true
		case r == '%':
			b.WriteString("(?s).*")
		case r == '_':
			b.WriteString("(?s).")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return regexp.MustCompile(b.String())
}

func (f *fakeStore) Keys(_ context.Context, pattern, token string, pageSize int) ([]string, string, error) {
	f.keyCalls++
	f.patterns = append(f.patterns, pattern)
	re := likeToRegexp(pattern)
	var all []string
	for k := range f.kv {
		if re.MatchString(k) {
			all = append(all, k)
		}
	}
	sort.Strings(all)
	// Cursor paging: the token is the last key of the previous page.
	if token != "" {
		i := sort.SearchStrings(all, token)
		if i < len(all) && all[i] == token {
			i++
		}
		all = all[i:]
	}
	limit := f.pageLimit
	if limit <= 0 {
		limit = pageSize
	}
	if limit > 0 && len(all) > limit {
		return all[:limit], all[limit-1], nil
	}
	return all, "", nil
}

func (f *fakeStore) Get(_ context.Context, key string) ([]byte, error) { return f.kv[key], nil }

func (f *fakeStore) BulkGet(_ context.Context, keys []string) (map[string][]byte, error) {
	out := map[string][]byte{}
	for _, k := range keys {
		out[k] = f.kv[k]
	}
	return out, nil
}

func (f *fakeStore) Records(_ context.Context, keys []string) ([]statestore.Record, error) {
	f.recordCalls++
	out := make([]statestore.Record, 0, len(keys))
	for _, k := range keys {
		v, ok := f.kv[k]
		if !ok {
			continue // missing keys are omitted, like the real backends
		}
		out = append(out, statestore.Record{Key: k, Value: v, ETag: f.etags[k]})
	}
	return out, nil
}

func (f *fakeStore) Delete(_ context.Context, key string) error {
	if err, ok := f.deleteErr[key]; ok {
		return err
	}
	delete(f.kv, key)
	return nil
}

func (f *fakeStore) Set(_ context.Context, k string, v []byte) error { f.kv[k] = v; return nil }
func (f *fakeStore) Close() error                                    { return nil }

func TestServiceDegradation(t *testing.T) {
	ctx := context.Background()

	t.Run("nil store reports ErrNoStore from every method", func(t *testing.T) {
		svc := New(nil, nil)
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrNoStore)
		_, err = svc.Record(ctx, "k")
		require.ErrorIs(t, err, ErrNoStore)
		_, err = svc.AppIDs(ctx)
		require.ErrorIs(t, err, ErrNoStore)
		res := svc.Delete(ctx, []string{"k"})
		require.Len(t, res, 1)
		require.False(t, res[0].OK)
		require.Contains(t, res[0].Error, "no state store")
	})

	t.Run("store without a RecordReader reports ErrNotBrowsable", func(t *testing.T) {
		svc := New(newFakeStore(), nil)
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrNotBrowsable)
	})

	t.Run("unreachable service names the store and its connection", func(t *testing.T) {
		svc := NewUnreachable("mystore", "localhost:6379")
		_, err := svc.List(ctx, ListQuery{})
		require.ErrorIs(t, err, ErrStoreUnreachable)
		require.Contains(t, err.Error(), "mystore")
		require.Contains(t, err.Error(), "localhost:6379")

		res := svc.Delete(ctx, []string{"a", "b"})
		require.Len(t, res, 2)
		require.False(t, res[0].OK)
	})
}

func TestAppIDs(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("zeta||order-1", "v")
	f.set("alpha||order-2", "v")
	f.set("alpha||order-3", "v")
	f.set("alpha||dapr.internal.default.alpha.workflow||i1||metadata", "v")
	f.set("bare-key-no-prefix", "v")
	svc := New(f, f)

	ids, err := svc.AppIDs(ctx)
	require.NoError(t, err)
	require.Equal(t, []string{"alpha", "zeta"}, ids, "sorted, deduped, unprefixed keys excluded")

	t.Run("is filter-independent: internal keys contribute their prefix too", func(t *testing.T) {
		only := newFakeStore()
		only.set("gamma||dapr.internal.default.gamma.workflow||i1||metadata", "v")
		ids, err := New(only, only).AppIDs(ctx)
		require.NoError(t, err)
		require.Equal(t, []string{"gamma"}, ids)
	})

	t.Run("a store of only unprefixed keys yields an empty list", func(t *testing.T) {
		bare := newFakeStore()
		bare.set("k1", "v")
		ids, err := New(bare, bare).AppIDs(ctx)
		require.NoError(t, err)
		require.Empty(t, ids)
	})
}

func TestAppIDsPropagatesStoreErrors(t *testing.T) {
	f := &erroringStore{}
	_, err := New(f, f).AppIDs(context.Background())
	require.Error(t, err)
	require.Contains(t, err.Error(), "boom")
}

// erroringStore fails every Keys call.
type erroringStore struct{ fakeStore }

func (e *erroringStore) Keys(context.Context, string, string, int) ([]string, string, error) {
	return nil, "", errors.New("boom")
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT && go test -tags unit ./pkg/state/ -run 'TestServiceDegradation|TestAppIDs' -v
```
Expected: FAIL — `undefined: New`, `undefined: NewUnreachable`.

- [ ] **Step 3: Write `service.go` (skeleton, degradation, AppIDs)**

```go
package state

import (
	"context"
	"fmt"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// service is the store-backed Service.
type service struct {
	store  statestore.Store
	reader statestore.RecordReader
}

// New builds a Service over an opened store. A nil store yields ErrNoStore
// from every method — cmd builds a degraded entry that way. A non-nil store
// whose backend does not implement RecordReader yields ErrNotBrowsable.
func New(store statestore.Store, rr statestore.RecordReader) Service {
	return &service{store: store, reader: rr}
}

// ready reports why the service cannot serve, or nil.
func (s *service) ready() error {
	if s.store == nil {
		return ErrNoStore
	}
	if s.reader == nil {
		return ErrNotBrowsable
	}
	return nil
}

// AppIDs returns the sorted distinct key prefixes in the store.
//
// It reads keys only — no values — and is deliberately filter-independent:
// it ignores Search, AppID and IncludeInternal, so selecting an app never
// collapses the dropdown to that one app, and toggling internal keys never
// changes the available prefixes (app and workflow keys share a prefix).
// Unprefixed keys contribute nothing; those records are still listed and
// reachable under "All apps".
func (s *service) AppIDs(ctx context.Context) ([]string, error) {
	if err := s.ready(); err != nil {
		return nil, err
	}
	keys, _, err := s.store.Keys(ctx, "%", "", 0)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]struct{}, len(keys))
	var ids []string
	for _, k := range keys {
		p := classify(k)
		if p.AppID == "" {
			continue
		}
		if _, dup := seen[p.AppID]; dup {
			continue
		}
		seen[p.AppID] = struct{}{}
		ids = append(ids, p.AppID)
	}
	sort.Strings(ids)
	return ids, nil
}

// Delete removes each key, reporting per-key outcomes so a partial failure
// names exactly which keys survived. There is no second mechanism: unlike a
// workflow instance, a state record has no lifecycle to terminate.
func (s *service) Delete(ctx context.Context, keys []string) []DeleteResult {
	out := make([]DeleteResult, 0, len(keys))
	if err := s.ready(); err != nil {
		for _, k := range keys {
			out = append(out, DeleteResult{Key: k, Error: err.Error()})
		}
		return out
	}
	for _, k := range keys {
		res := DeleteResult{Key: k}
		if err := s.store.Delete(ctx, k); err != nil {
			res.Error = err.Error()
		} else {
			res.OK = true
		}
		out = append(out, res)
	}
	return out
}

// unreachable is the Service for a known store whose backend could not be
// opened. Every method fails with a store-specific ErrStoreUnreachable so the
// API can surface an accurate "could not connect…" message. There is no
// sidecar fallback: Dapr's HTTP State API cannot enumerate keys.
type unreachable struct{ name, conn string }

// NewUnreachable builds a Service that always reports ErrStoreUnreachable.
func NewUnreachable(name, conn string) Service { return unreachable{name: name, conn: conn} }

func (u unreachable) err() error {
	return fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, u.name, u.conn)
}

func (u unreachable) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{}, u.err()
}
func (u unreachable) Record(context.Context, string) (Record, error) { return Record{}, u.err() }
func (u unreachable) AppIDs(context.Context) ([]string, error)       { return nil, u.err() }
func (u unreachable) Delete(_ context.Context, keys []string) []DeleteResult {
	out := make([]DeleteResult, 0, len(keys))
	for _, k := range keys {
		out = append(out, DeleteResult{Key: k, Error: u.err().Error()})
	}
	return out
}
```

- [ ] **Step 4: Add temporary `List`/`Record` stubs so the package compiles**

Append to `service.go` (Task 5 replaces both bodies):

```go
func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if err := s.ready(); err != nil {
		return ListResult{}, err
	}
	return ListResult{}, nil
}

func (s *service) Record(ctx context.Context, key string) (Record, error) {
	if err := s.ready(); err != nil {
		return Record{}, err
	}
	return Record{}, ErrNotFound
}
```

- [ ] **Step 5: Run the tests to verify they pass**

```bash
cd $WT && gofmt -w pkg/state/ && go test -tags unit ./pkg/state/ -v
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/state/service.go pkg/state/service_test.go
git commit -m "$(cat <<'EOF'
feat(state): add service skeleton, degradation and AppIDs

New(nil, nil) reports ErrNoStore and a store without a RecordReader
reports ErrNotBrowsable, so cmd's degraded entry has no nil-pointer
path. NewUnreachable mirrors workflow.NewUnreachableService.

AppIDs scans keys only and is filter-independent, so selecting an app
never collapses the dropdown to that one app.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: `List` and `Record`

The core read path. The ordering here is what keeps the page cheap: classify on keys alone, loop-fill, then **one** bulk value read for the surviving page.

**Files:**
- Modify: `pkg/state/service.go` (replace the Task 4 stubs)
- Create: `pkg/state/list_test.go`

**Interfaces:**
- Consumes: `classify`, `listPattern` (Task 2), `renderValue`, `preview`, `truncateValue` (Task 3), `fakeStore` (Task 4)
- Produces: working `service.List` and `service.Record`; unexported `newItem(keyParts, statestore.Record) Item`

- [ ] **Step 1: Write the failing test**

Create `pkg/state/list_test.go`:

```go
//go:build unit

package state

import (
	"context"
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func seedApp(f *fakeStore, app string, n int) {
	for i := 0; i < n; i++ {
		f.set(fmt.Sprintf("%s||order-%03d", app, i), fmt.Sprintf(`{"id":%d}`, i))
	}
}

func TestListDefaultsToAppRecordsOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", `{"id":1}`)
	f.set("myapp||dapr.internal.default.myapp.workflow||i1||metadata", "wf")
	f.set("myapp||MyActor||a1||balance", "42")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "myapp||order-1", res.Items[0].Key)
	require.Equal(t, "order-1", res.Items[0].LogicalKey)
	require.Equal(t, "myapp", res.Items[0].AppID)
	require.Equal(t, KindApp, res.Items[0].Kind)
	require.Equal(t, `{"id":1}`, res.Items[0].Preview)
	require.Equal(t, EncodingText, res.Items[0].Encoding)
	require.Equal(t, len(`{"id":1}`), res.Items[0].Size)

	t.Run("IncludeInternal reveals workflow and actor keys", func(t *testing.T) {
		res, err := svc.List(ctx, ListQuery{IncludeInternal: true})
		require.NoError(t, err)
		require.Len(t, res.Items, 3)
	})
}

func TestListPushesFiltersIntoThePattern(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", "a")
	f.set("other||order-2", "b")
	f.set("myapp||invoice-9", "c")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{AppID: "myapp"})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Equal(t, "myapp||%", f.patterns[0])

	f.patterns = nil
	res, err = svc.List(ctx, ListQuery{AppID: "myapp", Search: "order"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "myapp||%order%", f.patterns[0])
}

func TestListSearchMetacharactersMatchLiterally(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order_42", "underscore")
	f.set("myapp||order-42", "hyphen")
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{Search: "order_42"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1, "the underscore must not act as a single-character wildcard")
	require.Equal(t, "myapp||order_42", res.Items[0].Key)
}

func TestListReadsValuesOnceForTheReturnedPageOnly(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	seedApp(f, "myapp", 5)
	// A pile of workflow keys that must cost only key bytes to skip.
	for i := 0; i < 40; i++ {
		f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%02d||metadata", i), "wf")
	}
	svc := New(f, f)

	res, err := svc.List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 5)
	require.Equal(t, 1, f.recordCalls, "exactly one bulk value read per List")
}

func TestListPaging(t *testing.T) {
	ctx := context.Background()

	t.Run("unfiltered returns one key page per call and a forward token", func(t *testing.T) {
		f := newFakeStore()
		seedApp(f, "myapp", 7)
		svc := New(f, f)

		first, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true})
		require.NoError(t, err)
		require.Len(t, first.Items, 3)
		require.NotEmpty(t, first.NextToken)

		second, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true, PageToken: first.NextToken})
		require.NoError(t, err)
		require.Len(t, second.Items, 3)
		require.NotEqual(t, first.Items[0].Key, second.Items[0].Key)

		third, err := svc.List(ctx, ListQuery{PageSize: 3, IncludeInternal: true, PageToken: second.NextToken})
		require.NoError(t, err)
		require.Len(t, third.Items, 1)
		require.Empty(t, third.NextToken)
	})

	t.Run("loop-fills a page thinned by the internal-key filter", func(t *testing.T) {
		f := newFakeStore()
		// 10 app keys and 40 internal ones. Keys sort with the app keys first
		// ("a-order-" < "dapr.internal."), so with a 5-key page limit the first
		// two pages are needed to reach a 10-item page — the loop-fill path.
		for i := 0; i < 10; i++ {
			f.set(fmt.Sprintf("myapp||a-order-%02d", i), "v")
			for j := 0; j < 4; j++ {
				f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%02d-%d||metadata", i, j), "wf")
			}
		}
		f.pageLimit = 5 // each Keys call returns 5 keys regardless of pageSize
		svc := New(f, f)

		res, err := svc.List(ctx, ListQuery{PageSize: 10})
		require.NoError(t, err)
		require.GreaterOrEqual(t, len(res.Items), 10, "loop-fill must reach the page size")
		require.Greater(t, f.keyCalls, 1, "one key page cannot fill a filtered page")
		require.Equal(t, 1, f.recordCalls, "still exactly one bulk value read")
	})

	t.Run("stops at the scan cap and returns a resume token", func(t *testing.T) {
		f := newFakeStore()
		// 3000 internal keys and no app keys: the filter can never fill a page.
		for i := 0; i < 3000; i++ {
			f.set(fmt.Sprintf("myapp||dapr.internal.default.myapp.workflow||i%04d||metadata", i), "wf")
		}
		f.pageLimit = 100
		svc := New(f, f)

		res, err := svc.List(ctx, ListQuery{PageSize: 50})
		require.NoError(t, err)
		require.Empty(t, res.Items)
		require.NotEmpty(t, res.NextToken, "a capped page must still be resumable")
		require.LessOrEqual(t, f.keyCalls, maxFilteredScanKeys/100+1, "the scan must be bounded")
	})
}

func TestListSortsByKeyForStablePaging(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||c", "3")
	f.set("myapp||a", "1")
	f.set("myapp||b", "2")
	res, err := New(f, f).List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Equal(t,
		[]string{"myapp||a", "myapp||b", "myapp||c"},
		[]string{res.Items[0].Key, res.Items[1].Key, res.Items[2].Key})
}

func TestListSurfacesEtagAsVersion(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	f.set("myapp||order-1", "v")
	f.etags["myapp||order-1"] = "7"
	res, err := New(f, f).List(ctx, ListQuery{})
	require.NoError(t, err)
	require.Equal(t, "7", res.Items[0].ETag)
}

func TestRecordReturnsFullValue(t *testing.T) {
	ctx := context.Background()
	f := newFakeStore()
	big := strings.Repeat("x", 5000)
	f.set("myapp||order-1", big)
	f.etags["myapp||order-1"] = "3"
	svc := New(f, f)

	rec, err := svc.Record(ctx, "myapp||order-1")
	require.NoError(t, err)
	require.Equal(t, big, rec.Value, "the detail read is not preview-truncated")
	require.False(t, rec.Truncated)
	require.Equal(t, 5000, rec.Size)
	require.Equal(t, "3", rec.ETag)
	require.Equal(t, "order-1", rec.LogicalKey)
	require.Equal(t, KindApp, rec.Kind)

	t.Run("missing key reports ErrNotFound", func(t *testing.T) {
		_, err := svc.Record(ctx, "myapp||nope")
		require.ErrorIs(t, err, ErrNotFound)
	})

	t.Run("over-cap value is truncated and flagged", func(t *testing.T) {
		f.set("myapp||huge", strings.Repeat("y", maxValueBytes+100))
		rec, err := svc.Record(ctx, "myapp||huge")
		require.NoError(t, err)
		require.True(t, rec.Truncated)
		require.Len(t, rec.Value, maxValueBytes)
		require.Equal(t, maxValueBytes+100, rec.Size, "Size reports the true length")
	})

	t.Run("internal keys are readable by key even though the list hides them", func(t *testing.T) {
		f.set("myapp||dapr.internal.default.myapp.workflow||i1||metadata", "wf")
		rec, err := svc.Record(ctx, "myapp||dapr.internal.default.myapp.workflow||i1||metadata")
		require.NoError(t, err)
		require.Equal(t, KindWorkflow, rec.Kind)
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT && go test -tags unit ./pkg/state/ -run 'TestList|TestRecord' -v
```
Expected: FAIL — the stubs return empty results, so the assertions on `res.Items` fail.

- [ ] **Step 3: Replace the stubs with the real implementation**

In `pkg/state/service.go`, replace the two stub bodies from Task 4:

```go
// List returns one page of records.
//
// The ordering matters. Keys are paged and classified first, so a store that
// is 99% workflow history costs only key bytes to skip; the single bulk value
// read happens last, for the rows actually returned. (Contrast workflow.List,
// which must load each instance in order to filter it.)
//
// Loop-fill is needed even though the app filter and key search are pushed
// into the pattern, because excluding runtime-internal keys cannot be: KeysLike
// takes a single positive pattern with no negation. As in workflow.List,
// NextToken always points past the last fully-scanned key page, so a page
// capped by the scan guard may hold fewer than PageSize items — possibly zero —
// alongside a non-empty token; clients must treat that as "keep paging".
// Accumulated matches are never truncated: NextToken has already advanced past
// them, so dropping them would remove them from pagination entirely.
func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if err := s.ready(); err != nil {
		return ListResult{}, err
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}
	pattern := listPattern(q.AppID, q.Search)

	maxScan := pageSize * filteredScanPageMultiple
	if maxScan > maxFilteredScanKeys {
		maxScan = maxFilteredScanKeys
	}

	var matched []string
	parts := make(map[string]keyParts, pageSize)
	token := q.PageToken
	next := ""
	scanned := 0
	for {
		keys, n, err := s.store.Keys(ctx, pattern, token, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		next = n
		scanned += len(keys)
		for _, k := range keys {
			p := classify(k)
			if !q.IncludeInternal && p.Kind != KindApp {
				continue
			}
			if _, dup := parts[k]; dup {
				continue
			}
			parts[k] = p
			matched = append(matched, k)
		}
		// Unfiltered: preserve one-key-page-per-call semantics. Filtered: stop
		// once the page is full, the keys ran out, or the scan cap is reached.
		if q.IncludeInternal || len(matched) >= pageSize || next == "" || scanned >= maxScan {
			break
		}
		token = next
	}

	recs, err := s.reader.Records(ctx, matched)
	if err != nil {
		return ListResult{}, err
	}
	byKey := make(map[string]statestore.Record, len(recs))
	for _, r := range recs {
		byKey[r.Key] = r
	}

	items := make([]Item, 0, len(matched))
	for _, k := range matched {
		r, ok := byKey[k]
		if !ok {
			continue // deleted between the key scan and the value read
		}
		items = append(items, newItem(parts[k], r))
	}
	// Keys ordering is not guaranteed across backends; sort so page boundaries
	// and the rendered order are stable.
	sort.Slice(items, func(a, b int) bool { return items[a].Key < items[b].Key })
	return ListResult{Items: items, NextToken: next}, nil
}

// newItem builds a list row from a classified key and its record.
func newItem(p keyParts, r statestore.Record) Item {
	rendered, enc := renderValue(r.Value)
	return Item{
		Key:          r.Key,
		AppID:        p.AppID,
		LogicalKey:   p.LogicalKey,
		Kind:         p.Kind,
		Preview:      preview(rendered),
		Encoding:     enc,
		Size:         len(r.Value),
		ETag:         r.ETag,
		TTLExpiresAt: r.TTLExpire,
		ContentType:  r.ContentType,
	}
}

// Record returns one record's full value, capped at maxValueBytes. It reads by
// exact key, so a runtime-internal key the list filter hides is still readable.
func (s *service) Record(ctx context.Context, key string) (Record, error) {
	if err := s.ready(); err != nil {
		return Record{}, err
	}
	recs, err := s.reader.Records(ctx, []string{key})
	if err != nil {
		return Record{}, err
	}
	if len(recs) == 0 {
		return Record{}, ErrNotFound
	}
	r := recs[0]
	p := classify(r.Key)
	rendered, enc := renderValue(r.Value)
	value, cut := truncateValue(rendered)
	return Record{
		Key:          r.Key,
		AppID:        p.AppID,
		LogicalKey:   p.LogicalKey,
		Kind:         p.Kind,
		Value:        value,
		Encoding:     enc,
		Size:         len(r.Value),
		Truncated:    cut,
		ETag:         r.ETag,
		TTLExpiresAt: r.TTLExpire,
		ContentType:  r.ContentType,
	}, nil
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd $WT && gofmt -w pkg/state/ && go test -tags unit ./pkg/state/ -v
```
Expected: PASS, all of `TestList*` and `TestRecord*`.

- [ ] **Step 5: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/state/service.go pkg/state/list_test.go
git commit -m "$(cat <<'EOF'
feat(state): implement List and Record

List pages keys, classifies them on key text alone, loop-fills a page
thinned by the internal-key filter, then does exactly one bulk value
read for the rows returned. Values for the detail view come from Record
so list pages stay small under auto-refresh.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: `/api/state` router

**Files:**
- Create: `pkg/server/state.go`, `pkg/server/state_test.go`

**Interfaces:**
- Consumes: `pkg/state` (Tasks 2–5), `writeJSON` and `maxListPageSize` (existing, same package)
- Produces:
  - `server.StateBackend` interface: `StateFor(store string) (state.Service, bool)`
  - `stateRouter(backend StateBackend) http.Handler`
  - `parseStateQuery(*http.Request) state.ListQuery`

- [ ] **Step 1: Write the failing test**

Create `pkg/server/state_test.go`:

```go
//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/state"
	"github.com/stretchr/testify/require"
)

// stubStateService records the last query and returns canned results.
type stubStateService struct {
	lastQuery   state.ListQuery
	lastKey     string
	lastDeletes []string
	list        state.ListResult
	listErr     error
	record      state.Record
	recordErr   error
	appIDs      []string
	appIDsErr   error
	deletes     []state.DeleteResult
}

func (s *stubStateService) List(_ context.Context, q state.ListQuery) (state.ListResult, error) {
	s.lastQuery = q
	return s.list, s.listErr
}
func (s *stubStateService) Record(_ context.Context, key string) (state.Record, error) {
	s.lastKey = key
	return s.record, s.recordErr
}
func (s *stubStateService) AppIDs(context.Context) ([]string, error) {
	return s.appIDs, s.appIDsErr
}
func (s *stubStateService) Delete(_ context.Context, keys []string) []state.DeleteResult {
	s.lastDeletes = keys
	return s.deletes
}

// stubStateBackend serves one service, or reports the store unknown.
type stubStateBackend struct {
	svc     state.Service
	unknown bool
}

func (b stubStateBackend) StateFor(string) (state.Service, bool) {
	if b.unknown {
		return nil, false
	}
	return b.svc, true
}

func doState(t *testing.T, backend StateBackend, method, target string, body string) *httptest.ResponseRecorder {
	t.Helper()
	var r *http.Request
	if body == "" {
		r = httptest.NewRequest(method, target, nil)
	} else {
		r = httptest.NewRequest(method, target, strings.NewReader(body))
	}
	w := httptest.NewRecorder()
	stateRouter(backend).ServeHTTP(w, r)
	return w
}

func TestStateListQueryParsing(t *testing.T) {
	svc := &stubStateService{}
	b := stubStateBackend{svc: svc}

	doState(t, b, http.MethodGet, "/?appId=myapp&search=order&page=tok&limit=25&includeInternal=true", "")
	require.Equal(t, "myapp", svc.lastQuery.AppID)
	require.Equal(t, "order", svc.lastQuery.Search)
	require.Equal(t, "tok", svc.lastQuery.PageToken)
	require.Equal(t, 25, svc.lastQuery.PageSize)
	require.True(t, svc.lastQuery.IncludeInternal)

	t.Run("internal keys are excluded by default", func(t *testing.T) {
		doState(t, b, http.MethodGet, "/", "")
		require.False(t, svc.lastQuery.IncludeInternal)
	})
	t.Run("limit is capped", func(t *testing.T) {
		doState(t, b, http.MethodGet, "/?limit=100000", "")
		require.Equal(t, maxListPageSize, svc.lastQuery.PageSize)
	})
	t.Run("non-positive and unparseable limits fall back to the service default", func(t *testing.T) {
		for _, l := range []string{"0", "-5", "abc"} {
			doState(t, b, http.MethodGet, "/?limit="+l, "")
			require.Equal(t, 0, svc.lastQuery.PageSize, "limit=%s", l)
		}
	})
}

func TestStateListResponse(t *testing.T) {
	svc := &stubStateService{list: state.ListResult{
		Items:     []state.Item{{Key: "myapp||order-1", LogicalKey: "order-1", Kind: state.KindApp, Preview: "v", Size: 1}},
		NextToken: "next",
	}}
	w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/", "")
	require.Equal(t, http.StatusOK, w.Code)
	var got state.ListResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Len(t, got.Items, 1)
	require.Equal(t, "myapp||order-1", got.Items[0].Key)
	require.Equal(t, "next", got.NextToken)
}

func TestStateUnknownStoreIs404(t *testing.T) {
	for _, target := range []string{"/", "/record?key=k", "/appids"} {
		w := doState(t, stubStateBackend{unknown: true}, http.MethodGet, target, "")
		require.Equal(t, http.StatusNotFound, w.Code, target)
		require.Contains(t, w.Body.String(), "unknown state store")
	}
	w := doState(t, stubStateBackend{unknown: true}, http.MethodPost, "/delete", `{"keys":["k"]}`)
	require.Equal(t, http.StatusNotFound, w.Code)
}

func TestStateErrorMapping(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		status int
		body   string
	}{
		{"no store", state.ErrNoStore, http.StatusServiceUnavailable, "no state store detected"},
		{"unreachable", state.ErrStoreUnreachable, http.StatusServiceUnavailable, "could not connect"},
		{"not browsable", state.ErrNotBrowsable, http.StatusServiceUnavailable, "cannot be browsed"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			svc := &stubStateService{listErr: tc.err}
			w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/", "")
			require.Equal(t, tc.status, w.Code)
			require.Contains(t, w.Body.String(), tc.body)
		})
	}
}

func TestStateRecordEndpoint(t *testing.T) {
	svc := &stubStateService{record: state.Record{Key: "myapp||order-1", Value: "{}", Size: 2}}
	b := stubStateBackend{svc: svc}

	// A key with the || delimiter and non-ASCII text must round-trip.
	key := "myapp||órder||42"
	w := doState(t, b, http.MethodGet, "/record?key="+url.QueryEscape(key), "")
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, key, svc.lastKey)

	t.Run("missing key parameter is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodGet, "/record", "")
		require.Equal(t, http.StatusBadRequest, w.Code)
		require.Contains(t, w.Body.String(), "key is required")
	})

	t.Run("not found is a 404", func(t *testing.T) {
		nf := &stubStateService{recordErr: state.ErrNotFound}
		w := doState(t, stubStateBackend{svc: nf}, http.MethodGet, "/record?key=k", "")
		require.Equal(t, http.StatusNotFound, w.Code)
		require.Contains(t, w.Body.String(), "record not found")
	})
}

func TestStateAppIDsNeverReturnsNullJSON(t *testing.T) {
	svc := &stubStateService{appIDs: nil}
	w := doState(t, stubStateBackend{svc: svc}, http.MethodGet, "/appids", "")
	require.Equal(t, http.StatusOK, w.Code)
	require.JSONEq(t, `[]`, w.Body.String())
}

func TestStateDelete(t *testing.T) {
	svc := &stubStateService{deletes: []state.DeleteResult{
		{Key: "a", OK: true},
		{Key: "b", Error: "boom"},
	}}
	b := stubStateBackend{svc: svc}

	w := doState(t, b, http.MethodPost, "/delete", `{"keys":["a","b"]}`)
	require.Equal(t, http.StatusOK, w.Code)
	require.Equal(t, []string{"a", "b"}, svc.lastDeletes)
	var got []state.DeleteResult
	require.NoError(t, json.Unmarshal(w.Body.Bytes(), &got))
	require.Len(t, got, 2)
	require.True(t, got[0].OK)
	require.False(t, got[1].OK)

	t.Run("invalid JSON is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/delete", `{`)
		require.Equal(t, http.StatusBadRequest, w.Code)
	})
	t.Run("empty key list is a 400", func(t *testing.T) {
		w := doState(t, b, http.MethodPost, "/delete", `{"keys":[]}`)
		require.Equal(t, http.StatusBadRequest, w.Code)
		require.Contains(t, w.Body.String(), "keys is required")
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT && go test -tags unit ./pkg/server/ -run TestState -v
```
Expected: FAIL — `undefined: stateRouter`, `undefined: StateBackend`.

- [ ] **Step 3: Write the router**

Create `pkg/server/state.go`:

```go
package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"

	"github.com/diagridio/dev-dashboard/pkg/state"
	"github.com/go-chi/chi/v5"
)

// StateBackend selects the state service for a named store. An empty name
// selects the active store; ok=false means the named store is unknown.
type StateBackend interface {
	StateFor(store string) (state.Service, bool)
}

// deleteBody is the request body for the bulk delete endpoint.
type deleteBody struct {
	Keys []string `json:"keys"`
}

func stateRouter(backend StateBackend) http.Handler {
	r := chi.NewRouter()

	// svcFor resolves the store from ?store=, writing the 404 itself when the
	// store is unknown.
	svcFor := func(w http.ResponseWriter, req *http.Request) (state.Service, bool) {
		svc, ok := backend.StateFor(req.URL.Query().Get("store"))
		if !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "unknown state store"})
			return nil, false
		}
		return svc, true
	}

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		res, err := svc.List(req.Context(), parseStateQuery(req))
		if err != nil {
			writeStateErr(w, err)
			return
		}
		if res.Items == nil {
			res.Items = []state.Item{}
		}
		writeJSON(w, http.StatusOK, res)
	})

	r.Get("/record", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		// The key is a query parameter, not a path segment: keys contain "||"
		// and arbitrary characters, which path escaping handles badly.
		key := req.URL.Query().Get("key")
		if key == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "key is required"})
			return
		}
		rec, err := svc.Record(req.Context(), key)
		if err != nil {
			writeStateErr(w, err)
			return
		}
		writeJSON(w, http.StatusOK, rec)
	})

	r.Get("/appids", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		ids, err := svc.AppIDs(req.Context())
		if err != nil {
			writeStateErr(w, err)
			return
		}
		if ids == nil {
			ids = []string{} // never serialize a bare null to the SPA
		}
		writeJSON(w, http.StatusOK, ids)
	})

	r.Post("/delete", func(w http.ResponseWriter, req *http.Request) {
		svc, ok := svcFor(w, req)
		if !ok {
			return
		}
		var body deleteBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if len(body.Keys) == 0 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "keys is required"})
			return
		}
		writeJSON(w, http.StatusOK, svc.Delete(req.Context(), body.Keys))
	})

	return r
}

// writeStateErr maps service errors to status codes by sentinel, never by
// message text. The 503 bodies match the workflow endpoints' shapes so the
// SPA's shared banner extraction keeps working.
//
// There is deliberately no 400 for a bad search pattern: every fragment of
// user input is escaped before it reaches KeysLike, so a pattern error would
// be our bug, not the caller's, and belongs in the 500 bucket.
func writeStateErr(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, state.ErrNoStore):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
	case errors.Is(err, state.ErrStoreUnreachable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
	case errors.Is(err, state.ErrNotBrowsable):
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "this state store cannot be browsed"})
	case errors.Is(err, state.ErrNotFound):
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "record not found"})
	default:
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
	}
}

// parseStateQuery reads the list query parameters. The limit shares
// maxListPageSize with the workflow list: each returned row costs value bytes,
// so an unbounded limit would let one request pull an unbounded page.
func parseStateQuery(req *http.Request) state.ListQuery {
	q := state.ListQuery{
		AppID:     req.URL.Query().Get("appId"),
		Search:    req.URL.Query().Get("search"),
		PageToken: req.URL.Query().Get("page"),
	}
	if req.URL.Query().Get("includeInternal") == "true" {
		q.IncludeInternal = true
	}
	if l := req.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			switch {
			case n > maxListPageSize:
				q.PageSize = maxListPageSize
			case n > 0:
				q.PageSize = n
				// n <= 0: leave PageSize at 0 so the service default applies.
			}
		}
	}
	return q
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd $WT && gofmt -w pkg/server/ && go test -tags unit ./pkg/server/ -v
```
Expected: PASS, including every pre-existing server test.

- [ ] **Step 5: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/server/state.go pkg/server/state_test.go
git commit -m "$(cat <<'EOF'
feat(server): add the /api/state router

List, per-key record read, app-ids and bulk delete. The record key is a
query parameter, not a path segment, because keys contain || and
arbitrary characters. 503 bodies match the workflow endpoints so the
SPA's shared banner extraction keeps working.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Capability flag and `cmd` wiring

Makes the route real: the per-store service is built alongside the workflow service, and the reconciler resolves it.

**Files:**
- Modify: `pkg/server/server.go` (`Capabilities.State`, `FullCapabilities`, `Options.StateBackend`)
- Modify: `pkg/server/api.go` (`apiRouter` signature + mount)
- Modify: `cmd/workflow.go` (`storeEntry.state`, `buildStoreEntry`)
- Modify: `cmd/reconciler.go` (`resolveComponent` helper, `StateFor`)
- Modify: `cmd/serve.go` (pass `StateBackend`)
- Modify: `cmd/root.go` (set `State` in the container branch)
- Modify: `pkg/server/api_test.go` or `pkg/server/server_test.go` (cap gating)
- Modify: `cmd/workflow_test.go` (buildStoreEntry degradation)

**Interfaces:**
- Consumes: `server.StateBackend` (Task 6), `state.New` / `state.NewUnreachable` (Task 4), `statestore.RecordReader` (Task 1)
- Produces:
  - `Capabilities.State bool` (JSON `state`)
  - `Options.StateBackend StateBackend`
  - `cmd.storeEntry.state state.Service`
  - `(*reconciler).StateFor(id string) (state.Service, bool)`

- [ ] **Step 1: Write the failing tests**

Add to `pkg/server/server_test.go`:

```go
func TestStateRouteGatedOnCapability(t *testing.T) {
	// State off: the route must not exist at all — absent routes are the real
	// boundary; the capability flag is only advisory UX for the SPA.
	off := NewRouter(Options{
		DistFS:       fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Version:      version.Info{Version: "test"},
		Apps:         newFakeApps(),
		Backend:      newFakeBackend(fakeWF{}),
		Capabilities: &Capabilities{},
	})
	w := httptest.NewRecorder()
	off.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/state", nil))
	require.Equal(t, http.StatusNotFound, w.Code)

	require.True(t, FullCapabilities().State, "host mode enables the State page")
}
```

> `DistFS`, `Version`, `Apps` and `Backend` are not optional padding: every other
> `NewRouter` call in this file supplies them (`server_test.go:17`), because the
> router builds the SPA handler eagerly. Copy that shape rather than passing a
> bare `Options{}`.

Add to `cmd/workflow_test.go`:

```go
// recordingStore is a statestore.Store that also implements RecordReader.
// patternKeysStore's methods are on a pointer receiver, so the embed must be a
// pointer for the promoted methods to satisfy statestore.Store.
type recordingStore struct{ *patternKeysStore }

func (recordingStore) Records(context.Context, []string) ([]statestore.Record, error) {
	return nil, nil
}

func TestBuildStoreEntryStateService(t *testing.T) {
	ctx := context.Background()

	t.Run("store implementing RecordReader yields a working state service", func(t *testing.T) {
		e := buildStoreEntry(recordingStore{&patternKeysStore{}}, "default", http.DefaultClient, nil, nil)
		require.NotNil(t, e.state)
		_, err := e.state.AppIDs(ctx)
		require.NoError(t, err)
	})

	t.Run("store without RecordReader degrades to not-browsable", func(t *testing.T) {
		e := buildStoreEntry(&patternKeysStore{}, "default", http.DefaultClient, nil, nil)
		require.NotNil(t, e.state)
		_, err := e.state.AppIDs(ctx)
		require.ErrorIs(t, err, state.ErrNotBrowsable)
	})

	t.Run("nil store degrades to no-store without panicking", func(t *testing.T) {
		e := buildStoreEntry(nil, "default", http.DefaultClient, nil, nil)
		require.NotNil(t, e.state)
		_, err := e.state.AppIDs(ctx)
		require.ErrorIs(t, err, state.ErrNoStore)
	})
}
```

> Add `"github.com/diagridio/dev-dashboard/pkg/state"` and `"github.com/diagridio/dev-dashboard/pkg/statestore"` to the imports if absent.

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd $WT && go test -tags unit ./pkg/server/ -run TestStateRouteGated -v; go test -tags unit ./cmd/ -run TestBuildStoreEntryStateService -v
```
Expected: FAIL — `Capabilities` has no field `State`; `storeEntry` has no field `state`.

- [ ] **Step 3: Add the capability**

In `pkg/server/server.go`, add to `Capabilities` (after `Workflows`):

```go
	// State gates the State page (state-store record browser). It needs a
	// connected store, the same precondition as Workflows, but is a separate
	// flag because a store with no workflow data still has state worth
	// browsing.
	State bool `json:"state"`
```

Update `FullCapabilities`:

```go
func FullCapabilities() Capabilities {
	return Capabilities{Lifecycle: true, ControlPlane: true, Logs: true, Workflows: true, State: true}
}
```

Add to `Options` (next to `Backend`):

```go
	// StateBackend resolves the per-store state service for the State page.
	StateBackend StateBackend
```

And pass it into `apiRouter` where `mount` is defined:

```go
		router.Mount("/api", apiRouter(opts.Version, opts.Apps, opts.ContainerLogs, opts.Lifecycle, opts.Backend, opts.StateBackend, opts.Stores, opts.Resources, opts.News, opts.ControlPlane, opts.UpdateCheck, caps))
```

- [ ] **Step 4: Mount the route**

In `pkg/server/api.go`, add the parameter to the signature (after `backend WorkflowBackend`):

```go
func apiRouter(v version.Info, apps discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), life lifecycle.Manager, backend WorkflowBackend, stateBackend StateBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service, cp controlplane.Manager, uc updatecheck.Service, caps Capabilities) http.Handler {
```

And mount it next to the workflows mount:

```go
	if caps.Workflows {
		r.Mount("/workflows", workflowsRouter(backend, stores))
	}
	if caps.State && stateBackend != nil {
		r.Mount("/state", stateRouter(stateBackend))
	}
```

`apiRouter` has **five test call sites** that all need the new parameter — pass `nil` for it at each, since none of them is about state:

- `pkg/server/api_test.go:16`
- `pkg/server/api_test.go:30`
- `pkg/server/statestores_test.go:60`
- `pkg/server/workflows_test.go:243`
- `pkg/server/workflows_test.go:254`

The new argument goes **after** `newFakeBackend(fakeWF{})` and before the `stores` argument, matching the signature. Verify with `grep -rn 'apiRouter(' pkg/server/` that none are missed.

- [ ] **Step 5: Build the per-store state service**

In `cmd/workflow.go`, add the field to `storeEntry`:

```go
// storeEntry holds the per-store workflow service, remover, target resolver,
// and state-record service.
type storeEntry struct {
	svc     workflow.Service
	rem     server.WorkflowRemover
	targets server.TargetResolver
	state   state.Service
}
```

And extend `buildStoreEntry` (keep the existing doc comment, append to it):

```go
func buildStoreEntry(st statestore.Store, namespace string, client *http.Client, apps discovery.Service, appNS map[string]string) storeEntry {
	nsResolver := func(_ context.Context, appID string) string { return appNS[appID] }
	svc := workflow.New(st, namespace, workflow.WithNamespaceResolver(nsResolver))
	rem := workflow.NewRemover(client, st, namespace)
	res := newTargetResolver(apps, svc)

	// The single seam where the optional RecordReader capability is asserted.
	// A nil store (the degraded entry) or a backend without the capability
	// yields a service that reports ErrNoStore / ErrNotBrowsable rather than
	// panicking.
	var rr statestore.RecordReader
	if st != nil {
		rr, _ = st.(statestore.RecordReader)
	}

	return storeEntry{svc: svc, rem: rem, targets: res, state: state.New(st, rr)}
}
```

Add `"github.com/diagridio/dev-dashboard/pkg/state"` to the imports.

- [ ] **Step 6: Implement `StateFor` and factor out component resolution**

In `cmd/reconciler.go`, add a helper that both resolvers share, then `StateFor`:

```go
// resolveComponent maps a registry entry id to the component to open. degraded
// reports the no-store case (no active store elected); known is false for an
// unrecognised id.
func (rc *reconciler) resolveComponent(id string) (comp statestore.Component, degraded, known bool) {
	if id == "" {
		active := rc.activeComponent()
		if active == nil {
			return statestore.Component{}, true, true
		}
		comp = *active
	} else {
		c, ok := rc.componentFor(id)
		if !ok {
			return statestore.Component{}, false, false
		}
		comp = c
	}
	// Apply compose address translation (no-op for non-compose stores) so the
	// pool key matches the pre-warmed translated entry and the dial uses the
	// host-reachable address rather than the in-container service name.
	return rc.translate(comp), false, true
}

// StateFor satisfies server.StateBackend.
//
// Unlike ServiceFor there is no sidecar composition: Dapr's HTTP State API
// cannot enumerate keys, so a store that will not open has no fallback and the
// unreachable service is the final answer.
func (rc *reconciler) StateFor(id string) (state.Service, bool) {
	comp, degraded, known := rc.resolveComponent(id)
	if !known {
		return nil, false
	}
	if degraded {
		return rc.degraded.state, true
	}
	// Derive from baseCtx so shutdown aborts an in-flight dial here too.
	octx, cancel := context.WithTimeout(rc.baseCtx, connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		return state.NewUnreachable(comp.Name, statestore.ConnInfo(comp)), true
	}
	return e.state, true
}
```

Then rewrite `baseServiceFor`'s resolution half to use the helper, leaving its
return values and behavior unchanged:

```go
func (rc *reconciler) baseServiceFor(id string) (svc workflow.Service, rem server.WorkflowRemover, storeUp, known bool) {
	comp, degraded, known := rc.resolveComponent(id)
	if !known {
		return nil, nil, false, false
	}
	if degraded {
		return rc.degraded.svc, rc.degraded.rem, false, true
	}
	octx, cancel := context.WithTimeout(rc.baseCtx, connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		// Known store, unreachable: surface an accurate store-specific
		// "could not connect…" error (not the no-store message).
		return workflow.NewUnreachableService(comp.Name, statestore.ConnInfo(comp)),
			rc.degraded.rem, false, true
	}
	return e.svc, e.rem, true, true
}
```

Add the `state` import.

- [ ] **Step 7: Wire the option and the capability**

In `cmd/serve.go`, next to `Backend: rc,` (line ~149) add:

```go
		StateBackend:     rc,
```

In `cmd/root.go`, the container-posture branch (line ~147):

```go
		caps = &server.Capabilities{
			Workflows: settings.StateStore != "",
			State:     settings.StateStore != "",
			Mode:      string(ModeAspire),
		}
```

- [ ] **Step 8: Run the full Go suite**

```bash
cd $WT && gofmt -w ./pkg ./cmd && go build ./... && go test -tags unit ./... 2>&1 | tail -30
```
Expected: PASS across all packages. Existing reconciler tests must still pass — `resolveComponent` is a pure extraction.

- [ ] **Step 9: Commit**

```bash
cd $WT && git branch --show-current
git add pkg/server/ cmd/
git commit -m "$(cat <<'EOF'
feat: wire the state service through cmd and the API

buildStoreEntry gains the state service; the RecordReader assertion
lives there alone, so a nil store or a backend without the capability
degrades instead of panicking. reconciler.StateFor resolves it with no
sidecar composition — key enumeration has no Dapr-API fallback.

resolveComponent factors the id -> component resolution shared by
StateFor and baseServiceFor.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Frontend types, hooks, and the shared `DateTimeCell`

**Files:**
- Create: `web/src/types/state.ts`
- Create: `web/src/hooks/useStateRecords.ts`, `web/src/hooks/useStateRecords.test.tsx`
- Create: `web/src/components/DateTimeCell.tsx`
- Modify: `web/src/pages/Workflows.tsx` (remove the local copy, import the shared one)
- Modify: `web/src/lib/capabilities.ts` (add `state`)

**Interfaces:**
- Consumes: `fetchJSON`, `apiUrl` (`lib/api.ts`), `useRefreshInterval`/`refetchMs` (`lib/refresh.ts`)
- Produces:
  - types `StateItem`, `StateListResult`, `StateRecord`, `StateDeleteResult`, `StateKind`
  - hooks `useStateRecords(params)`, `useStateRecord(key, store, enabled)`, `useStateAppIds(params)`, `useDeleteStateRecords()`
  - component `DateTimeCell({ ts }: { ts?: string })`
  - `Capabilities.state?: boolean`

- [ ] **Step 1: Write the failing hook test**

Create `web/src/hooks/useStateRecords.test.tsx`:

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useStateRecords, useStateRecord, useStateAppIds } from './useStateRecords'

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 } } })
  return (
    <QueryProvider client={client}>
      <RefreshProvider>{children}</RefreshProvider>
    </QueryProvider>
  )
}

describe('useStateRecords', () => {
  it('sends app, search, page, store and includeInternal as query params', async () => {
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [], nextToken: '' })
      }),
    )
    renderHook(
      () =>
        useStateRecords({
          appId: 'myapp',
          search: 'order',
          page: 'tok',
          store: 'store-1',
          includeInternal: true,
        }),
      { wrapper },
    )
    await waitFor(() => expect(seen).toContain('appId=myapp'))
    expect(seen).toContain('search=order')
    expect(seen).toContain('page=tok')
    expect(seen).toContain('store=store-1')
    expect(seen).toContain('includeInternal=true')
  })

  it('omits includeInternal when false', async () => {
    let seen = 'unset'
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [] })
      }),
    )
    renderHook(() => useStateRecords({ includeInternal: false }), { wrapper })
    await waitFor(() => expect(seen).not.toBe('unset'))
    expect(seen).not.toContain('includeInternal')
  })

  it('does not fetch while disabled', async () => {
    let calls = 0
    server.use(
      http.get('/api/state', () => {
        calls++
        return HttpResponse.json({ items: [] })
      }),
    )
    renderHook(() => useStateRecords({ enabled: false }), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })
})

describe('useStateRecord', () => {
  it('encodes a key containing the || delimiter', async () => {
    let seen = ''
    server.use(
      http.get('/api/state/record', ({ request }) => {
        seen = new URL(request.url).searchParams.get('key') ?? ''
        return HttpResponse.json({ key: seen, value: '{}', encoding: 'text', size: 2, truncated: false })
      }),
    )
    const { result } = renderHook(() => useStateRecord('myapp||order-1', 'store-1', true), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(seen).toBe('myapp||order-1')
  })

  it('stays idle until enabled', async () => {
    let calls = 0
    server.use(
      http.get('/api/state/record', () => {
        calls++
        return HttpResponse.json({ key: 'k', value: '', encoding: 'text', size: 0, truncated: false })
      }),
    )
    renderHook(() => useStateRecord('k', undefined, false), { wrapper })
    await new Promise((r) => setTimeout(r, 50))
    expect(calls).toBe(0)
  })
})

describe('useStateAppIds', () => {
  it('fetches the store-scoped app id list', async () => {
    server.use(http.get('/api/state/appids', () => HttpResponse.json(['alpha', 'zeta'])))
    const { result } = renderHook(() => useStateAppIds({ store: 's1' }), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual(['alpha', 'zeta']))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT/web && npx vitest run src/hooks/useStateRecords.test.tsx
```
Expected: FAIL — cannot resolve `./useStateRecords`.

- [ ] **Step 3: Write the types**

Create `web/src/types/state.ts`:

```ts
/** How a key was produced: app code, the workflow engine, or an actor. */
export type StateKind = 'app' | 'workflow' | 'actor'

/** How `preview` / `value` represent the raw bytes. */
export type StateEncoding = 'text' | 'base64'

/** One row in the State table: metadata plus a bounded preview, never the full value. */
export interface StateItem {
  key: string
  appId: string
  logicalKey: string
  kind: StateKind
  preview: string
  encoding: StateEncoding
  size: number
  /** Backend etag — a revision counter, not a timestamp. Absent for some redis entries. */
  etag?: string
  ttlExpiresAt?: string
  contentType?: string
}

export interface StateListResult {
  items: StateItem[]
  /** Non-empty means "keep paging", even when items is short. */
  nextToken?: string
}

/** One record's full value, fetched only when a row is expanded. */
export interface StateRecord {
  key: string
  appId: string
  logicalKey: string
  kind: StateKind
  value: string
  encoding: StateEncoding
  size: number
  truncated: boolean
  etag?: string
  ttlExpiresAt?: string
  contentType?: string
}

export interface StateDeleteResult {
  key: string
  ok: boolean
  error?: string
}
```

- [ ] **Step 4: Write the hooks**

Create `web/src/hooks/useStateRecords.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiUrl, fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { StateDeleteResult, StateListResult, StateRecord } from '../types/state'

interface StateRecordsParams {
  appId?: string
  search?: string
  page?: string
  limit?: number
  store?: string
  includeInternal?: boolean
  enabled?: boolean
}

function queryString(p: StateRecordsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  if (p.store) sp.set('store', p.store)
  if (p.includeInternal) sp.set('includeInternal', 'true')
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function useStateRecords(params: StateRecordsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  return useQuery<StateListResult>({
    queryKey: ['state-records', qs],
    queryFn: () => fetchJSON<StateListResult>(`/state${qs}`),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}

/**
 * One record's full value. Enabled only while its row is expanded, so a wide
 * table never pulls megabytes of values it will not show. Not on the refresh
 * interval: an expanded value is a snapshot the user is reading.
 */
export function useStateRecord(key: string, store?: string, enabled = true) {
  const sp = new URLSearchParams({ key })
  if (store) sp.set('store', store)
  return useQuery<StateRecord>({
    queryKey: ['state-record', key, store],
    queryFn: () => fetchJSON<StateRecord>(`/state/record?${sp.toString()}`),
    enabled: enabled && !!key,
  })
}

export function useStateAppIds(params: { store?: string; enabled?: boolean }) {
  const ctx = useRefreshInterval()
  const qs = params.store ? `?store=${encodeURIComponent(params.store)}` : ''
  return useQuery<string[]>({
    queryKey: ['state-appids', qs],
    queryFn: () => fetchJSON<string[]>(`/state/appids${qs}`),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}

async function postDelete(vars: { keys: string[]; store?: string }): Promise<StateDeleteResult[]> {
  const qs = vars.store ? `?store=${encodeURIComponent(vars.store)}` : ''
  const res = await fetch(apiUrl(`/state/delete${qs}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keys: vars.keys }),
  })
  if (!res.ok) throw new Error(`delete failed: ${res.status}`)
  return res.json() as Promise<StateDeleteResult[]>
}

export function useDeleteStateRecords() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: postDelete,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['state-records'] })
      qc.invalidateQueries({ queryKey: ['state-record'] })
      // The app dropdown derives from the same keyspace, so it goes stale too;
      // with auto-refresh paused it would never catch up on its own.
      qc.invalidateQueries({ queryKey: ['state-appids'] })
    },
  })
}
```

- [ ] **Step 5: Extract `DateTimeCell`**

Create `web/src/components/DateTimeCell.tsx` with the body currently at `web/src/pages/Workflows.tsx:24-33`:

```tsx
import { formatDateTimeParts } from '../lib/wallclock'

/**
 * Render a timestamp as localized date and time in separate spans so they sit
 * on one line when there's room and stack (date first, time second) when the
 * column is narrow. Falls back to an em dash on missing/invalid input.
 */
export function DateTimeCell({ ts }: { ts?: string }) {
  const parts = formatDateTimeParts(ts)
  if (!parts) return <>—</>
  return (
    <>
      <span className="dt-date">{parts.date}</span>{' '}
      <span className="dt-time">{parts.time}</span>
    </>
  )
}
```

In `web/src/pages/Workflows.tsx`: delete the local `DateTimeCell` function and its now-unused `formatDateTimeParts` import, and add `import { DateTimeCell } from '../components/DateTimeCell'`.

- [ ] **Step 6: Add the capability flag**

In `web/src/lib/capabilities.ts`, add `state?: boolean` to the interface and `state: true` to `FULL`:

```ts
export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
  /** State page (state-store record browser). */
  state?: boolean
  /** CLI --mode value ('' = complete scan); lets the UI adapt static fallbacks. */
  mode?: string
}

const FULL: Capabilities = { lifecycle: true, controlPlane: true, logs: true, workflows: true, state: true, mode: '' }
```

- [ ] **Step 7: Run the tests and the typecheck**

```bash
cd $WT/web && npx vitest run src/hooks/useStateRecords.test.tsx src/pages/Workflows.test.tsx && cd $WT && make build
```
Expected: hook tests PASS; the Workflows suite still PASSes after the `DateTimeCell` move; `make build` succeeds.

- [ ] **Step 8: Commit**

```bash
cd $WT && git branch --show-current
git add web/src/types/state.ts web/src/hooks/useStateRecords.ts web/src/hooks/useStateRecords.test.tsx web/src/components/DateTimeCell.tsx web/src/pages/Workflows.tsx web/src/lib/capabilities.ts
git commit -m "$(cat <<'EOF'
feat(web): add state record types, hooks and shared DateTimeCell

useStateRecord is enabled per expanded row and off the refresh interval,
so a wide table never pulls values it will not show. DateTimeCell moves
out of Workflows.tsx so both tables share one implementation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The State page — table, filters, store selector, pager

Read-only listing. Row expansion (Task 10) and deletion (Task 11) come after.

**Files:**
- Create: `web/src/pages/State.tsx`, `web/src/pages/State.test.tsx`
- Modify: `web/src/components/TopNav.tsx`, `web/src/router.tsx`

**Interfaces:**
- Consumes: hooks and types from Task 8; `useStateStores` from `hooks/useWorkflows`; `dedupeStores` from `lib/dedupeStores`; `useDocumentTitle`; `DateTimeCell`
- Produces: `State` page component; nav item `{ label: 'State', to: '/state', cap: 'state' }`

- [ ] **Step 1: Write the failing page test**

Create `web/src/pages/State.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { State } from './State'

const STORES = [
  { id: 's1', name: 'statestore', type: 'state.redis', source: 'auto', path: '/c/s.yaml', active: true, connection: 'localhost:6379' },
  { id: 's2', name: 'other', type: 'state.sqlite', source: 'manual', path: '', active: false, connection: '/tmp/x.db' },
]

const ITEM = {
  key: 'myapp||order-42',
  appId: 'myapp',
  logicalKey: 'order-42',
  kind: 'app' as const,
  preview: '{ "id": 42 }',
  encoding: 'text' as const,
  size: 1284,
  etag: '3',
  ttlExpiresAt: '2026-08-26T14:02:11Z',
}

function stubApi(overrides?: { items?: unknown[]; nextToken?: string }) {
  server.use(
    http.get('/api/statestores', () => HttpResponse.json(STORES)),
    http.get('/api/state/appids', () => HttpResponse.json(['myapp', 'other-app'])),
    http.get('/api/state', () =>
      HttpResponse.json({ items: overrides?.items ?? [ITEM], nextToken: overrides?.nextToken ?? '' }),
    ),
  )
}

function renderAt(entry = '/state') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
  const router = createMemoryRouter(
    [
      { path: '/state', element: <State /> },
      { path: '/components/:name', element: <div>component page</div> },
    ],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('State page', () => {
  it('renders a record row with key, app, preview, size, version and TTL', async () => {
    stubApi()
    renderAt()
    const cell = await screen.findByText('order-42')
    const row = within(cell.closest('tr') as HTMLElement)
    expect(row.getByText('myapp')).toBeInTheDocument()
    expect(row.getByText('{ "id": 42 }')).toBeInTheDocument()
    expect(row.getByText('1.3 KB')).toBeInTheDocument()
    expect(row.getByText('3')).toBeInTheDocument()
  })

  it('lists the store selector and links to the selected store component', async () => {
    stubApi()
    renderAt()
    const select = await screen.findByTestId('store-select')
    expect(select).toHaveValue('s1')
    expect(within(select as HTMLElement).getAllByRole('option')).toHaveLength(2)
    expect(screen.getByRole('link', { name: /statestore component page/i })).toHaveAttribute(
      'href',
      '/components/statestore',
    )
  })

  it('sends the selected app as a query param', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.selectOptions(await screen.findByTestId('app-select'), 'other-app')
    await waitFor(() => expect(seen).toContain('appId=other-app'))
  })

  it('debounces the key search into the query', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.type(screen.getByLabelText('Search key'), 'order')
    await waitFor(() => expect(seen).toContain('search=order'), { timeout: 2000 })
  })

  it('requests internal keys only when the toggle is on', async () => {
    stubApi()
    let seen = ''
    server.use(
      http.get('/api/state', ({ request }) => {
        seen = new URL(request.url).search
        return HttpResponse.json({ items: [ITEM] })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(seen).not.toContain('includeInternal')
    await userEvent.click(screen.getByLabelText('Show internal keys'))
    await waitFor(() => expect(seen).toContain('includeInternal=true'))
  })

  it('marks a non-app record with its kind', async () => {
    stubApi({
      items: [{ ...ITEM, key: 'myapp||MyActor||a1||balance', logicalKey: 'MyActor||a1||balance', kind: 'actor' }],
    })
    renderAt()
    expect(await screen.findByText('actor')).toBeInTheDocument()
  })

  it('shows an em dash for a record with no version or TTL', async () => {
    stubApi({ items: [{ ...ITEM, etag: undefined, ttlExpiresAt: undefined }] })
    renderAt()
    const cell = await screen.findByText('order-42')
    const row = within(cell.closest('tr') as HTMLElement)
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(2)
  })

  it('pages forward and back with the cursor token', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json(['myapp'])),
      http.get('/api/state', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        if (page === 'tok') {
          return HttpResponse.json({ items: [{ ...ITEM, key: 'myapp||order-99', logicalKey: 'order-99' }] })
        }
        return HttpResponse.json({ items: [ITEM], nextToken: 'tok' })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(screen.getByText('1–1 loaded')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('order-99')
    expect(screen.getByText('2–2 loaded')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /prev/i }))
    await screen.findByText('order-42')
  })

  it('shows the empty state when the store has no matching records', async () => {
    stubApi({ items: [] })
    renderAt()
    expect(await screen.findByText('No state records found')).toBeInTheDocument()
    expect(screen.getByText('No results')).toBeInTheDocument()
  })

  it('keeps the chrome usable and banners a 503 so another store can be picked', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json([])),
      http.get('/api/state', () =>
        HttpResponse.json({ error: 'this state store cannot be browsed' }, { status: 503 }),
      ),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent('cannot be browsed')
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
  })

  it('guides the user when no state store is configured at all', async () => {
    server.use(http.get('/api/statestores', () => HttpResponse.json([])))
    renderAt()
    expect(await screen.findByText('No state store detected')).toBeInTheDocument()
  })

  it('persists the selected store across mounts', async () => {
    stubApi()
    renderAt()
    await userEvent.selectOptions(await screen.findByTestId('store-select'), 's2')
    await waitFor(() => expect(window.localStorage.getItem('devdash.stateStore')).toBe('s2'))
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd $WT/web && npx vitest run src/pages/State.test.tsx
```
Expected: FAIL — cannot resolve `./State`.

- [ ] **Step 3: Write the page**

Create `web/src/pages/State.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useStateStores } from '../hooks/useWorkflows'
import { useStateAppIds, useStateRecords } from '../hooks/useStateRecords'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { DateTimeCell } from '../components/DateTimeCell'
import { dedupeStores } from '../lib/dedupeStores'
import type { StateStore } from '../types/workflow'
import type { StateItem } from '../types/state'

const STORE_KEY = 'devdash.stateStore'

/** Humanize a byte count for the Size column. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

export function State() {
  const [searchParams, setSearchParams] = useSearchParams()
  useDocumentTitle('State')

  const urlApp = searchParams.get('app') ?? ''
  const urlSearch = searchParams.get('search') ?? ''
  const urlPage = searchParams.get('page') ?? undefined

  const [selectedApp, setSelectedApp] = useState(urlApp)
  const [searchInput, setSearchInput] = useState(urlSearch)
  const [debouncedSearch, setDebouncedSearch] = useState(urlSearch)
  const [includeInternal, setIncludeInternal] = useState(false)
  const [page, setPage] = useState<string | undefined>(urlPage)
  // The API returns only a forward cursor, so Prev is served by stacking the
  // (token, offset) of each page we leave. Empty = on the first page.
  const [history, setHistory] = useState<{ token: string | undefined; offset: number }[]>([])
  const [pageOffset, setPageOffset] = useState(0)

  function resetPaging() {
    setPage(undefined)
    setHistory([])
    setPageOffset(0)
  }

  // Stores. The dropdown collapses entries that differ only by file path, since
  // they read identical data; the choice is a store id, persisted across reloads.
  const { data: storeList } = useStateStores()
  const storesResolved = storeList !== undefined
  const noStores = storesResolved && storeList.length === 0
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]
  const displayStores = useMemo(() => dedupeStores(storeList ?? []), [storeList])

  // null = not yet determined; the list query stays disabled until it resolves,
  // which avoids a double-fetch on mount.
  const [selectedStore, setSelectedStore] = useState<string | null>(null)
  useEffect(() => {
    if (!displayStores || displayStores.length === 0) return
    if (selectedStore !== null && displayStores.some((s) => s.id === selectedStore)) return
    const persisted = window.localStorage.getItem(STORE_KEY)
    const fromPersisted =
      persisted && displayStores.some((s) => s.id === persisted) ? persisted : undefined
    setSelectedStore(fromPersisted ?? activeStore?.id ?? displayStores[0].id)
  }, [displayStores, activeStore, selectedStore])

  const selectedStoreObj = useMemo(
    () => storeList?.find((s) => s.id === selectedStore),
    [storeList, selectedStore],
  )

  function storeOptionLabel(s: StateStore): string {
    const typeShort = s.type.split('.').pop() ?? s.type
    const head = `${s.name} — ${s.connection ? `${typeShort} · ${s.connection}` : typeShort}`
    return s.active ? `${head} (active)` : head
  }

  function onStoreChange(id: string) {
    setSelectedStore(id)
    window.localStorage.setItem(STORE_KEY, id)
    // A different store has different prefixes — reset the app filter.
    setSelectedApp('')
    resetPaging()
  }

  // Debounce search ~250ms so typing does not fire a request per keystroke.
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current)
    debounceTimer.current = setTimeout(() => setDebouncedSearch(searchInput), 250)
    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current)
    }
  }, [searchInput])

  useEffect(() => {
    const params: Record<string, string> = {}
    if (selectedApp) params.app = selectedApp
    if (debouncedSearch) params.search = debouncedSearch
    if (page) params.page = page
    setSearchParams(params, { replace: true })
  }, [selectedApp, debouncedSearch, page, setSearchParams])

  const { data, isLoading, isError, error } = useStateRecords({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
    page,
    store: selectedStore ?? undefined,
    includeInternal,
    enabled: selectedStore !== null,
  })

  const { data: storeAppIds } = useStateAppIds({
    store: selectedStore ?? undefined,
    enabled: selectedStore !== null,
  })
  const appIds = useMemo(() => storeAppIds ?? [], [storeAppIds])

  // On error, treat the page as empty so the pager reads "No results" and no
  // row-derived UI acts on stale data TanStack Query may have retained.
  const items = useMemo<StateItem[]>(() => (isError ? [] : (data?.items ?? [])), [isError, data?.items])

  if (noStores) {
    return (
      <div className="page">
        <p className="err b">No state store detected</p>
        <p className="muted" style={{ marginTop: 8 }}>
          Configure one with the <span className="mono">--statestore</span> flag or add a state
          store component.
        </p>
      </div>
    )
  }

  // Any load error degrades gracefully: the chrome stays usable so the user can
  // switch to a reachable store.
  let loadError: string | null = null
  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      const extracted = errStr
        .replace(/^.*?503[:\s]+/, '')
        .replace(/\s*for\s+\/\S*$/, '')
        .trim()
      loadError = extracted && extracted !== errStr ? extracted : 'state store unavailable'
    } else {
      loadError = `Error loading state records: ${errStr}`
    }
  }

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>State records</h1>
          <div className="sub">
            {appIds.length > 0
              ? `Across ${appIds.length} prefix${appIds.length !== 1 ? 'es' : ''} · read only`
              : 'Read only'}
          </div>
        </div>
        <div className="ctrlset">
          {storeList && storeList.length > 0 ? (
            <>
              <span className="led" />
              <select
                className="select"
                data-testid="store-select"
                aria-label="Switch state store"
                value={selectedStore ?? ''}
                onChange={(e) => onStoreChange(e.target.value)}
              >
                {displayStores.map((s) => (
                  <option key={s.id} value={s.id}>
                    {storeOptionLabel(s)}
                  </option>
                ))}
              </select>
              {selectedStoreObj && (
                <Link
                  className="chip"
                  to={`/components/${selectedStoreObj.name}`}
                  aria-label={`Open the ${selectedStoreObj.name} component page`}
                  title={`Open the ${selectedStoreObj.name} component page`}
                >
                  component
                </Link>
              )}
            </>
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
        </div>
      </div>

      {loadError && (
        <div
          data-testid="load-error-banner"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: 'var(--fail-fg)',
            fontSize: 13,
          }}
        >
          {loadError} — Select another state store or check the connection.
        </div>
      )}

      <div className="filters">
        <select
          className="select"
          data-testid="app-select"
          aria-label="Filter by app"
          value={selectedApp}
          onChange={(e) => {
            setSelectedApp(e.target.value)
            resetPaging()
          }}
        >
          <option value="">All apps</option>
          {selectedApp && !appIds.includes(selectedApp) && (
            <option value={selectedApp}>{selectedApp}</option>
          )}
          {appIds.map((id) => (
            <option key={id} value={id}>
              {id}
            </option>
          ))}
        </select>

        <label className="search">
          🔍
          <input
            placeholder="Search key…"
            aria-label="Search key"
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value)
              resetPaging()
            }}
          />
        </label>

        <label className="childtoggle">
          <input
            type="checkbox"
            aria-label="Show internal keys"
            checked={includeInternal}
            onChange={(e) => {
              setIncludeInternal(e.target.checked)
              resetPaging()
            }}
          />
          Show internal keys
        </label>
      </div>

      <div className="card">
        <div className="tablewrap">
          {isLoading || (!noStores && selectedStore === null) ? (
            <p className="muted" style={{ padding: 20 }}>
              Loading…
            </p>
          ) : isError ? (
            <p className="muted" style={{ padding: 20 }}>
              Couldn't load state records from this store.
            </p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ padding: 20 }}>
              No state records found
            </p>
          ) : (
            <table className="wf">
              <thead>
                <tr>
                  <th>Key</th>
                  <th>App</th>
                  <th>Value</th>
                  <th>Size</th>
                  <th>Version</th>
                  <th>TTL</th>
                </tr>
              </thead>
              <tbody>
                {items.map((rec) => (
                  <tr key={rec.key}>
                    <td className="iid mono">
                      {rec.logicalKey}
                      {rec.kind !== 'app' && (
                        <span className="typechip" style={{ marginLeft: 6 }}>
                          {rec.kind}
                        </span>
                      )}
                    </td>
                    <td>{rec.appId || '—'}</td>
                    <td className="mono">
                      {rec.preview}
                      {rec.encoding === 'base64' && (
                        <span className="typechip" style={{ marginLeft: 6 }}>
                          base64
                        </span>
                      )}
                    </td>
                    <td className="mono tabnum">{formatSize(rec.size)}</td>
                    <td
                      className="mono tabnum"
                      title="Backend revision counter (etag) — it changes on every write, but is not a timestamp"
                    >
                      {rec.etag || '—'}
                    </td>
                    <td className="muted mono tabnum dt">
                      <DateTimeCell ts={rec.ttlExpiresAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="pager">
          <span className="mono">
            {items.length > 0 ? `${pageOffset + 1}–${pageOffset + items.length} loaded` : 'No results'}
          </span>
          <div className="pgbtns">
            <button
              disabled={history.length === 0}
              onClick={() => {
                if (history.length === 0) return
                const prev = history[history.length - 1]
                setPage(prev.token)
                setPageOffset(prev.offset)
                setHistory((h) => h.slice(0, -1))
              }}
            >
              ← Prev
            </button>
            <button
              disabled={isError || !data?.nextToken}
              onClick={() => {
                if (!data?.nextToken) return
                setHistory((h) => [...h, { token: page, offset: pageOffset }])
                setPageOffset((o) => o + items.length)
                setPage(data.nextToken)
              }}
            >
              Next →
            </button>
          </div>
        </div>
      </div>

      <p className="hint">
        Tip — records are read only. Use “Show internal keys” to reveal workflow history and actor
        state.
      </p>
    </div>
  )
}
```

- [ ] **Step 4: Add the nav item and the route**

In `web/src/components/TopNav.tsx`, insert after the Workflows entry:

```ts
  { label: 'State', to: '/state', cap: 'state' },
```

In `web/src/router.tsx`, add after the workflows branch:

```tsx
  ...(caps.state ? [{ path: 'state', element: <State />, handle: { rumView: 'State' } }] : []),
```

with `import { State } from './pages/State'` at the top.

- [ ] **Step 5: Run the page test and the typecheck**

```bash
cd $WT/web && npx vitest run src/pages/State.test.tsx src/components/TopNav.test.tsx && cd $WT && make build
```
Expected: PASS. If `TopNav.test.tsx` asserts an exact nav-item count or list, update that expectation to include State.

- [ ] **Step 6: Commit**

```bash
cd $WT && git branch --show-current
git add web/src/pages/State.tsx web/src/pages/State.test.tsx web/src/components/TopNav.tsx web/src/router.tsx web/src/components/TopNav.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): add the State records page

Store selector, app filter, debounced key search, internal-key toggle,
and a cursor pager with a Prev history stack — the Workflows overview
structure and classes, so the two tables match by construction.

The Version column carries a tooltip stating that the etag is a revision
counter, not a timestamp: no backend surfaces a modified time through
components-contrib.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Row expansion with the full value

**Files:**
- Modify: `web/src/pages/State.tsx`, `web/src/pages/State.test.tsx`

**Interfaces:**
- Consumes: `useStateRecord` (Task 8), `highlightJson` from `lib/json-highlight`
- Produces: expansion state in `State.tsx`; a `RecordPanel` component local to that file

- [ ] **Step 1: Write the failing tests**

Append to `web/src/pages/State.test.tsx`:

```tsx
describe('State page row expansion', () => {
  const RECORD = {
    key: 'myapp||order-42',
    appId: 'myapp',
    logicalKey: 'order-42',
    kind: 'app' as const,
    value: '{"id":42,"total":19.99}',
    encoding: 'text' as const,
    size: 23,
    truncated: false,
    etag: '3',
  }

  it('fetches and shows the full value when a row is clicked', async () => {
    stubApi()
    let calls = 0
    server.use(
      http.get('/api/state/record', ({ request }) => {
        calls++
        expect(new URL(request.url).searchParams.get('key')).toBe('myapp||order-42')
        return HttpResponse.json(RECORD)
      }),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toHaveTextContent('"total"')
    // The full key, which the table abbreviates, is shown in the panel.
    expect(screen.getByTestId('record-panel')).toHaveTextContent('myapp||order-42')
    expect(calls).toBe(1)
  })

  it('does not fetch any value before a row is expanded', async () => {
    stubApi()
    let calls = 0
    server.use(
      http.get('/api/state/record', () => {
        calls++
        return HttpResponse.json(RECORD)
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    expect(calls).toBe(0)
  })

  it('collapses on a second click and expands only one row at a time', async () => {
    stubApi({
      items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }],
    })
    server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
    renderAt()

    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toBeInTheDocument()

    await userEvent.click(screen.getByText('order-43'))
    await waitFor(() => expect(screen.getAllByTestId('record-panel')).toHaveLength(1))

    await userEvent.click(screen.getByText('order-43'))
    await waitFor(() => expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument())
  })

  it('flags a truncated value', async () => {
    stubApi()
    server.use(
      http.get('/api/state/record', () =>
        HttpResponse.json({ ...RECORD, truncated: true, size: 5_000_000 }),
      ),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByText(/truncated/i)).toBeInTheDocument()
  })

  it('reports a value that could not be loaded without breaking the table', async () => {
    stubApi()
    server.use(
      http.get('/api/state/record', () => HttpResponse.json({ error: 'record not found' }, { status: 404 })),
    )
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByText(/couldn't load this value/i)).toBeInTheDocument()
    expect(screen.getByText('order-42')).toBeInTheDocument()
  })

  it('collapses the expanded row when a filter changes', async () => {
    stubApi()
    server.use(http.get('/api/state/record', () => HttpResponse.json(RECORD)))
    renderAt()
    await userEvent.click(await screen.findByText('order-42'))
    expect(await screen.findByTestId('record-panel')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Show internal keys'))
    await waitFor(() => expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd $WT/web && npx vitest run src/pages/State.test.tsx -t 'row expansion'
```
Expected: FAIL — no `record-panel` element exists.

- [ ] **Step 3: Implement expansion**

In `web/src/pages/State.tsx`:

Add imports:

```tsx
import { useStateAppIds, useStateRecord, useStateRecords } from '../hooks/useStateRecords'
import { highlightJson } from '../lib/json-highlight'
```

Add state, and clear it whenever the visible set changes:

```tsx
  // Full key of the expanded row, or null. One row at a time: the panel is
  // tall, and two open panels make the table unreadable.
  const [expandedKey, setExpandedKey] = useState<string | null>(null)
```

Extend `resetPaging` and `onStoreChange` to clear it:

```tsx
  function resetPaging() {
    setPage(undefined)
    setHistory([])
    setPageOffset(0)
    // The expanded row may not exist under the new filter/store/page.
    setExpandedKey(null)
  }
```

Also clear it in both pager button handlers (add `setExpandedKey(null)` alongside the `setPage` calls).

Add the panel component below `formatSize`:

```tsx
/**
 * The expanded row's body: the full value plus the metadata the table
 * abbreviates. The value is fetched only while this is mounted.
 */
function RecordPanel({ recordKey, store }: { recordKey: string; store?: string }) {
  const { data, isLoading, isError } = useStateRecord(recordKey, store)

  if (isLoading) {
    return (
      <p className="muted" style={{ padding: 12 }}>
        Loading…
      </p>
    )
  }
  if (isError || !data) {
    return (
      <p className="muted" style={{ padding: 12 }}>
        Couldn't load this value.
      </p>
    )
  }
  return (
    <div data-testid="record-panel" style={{ padding: 12 }}>
      <div className="muted mono" style={{ marginBottom: 8, wordBreak: 'break-all' }}>
        {data.key}
      </div>
      <pre className="json" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {highlightJson(data.value)}
      </pre>
      <div className="muted" style={{ marginTop: 8, fontSize: 12 }}>
        {formatSize(data.size)} · version {data.etag || '—'} · {data.encoding}
        {data.contentType ? ` · ${data.contentType}` : ''}
        {data.truncated ? ' · truncated at 1 MB' : ''}
      </div>
      <button
        type="button"
        className="btn ghost"
        style={{ marginTop: 8 }}
        onClick={() => void navigator.clipboard?.writeText(data.value)}
      >
        Copy value
      </button>
    </div>
  )
}
```

Make the row clickable and render the panel. Replace the `<tr>` in the body map with a fragment:

```tsx
                {items.map((rec) => {
                  const expanded = expandedKey === rec.key
                  return (
                    <React.Fragment key={rec.key}>
                      <tr
                        className={expanded ? 'sel' : undefined}
                        onClick={() => setExpandedKey(expanded ? null : rec.key)}
                      >
                        <td className="iid mono">
                          <span aria-hidden="true" style={{ marginRight: 6 }}>
                            {expanded ? '▾' : '▸'}
                          </span>
                          {rec.logicalKey}
                          {rec.kind !== 'app' && (
                            <span className="typechip" style={{ marginLeft: 6 }}>
                              {rec.kind}
                            </span>
                          )}
                        </td>
                        {/* …App / Value / Size / Version / TTL cells unchanged… */}
                      </tr>
                      {expanded && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface)' }}>
                            <RecordPanel recordKey={rec.key} store={selectedStore ?? undefined} />
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  )
                })}
```

Add `import React from 'react'` (or import `Fragment` by name and use `<Fragment key=…>`), matching whichever style the neighboring pages use.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
cd $WT/web && npx vitest run src/pages/State.test.tsx && cd $WT && make build
```
Expected: PASS for the whole State suite.

- [ ] **Step 5: Commit**

```bash
cd $WT && git branch --show-current
git add web/src/pages/State.tsx web/src/pages/State.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): expand a state row to show its full value

Clicking a row fetches /state/record for that key alone and renders it
through the existing highlightJson helper, with the full key and the
metadata the table abbreviates. One row at a time; expansion clears on
any filter, store or page change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Multi-select and bulk delete

**Files:**
- Modify: `web/src/pages/State.tsx`, `web/src/pages/State.test.tsx`

**Interfaces:**
- Consumes: `useDeleteStateRecords` (Task 8), `ConfirmDialog` from `components/ConfirmDialog`
- Produces: selection + delete UI in `State.tsx`

- [ ] **Step 1: Write the failing tests**

Append to `web/src/pages/State.test.tsx`:

```tsx
describe('State page deletion', () => {
  it('selects rows and posts the selected keys', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    let body: unknown = null
    server.use(
      http.post('/api/state/delete', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json([
          { key: 'myapp||order-42', ok: true },
          { key: 'myapp||order-43', ok: true },
        ])
      }),
    )
    renderAt()
    await screen.findByText('order-42')

    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByLabelText('Select myapp||order-43'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await userEvent.click(await screen.findByTestId('confirm-delete-state'))

    await waitFor(() => expect(body).toEqual({ keys: ['myapp||order-42', 'myapp||order-43'] }))
    expect(await screen.findByText(/deleted 2 records/i)).toBeInTheDocument()
  })

  it('select-all toggles every row on the page', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select all'))
    expect(screen.getByText('2 selected')).toBeInTheDocument()
    await userEvent.click(screen.getByLabelText('Select all'))
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })

  it('reports a partial failure', async () => {
    stubApi({ items: [ITEM, { ...ITEM, key: 'myapp||order-43', logicalKey: 'order-43' }] })
    server.use(
      http.post('/api/state/delete', () =>
        HttpResponse.json([
          { key: 'myapp||order-42', ok: true },
          { key: 'myapp||order-43', ok: false, error: 'boom' },
        ]),
      ),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select all'))
    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await userEvent.click(await screen.findByTestId('confirm-delete-state'))
    expect(await screen.findByText(/deleted 1 record, 1 failed/i)).toBeInTheDocument()
  })

  it('cancelling the dialog deletes nothing', async () => {
    stubApi()
    let called = false
    server.use(
      http.post('/api/state/delete', () => {
        called = true
        return HttpResponse.json([])
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByRole('button', { name: /delete…/i }))
    await userEvent.click(screen.getByRole('button', { name: /cancel/i }))
    expect(called).toBe(false)
    expect(screen.getByText('1 selected')).toBeInTheDocument()
  })

  it('clicking a checkbox does not expand the row', async () => {
    stubApi()
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    expect(screen.queryByTestId('record-panel')).not.toBeInTheDocument()
  })

  it('clears the selection when the page changes', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(STORES)),
      http.get('/api/state/appids', () => HttpResponse.json(['myapp'])),
      http.get('/api/state', ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        if (page === 'tok') return HttpResponse.json({ items: [{ ...ITEM, key: 'myapp||o99', logicalKey: 'o99' }] })
        return HttpResponse.json({ items: [ITEM], nextToken: 'tok' })
      }),
    )
    renderAt()
    await screen.findByText('order-42')
    await userEvent.click(screen.getByLabelText('Select myapp||order-42'))
    await userEvent.click(screen.getByRole('button', { name: /next/i }))
    await screen.findByText('o99')
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd $WT/web && npx vitest run src/pages/State.test.tsx -t 'deletion'
```
Expected: FAIL — no checkbox column, no Delete button.

- [ ] **Step 3: Implement selection and deletion**

In `web/src/pages/State.tsx`:

Add imports and state:

```tsx
import { ConfirmDialog } from '../components/ConfirmDialog'
import { useDeleteStateRecords, useStateAppIds, useStateRecord, useStateRecords } from '../hooks/useStateRecords'
```

```tsx
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleteStatus, setDeleteStatus] = useState<{ ok: number; failed: number } | null>(null)
  const { mutate: deleteRecords } = useDeleteStateRecords()
```

Clear the selection in `resetPaging` (selection is scoped to the visible page, and the selected keys may not exist under a new filter):

```tsx
    setSelected(new Set())
```

and add the same line to both pager handlers.

Handlers:

```tsx
  function toggleRow(key: string, e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation() // never expand the row from the checkbox
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation()
    if (selected.size === items.length && items.length > 0) setSelected(new Set())
    else setSelected(new Set(items.map((r) => r.key)))
  }

  function onConfirmDelete() {
    deleteRecords(
      { keys: Array.from(selected), store: selectedStore ?? undefined },
      {
        onSuccess: (results) => {
          setDeleteStatus({
            ok: results.filter((r) => r.ok).length,
            failed: results.filter((r) => !r.ok).length,
          })
          setSelected(new Set())
          setConfirmOpen(false)
        },
        onError: () => setConfirmOpen(false),
      },
    )
  }

  const allSelected = selected.size === items.length && items.length > 0
  const selectedKeys = Array.from(selected)
```

Status banner, directly after the `loadError` banner:

```tsx
      {deleteStatus && (
        <div
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: deleteStatus.failed > 0 ? 'var(--fail-fg)' : 'var(--accent-bright)',
            fontSize: 13,
          }}
        >
          Deleted {deleteStatus.ok} record{deleteStatus.ok !== 1 ? 's' : ''}
          {deleteStatus.failed > 0 ? `, ${deleteStatus.failed} failed` : ''}.{' '}
          <button
            onClick={() => setDeleteStatus(null)}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: 'inherit',
              fontSize: 'inherit',
              textDecoration: 'underline',
              padding: 0,
            }}
          >
            Dismiss
          </button>
        </div>
      )}
```

Selection bar as the first child of `.card`:

```tsx
        {selected.size > 0 && !isError && (
          <div className="selbar">
            <span className="cnt">{selected.size} selected</span>
            <span className="grow" />
            <button
              className="btn danger"
              data-cy="bulk-delete"
              onClick={() => {
                setDeleteStatus(null)
                setConfirmOpen(true)
              }}
            >
              Delete…
            </button>
          </div>
        )}
```

Checkbox column — a `<th>` before Key, and a `<td>` before the Key cell:

```tsx
                  <th style={{ width: 34 }}>
                    <span
                      className={allSelected ? 'cbx on' : 'cbx'}
                      role="checkbox"
                      aria-checked={allSelected}
                      aria-label="Select all"
                      tabIndex={0}
                      onClick={toggleAll}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleAll(e)
                        }
                      }}
                    />
                  </th>
```

```tsx
                        <td>
                          <span
                            className={selected.has(rec.key) ? 'cbx on' : 'cbx'}
                            role="checkbox"
                            aria-checked={selected.has(rec.key)}
                            aria-label={`Select ${rec.key}`}
                            tabIndex={0}
                            onClick={(e) => toggleRow(rec.key, e)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                toggleRow(rec.key, e)
                              }
                            }}
                          />
                        </td>
```

Update the expanded row's `colSpan` from 6 to **7**.

Dialog at the end of the page, before the closing `</div>`:

```tsx
      <ConfirmDialog
        open={confirmOpen}
        title={`Delete ${selected.size} record${selected.size !== 1 ? 's' : ''}?`}
        confirmLabel="Delete"
        confirmDataCy="confirm-delete-state"
        onConfirm={onConfirmDelete}
        onCancel={() => setConfirmOpen(false)}
      >
        <p className="muted">
          These records will be removed from the state store immediately. This cannot be undone.
        </p>
        <ul className="mono" style={{ fontSize: 12, marginTop: 8 }}>
          {selectedKeys.slice(0, 5).map((k) => (
            <li key={k} style={{ wordBreak: 'break-all' }}>
              {k}
            </li>
          ))}
          {selectedKeys.length > 5 && <li className="muted">…and {selectedKeys.length - 5} more</li>}
        </ul>
      </ConfirmDialog>
```

> `ConfirmRemoveDialog` is deliberately **not** reused: it is workflow-specific (a force checkbox and terminate/purge mechanism copy) and would have to be gutted. `ConfirmDialog` is the shared primitive underneath it.

- [ ] **Step 4: Run the whole web suite and the typecheck**

```bash
cd $WT/web && npx vitest run && cd $WT && make build
```
Expected: PASS, including `src/test/styleguide.test.ts` (no hex literals, no bare template-literal classNames).

- [ ] **Step 5: Commit**

```bash
cd $WT && git branch --show-current
git add web/src/pages/State.tsx web/src/pages/State.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): multi-select and bulk-delete state records

Per-row and select-all checkboxes feed one Delete… action through the
shared ConfirmDialog, which names the keys and states the deletion is
immediate. Per-key results drive a full/partial success banner.

Selection is scoped to the visible page and cleared on any page, filter
or store change.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: Documentation and full verification

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `web/STYLEGUIDE.md`

**Interfaces:**
- Consumes: everything above
- Produces: docs describing the page and its stated limitations

- [ ] **Step 1: Document the page in `README.md`**

Find the section listing the dashboard's pages and add State, in the same style as the neighboring entries. Include the two limitations users will otherwise file as bugs:

```markdown
### State

Browse the records in any connected state store: key, value, version (etag) and
TTL, paginated, with multi-select deletion. Read only — records cannot be edited
from the dashboard.

Two limitations worth knowing:

- **Workflow history and actor state are hidden by default.** Both live in the
  same keyspace as your app's records. Use **Show internal keys** to reveal them.
- **There is no "last modified" column.** Dapr's state components do not expose a
  modification timestamp, so none can be shown. The Version column is the
  backend's etag: it changes on every write, but it is not a time.

Stores that cannot be opened directly — an in-memory store inside a
testcontainers app, for example — cannot be browsed at all: Dapr's state API has
no way to enumerate keys, so there is nothing to page over.
```

- [ ] **Step 2: Document the architecture in `ARCHITECTURE.md`**

Add `pkg/state` to the package list/diagram wherever `pkg/workflow` is described, with a short entry:

```markdown
- **`pkg/state`** — reads and deletes state-store records for the State page.
  Pages keys through `statestore.Store.Keys`, classifies them (app / workflow /
  actor) on key text alone, then does one bulk value read per page via
  `statestore.RecordReader`. Unlike `pkg/workflow` it has no sidecar fallback:
  Dapr's HTTP State API cannot enumerate keys.
```

- [ ] **Step 3: Add `DateTimeCell` to the styleguide component catalog**

In `web/STYLEGUIDE.md` §5, add an entry next to the other small table primitives:

```markdown
- `components/DateTimeCell.tsx` — a timestamp split into `.dt-date` + `.dt-time`
  spans so it sits on one line when there's room and stacks when the column is
  narrow. Falls back to an em dash. Used by the Workflows and State tables.
```

The styleguide freshness test asserts that every backtick-quoted `components/*.tsx` path in that file exists, so this entry is checked automatically.

- [ ] **Step 4: Run every gate**

```bash
cd $WT && make lint && make test && make build
```
Expected: all PASS. `make test` runs both `test-go` (with `-tags unit -race`) and `test-web`.

```bash
cd $WT && make test-integration
```
Expected: PASS (needs a container runtime for redis/postgres/mongo).

- [ ] **Step 5: Smoke-test against a real store**

```bash
cd $WT && ./bin/diagrid-dev-dashboard --help
```

Then, with a Dapr app running against redis or sqlite, start the dashboard and check by hand:

1. **State** appears in the nav after Workflows; the page lists records.
2. A workflow-heavy store shows only app records until **Show internal keys** is ticked.
3. The app dropdown lists prefixes; picking one filters; searching a key with an underscore matches literally.
4. Expanding a row shows the pretty-printed value; Copy works.
5. Selecting rows and deleting removes them, and the row count drops on the next refresh.
6. Switching to a store that cannot be opened shows the banner with the chrome intact.

- [ ] **Step 6: Commit and open the PR**

```bash
cd $WT && git branch --show-current
git add README.md ARCHITECTURE.md web/STYLEGUIDE.md
git commit -m "$(cat <<'EOF'
docs: document the State page and pkg/state

Records the two limitations users would otherwise file as bugs: internal
keys are hidden by default, and there is no last-modified column because
Dapr's state components do not expose one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
git push -u origin HEAD
gh pr create --title "feat: State page for browsing state-store records" --body "$(cat <<'EOF'
Adds a read-only, paginated **State** page listing state-store records
(key, value, version, TTL) for any connected store, with multi-select
deletion.

Spec: `docs/superpowers/specs/2026-08-26-state-records-page-design.md`
Plan: `docs/superpowers/plans/2026-08-26-state-records-page.md`

## Notes for reviewers

- `pkg/statestore` gains `Record` + an optional `RecordReader`; `Get`/`BulkGet`
  are untouched. The capability is asserted once, in `buildStoreEntry`.
- `pkg/state.List` classifies on key text alone and does exactly one bulk value
  read per page, so a workflow-heavy store costs only key bytes to skip.
- Search and the app filter are pushed into the `KeysLike` pattern with
  backslash escaping, so a literal `_` does not act as a wildcard.
- No "last modified" column: components-contrib exposes only etag and
  `ttlExpireTime` for all four backends. The spec explains why.
- Stores that cannot be opened directly cannot be browsed — Dapr's HTTP State
  API cannot enumerate keys, so there is no sidecar fallback.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Widening `pkg/statestore` (`Record`, `RecordReader`, real bulk get) | 1 |
| Optional-interface rationale, single assertion seam | 1, 7 |
| Key classification table + heuristic caveat | 2 |
| LIKE escaping (search **and** app id) | 2 |
| `List` order of operations, loop-fill, scan cap | 5 |
| One bulk read per page | 5 (asserted in `TestListReadsValuesOnceForTheReturnedPageOnly`) |
| `AppIDs` filter-independence, unprefixed keys | 4 |
| Value encoding, 200-char preview, 1 MiB detail cap | 3, 5 |
| `Delete` per-key results, single mechanism | 4 |
| API surface, `key` as query param, limit cap | 6 |
| Error mapping incl. no-400-for-pattern | 6 |
| `caps.State`, `Options.StateBackend`, `StateFor`, `storeEntry.state` | 7 |
| Nav + gated route + `rumView` | 9 |
| Page structure, columns, Version tooltip, no timestamp column | 9 |
| Row expansion via `highlightJson`, one at a time, Copy | 10 |
| Bulk delete via `ConfirmDialog` (not `ConfirmRemoveDialog`) | 11 |
| Pager with Prev history, `X–Y loaded`, no status counters | 9 |
| Not-browsable / 503 degradation with chrome intact | 9 |
| Testing plan (all bullets) | 1–11 |
| Files-touched list | all |

Two spec items are covered indirectly and deliberately: **redis's full-SCAN cost** is documented in `pkg/state`'s `List` comment rather than tested (it is a property of the backend, not of our code), and **`ContentType`** is carried end-to-end and rendered in the expansion panel but has no assertion, since no supported backend populates it.

**Placeholder scan:** clean — no TBD/TODO, every code step carries real code, and no step says "similar to Task N".

**Type consistency:** `statestore.Record` (Go, byte-valued) and `state.Record` (wire, string-valued) are distinct types with the same name in different packages; Task 5 uses both in one file, so `statestore.Record` is always package-qualified there. `Item.ETag` ↔ `etag?: string`, `Item.TTLExpiresAt` ↔ `ttlExpiresAt?: string`, `Kind` ↔ `StateKind` all line up. The checkbox column makes the expanded row's `colSpan` 7, which Task 11 Step 3 changes explicitly.

One thing an executor should watch: Task 7's `recordingStore` embeds `patternKeysStore` from `cmd/workflow_test.go:126`, which this plan has not read in full. If its receivers are pointers, adjust the embed as the step notes.
