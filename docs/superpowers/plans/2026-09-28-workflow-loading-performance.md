# Workflow Loading Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Workflows page responsive on state stores with thousands of workflow instances, on Redis, PostgreSQL, SQLite and MongoDB alike (issue #93).

**Architecture:** Remove the per-instance `KeysLike` scan by deriving history keys from the instance metadata record's `HistoryLength`, back `Store.BulkGet` with the backends' native bulk read, load instances with bounded concurrency, and cache list/stats summaries keyed on the raw metadata bytes. On the web side, cancel superseded requests, poll Stats less often, and keep the previous rows visible (store-scoped) while a new filter loads.

**Tech Stack:** Go 1.26 (`dapr/components-contrib` v1.18.0, `dapr/durabletask-go` v0.12.1, testcontainers-go v0.43.0), React + TypeScript + TanStack Query v5 + Vitest + MSW.

**Spec:** `docs/superpowers/specs/2026-09-28-workflow-loading-performance-design.md`

## Global Constraints

- Work only in the worktree `/Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf` on branch `worktree-workflow-loading-perf`. Use absolute paths; before every commit run `git -C /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf branch --show-current` and confirm it prints `worktree-workflow-loading-perf` (subagents start in the main repo cwd).
- Go tests are build-tag gated: always pass `-tags unit` or `-tags integration`. A bare `go test ./...` runs nothing.
- No new Go or npm dependencies. No changes to `go.mod` beyond what `go mod tidy` does on its own (it should do nothing).
- `pkg/*` must not import `cmd/`.
- No change to API response shapes (`ListResult`, `StatsResult`, `Execution`) or HTTP routes.
- Constants (exact values from the spec): `maxHistoryEntries = 1_000_000`, `bulkGetChunk = 100`, `bulkGetParallelism = 16`, `instanceLoadConcurrency = 8`, `maxCachedSummaries = 20_000`, `STATS_MIN_REFETCH_MS = 10_000`.
- Frontend follows `web/STYLEGUIDE.md`: reuse existing classes and the `Spinner` component; no new colors or CSS primitives.
- Vitest does not typecheck: run `cd web && npx tsc -b` after any `.ts`/`.tsx` change, test files included.
- Commits use Conventional Commit prefixes and end with the line `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- **Deviation from spec §3, on purpose:** only summaries loaded through the metadata-derived path are cached. Results from the scan fallback (metadata `{}`, zero length, undecodable) are **not** cached, because a `{}` metadata record never changes when history grows, so its bytes can't signal staleness. Real Dapr data always takes the metadata path.
- **Clarification of spec §6:** placeholder rows are kept across filter/search/page changes **within the same store only**. On a store switch the table shows the first-load state, because another store's rows must never be clickable or removable against the newly selected store.

## Review Focus

1. **Store switch while a load is pending**: the previous store's rows must not show (links and removal would target the wrong store). Pinned by a hook test in Task 7.
2. **Pager clicked while placeholder rows are shown**: `nextToken` belongs to the previous query, so Prev/Next must be disabled while updating. Pinned in Task 8.
3. **Row selection while placeholder rows are shown**: selecting a stale row could feed the removal dialog a row the new filter doesn't contain. Toggling is blocked while updating. Pinned in Task 8.
4. **Instance with more than 100 history events**: its history spans several `BulkGet` chunks and must decode completely and in order. Pinned in Task 2 (chunking) and Task 6 (150-event instance, all four backends).
5. **Request cancelled mid-page**: `List`/`Stats` must return the context error rather than a silently partial page or counts. Pinned in Task 4.

---

### Task 1: Integration harness + baseline benchmark

Build the shared multi-backend test harness and a benchmark, and record **before** numbers against the unchanged code.

**Files:**
- Create: `pkg/workflow/backends_integration_test.go`
- Create: `pkg/workflow/seed_integration_test.go`
- Create: `pkg/workflow/bench_integration_test.go`

**Interfaces:**
- Produces (package `workflow_test`, build tag `integration`):
  - `var backendKinds = []string{"sqlite", "redis", "postgres", "mongodb"}`
  - `func openStore(tb testing.TB, kind string) statestore.Store` (skips container kinds when no container provider is healthy)
  - `func buildHistory(i, n int, parent string) []*protos.HistoryEvent`
  - `type metaFormat int` with `metaProto`, `metaLegacyJSON`, `metaEmptyJSON`
  - `func seedInstance(tb testing.TB, store statestore.Store, ns, appID, id string, history []*protos.HistoryEvent, customStatus string, mf metaFormat)`
  - `func seedMany(tb testing.TB, store statestore.Store, n int)`: seeds `n` instances across apps `order` and `billing` in namespace `default` (see code for the mix)

- [ ] **Step 1: Write the backend harness**

`pkg/workflow/backends_integration_test.go`:

```go
//go:build integration

package workflow_test

import (
	"context"
	"path/filepath"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"github.com/testcontainers/testcontainers-go"
	tcmongo "github.com/testcontainers/testcontainers-go/modules/mongodb"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
)

// backendKinds lists every supported state store. SQLite always runs; the
// others need a healthy container provider and skip otherwise.
var backendKinds = []string{"sqlite", "redis", "postgres", "mongodb"}

// skipIfNoContainers mirrors testcontainers.SkipIfProviderIsNotHealthy but
// accepts testing.TB so benchmarks can use it too.
func skipIfNoContainers(tb testing.TB) {
	tb.Helper()
	defer func() {
		if r := recover(); r != nil {
			tb.Skipf("container provider unavailable: %v", r)
		}
	}()
	p, err := testcontainers.ProviderDocker.GetProvider()
	if err != nil {
		tb.Skipf("container provider unavailable: %v", err)
	}
	if err := p.Health(context.Background()); err != nil {
		tb.Skipf("container provider unhealthy: %v", err)
	}
}

// openStore starts (for container kinds) and opens a fresh, empty store of
// the given kind. Everything is torn down via tb.Cleanup.
func openStore(tb testing.TB, kind string) statestore.Store {
	tb.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	tb.Cleanup(cancel)

	var comp statestore.Component
	switch kind {
	case "sqlite":
		comp = statestore.Component{Name: "statestore", Type: "state.sqlite", Version: "v1",
			Metadata: map[string]string{"connectionString": filepath.Join(tb.TempDir(), "wf.db")}}
	case "redis":
		skipIfNoContainers(tb)
		c, err := tcredis.Run(ctx, "redis:7")
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		host, err := c.Host(ctx)
		require.NoError(tb, err)
		port, err := c.MappedPort(ctx, "6379/tcp")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.redis", Version: "v1",
			Metadata: map[string]string{"redisHost": host + ":" + port.Port(), "redisPassword": ""}}
	case "postgres":
		skipIfNoContainers(tb)
		c, err := tcpostgres.Run(ctx, "postgres:16-alpine",
			tcpostgres.WithDatabase("dapr"),
			tcpostgres.WithUsername("dapr"),
			tcpostgres.WithPassword("dapr"),
			tcpostgres.BasicWaitStrategies(),
		)
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		cs, err := c.ConnectionString(ctx, "sslmode=disable")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.postgresql", Version: "v1",
			Metadata: map[string]string{"connectionString": cs}}
	case "mongodb":
		skipIfNoContainers(tb)
		c, err := tcmongo.Run(ctx, "mongo:7")
		require.NoError(tb, err)
		tb.Cleanup(func() { _ = c.Terminate(context.Background()) })
		host, err := c.Host(ctx)
		require.NoError(tb, err)
		port, err := c.MappedPort(ctx, "27017/tcp")
		require.NoError(tb, err)
		comp = statestore.Component{Name: "statestore", Type: "state.mongodb", Version: "v1",
			Metadata: map[string]string{"host": host + ":" + port.Port(), "databaseName": "daprStore"}}
	default:
		tb.Fatalf("unknown backend kind %q", kind)
	}

	store, err := statestore.New(ctx, comp)
	require.NoError(tb, err)
	tb.Cleanup(func() { _ = store.Close() })
	return store
}
```

- [ ] **Step 2: Write the seed helpers**

`pkg/workflow/seed_integration_test.go`:

```go
//go:build integration

package workflow_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type metaFormat int

const (
	metaProto      metaFormat = iota // Dapr 1.16+: BackendWorkflowStateMetadata proto
	metaLegacyJSON                   // Dapr < 1.16: {"InboxLength","HistoryLength","Generation"}
	metaEmptyJSON                    // test fixtures: "{}" (forces the scan fallback)
)

// buildHistory returns n (>= 1) history events for synthetic instance i:
// ExecutionStarted, then TaskScheduled filler, then a terminal event chosen
// by i%4 (0 = still running, 1 = completed, 2 = failed, 3 = terminated).
// parent != "" marks the instance as a child of that instance id.
func buildHistory(i, n int, parent string) []*protos.HistoryEvent {
	base := time.Date(2026, 9, 1, 0, 0, 0, 0, time.UTC).Add(time.Duration(i) * time.Minute)
	ts := func(k int) *timestamppb.Timestamp { return timestamppb.New(base.Add(time.Duration(k) * time.Second)) }

	started := &protos.ExecutionStartedEvent{Name: fmt.Sprintf("Workflow%d", i%5), Input: wrapperspb.String(`{}`)}
	if parent != "" {
		started.ParentInstance = &protos.ParentInstanceInfo{WorkflowInstance: &protos.WorkflowInstance{InstanceId: parent}}
	}
	h := []*protos.HistoryEvent{{EventId: -1, Timestamp: ts(0), EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: started}}}

	terminal := i%4 != 0
	fill := n - 1
	if terminal {
		fill = n - 2
	}
	for k := 0; k < fill; k++ {
		h = append(h, &protos.HistoryEvent{EventId: int32(k), Timestamp: ts(k + 1),
			EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "Activity"}}})
	}
	if terminal {
		ev := &protos.ExecutionCompletedEvent{}
		switch i % 4 {
		case 1:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED
			ev.Result = wrapperspb.String(`"ok"`)
		case 2:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED
			ev.FailureDetails = &protos.TaskFailureDetails{ErrorType: "Boom", ErrorMessage: "failed on purpose"}
		case 3:
			ev.WorkflowStatus = protos.OrchestrationStatus_ORCHESTRATION_STATUS_TERMINATED
		}
		h = append(h, &protos.HistoryEvent{EventId: -1, Timestamp: ts(n),
			EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: ev}})
	}
	return h
}

// seedInstance writes one instance's metadata, history-* and (optional)
// customStatus keys exactly as Dapr lays them out.
func seedInstance(tb testing.TB, store statestore.Store, ns, appID, id string, history []*protos.HistoryEvent, customStatus string, mf metaFormat) {
	tb.Helper()
	ctx := context.Background()
	prefix := statestore.InstancePrefix(ns, appID, id)

	var meta []byte
	switch mf {
	case metaProto:
		b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: uint64(len(history)), Generation: 1})
		require.NoError(tb, err)
		meta = b
	case metaLegacyJSON:
		meta = []byte(fmt.Sprintf(`{"InboxLength":0,"HistoryLength":%d,"Generation":1}`, len(history)))
	case metaEmptyJSON:
		meta = []byte(`{}`)
	}
	require.NoError(tb, store.Set(ctx, prefix+statestore.SuffixMetadata, meta))
	for k, e := range history {
		b, err := proto.Marshal(e)
		require.NoError(tb, err)
		require.NoError(tb, store.Set(ctx, prefix+fmt.Sprintf("%s%06d", statestore.HistoryPrefix, k), b))
	}
	if customStatus != "" {
		require.NoError(tb, store.Set(ctx, prefix+statestore.SuffixCustomStatus, []byte(customStatus)))
	}
}

// seedMany seeds n instances in namespace "default", split across apps
// "order" (even i) and "billing" (odd i). The mix covers every load path:
//   - i == 0: 150 history events (spans several BulkGet chunks)
//   - i == 1: metadata "{}" (scan fallback)
//   - i%50 == 7: legacy JSON metadata
//   - i%10 == 3 (i > 3): child of instance i-1
//   - i%3 == 0: has a customStatus
//   - everything else: 5-30 events, proto metadata
func seedMany(tb testing.TB, store statestore.Store, n int) {
	tb.Helper()
	for i := 0; i < n; i++ {
		appID := "order"
		if i%2 == 1 {
			appID = "billing"
		}
		id := fmt.Sprintf("inst-%04d", i)
		events := 5 + i%26
		if i == 0 {
			events = 150
		}
		parent := ""
		if i%10 == 3 && i > 3 {
			parent = fmt.Sprintf("inst-%04d", i-1)
		}
		cs := ""
		if i%3 == 0 {
			cs = fmt.Sprintf(`{"step":%d}`, i)
		}
		mf := metaProto
		switch {
		case i == 1:
			mf = metaEmptyJSON
		case i%50 == 7:
			mf = metaLegacyJSON
		}
		seedInstance(tb, store, "default", appID, id, buildHistory(i, events, parent), cs, mf)
	}
}
```

- [ ] **Step 3: Write the benchmark**

`pkg/workflow/bench_integration_test.go`:

```go
//go:build integration

package workflow_test

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

// BenchmarkWorkflowListStats measures one list page, a cold Stats (fresh
// service, empty cache) and a warm Stats (reused service) per backend over
// 2 000 seeded instances. Run manually; not a CI gate:
//
//	go test -tags integration -run '^$' -bench BenchmarkWorkflowListStats -benchtime 5x ./pkg/workflow
func BenchmarkWorkflowListStats(b *testing.B) {
	for _, kind := range backendKinds {
		b.Run(kind, func(b *testing.B) {
			store := openStore(b, kind)
			seedMany(b, store, 2000)
			ctx := context.Background()
			q := workflow.ListQuery{IncludeChildren: true}

			b.Run("list-page", func(b *testing.B) {
				svc := workflow.New(store, "default")
				for b.Loop() {
					_, err := svc.List(ctx, q)
					require.NoError(b, err)
				}
			})
			b.Run("stats-cold", func(b *testing.B) {
				for b.Loop() {
					_, err := workflow.New(store, "default").Stats(ctx, q)
					require.NoError(b, err)
				}
			})
			b.Run("stats-warm", func(b *testing.B) {
				svc := workflow.New(store, "default")
				_, err := svc.Stats(ctx, q)
				require.NoError(b, err)
				for b.Loop() {
					_, err := svc.Stats(ctx, q)
					require.NoError(b, err)
				}
			})
		})
	}
}
```

- [ ] **Step 4: Verify it compiles and runs on SQLite**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go vet -tags integration ./pkg/workflow/ && go test -tags integration -run '^$' -bench 'BenchmarkWorkflowListStats/sqlite' -benchtime 1x ./pkg/workflow`
Expected: vet clean; benchmark prints `list-page`, `stats-cold`, `stats-warm` lines for sqlite.

- [ ] **Step 5: Record baseline numbers (all backends)**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags integration -run '^$' -bench BenchmarkWorkflowListStats -benchtime 3x -timeout 60m ./pkg/workflow | tee /tmp/wf-bench-before.txt`
Expected: ns/op lines for each backend available locally (container backends skip without Docker). Keep `/tmp/wf-bench-before.txt`; Task 9 puts these numbers in the PR description. **Don't commit it.** If Redis Stats takes longer than the timeout at 2 000 instances, rerun with `-benchtime 1x` and note that in the results.

- [ ] **Step 6: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/workflow/backends_integration_test.go pkg/workflow/seed_integration_test.go pkg/workflow/bench_integration_test.go
git commit -m "test(workflow): multi-backend integration harness and list/stats benchmark

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 2: `HistoryKey` helper + native chunked `BulkGet`

**Files:**
- Modify: `pkg/statestore/keys.go` (add `HistoryKey`)
- Modify: `pkg/statestore/store.go:149-161` (replace `ccStore.BulkGet`)
- Test: `pkg/statestore/keys_test.go`, create `pkg/statestore/bulkget_test.go`
- Test: `pkg/statestore/store_integration_test.go` (extend `runStoreContract`)

**Interfaces:**
- Produces:
  - `func HistoryKey(i uint64) string`: returns the key **suffix** `history-NNNNNN` (at least 6 digits, zero-padded), e.g. `HistoryKey(7) == "history-000007"`, `HistoryKey(1234567) == "history-1234567"`.
  - `ccStore.BulkGet` contract unchanged: `map[string][]byte` with one entry per requested key, `nil` for a missing key; any per-key backend error fails the call.
  - Unexported `func bulkGetChunked(ctx context.Context, bs state.BulkStore, keys []string, chunk int) (map[string][]byte, error)`.

- [ ] **Step 1: Write the failing unit tests**

Append to `pkg/statestore/keys_test.go`:

```go
func TestHistoryKey(t *testing.T) {
	require.Equal(t, "history-000000", HistoryKey(0))
	require.Equal(t, "history-000007", HistoryKey(7))
	require.Equal(t, "history-999999", HistoryKey(999999))
	require.Equal(t, "history-1234567", HistoryKey(1234567))
}
```

(If `keys_test.go` doesn't import `require` yet, add `"github.com/stretchr/testify/require"`. Keep its existing `//go:build unit` tag.)

Create `pkg/statestore/bulkget_test.go`:

```go
//go:build unit

package statestore

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/dapr/components-contrib/state"
	"github.com/stretchr/testify/require"
)

// fakeBulk is a state.BulkStore that serves BulkGet from a map and records
// the size of every request, so tests can assert chunking. Like the native
// backends, it returns results in arbitrary order and a Key-only entry for
// a missing key.
type fakeBulk struct {
	kv     map[string][]byte
	calls  []int
	errKey string
	failAt int // 1-based BulkGet call that returns a transport error; 0 = never
}

func (f *fakeBulk) BulkGet(_ context.Context, req []state.GetRequest, _ state.BulkGetOpts) ([]state.BulkGetResponse, error) {
	f.calls = append(f.calls, len(req))
	if f.failAt == len(f.calls) {
		return nil, errors.New("transport down")
	}
	out := make([]state.BulkGetResponse, 0, len(req))
	for i := len(req) - 1; i >= 0; i-- { // reversed: order must not matter
		k := req[i].Key
		r := state.BulkGetResponse{Key: k, Data: f.kv[k]}
		if k == f.errKey {
			r.Error = "row decode failed"
		}
		out = append(out, r)
	}
	return out, nil
}
func (f *fakeBulk) BulkSet(context.Context, []state.SetRequest, state.BulkStoreOpts) error {
	return nil
}
func (f *fakeBulk) BulkDelete(context.Context, []state.DeleteRequest, state.BulkStoreOpts) error {
	return nil
}

func TestBulkGetChunkedSplitsAndMaps(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{}}
	var keys []string
	for i := 0; i < 250; i++ {
		k := fmt.Sprintf("k%03d", i)
		keys = append(keys, k)
		if i != 42 {
			f.kv[k] = []byte("v" + k)
		}
	}
	got, err := bulkGetChunked(context.Background(), f, keys, 100)
	require.NoError(t, err)
	require.Equal(t, []int{100, 100, 50}, f.calls)
	require.Len(t, got, 250, "every requested key has an entry")
	require.Equal(t, []byte("vk000"), got["k000"])
	require.Equal(t, []byte("vk249"), got["k249"])
	v, ok := got["k042"]
	require.True(t, ok, "a missing key is present in the map")
	require.Nil(t, v, "a missing key maps to nil")
}

func TestBulkGetChunkedPerKeyErrorFails(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{"a": []byte("1")}, errKey: "a"}
	_, err := bulkGetChunked(context.Background(), f, []string{"a"}, 100)
	require.ErrorContains(t, err, "row decode failed")
}

func TestBulkGetChunkedTransportErrorFails(t *testing.T) {
	f := &fakeBulk{kv: map[string][]byte{}, failAt: 2}
	keys := make([]string, 150)
	for i := range keys {
		keys[i] = fmt.Sprintf("k%d", i)
	}
	_, err := bulkGetChunked(context.Background(), f, keys, 100)
	require.ErrorContains(t, err, "transport down")
}

func TestBulkGetChunkedEmpty(t *testing.T) {
	f := &fakeBulk{}
	got, err := bulkGetChunked(context.Background(), f, nil, 100)
	require.NoError(t, err)
	require.Empty(t, got)
	require.Empty(t, f.calls, "no backend round-trip for zero keys")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit ./pkg/statestore/ -run 'TestHistoryKey|TestBulkGetChunked'`
Expected: FAIL to compile, `undefined: HistoryKey` and `undefined: bulkGetChunked`.

- [ ] **Step 3: Implement `HistoryKey`**

In `pkg/statestore/keys.go`, add `"strconv"` to the imports and append:

```go
// HistoryKey returns the key suffix of an instance's i-th history entry,
// matching Dapr's naming: "history-" + i zero-padded to at least 6 digits.
// Prepend InstancePrefix to get the full key.
func HistoryKey(i uint64) string {
	s := strconv.FormatUint(i, 10)
	if len(s) < 6 {
		s = strings.Repeat("0", 6-len(s)) + s
	}
	return HistoryPrefix + s
}
```

- [ ] **Step 4: Replace `ccStore.BulkGet`**

In `pkg/statestore/store.go`, replace the whole `BulkGet` method (the comment block starting `// BulkGet retrieves multiple keys in a sequential loop.` through the closing brace) with:

```go
const (
	// bulkGetChunk caps keys per backend bulk read: well under SQLite's
	// bound-parameter limit, and small enough to keep PostgreSQL/MongoDB
	// queries cheap.
	bulkGetChunk = 100
	// bulkGetParallelism bounds concurrent Gets for backends whose BulkGet is
	// contrib's DefaultBulkStore (Redis); native implementations ignore it.
	bulkGetParallelism = 16
)

// BulkGet reads many keys through the backend's bulk path: one query per
// chunk on PostgreSQL, SQLite and MongoDB; bounded parallel Gets on Redis.
// The result has an entry for every requested key, nil when the key is
// missing. A per-key backend error fails the whole call, like Get.
func (s *ccStore) BulkGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	bs, ok := s.inner.(state.BulkStore)
	if !ok {
		// Defensive: state.Store embeds BulkStore, so every supported
		// backend takes the branch above.
		out := make(map[string][]byte, len(keys))
		for _, k := range keys {
			b, err := s.Get(ctx, k)
			if err != nil {
				return nil, err
			}
			out[k] = b
		}
		return out, nil
	}
	return bulkGetChunked(ctx, bs, keys, bulkGetChunk)
}

// bulkGetChunked issues one bs.BulkGet per chunk of keys and merges the
// responses by key (backends may return them in any order).
func bulkGetChunked(ctx context.Context, bs state.BulkStore, keys []string, chunk int) (map[string][]byte, error) {
	out := make(map[string][]byte, len(keys))
	for start := 0; start < len(keys); start += chunk {
		end := min(start+chunk, len(keys))
		reqs := make([]state.GetRequest, 0, end-start)
		for _, k := range keys[start:end] {
			reqs = append(reqs, state.GetRequest{Key: k})
			out[k] = nil
		}
		resp, err := bs.BulkGet(ctx, reqs, state.BulkGetOpts{Parallelism: bulkGetParallelism})
		if err != nil {
			return nil, err
		}
		for _, r := range resp {
			if r.Error != "" {
				return nil, fmt.Errorf("bulk get %q: %s", r.Key, r.Error)
			}
			if _, want := out[r.Key]; want {
				out[r.Key] = r.Data
			}
		}
	}
	return out, nil
}
```

- [ ] **Step 5: Run the unit tests to verify they pass**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit -race ./pkg/statestore/ ./pkg/workflow/`
Expected: PASS (workflow tests use a fake store and are unaffected).

- [ ] **Step 6: Extend the cross-backend contract test**

In `pkg/statestore/store_integration_test.go`, add `"fmt"` and `"google.golang.org/protobuf/types/known/wrapperspb"` plus `"google.golang.org/protobuf/proto"` to the imports, and append this block at the end of `runStoreContract` (after `require.Empty(t, mustRecords(t, rr, nil), ...)`):

```go
	// BulkGet parity: binary (proto) values must come back byte-identical to
	// Get on every backend (SQLite base64-encodes binary values at rest), a
	// missing key maps to nil, and >bulkGetChunk keys span several chunks.
	bin, err := proto.Marshal(wrapperspb.String("binary\x00payload\xff"))
	require.NoError(t, err)
	var bulkKeys []string
	for i := 0; i < 130; i++ {
		k := fmt.Sprintf("k||a||bulk||history-%06d", i)
		require.NoError(t, store.Set(ctx, k, bin))
		bulkKeys = append(bulkKeys, k)
	}
	missing := "k||a||bulk||absent"
	got2, err := store.BulkGet(ctx, append(bulkKeys, missing))
	require.NoError(t, err)
	require.Len(t, got2, len(bulkKeys)+1)
	for _, k := range bulkKeys {
		single, err := store.Get(ctx, k)
		require.NoError(t, err)
		require.Equal(t, single, got2[k], "BulkGet bytes must equal Get bytes for %s", k)
		require.Equal(t, bin, got2[k])
	}
	require.Nil(t, got2[missing])
```

- [ ] **Step 7: Run the contract on every backend**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags integration -race ./pkg/statestore/ -run 'StoreContract' -v`
Expected: PASS for SQLite, Redis, Postgres, Mongo (container tests SKIP only if Docker is unavailable; if so, say so in the task report). **If one backend fails parity**, don't change the test. Instead, make `ccStore.BulkGet` use the `Get` loop for that `s.storeType` only (a `switch s.storeType` before the type assertion) with a comment naming the failing behaviour, then rerun.

- [ ] **Step 8: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/statestore/keys.go pkg/statestore/keys_test.go pkg/statestore/store.go pkg/statestore/bulkget_test.go pkg/statestore/store_integration_test.go
git commit -m "perf(statestore): native chunked BulkGet and HistoryKey helper

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 3: Metadata-driven instance load with scan fallback

**Files:**
- Modify: `pkg/workflow/decode.go` (add `historyLength`, `maxHistoryEntries`)
- Modify: `pkg/workflow/service.go` (replace `load` at the end of the file with `load` / `loadWithMeta` / `loadByScan` / `decodeInstance`)
- Create: `pkg/workflow/load_test.go`
- Test: `pkg/workflow/decode_test.go`

**Interfaces:**
- Consumes: `statestore.HistoryKey(i uint64) string` (Task 2).
- Produces (package `workflow`, unexported):
  - `const maxHistoryEntries = 1_000_000`
  - `func historyLength(meta []byte) (n uint64, ok bool)`: ok only when the record decodes and `0 < n <= maxHistoryEntries`.
  - `func (s *service) load(ctx context.Context, ns, appID, instanceID string) (Execution, error)`: signature unchanged.
  - `func (s *service) loadWithMeta(ctx context.Context, ns, appID, instanceID string, meta []byte) (ex Execution, fromMeta bool, err error)`: `fromMeta` is true when the metadata path was used (Task 5 caches only those).
  - `func (s *service) loadByScan(ctx context.Context, ns, appID, instanceID string) (Execution, error)`
  - `func decodeInstance(appID, instanceID, prefix string, values map[string][]byte) Execution`
- Test helpers (package `workflow`, `load_test.go`): `type countingStore`, `func newCountingStore(f *fakeStore) *countingStore`, `func (c *countingStore) historyReads() int`, `func (c *countingStore) reset()`, `func seedWorkflowProto(t *testing.T, f *fakeStore, ns, appID, instanceID string, events []*protos.HistoryEvent)`.

- [ ] **Step 1: Write the failing decode test**

Append to `pkg/workflow/decode_test.go`:

```go
func TestHistoryLength(t *testing.T) {
	pb := func(n uint64) []byte {
		b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: n, Generation: 1})
		require.NoError(t, err)
		return b
	}
	cases := []struct {
		name   string
		meta   []byte
		wantN  uint64
		wantOK bool
	}{
		{"proto", pb(12), 12, true},
		{"proto zero length", pb(0), 0, false},
		{"proto at bound", pb(maxHistoryEntries), maxHistoryEntries, true},
		{"proto over bound", pb(maxHistoryEntries + 1), maxHistoryEntries + 1, false},
		{"legacy json", []byte(`{"InboxLength":0,"HistoryLength":3,"Generation":2}`), 3, true},
		{"legacy json lower-case keys", []byte(`{"historyLength":4}`), 4, true},
		{"empty json object", []byte(`{}`), 0, false},
		{"json-looking garbage", []byte(`{not json`), 0, false},
		{"nil", nil, 0, false},
		{"empty", []byte{}, 0, false},
		{"binary garbage", []byte{0xff, 0xff, 0xff}, 0, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			n, ok := historyLength(c.meta)
			require.Equal(t, c.wantOK, ok)
			if c.wantOK {
				require.Equal(t, c.wantN, n)
			}
		})
	}
}
```

Add `"google.golang.org/protobuf/proto"` to `decode_test.go`'s imports (it already has `protos` and `require`).

- [ ] **Step 2: Write the failing load tests**

Create `pkg/workflow/load_test.go`:

```go
//go:build unit

package workflow

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// countingStore wraps fakeStore and counts store round-trips so tests can
// pin how many scans and reads each operation costs. Safe for concurrent use
// as long as the underlying map is not written concurrently.
type countingStore struct {
	*fakeStore
	keys, gets, bulkGets atomic.Int32
	mu                   sync.Mutex
	bulkKeys             []string
}

func newCountingStore(f *fakeStore) *countingStore { return &countingStore{fakeStore: f} }

func (c *countingStore) Keys(ctx context.Context, p, tok string, n int) ([]string, string, error) {
	c.keys.Add(1)
	return c.fakeStore.Keys(ctx, p, tok, n)
}
func (c *countingStore) Get(ctx context.Context, k string) ([]byte, error) {
	c.gets.Add(1)
	return c.fakeStore.Get(ctx, k)
}
func (c *countingStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	c.bulkGets.Add(1)
	c.mu.Lock()
	c.bulkKeys = append(c.bulkKeys, ks...)
	c.mu.Unlock()
	return c.fakeStore.BulkGet(ctx, ks)
}

// historyReads counts history-* keys requested through BulkGet.
func (c *countingStore) historyReads() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	n := 0
	for _, k := range c.bulkKeys {
		if strings.Contains(k, statestore.KeyDelimiter+statestore.HistoryPrefix) {
			n++
		}
	}
	return n
}

func (c *countingStore) reset() {
	c.keys.Store(0)
	c.gets.Store(0)
	c.bulkGets.Store(0)
	c.mu.Lock()
	c.bulkKeys = nil
	c.mu.Unlock()
}

// seedWorkflowProto writes an instance the way Dapr 1.16+ does: a
// BackendWorkflowStateMetadata proto whose HistoryLength matches the events.
func seedWorkflowProto(t *testing.T, f *fakeStore, ns, appID, instanceID string, events []*protos.HistoryEvent) {
	t.Helper()
	seedWorkflow(t, f, ns, appID, instanceID, "", events)
	b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: uint64(len(events)), Generation: 1})
	require.NoError(t, err)
	f.kv[statestore.InstancePrefix(ns, appID, instanceID)+statestore.SuffixMetadata] = b
}

func TestLoadProtoMetadataSkipsKeyScan(t *testing.T) {
	f := newFakeStore()
	seedWorkflowProto(t, f, "default", "order", "inst-a", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("ignored")})
	cs := newCountingStore(f)

	ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Equal(t, "OrderWorkflow", ex.Name)
	require.Len(t, ex.History, 2)
	require.EqualValues(t, 0, cs.keys.Load(), "metadata path must not scan keys")
	require.EqualValues(t, 1, cs.gets.Load(), "one Get for the metadata record")
	require.EqualValues(t, 1, cs.bulkGets.Load(), "one BulkGet for history + customStatus")
}

func TestLoadLegacyJSONMetadataSkipsKeyScan(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("x")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] =
		[]byte(`{"InboxLength":0,"HistoryLength":2,"Generation":1}`)
	cs := newCountingStore(f)

	ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Len(t, ex.History, 2)
	require.EqualValues(t, 0, cs.keys.Load())
}

func TestLoadFallsBackToScan(t *testing.T) {
	for name, meta := range map[string][]byte{
		"empty json":    []byte(`{}`),
		"garbage json":  []byte(`{not json`),
		"over bound":    mustProtoMeta(t, maxHistoryEntries+1),
		"zero length":   mustProtoMeta(t, 0),
		"binary junk":   {0xff, 0xff, 0xff},
	} {
		t.Run(name, func(t *testing.T) {
			f := newFakeStore()
			seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
			f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] = meta
			cs := newCountingStore(f)

			ex, err := New(cs, "default").Get(context.Background(), "order", "inst-a")
			require.NoError(t, err)
			require.Equal(t, "OrderWorkflow", ex.Name)
			require.EqualValues(t, 1, cs.keys.Load(), "exactly one fallback scan")
		})
	}
}

func TestLoadMissingMetadataIsNotFound(t *testing.T) {
	cs := newCountingStore(newFakeStore())
	_, err := New(cs, "default").Get(context.Background(), "order", "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestLoadSkipsMissingConstructedHistoryKey(t *testing.T) {
	// Metadata claims 3 events but only 2 exist (history truncated by a
	// concurrent continue-as-new): decode what exists, no error.
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("OrderWorkflow"), startedEvent("x")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixMetadata] = mustProtoMeta(t, 3)

	ex, err := New(f, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Len(t, ex.History, 2)
}

func TestLoadReadsCustomStatusOnMetadataPath(t *testing.T) {
	f := newFakeStore()
	seedWorkflowProto(t, f, "default", "order", "inst-a", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	f.kv[statestore.InstancePrefix("default", "order", "inst-a")+statestore.SuffixCustomStatus] = []byte(`{"step":2}`)

	ex, err := New(f, "default").Get(context.Background(), "order", "inst-a")
	require.NoError(t, err)
	require.Equal(t, `{"step":2}`, ex.CustomStatus)
}

func TestListUnfilteredPageScansKeysOnce(t *testing.T) {
	f := newFakeStore()
	for _, id := range []string{"a", "b", "c"} {
		seedWorkflowProto(t, f, "default", "order", id, []*protos.HistoryEvent{startedEvent("W")})
	}
	cs := newCountingStore(f)
	res, err := New(cs, "default").List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 3)
	require.EqualValues(t, 1, cs.keys.Load(), "one metadata-key scan per unfiltered page, no per-instance scans")
}

func mustProtoMeta(t *testing.T, n uint64) []byte {
	t.Helper()
	b, err := proto.Marshal(&protos.BackendWorkflowStateMetadata{HistoryLength: n, Generation: 1})
	require.NoError(t, err)
	return b
}
```

Note: `seedWorkflow`'s existing signature in `service_test.go` is `seedWorkflow(t, f, ns, appID, instanceID, name string, events)`; the `name` argument is unused by it, so pass `""`.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit ./pkg/workflow/ -run 'TestHistoryLength|TestLoad|TestListUnfilteredPageScansKeysOnce'`
Expected: FAIL to compile (`undefined: historyLength`, `undefined: maxHistoryEntries`).

- [ ] **Step 4: Implement `historyLength`**

In `pkg/workflow/decode.go`, add `"encoding/json"` and `"google.golang.org/protobuf/proto"` to the imports and append:

```go
// maxHistoryEntries mirrors Dapr's maxStateEntries bound on metadata lengths
// (pkg/runtime/wfengine/state): a larger value is treated as corrupt and the
// loader falls back to a key scan.
const maxHistoryEntries = 1_000_000

// historyLength extracts HistoryLength from an instance metadata record:
// a BackendWorkflowStateMetadata proto (Dapr 1.16+) or the legacy JSON
// object {"InboxLength","HistoryLength","Generation"}. A record starting
// with '{' is JSON; a valid metadata proto never starts with that byte
// (0x7b would be a field-15 group, which the message doesn't have).
// ok is false when the record is missing, undecodable, zero, or above
// maxHistoryEntries; the caller then scans for the instance's keys.
func historyLength(meta []byte) (uint64, bool) {
	if len(meta) == 0 {
		return 0, false
	}
	var n uint64
	if meta[0] == '{' {
		var legacy struct{ HistoryLength uint64 }
		if err := json.Unmarshal(meta, &legacy); err != nil {
			return 0, false
		}
		n = legacy.HistoryLength
	} else {
		var md protos.BackendWorkflowStateMetadata
		if err := proto.Unmarshal(meta, &md); err != nil {
			return 0, false
		}
		n = md.GetHistoryLength()
	}
	return n, n > 0 && n <= maxHistoryEntries
}
```

- [ ] **Step 5: Replace `load` in `service.go`**

In `pkg/workflow/service.go`, replace the whole `load` function (from `// load reads an instance's history-* and customStatus keys` to its closing brace) with:

```go
// load reads one instance: its metadata record first, then (via
// loadWithMeta) the history keys that record declares.
func (s *service) load(ctx context.Context, ns, appID, instanceID string) (Execution, error) {
	meta, err := s.store.Get(ctx, statestore.InstancePrefix(ns, appID, instanceID)+statestore.SuffixMetadata)
	if err != nil {
		return Execution{}, err
	}
	ex, _, err := s.loadWithMeta(ctx, ns, appID, instanceID, meta)
	return ex, err
}

// loadWithMeta loads an instance given its already-read metadata record.
// When the record declares a usable HistoryLength, the history keys are
// built directly (as Dapr itself loads state) and fetched in one BulkGet:
// no key scan. Otherwise it falls back to scanning the instance's keys.
// fromMeta reports which path ran; only metadata-path results are safe to
// cache against the metadata bytes.
func (s *service) loadWithMeta(ctx context.Context, ns, appID, instanceID string, meta []byte) (Execution, bool, error) {
	n, ok := historyLength(meta)
	if !ok {
		ex, err := s.loadByScan(ctx, ns, appID, instanceID)
		return ex, false, err
	}
	prefix := statestore.InstancePrefix(ns, appID, instanceID)
	keys := make([]string, 0, n+1)
	for i := uint64(0); i < n; i++ {
		keys = append(keys, prefix+statestore.HistoryKey(i))
	}
	keys = append(keys, prefix+statestore.SuffixCustomStatus)
	values, err := s.store.BulkGet(ctx, keys)
	if err != nil {
		return Execution{}, false, err
	}
	return decodeInstance(appID, instanceID, prefix, values), true, nil
}

// loadByScan is the original loader: discover the instance's keys with a
// KeysLike scan, then read them. Used when metadata can't be trusted.
func (s *service) loadByScan(ctx context.Context, ns, appID, instanceID string) (Execution, error) {
	keys, _, err := s.store.Keys(ctx, statestore.InstanceKeyPattern(ns, appID, instanceID), "", 0)
	if err != nil {
		return Execution{}, err
	}
	if len(keys) == 0 {
		return Execution{}, ErrNotFound
	}
	values, err := s.store.BulkGet(ctx, keys)
	if err != nil {
		return Execution{}, err
	}
	return decodeInstance(appID, instanceID, statestore.InstancePrefix(ns, appID, instanceID), values), nil
}

// decodeInstance decodes history-* (in key order, which is chronological)
// and customStatus values into an Execution. Missing or empty values and
// undecodable events are skipped.
func decodeInstance(appID, instanceID, prefix string, values map[string][]byte) Execution {
	var historyKeys []string
	customStatus := ""
	for k, v := range values {
		suffix := strings.TrimPrefix(k, prefix)
		switch {
		case strings.HasPrefix(suffix, statestore.HistoryPrefix):
			if len(v) > 0 {
				historyKeys = append(historyKeys, k)
			}
		case suffix == statestore.SuffixCustomStatus:
			customStatus = string(v)
		}
	}
	sort.Strings(historyKeys) // history-000000, history-000001, ... lexical == chronological
	history := make([]*protos.HistoryEvent, 0, len(historyKeys))
	for _, hk := range historyKeys {
		var e protos.HistoryEvent
		if err := proto.Unmarshal(values[hk], &e); err != nil {
			continue
		}
		history = append(history, &e)
	}
	return DecodeExecution(appID, instanceID, history, customStatus)
}
```

Note: the lexical sort is chronological because the metadata path builds indexes `0 … n-1` with `n <= maxHistoryEntries` (1 000 000), so every key has exactly 6 digits. Don't add a numeric sort.

- [ ] **Step 6: Run the workflow unit tests**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit -race ./pkg/workflow/`
Expected: PASS, new tests included; existing tests (which seed `{}` metadata) pass through the scan fallback unchanged.

- [ ] **Step 7: Run the existing integration tests (golden files must be unchanged)**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags integration -race ./pkg/workflow/ -run 'Golden|SQLite'`
Expected: PASS without `-update`.

- [ ] **Step 8: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/workflow/decode.go pkg/workflow/decode_test.go pkg/workflow/service.go pkg/workflow/load_test.go
git commit -m "perf(workflow): derive history keys from instance metadata

Replaces the per-instance KeysLike scan with Dapr's own layout: read
metadata, build history-0..HistoryLength-1, fetch in one BulkGet. Falls
back to the scan when metadata is missing, undecodable or zero-length.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 4: Bounded parallel instance loads + cancellation

**Files:**
- Modify: `pkg/workflow/service.go` (`List`, `Stats`; add `instanceRef`, `loaded`, `refsFromKeys`, `forEachBounded`, `loadSummaries`)
- Create: `pkg/workflow/parallel_test.go`
- Modify: `pkg/server/workflows_test.go` (context-threading test)

**Interfaces:**
- Consumes: `(*service).load` (Task 3).
- Produces (package `workflow`, unexported):
  - `const instanceLoadConcurrency = 8`
  - `type instanceRef struct{ appID, id string }`
  - `type loaded struct{ summary ExecutionSummary; ok bool }`
  - `func refsFromKeys(keys []string, seen map[string]struct{}) []instanceRef`
  - `func forEachBounded(ctx context.Context, n int, fn func(i int))`
  - `func (s *service) loadSummaries(ctx context.Context, ns string, refs []instanceRef) ([]loaded, error)`: one result per ref, in input order; returns `ctx.Err()` if the context ended. Task 5 replaces its body.

- [ ] **Step 1: Write the failing tests**

Create `pkg/workflow/parallel_test.go`:

```go
//go:build unit

package workflow

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
)

// slowStore delays every BulkGet and records the peak number in flight.
type slowStore struct {
	*countingStore
	inflight, peak atomic.Int32
}

func (s *slowStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	n := s.inflight.Add(1)
	for {
		p := s.peak.Load()
		if n <= p || s.peak.CompareAndSwap(p, n) {
			break
		}
	}
	time.Sleep(5 * time.Millisecond)
	defer s.inflight.Add(-1)
	return s.countingStore.BulkGet(ctx, ks)
}

func seedN(t *testing.T, f *fakeStore, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		seedWorkflowProto(t, f, "default", "order", fmt.Sprintf("inst-%03d", i), []*protos.HistoryEvent{startedEvent(fmt.Sprintf("W%d", i))})
	}
}

func TestStatsLoadsInParallelWithinBound(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 40)
	s := &slowStore{countingStore: newCountingStore(f)}

	res, err := New(s, "default").Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 40, res.Total)
	require.Greater(t, s.peak.Load(), int32(1), "instances load concurrently")
	require.LessOrEqual(t, s.peak.Load(), int32(instanceLoadConcurrency))
}

func TestListParallelResultsMatchSequentialOrder(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 30)
	s := &slowStore{countingStore: newCountingStore(f)}

	res, err := New(s, "default").List(context.Background(), ListQuery{IncludeChildren: true, PageSize: 50})
	require.NoError(t, err)
	require.Len(t, res.Items, 30)
	seen := map[string]bool{}
	for _, it := range res.Items {
		require.False(t, seen[it.InstanceID], "no duplicates")
		seen[it.InstanceID] = true
	}
}

// cancellingStore cancels the request context on its first BulkGet.
type cancellingStore struct {
	*countingStore
	cancel context.CancelFunc
}

func (c *cancellingStore) BulkGet(ctx context.Context, ks []string) (map[string][]byte, error) {
	c.cancel()
	return c.countingStore.BulkGet(ctx, ks)
}

func TestStatsStopsOnCancelledContext(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 50)
	ctx, cancel := context.WithCancel(context.Background())
	s := &cancellingStore{countingStore: newCountingStore(f), cancel: cancel}

	_, err := New(s, "default").Stats(ctx, ListQuery{IncludeChildren: true})
	require.ErrorIs(t, err, context.Canceled)
	require.LessOrEqual(t, s.bulkGets.Load(), int32(instanceLoadConcurrency+1),
		"no new loads are scheduled after cancellation")
}

func TestListReturnsErrorOnCancelledContext(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 50)
	ctx, cancel := context.WithCancel(context.Background())
	s := &cancellingStore{countingStore: newCountingStore(f), cancel: cancel}

	res, err := New(s, "default").List(ctx, ListQuery{IncludeChildren: true, PageSize: 50})
	require.ErrorIs(t, err, context.Canceled)
	require.Empty(t, res.Items, "never a silently partial page")
}
```

Append to `pkg/server/workflows_test.go` (add `"sync/atomic"` to its imports):

```go
// ctxProbeWF records whether the context List/Stats received was already
// cancelled, proving the handlers pass the request context through so a
// client abort stops the store work.
type ctxProbeWF struct {
	fakeWF
	sawCancelled *atomic.Bool
}

func (p ctxProbeWF) List(ctx context.Context, _ workflow.ListQuery) (workflow.ListResult, error) {
	p.sawCancelled.Store(ctx.Err() != nil)
	return workflow.ListResult{}, ctx.Err()
}
func (p ctxProbeWF) Stats(ctx context.Context, _ workflow.ListQuery) (workflow.StatsResult, error) {
	p.sawCancelled.Store(ctx.Err() != nil)
	return workflow.StatsResult{}, ctx.Err()
}

func TestWorkflowHandlersPassRequestContext(t *testing.T) {
	for _, path := range []string{"/", "/stats"} {
		t.Run(path, func(t *testing.T) {
			saw := &atomic.Bool{}
			h := workflowsRouter(newFakeBackend(ctxProbeWF{sawCancelled: saw}), nil)
			req := httptest.NewRequest(http.MethodGet, path, nil)
			ctx, cancel := context.WithCancel(req.Context())
			cancel()
			h.ServeHTTP(httptest.NewRecorder(), req.WithContext(ctx))
			require.True(t, saw.Load(), "handler must hand the request context to the service")
		})
	}
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit -race ./pkg/workflow/ -run 'Parallel|Cancelled|WithinBound' ./pkg/server/ -run 'PassRequestContext'`
Expected: workflow FAIL to compile (`undefined: instanceLoadConcurrency`). The server test should already PASS: it pins existing behaviour so a later refactor can't break it.

- [ ] **Step 3: Implement the parallel loader**

In `pkg/workflow/service.go`, add `"sync"` to the imports. After the `maxFilteredScanKeys` const block, add:

```go
// instanceLoadConcurrency bounds how many instances List/Stats load at once.
const instanceLoadConcurrency = 8

// instanceRef identifies one instance found by a metadata-key scan.
type instanceRef struct{ appID, id string }

// loaded is one instance's summary; ok is false when it failed to load
// (skipped, as a failed load always was).
type loaded struct {
	summary ExecutionSummary
	ok      bool
}

// refsFromKeys parses metadata keys into instance refs, skipping malformed
// keys and any app/instance pair already recorded in seen (which it updates).
func refsFromKeys(keys []string, seen map[string]struct{}) []instanceRef {
	refs := make([]instanceRef, 0, len(keys))
	for _, k := range keys {
		appID, ok := statestore.ParseAppID(k)
		if !ok {
			continue
		}
		id, ok := statestore.ParseInstanceID(k)
		if !ok {
			continue
		}
		dk := appID + "/" + id
		if _, dup := seen[dk]; dup {
			continue
		}
		seen[dk] = struct{}{}
		refs = append(refs, instanceRef{appID: appID, id: id})
	}
	return refs
}

// forEachBounded runs fn(i) for every i in [0, n) on at most
// instanceLoadConcurrency goroutines. It stops scheduling once ctx is done
// and always waits for in-flight calls before returning.
func forEachBounded(ctx context.Context, n int, fn func(i int)) {
	sem := make(chan struct{}, instanceLoadConcurrency)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		if ctx.Err() != nil {
			break
		}
		sem <- struct{}{}
		wg.Add(1)
		go func() {
			defer wg.Done()
			defer func() { <-sem }()
			fn(i)
		}()
	}
	wg.Wait()
}

// loadSummaries loads refs concurrently and returns one result per ref, in
// input order, so callers stay deterministic before their own sort.
func (s *service) loadSummaries(ctx context.Context, ns string, refs []instanceRef) ([]loaded, error) {
	out := make([]loaded, len(refs))
	forEachBounded(ctx, len(refs), func(i int) {
		ex, err := s.load(ctx, ns, refs[i].appID, refs[i].id)
		if err != nil {
			return
		}
		out[i] = loaded{summary: ex.ExecutionSummary, ok: true}
	})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
```

- [ ] **Step 4: Use it in `List`**

In `List`, replace the inner `for _, k := range metaKeys { ... }` loop (from `for _, k := range metaKeys {` through its closing brace, just before the `// Unfiltered: preserve one-key-page-per-call semantics.` comment) with:

```go
		results, err := s.loadSummaries(ctx, ns, refsFromKeys(metaKeys, seen))
		if err != nil {
			return ListResult{}, err
		}
		for _, r := range results {
			if r.ok && matches(r.summary, q) {
				items = append(items, r.summary)
			}
		}
```

- [ ] **Step 5: Use it in `Stats`**

In `Stats`, replace everything from `for _, k := range metaKeys {` to the end of that loop (just before `return res, nil`) with:

```go
	results, err := s.loadSummaries(ctx, ns, refsFromKeys(metaKeys, seen))
	if err != nil {
		return StatsResult{}, err
	}
	for _, r := range results {
		if !r.ok || !matches(r.summary, searchQ) {
			continue
		}
		res.Counts[r.summary.Status]++
		res.Total++
	}
```

The `seen := make(map[string]struct{})` line in `Stats` stays; it's now passed to `refsFromKeys`.

- [ ] **Step 6: Run the tests**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit -race ./pkg/workflow/ ./pkg/server/`
Expected: PASS, with no data races reported.

- [ ] **Step 7: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/workflow/service.go pkg/workflow/parallel_test.go pkg/server/workflows_test.go
git commit -m "perf(workflow): load list/stats instances with bounded concurrency

Also stops scheduling loads once the request context ends and returns the
context error instead of a partial page.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 5: Summary cache keyed on metadata bytes

**Files:**
- Create: `pkg/workflow/summary_cache.go`
- Create: `pkg/workflow/summary_cache_test.go`
- Modify: `pkg/workflow/service.go` (`service` struct, `New`, `loadSummaries`, `Stats`)

**Interfaces:**
- Consumes: `loadWithMeta` (Task 3), `forEachBounded`, `instanceRef`, `loaded`, `loadSummaries` signature (Task 4).
- Produces (package `workflow`, unexported):
  - `const maxCachedSummaries = 20_000`
  - `type summaryCache` with `func newSummaryCache(max int) *summaryCache`, `get(key string, meta []byte) (ExecutionSummary, bool)`, `put(key, ns, appID string, meta []byte, sum ExecutionSummary)`, `prune(ns, appID string, keep map[string]struct{})`, `size() int`
  - `func cacheKey(ns, appID, id string) string`
  - `service.cache *summaryCache` (set in `New`)

- [ ] **Step 1: Write the failing tests**

Create `pkg/workflow/summary_cache_test.go`:

```go
//go:build unit

package workflow

import (
	"context"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestSummaryCacheGetPutMatchesMetaBytes(t *testing.T) {
	c := newSummaryCache(10)
	k := cacheKey("default", "order", "a")
	c.put(k, "default", "order", []byte("m1"), ExecutionSummary{InstanceID: "a", Name: "W"})

	got, ok := c.get(k, []byte("m1"))
	require.True(t, ok)
	require.Equal(t, "W", got.Name)

	_, ok = c.get(k, []byte("m2"))
	require.False(t, ok, "changed metadata bytes are a miss")
	_, ok = c.get(k, nil)
	require.False(t, ok, "nil metadata is always a miss")
}

func TestSummaryCacheClearsOnOverflow(t *testing.T) {
	c := newSummaryCache(2)
	c.put(cacheKey("default", "o", "a"), "default", "o", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "o", "b"), "default", "o", []byte("m"), ExecutionSummary{})
	require.Equal(t, 2, c.size())
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m"), ExecutionSummary{})
	require.Equal(t, 1, c.size(), "overflow clears, then stores the new entry")
	// Overwriting an existing key at the cap doesn't clear.
	c.put(cacheKey("default", "o", "c"), "default", "o", []byte("m2"), ExecutionSummary{})
	require.Equal(t, 1, c.size())
}

func TestSummaryCachePruneScopesByNamespaceAndApp(t *testing.T) {
	c := newSummaryCache(10)
	c.put(cacheKey("default", "order", "a"), "default", "order", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "order", "b"), "default", "order", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("default", "billing", "c"), "default", "billing", []byte("m"), ExecutionSummary{})
	c.put(cacheKey("prod", "order", "d"), "prod", "order", []byte("m"), ExecutionSummary{})

	// App-scoped prune only touches that app in that namespace.
	c.prune("default", "order", map[string]struct{}{cacheKey("default", "order", "a"): {}})
	require.Equal(t, 3, c.size())
	_, ok := c.get(cacheKey("default", "order", "b"), []byte("m"))
	require.False(t, ok)

	// All-apps prune touches every app in that namespace, never other namespaces.
	c.prune("default", "", map[string]struct{}{})
	require.Equal(t, 1, c.size())
	_, ok = c.get(cacheKey("prod", "order", "d"), []byte("m"))
	require.True(t, ok)
}

func TestStatsSecondCallReadsOnlyMetadata(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 20)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	q := ListQuery{IncludeChildren: true}

	first, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 20, first.Total)

	cs.reset()
	second, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, first, second)
	require.EqualValues(t, 1, cs.keys.Load(), "one metadata-key scan")
	require.EqualValues(t, 1, cs.bulkGets.Load(), "one BulkGet for all metadata values")
	require.Zero(t, cs.historyReads(), "no history is re-read for unchanged instances")
}

func TestStatsReloadsOnlyChangedInstance(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 5)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	q := ListQuery{IncludeChildren: true}
	_, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)

	// inst-002 gains a second event: Dapr rewrites metadata with the new length.
	seedWorkflowProto(t, f, "default", "order", "inst-002", []*protos.HistoryEvent{startedEvent("W2"), startedEvent("x")})

	cs.reset()
	_, err = svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 2, cs.historyReads(), "only the changed instance's 2 history keys are read")
}

func TestStatsPrunesRemovedInstancesListDoesNot(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 3)
	svc := New(f, "default")
	inner := svc.(*service)
	q := ListQuery{IncludeChildren: true}
	_, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 3, inner.cache.size())

	// Purge inst-001.
	prefix := statestore.InstancePrefix("default", "order", "inst-001")
	for k := range f.kv {
		if len(k) >= len(prefix) && k[:len(prefix)] == prefix {
			delete(f.kv, k)
		}
	}

	res, err := svc.List(context.Background(), q)
	require.NoError(t, err)
	require.Len(t, res.Items, 2, "a purged instance is not listed")
	require.Equal(t, 3, inner.cache.size(), "List never prunes")

	st, err := svc.Stats(context.Background(), q)
	require.NoError(t, err)
	require.Equal(t, 2, st.Total)
	require.Equal(t, 2, inner.cache.size(), "Stats prunes entries whose keys are gone")
}

func TestScanFallbackResultsAreNotCached(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "", []*protos.HistoryEvent{startedEvent("W")}) // "{}" metadata
	svc := New(f, "default")
	_, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Zero(t, svc.(*service).cache.size())
}

func TestGetBypassesCache(t *testing.T) {
	f := newFakeStore()
	seedN(t, f, 1)
	cs := newCountingStore(f)
	svc := New(cs, "default")
	_, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)

	cs.reset()
	ex, err := svc.Get(context.Background(), "order", "inst-000")
	require.NoError(t, err)
	require.Len(t, ex.History, 1)
	require.Equal(t, 1, cs.historyReads(), "detail always reads history")
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit ./pkg/workflow/ -run 'SummaryCache|SecondCall|ChangedInstance|Prunes|NotCached|BypassesCache'`
Expected: FAIL to compile (`undefined: newSummaryCache`, `undefined: cacheKey`, `inner.cache undefined`).

- [ ] **Step 3: Implement the cache**

Create `pkg/workflow/summary_cache.go`:

```go
package workflow

import (
	"bytes"
	"sync"
)

// maxCachedSummaries caps the summary cache. Past it the cache is cleared
// and refills on demand: simple and correct, and a local store that large
// is already an outlier.
const maxCachedSummaries = 20_000

// summaryCache holds list/stats summaries keyed by namespace/app/instance and
// validated against the instance's raw metadata bytes. Dapr rewrites the
// metadata record (new HistoryLength/Generation) in the same transaction as
// every history change, so identical bytes mean an unchanged summary.
type summaryCache struct {
	mu  sync.Mutex
	max int
	m   map[string]cachedSummary
}

type cachedSummary struct {
	ns, appID string
	meta      []byte
	summary   ExecutionSummary
}

func newSummaryCache(max int) *summaryCache {
	return &summaryCache{max: max, m: map[string]cachedSummary{}}
}

func cacheKey(ns, appID, id string) string { return ns + "\x00" + appID + "\x00" + id }

// get returns the cached summary when its metadata bytes equal meta.
func (c *summaryCache) get(key string, meta []byte) (ExecutionSummary, bool) {
	if meta == nil {
		return ExecutionSummary{}, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.m[key]
	if !ok || !bytes.Equal(e.meta, meta) {
		return ExecutionSummary{}, false
	}
	return e.summary, true
}

func (c *summaryCache) put(key, ns, appID string, meta []byte, sum ExecutionSummary) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if _, exists := c.m[key]; !exists && len(c.m) >= c.max {
		c.m = map[string]cachedSummary{}
	}
	c.m[key] = cachedSummary{ns: ns, appID: appID, meta: meta, summary: sum}
}

// prune drops entries in namespace ns (and, when appID != "", only that
// app) whose key is not in keep. Called after a full metadata scan.
func (c *summaryCache) prune(ns, appID string, keep map[string]struct{}) {
	c.mu.Lock()
	defer c.mu.Unlock()
	for k, e := range c.m {
		if e.ns != ns || (appID != "" && e.appID != appID) {
			continue
		}
		if _, ok := keep[k]; !ok {
			delete(c.m, k)
		}
	}
}

func (c *summaryCache) size() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.m)
}
```

- [ ] **Step 4: Wire the cache into the service**

In `pkg/workflow/service.go`:

1. Add a field to `service` (after `nsResolver`):

```go
	// cache holds list/stats summaries validated by metadata bytes (see
	// summaryCache). Get never uses it: the detail page needs full history.
	cache *summaryCache
```

2. In `New`, change `s := &service{store: store, namespace: namespace}` to:

```go
	s := &service{store: store, namespace: namespace, cache: newSummaryCache(maxCachedSummaries)}
```

3. Replace the body of `loadSummaries` (keep its doc comment, then extend it) with:

```go
// loadSummaries loads refs concurrently and returns one result per ref, in
// input order, so callers stay deterministic before their own sort. It
// reads all metadata values in one BulkGet, reuses cached summaries whose
// metadata bytes are unchanged, and loads the rest via loadWithMeta.
func (s *service) loadSummaries(ctx context.Context, ns string, refs []instanceRef) ([]loaded, error) {
	out := make([]loaded, len(refs))
	if len(refs) == 0 {
		return out, nil
	}
	metaKeys := make([]string, len(refs))
	for i, r := range refs {
		metaKeys[i] = statestore.InstancePrefix(ns, r.appID, r.id) + statestore.SuffixMetadata
	}
	metas, err := s.store.BulkGet(ctx, metaKeys)
	if err != nil {
		return nil, err
	}
	forEachBounded(ctx, len(refs), func(i int) {
		r := refs[i]
		meta := metas[metaKeys[i]]
		key := cacheKey(ns, r.appID, r.id)
		if sum, ok := s.cache.get(key, meta); ok {
			out[i] = loaded{summary: sum, ok: true}
			return
		}
		ex, fromMeta, err := s.loadWithMeta(ctx, ns, r.appID, r.id, meta)
		if err != nil {
			return
		}
		if fromMeta {
			s.cache.put(key, ns, r.appID, meta, ex.ExecutionSummary)
		}
		out[i] = loaded{summary: ex.ExecutionSummary, ok: true}
	})
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return out, nil
}
```

4. In `Stats`, prune after a successful full scan. Replace:

```go
	results, err := s.loadSummaries(ctx, ns, refsFromKeys(metaKeys, seen))
	if err != nil {
		return StatsResult{}, err
	}
```

with:

```go
	refs := refsFromKeys(metaKeys, seen)
	results, err := s.loadSummaries(ctx, ns, refs)
	if err != nil {
		return StatsResult{}, err
	}
	// Stats saw every metadata key in scope, so any cached instance it
	// didn't see was purged or deleted.
	keep := make(map[string]struct{}, len(refs))
	for _, r := range refs {
		keep[cacheKey(ns, r.appID, r.id)] = struct{}{}
	}
	s.cache.prune(ns, q.AppID, keep)
```

- [ ] **Step 5: Run the tests**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags unit -race ./pkg/workflow/ ./pkg/server/ ./cmd/...`
Expected: PASS. Task 3's `TestLoadProtoMetadataSkipsKeyScan` still passes (Get doesn't use the cache). Task 4's cancellation tests still pass, because the first BulkGet (metadata) cancels and nothing more is scheduled.

- [ ] **Step 6: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/workflow/summary_cache.go pkg/workflow/summary_cache_test.go pkg/workflow/service.go
git commit -m "perf(workflow): cache list/stats summaries keyed on metadata bytes

A stats poll over finished workflows now costs one key scan plus bulk
metadata reads; only instances whose metadata changed are reloaded.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 6: Cross-backend parity integration test

Prove `List`/`Stats`/`Get` produce exactly what the original scan-based loader produced, on all four backends.

**Files:**
- Create: `pkg/workflow/parity_integration_test.go`

**Interfaces:**
- Consumes: `backendKinds`, `openStore`, `seedMany` (Task 1); `workflow.New`, `workflow.DecodeExecution`, `statestore` key helpers.

- [ ] **Step 1: Write the parity test**

`pkg/workflow/parity_integration_test.go`:

```go
//go:build integration

package workflow_test

import (
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
)

// legacyLoadAll reimplements the pre-#93 loader (scan every instance's keys,
// Get each value) as the reference the new path must match.
func legacyLoadAll(t *testing.T, store statestore.Store, ns string) map[string]workflow.Execution {
	t.Helper()
	ctx := context.Background()
	metaKeys, _, err := store.Keys(ctx, statestore.AllInstanceMetaPattern(ns), "", 0)
	require.NoError(t, err)
	out := map[string]workflow.Execution{}
	for _, mk := range metaKeys {
		appID, ok := statestore.ParseAppID(mk)
		require.True(t, ok)
		id, ok := statestore.ParseInstanceID(mk)
		require.True(t, ok)
		keys, _, err := store.Keys(ctx, statestore.InstanceKeyPattern(ns, appID, id), "", 0)
		require.NoError(t, err)
		prefix := statestore.InstancePrefix(ns, appID, id)
		var hkeys []string
		cs := ""
		vals := map[string][]byte{}
		for _, k := range keys {
			v, err := store.Get(ctx, k)
			require.NoError(t, err)
			vals[k] = v
			suffix := strings.TrimPrefix(k, prefix)
			switch {
			case strings.HasPrefix(suffix, statestore.HistoryPrefix):
				hkeys = append(hkeys, k)
			case suffix == statestore.SuffixCustomStatus:
				cs = string(v)
			}
		}
		sort.Strings(hkeys)
		var history []*protos.HistoryEvent
		for _, hk := range hkeys {
			var e protos.HistoryEvent
			require.NoError(t, proto.Unmarshal(vals[hk], &e))
			history = append(history, &e)
		}
		out[appID+"/"+id] = workflow.DecodeExecution(appID, id, history, cs)
	}
	return out
}

func summariesOf(m map[string]workflow.Execution, keep func(workflow.ExecutionSummary) bool) []workflow.ExecutionSummary {
	var out []workflow.ExecutionSummary
	for _, ex := range m {
		if keep(ex.ExecutionSummary) {
			out = append(out, ex.ExecutionSummary)
		}
	}
	sortSummaries(out)
	return out
}

func sortSummaries(s []workflow.ExecutionSummary) {
	sort.Slice(s, func(a, b int) bool {
		if s[a].AppID != s[b].AppID {
			return s[a].AppID < s[b].AppID
		}
		return s[a].InstanceID < s[b].InstanceID
	})
}

// listAll pages List to the end (NextToken == "").
func listAll(t *testing.T, svc workflow.Service, q workflow.ListQuery) []workflow.ExecutionSummary {
	t.Helper()
	var all []workflow.ExecutionSummary
	for {
		res, err := svc.List(context.Background(), q)
		require.NoError(t, err)
		all = append(all, res.Items...)
		if res.NextToken == "" {
			break
		}
		q.PageToken = res.NextToken
	}
	sortSummaries(all)
	return all
}

func TestWorkflowReadParityAcrossBackends(t *testing.T) {
	for _, kind := range backendKinds {
		t.Run(kind, func(t *testing.T) {
			store := openStore(t, kind)
			seedMany(t, store, 200)
			want := legacyLoadAll(t, store, "default")
			require.Len(t, want, 200)

			svc := workflow.New(store, "default")
			all := func(workflow.ExecutionSummary) bool { return true }
			roots := func(s workflow.ExecutionSummary) bool { return s.ParentInstanceID == "" }

			// List, paged, with and without children.
			require.Equal(t, summariesOf(want, all),
				listAll(t, svc, workflow.ListQuery{IncludeChildren: true, PageSize: 25}))
			require.Equal(t, summariesOf(want, roots),
				listAll(t, svc, workflow.ListQuery{IncludeChildren: false, PageSize: 25}))

			// Stats, cold then warm (cached), must match the reference counts.
			wantCounts := map[workflow.Status]int{}
			for _, ex := range want {
				wantCounts[ex.Status]++
			}
			for pass := 0; pass < 2; pass++ {
				st, err := svc.Stats(context.Background(), workflow.ListQuery{IncludeChildren: true})
				require.NoError(t, err)
				require.Equal(t, 200, st.Total, "pass %d", pass)
				require.Equal(t, wantCounts, st.Counts, "pass %d", pass)
			}

			// Get: 150-event instance (spans BulkGet chunks), the "{}" fallback,
			// a legacy-JSON one, a child, and one with customStatus.
			for _, key := range []string{"order/inst-0000", "billing/inst-0001", "billing/inst-0007", "billing/inst-0013", "order/inst-0006"} {
				appID, id, _ := strings.Cut(key, "/")
				got, err := svc.Get(context.Background(), appID, id)
				require.NoError(t, err, key)
				require.Equal(t, want[key], got, key)
			}
			require.Len(t, want["order/inst-0000"].History, 150)
		})
	}
}
```

- [ ] **Step 2: Run it**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags integration -race ./pkg/workflow/ -run TestWorkflowReadParityAcrossBackends -v -timeout 20m`
Expected: PASS for `sqlite`, `redis`, `postgres`, `mongodb`. If Docker is unavailable, the three container subtests SKIP; report that explicitly, because this task isn't verified until all four have passed on a machine with Docker.

If a subtest fails, the likely culprits are: (a) a `BulkGet` value-encoding difference on that backend (go back to Task 2 Step 7's per-backend fallback), or (b) child/instance ids in `seedMany` not matching the `Get` keys above. Fix the code, not the expectations, unless (b).

- [ ] **Step 3: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add pkg/workflow/parity_integration_test.go
git commit -m "test(workflow): list/stats/get parity with the scan loader on all four backends

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 7: Web hooks: abort signal, store-scoped placeholder, slower stats

**Files:**
- Modify: `web/src/lib/api.ts` (`fetchJSON` accepts `init`)
- Modify: `web/src/lib/refresh.tsx` (add `refetchMsAtLeast`)
- Modify: `web/src/hooks/useWorkflows.ts`
- Test: `web/src/lib/api.test.ts`, `web/src/lib/refresh.test.tsx`, `web/src/hooks/useWorkflows.test.tsx`

**Interfaces:**
- Produces:
  - `fetchJSON<T>(path: string, init?: RequestInit): Promise<T>`: the extra argument is optional; all existing callers are unchanged.
  - `refetchMsAtLeast(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>, floorMs: number): number | false`
  - `STATS_MIN_REFETCH_MS = 10_000` (exported from `useWorkflows.ts`)
  - Query keys become `['workflows', store, qs]` and `['workflow-stats', store, qs]` (`store` = `params.store ?? ''`). The `['workflows']` / `['workflow-stats']` prefix invalidation in `useWorkflowRemoval.ts` keeps matching.
  - `useWorkflows(...)` and `useWorkflowStats(...)` results expose `isPlaceholderData` (TanStack), which Task 8 reads.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/lib/api.test.ts` (inside the file, after the existing `describe`; add `delay` to the `msw` import):

```ts
describe('fetchJSON abort', () => {
  it('forwards the AbortSignal so an aborted request rejects', async () => {
    server.use(
      http.get('/api/workflows', async () => {
        await delay(200)
        return HttpResponse.json({ items: [] })
      }),
    )
    const ctrl = new AbortController()
    const p = fetchJSON('/workflows', { signal: ctrl.signal })
    ctrl.abort()
    await expect(p).rejects.toThrow()
  })
})
```

Append to `web/src/lib/refresh.test.tsx` (import `refetchMsAtLeast` alongside the existing imports from `./refresh`):

```ts
describe('refetchMsAtLeast', () => {
  it('raises short intervals to the floor', () => {
    expect(refetchMsAtLeast({ intervalMs: 1000, paused: false }, 10_000)).toBe(10_000)
    expect(refetchMsAtLeast({ intervalMs: 3000, paused: false }, 10_000)).toBe(10_000)
  })
  it('keeps intervals already above the floor', () => {
    expect(refetchMsAtLeast({ intervalMs: 10_000, paused: false }, 5_000)).toBe(10_000)
  })
  it('stays disabled when paused or off', () => {
    expect(refetchMsAtLeast({ intervalMs: 3000, paused: true }, 10_000)).toBe(false)
    expect(refetchMsAtLeast({ intervalMs: 0, paused: false }, 10_000)).toBe(false)
  })
})
```

Append to `web/src/hooks/useWorkflows.test.tsx` (extend imports: `delay` from `msw`; `vi, afterEach` from `vitest`; `QueryClient` from `@tanstack/react-query`):

```tsx
function freshClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: 0, staleTime: 0 } } })
}

function ListProbe({ store, search }: { store: string; search?: string }) {
  const { data, isPlaceholderData } = useWorkflows({ store, search })
  return (
    <div>
      {data?.items.map((w) => <span key={w.instanceId}>{w.instanceId}</span>)}
      {isPlaceholderData && <span>placeholder</span>}
    </div>
  )
}

describe('useWorkflows loading behaviour', () => {
  afterEach(() => vi.restoreAllMocks())

  it('passes an AbortSignal to fetch', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    render(<QueryProvider client={freshClient()}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(spy).toHaveBeenCalled())
    const init = spy.mock.calls[0][1] as RequestInit | undefined
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('keeps previous rows while a new filter loads in the same store', async () => {
    server.use(http.get('/api/workflows', async ({ request }) => {
      const search = new URL(request.url).searchParams.get('search')
      if (search === 'b') {
        await delay(150)
        return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'row-b', name: 'W', status: 'Running' }] })
      }
      return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'row-a', name: 'W', status: 'Running' }] })
    }))
    const client = freshClient()
    const { rerender } = render(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await screen.findByText('row-a')
    rerender(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" search="b" /></RefreshProvider></QueryProvider>)
    expect(screen.getByText('row-a')).toBeInTheDocument()
    expect(screen.getByText('placeholder')).toBeInTheDocument()
    await screen.findByText('row-b')
    expect(screen.queryByText('placeholder')).not.toBeInTheDocument()
  })

  it('never shows the previous store rows after a store switch', async () => {
    server.use(http.get('/api/workflows', async ({ request }) => {
      const store = new URL(request.url).searchParams.get('store')
      if (store === 's2') {
        await delay(150)
        return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'from-s2', name: 'W', status: 'Running' }] })
      }
      return HttpResponse.json({ items: [{ appId: 'o', instanceId: 'from-s1', name: 'W', status: 'Running' }] })
    }))
    const client = freshClient()
    const { rerender } = render(<QueryProvider client={client}><RefreshProvider><ListProbe store="s1" /></RefreshProvider></QueryProvider>)
    await screen.findByText('from-s1')
    rerender(<QueryProvider client={client}><RefreshProvider><ListProbe store="s2" /></RefreshProvider></QueryProvider>)
    expect(screen.queryByText('from-s1')).not.toBeInTheDocument()
    await screen.findByText('from-s2')
  })
})

describe('useWorkflowStats cadence', () => {
  it('exports a 10s floor for stats polling', () => {
    expect(STATS_MIN_REFETCH_MS).toBe(10_000)
  })
})
```

Also add `STATS_MIN_REFETCH_MS` to the `./useWorkflows` import at the top of the file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf/web && npx vitest run src/lib/api.test.ts src/lib/refresh.test.tsx src/hooks/useWorkflows.test.tsx`
Expected: FAIL: `refetchMsAtLeast` / `STATS_MIN_REFETCH_MS` not exported, the signal assertion fails, and the placeholder tests fail.

- [ ] **Step 3: Implement `fetchJSON` init**

In `web/src/lib/api.ts`, change the signature and first line of `fetchJSON`:

```ts
export async function fetchJSON<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), init)
```

and add one line to its doc comment: ` *  Pass `init.signal` (e.g. TanStack Query's) so superseded requests are aborted. */` (put it before the closing `*/`).

- [ ] **Step 4: Implement `refetchMsAtLeast`**

In `web/src/lib/refresh.tsx`, after `refetchMs`, add:

```ts
// refetchMs with a lower bound, for expensive store-wide reads that don't
// need the page's full cadence. Paused / off still disable polling.
export function refetchMsAtLeast(ctx: Pick<RefreshCtx, 'intervalMs' | 'paused'>, floorMs: number): number | false {
  const ms = refetchMs(ctx)
  return ms === false ? false : Math.max(ms, floorMs)
}
```

- [ ] **Step 5: Update the hooks**

In `web/src/hooks/useWorkflows.ts`:

1. Change the refresh import to `import { useRefreshInterval, refetchMs, refetchMsAtLeast } from '../lib/refresh'`.
2. After the `queryString` function, add:

```ts
// Stats is the page's only store-wide read; its tab badges don't need the
// list's cadence.
export const STATS_MIN_REFETCH_MS = 10_000

// keepPreviousWithinStore keeps the previous result on screen while a new
// filter/search/page loads, but never across a store switch: another store's
// rows must not stand in for this store's (row links and removal target the
// selected store). queryKey[1] is the store id.
function keepPreviousWithinStore<T>(store: string) {
  return (prev: T | undefined, prevQuery: { queryKey: readonly unknown[] } | undefined) =>
    prevQuery?.queryKey[1] === store ? prev : undefined
}
```

3. Replace `useWorkflows` with:

```ts
export function useWorkflows(params: WorkflowsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  const store = params.store ?? ''
  return useQuery<WorkflowListResult>({
    queryKey: ['workflows', store, qs],
    queryFn: ({ signal }) => fetchJSON<WorkflowListResult>(`/workflows${qs}`, { signal }),
    refetchInterval: refetchMs(ctx),
    placeholderData: keepPreviousWithinStore<WorkflowListResult>(store),
    enabled: params.enabled !== false,
  })
}
```

4. Replace the `return useQuery<WorkflowStats>({ ... })` block in `useWorkflowStats` with:

```ts
  const store = params.store ?? ''
  return useQuery<WorkflowStats>({
    queryKey: ['workflow-stats', store, qs],
    queryFn: ({ signal }) => fetchJSON<WorkflowStats>(`/workflows/stats${qs}`, { signal }),
    refetchInterval: refetchMsAtLeast(ctx, STATS_MIN_REFETCH_MS),
    placeholderData: keepPreviousWithinStore<WorkflowStats>(store),
    enabled: params.enabled !== false,
  })
```

5. In `useWorkflowAppIds` and `useWorkflow`, pass the signal too: `queryFn: ({ signal }) => fetchJSON<string[]>(`/workflows/appids${qs}`, { signal })` and `queryFn: ({ signal }) => fetchJSON<WorkflowExecution>(`/workflows/${appId}/${instanceId}${qs}`, { signal })`.

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf/web && npx vitest run src/lib src/hooks && npx tsc -b`
Expected: all PASS; `tsc -b` prints nothing. If `tsc` rejects the `placeholderData` function type, type `prevQuery` as `Query<T, Error, T, readonly unknown[]> | undefined` imported from `@tanstack/react-query` instead of the structural type.

- [ ] **Step 7: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add web/src/lib/api.ts web/src/lib/api.test.ts web/src/lib/refresh.tsx web/src/lib/refresh.test.tsx web/src/hooks/useWorkflows.ts web/src/hooks/useWorkflows.test.tsx
git commit -m "perf(web): abort superseded workflow requests, slower stats polling

Keeps previous list/stats results while a filter loads within the same
store, never across a store switch.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 8: Workflows page: updating state, pending tabs, stale-row guards

**Files:**
- Modify: `web/src/pages/Workflows.tsx`
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: `isPlaceholderData` from `useWorkflows` (Task 7); `Spinner` from `../components/Spinner`.

- [ ] **Step 1: Write the failing tests**

Append inside the top-level `describe('Workflows', ...)` in `web/src/pages/Workflows.test.tsx` (add `delay` to the `msw` import):

```tsx
  describe('while a new filter loads', () => {
    function slowFailedHandler() {
      return http.get('/api/workflows', async ({ request }) => {
        const status = new URL(request.url).searchParams.get('status')
        if (status === 'Failed') {
          await delay(300)
          return HttpResponse.json({ items: [{ appId: 'order', instanceId: 'def', name: 'W', status: 'Failed' }] })
        }
        return HttpResponse.json({
          items: [{ appId: 'order', instanceId: 'abc', name: 'W', status: 'Running' }],
          nextToken: 'tok',
        })
      })
    }

    it('keeps the previous rows and shows Updating…', async () => {
      server.use(slowFailedHandler())
      renderAt()
      await screen.findByRole('link', { name: 'abc' })
      await userEvent.click(screen.getByRole('button', { name: /^Failed/ }))
      expect(screen.getByRole('link', { name: 'abc' })).toBeInTheDocument()
      expect(screen.getByTestId('list-updating')).toHaveTextContent('Updating…')
      await screen.findByRole('link', { name: 'def' })
      expect(screen.queryByTestId('list-updating')).not.toBeInTheDocument()
    })

    it('disables the pager while rows are placeholders', async () => {
      server.use(slowFailedHandler())
      renderAt()
      await screen.findByRole('link', { name: 'abc' })
      expect(screen.getByRole('button', { name: 'Next →' })).toBeEnabled()
      await userEvent.click(screen.getByRole('button', { name: /^Failed/ }))
      expect(screen.getByRole('button', { name: 'Next →' })).toBeDisabled()
    })

    it('does not let placeholder rows be selected', async () => {
      server.use(slowFailedHandler())
      renderAt()
      await screen.findByRole('link', { name: 'abc' })
      await userEvent.click(screen.getByRole('button', { name: /^Failed/ }))
      const cbx = screen.getByRole('checkbox', { name: 'Select abc' })
      await userEvent.click(cbx)
      expect(cbx).toHaveAttribute('aria-checked', 'false')
    })
  })

  it('shows … in the status tabs until stats load', async () => {
    server.use(
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
      http.get('/api/workflows/stats', async () => {
        await delay('infinite')
        return HttpResponse.json({ counts: {}, total: 0 })
      }),
    )
    renderAt()
    const all = await screen.findByRole('button', { name: /^All/ })
    expect(all).toHaveTextContent('All …')
    expect(screen.getByRole('button', { name: /^Running/ })).toHaveTextContent('Running …')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf/web && npx vitest run src/pages/Workflows.test.tsx`
Expected: the 4 new tests FAIL (no `list-updating`, Next enabled, checkbox toggles, tabs show `0`); existing tests PASS.

- [ ] **Step 3: Implement the page changes**

In `web/src/pages/Workflows.tsx`:

1. Add the import: `import { Spinner } from '../components/Spinner'`.
2. Change the list hook destructuring (line ~183) to `const { data, isLoading, isError, error, isPlaceholderData } = useWorkflows({` and, directly after that hook call, add:

```tsx
  // Previous rows stay on screen while a new filter/search/page loads (same
  // store only; see useWorkflows). They are display-only until the new page
  // lands: paging and selection would act on the wrong result set.
  const updating = isPlaceholderData
```

3. At the top of both `toggleRow` and `toggleAll`, right after `e.stopPropagation()`, add `if (updating) return`.
4. Status tab counts: change `All <span className="n">{stats?.total ?? 0}</span>` to `All <span className="n">{stats ? stats.total : '…'}</span>`, and `{s} <span className="n">{stats?.counts[s] ?? 0}</span>` to `{s} <span className="n">{stats ? (stats.counts[s] ?? 0) : '…'}</span>`.
5. Pager: after the closing `</span>` of the `<span className="mono">…loaded</span>` element, insert:

```tsx
          {updating && (
            <span className="mono muted" role="status" data-testid="list-updating">
              <Spinner /> Updating…
            </span>
          )}
```

6. Prev button: change `disabled={history.length === 0}` to `disabled={history.length === 0 || updating}`. Next button: change `disabled={isError || !data?.nextToken}` to `disabled={isError || updating || !data?.nextToken}`.

- [ ] **Step 4: Run all web tests and typecheck**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf/web && npx vitest run && npx tsc -b`
Expected: all PASS, `tsc` clean. If an existing test asserted a `0` badge **before** stats had loaded, update it to wait for stats (`await screen.findByRole('button', { name: /^All 0/ })`) rather than weakening the new behaviour.

- [ ] **Step 5: Commit**

```bash
cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf
git branch --show-current   # must print worktree-workflow-loading-perf
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): keep workflow rows visible while a filter loads

Shows Updating… in the pager, … in the status tabs before stats arrive,
and disables paging and row selection on placeholder rows.

Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>"
```

---

### Task 9: Full verification + after-benchmark

**Files:** none (verification only)

- [ ] **Step 1: Unit + web gate**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && make test`
Expected: exit 0. Quote the final Go and Vitest summary lines in the report.

- [ ] **Step 2: Integration gate**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && make test-integration`
Expected: exit 0, with the parity and store-contract tests PASS (not SKIP) for all four backends. If a known unrelated flake appears (the Linux-only proc-controller lifecycle test), rerun once and say so.

- [ ] **Step 3: Build (SPA typecheck + embed)**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && make build`
Expected: exit 0, `bin/diagrid-dev-dashboard` produced. Don't commit `web/dist`.

- [ ] **Step 4: After-benchmark**

Run: `cd /Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/workflow-loading-perf && go test -tags integration -run '^$' -bench BenchmarkWorkflowListStats -benchtime 3x -timeout 60m ./pkg/workflow | tee /tmp/wf-bench-after.txt`
Expected: `list-page` and `stats-cold` faster than `/tmp/wf-bench-before.txt` on every backend, and `stats-warm` much faster than `stats-cold`. Put a before/after table (backend × list-page / stats-cold / stats-warm, ns/op) in the PR description. If any backend got slower, stop and report instead of opening the PR.

- [ ] **Step 5: Manual smoke test (optional but recommended)**

Run the binary against a local Dapr app with a Redis state store holding a few hundred workflows (`./bin/diagrid-dev-dashboard --no-open --verbose`), open `/workflows`, switch status tabs and stores, and confirm: rows stay visible with "Updating…" on filter change, the table resets on store switch, and the tab counts fill in.
