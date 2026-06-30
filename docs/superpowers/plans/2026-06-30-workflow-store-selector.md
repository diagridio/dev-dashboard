# Workflow-page store selector (Spec 2c-i) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user pick any listed state store on the workflow page (defaulting to the active one), thread the selection through list/stats/detail and persist it, and make the page distinguish "no state store" from "store unreachable".

**Architecture:** Backend adds a `workflow.ErrStoreUnreachable` sentinel plus a tiny unreachable `Service` implementation; `reconciler.ServiceFor` returns that service (instead of the degraded/ErrNoStore one) when a *known* store fails to open, and the workflow HTTP handlers map the sentinel to a store-specific 503. Frontend replaces the read-only store chip with a `<select>` over `/api/statestores` entries (addressed by `id`), persists the choice in `localStorage`, threads `?store=<id>` into the list/stats/detail queries and links, and renders the server-provided error message verbatim for unreachable stores.

**Tech Stack:** Go (chi router, `errors.Is`, httptest), React + TypeScript (react-router-dom, @tanstack/react-query), Vitest + MSW.

## Global Constraints

- Go tests are gated by `//go:build unit` / `//go:build integration` build tags.
- Go commands: `go test -tags unit -race ./...`; `go test -tags integration ./cmd/...`; `go build ./...`.
- Web commands (run from `web/`): single file `npx vitest run <file>`; full suite `npm test`; typecheck/build `npm run build` (runs `tsc -b && vite build`).
- Commit ONLY each task's files via explicit `git add <paths>`; never `git commit -am`.
- Leave the pre-existing uncommitted artifacts `web/dist/index.html` and `web/package-lock.json` untouched — do not `git add` them.
- Store addressing is by `id` (the `?store=` value is a registry entry id, never a name). Same-named stores are disambiguated in the selector by including the connection in the option label.
- The localStorage key for the selected store is exactly `devdash.workflowStore`.

---

## File Structure

- `pkg/workflow/service.go` — owns the `Service` interface, `ErrNoStore`/`ErrNotFound`; gains `ErrStoreUnreachable` + `NewUnreachableService`.
- `pkg/workflow/unreachable_test.go` (new) — unit test for the unreachable service.
- `cmd/reconciler.go` — `ServiceFor` refactor to return the unreachable service for known-but-unreachable stores.
- `cmd/reconciler_test.go` — extends with failing-opener routing tests.
- `pkg/server/workflows.go` — adds the `ErrStoreUnreachable` → 503 case to the three GET handlers.
- `pkg/server/workflows_test.go` — extends with unreachable-handler tests.
- `web/src/types/workflow.ts` — `StateStore` gains `id` and `source`.
- `web/src/lib/api.ts` — `fetchJSON` includes the response body's `error` in the thrown message.
- `web/src/lib/api.test.ts` (new) — tests for the enriched error message.
- `web/src/pages/Workflows.tsx` — store `<select>` + persistence + error rendering + `?store=` link threading.
- `web/src/pages/Workflows.test.tsx` — selector / persistence / unreachable-error tests.
- `web/src/pages/WorkflowDetail.tsx` — copy-link affordance includes `?store=` (already reads `?store=`).

---

## Task 1: Backend — unreachable store sentinel, service, ServiceFor refactor, handler mapping

**Files:**
- Modify: `pkg/workflow/service.go:15-18` (sentinel vars), add new types after line 46
- Create: `pkg/workflow/unreachable_test.go`
- Modify: `cmd/reconciler.go:240-268` (`ServiceFor`)
- Modify: `cmd/reconciler_test.go` (add failing-opener tests)
- Modify: `pkg/server/workflows.go:69-123` (three GET handlers)
- Modify: `pkg/server/workflows_test.go` (add unreachable tests)

**Interfaces:**
- Produces:
  - `var workflow.ErrStoreUnreachable = errors.New("could not connect to state store")`
  - `func workflow.NewUnreachableService(name, conn string) workflow.Service` — its `List`/`Stats`/`Get` each return `fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, name, conn)`.
  - `reconciler.ServiceFor(id string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool)` — for a known-but-unreachable store returns `(workflow.NewUnreachableService(comp.Name, statestore.ConnInfo(comp)), rc.degraded.rem, rc.degraded.targets, true)`.
- Consumes:
  - `statestore.ConnInfo(c statestore.Component) string` (existing, `pkg/statestore/conninfo.go`).
  - `rc.degraded storeEntry` with fields `svc`, `rem`, `targets` (existing, `cmd/workflow.go:188`).
  - `rc.pool.openOrGet(ctx, comp) (storeEntry, error)` (existing, `cmd/connpool.go:55`).
  - The server test helpers `get`, `postJSON`, `newFakeBackend`, `fakeBackend`, `fakeWF` (existing, `pkg/server/workflows_test.go`).

- [ ] **Step 1: Write the failing unit test for the unreachable service**

Create `pkg/workflow/unreachable_test.go`:

```go
//go:build unit

package workflow

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestUnreachableService(t *testing.T) {
	svc := NewUnreachableService("statestore", "localhost:16379")

	_, listErr := svc.List(context.Background(), ListQuery{})
	_, statsErr := svc.Stats(context.Background(), ListQuery{})
	_, getErr := svc.Get(context.Background(), "order", "abc")

	for name, err := range map[string]error{"List": listErr, "Stats": statsErr, "Get": getErr} {
		require.Error(t, err, "%s should error", name)
		require.True(t, errors.Is(err, ErrStoreUnreachable), "%s wraps ErrStoreUnreachable", name)
		require.True(t, strings.Contains(err.Error(), "statestore"), "%s message names the store", name)
		require.True(t, strings.Contains(err.Error(), "localhost:16379"), "%s message includes the connection", name)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit -race ./pkg/workflow/ -run TestUnreachableService`
Expected: FAIL — compile error `undefined: NewUnreachableService` and `undefined: ErrStoreUnreachable`.

- [ ] **Step 3: Add the sentinel and the unreachable service**

In `pkg/workflow/service.go`, change the sentinel block (currently lines 15–18):

```go
var (
	ErrNotFound        = errors.New("workflow not found")
	ErrNoStore         = errors.New("no state store configured")
	ErrStoreUnreachable = errors.New("could not connect to state store")
)
```

Add `"fmt"` to the import block (it currently imports `"context"`, `"errors"`, `"sort"`, `"strings"`, `"time"` and the dapr/statestore/proto packages). The import block becomes:

```go
import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"google.golang.org/protobuf/proto"
)
```

Then add the unreachable service immediately after `func New(...)` (after line 46):

```go
// unreachableService is a workflow.Service for a known state store whose
// backend could not be opened. Every method returns ErrStoreUnreachable
// wrapped with the store's display name and secrets-free connection so the
// API can surface an accurate "could not connect…" message.
type unreachableService struct {
	name string
	conn string
}

// NewUnreachableService builds a Service whose List/Stats/Get all fail with a
// store-specific ErrStoreUnreachable error.
func NewUnreachableService(name, conn string) Service {
	return unreachableService{name: name, conn: conn}
}

func (u unreachableService) err() error {
	return fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, u.name, u.conn)
}

func (u unreachableService) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{}, u.err()
}

func (u unreachableService) Stats(context.Context, ListQuery) (StatsResult, error) {
	return StatsResult{}, u.err()
}

func (u unreachableService) Get(context.Context, string, string) (Execution, error) {
	return Execution{}, u.err()
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit -race ./pkg/workflow/ -run TestUnreachableService`
Expected: PASS.

- [ ] **Step 5: Write the failing reconciler routing tests (known-but-unreachable)**

Append to `cmd/reconciler_test.go` (the file already imports `context`, `net/http`, `os`, `path/filepath`, `sync/atomic`, `testing`, the `server`/`statestore` packages and `require`). Add `"errors"` and the workflow import to its import block first — change the import block to:

```go
import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)
```

Then append these tests and the failing opener helper at the end of the file:

```go
// failingOpener always fails to open, simulating an unreachable backend.
type failingOpener struct{}

func (failingOpener) open(_ context.Context, _ statestore.Component) (statestore.Store, error) {
	return nil, errors.New("dial tcp: connection refused")
}

func TestReconciler_ServiceForUnreachableByID(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	autoPath := seedAutoComponentYAML(t, dir, "downstore", filepath.Join(dir, "down.db"))
	reg := LoadRegistry(home)
	require.NoError(t, reg.UpsertAuto(ConnEntry{Name: "downstore", Type: "state.sqlite", Source: SourceAuto, Path: autoPath}))

	var id string
	for _, e := range reg.List() {
		if e.Path == autoPath {
			id = e.ID
		}
	}
	require.NotEmpty(t, id)

	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	svc, _, _, ok := rc.ServiceFor(id)
	require.True(t, ok, "a known but unreachable store is still ok=true")
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrStoreUnreachable), "unreachable store yields ErrStoreUnreachable, not ErrNoStore")
	require.False(t, errors.Is(err, workflow.ErrNoStore))
}

func TestReconciler_ServiceForUnreachableActive(t *testing.T) {
	dir := t.TempDir()
	home := t.TempDir()

	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// Elect an active store; the pool's opener will fail to connect to it.
	active := statestore.Component{Name: "activedown", Type: "state.sqlite", Metadata: map[string]string{"connectionString": filepath.Join(dir, "active.db")}}
	rc.mu.Lock()
	rc.electedReg = newStoreRegistry([]statestore.Component{active}, nil, nil)
	rc.mu.Unlock()

	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrStoreUnreachable), "active-but-unreachable yields ErrStoreUnreachable")
}

func TestReconciler_ServiceForNoStoreStillErrNoStore(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	// No elected store and empty id -> degraded/ErrNoStore (genuinely no store).
	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.True(t, errors.Is(err, workflow.ErrNoStore), "no store at all stays ErrNoStore")
}

func TestReconciler_ServiceForUnknownID(t *testing.T) {
	home := t.TempDir()
	reg := LoadRegistry(home)
	pool := newConnPool("default", &http.Client{}, nil, failingOpener{}.open)
	rc := newReconciler(nil, "default", home, "", &http.Client{}, reg, pool)
	t.Cleanup(func() { _ = rc.Close() })

	_, _, _, ok := rc.ServiceFor("nosuchid")
	require.False(t, ok, "unknown id -> ok=false")
}
```

- [ ] **Step 6: Run the reconciler tests to verify they fail**

Run: `go test -tags unit -race ./cmd/ -run 'TestReconciler_ServiceForUnreachable|TestReconciler_ServiceForNoStoreStillErrNoStore|TestReconciler_ServiceForUnknownID'`
Expected: FAIL — `TestReconciler_ServiceForUnreachableByID` and `...UnreachableActive` fail because the current `ServiceFor` returns the degraded entry (whose `List` yields `ErrNoStore`, not `ErrStoreUnreachable`). The degraded service comes from `buildStoreEntry(nil, …)` whose `workflow.New(nil, …)` returns `ErrNoStore`. (`...NoStoreStillErrNoStore` and `...UnknownID` may already pass.)

- [ ] **Step 7: Refactor `ServiceFor` to return the unreachable service for known-but-unreachable stores**

In `cmd/reconciler.go`, replace the whole `ServiceFor` method (lines 240–268) with:

```go
// ServiceFor satisfies server.WorkflowBackend. The argument is a registry entry
// id (the ?store= value), never a name.
//   - id == "" -> the elected active store, pre-warmed via the pool. If no store
//     is elected, the degraded (ErrNoStore) entry. If a store IS elected but the
//     pool cannot open it, the unreachable service (ErrStoreUnreachable).
//   - id matches a registry entry -> build its component and connect via the
//     pool; on open failure, the unreachable service.
//   - unknown id -> ok=false.
func (rc *reconciler) ServiceFor(id string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	var comp statestore.Component
	if id == "" {
		active := rc.activeComponent()
		if active == nil {
			return rc.degraded.svc, rc.degraded.rem, rc.degraded.targets, true
		}
		comp = *active
	} else {
		c, ok := rc.componentFor(id)
		if !ok {
			return nil, nil, nil, false
		}
		comp = c
	}

	octx, cancel := context.WithTimeout(context.Background(), connectTimeout)
	defer cancel()
	e, err := rc.pool.openOrGet(octx, comp)
	if err != nil {
		// Known store, unreachable: return a service that surfaces an accurate
		// store-specific "could not connect…" error (not the no-store message),
		// reusing the degraded remover/target-resolver.
		return workflow.NewUnreachableService(comp.Name, statestore.ConnInfo(comp)),
			rc.degraded.rem, rc.degraded.targets, true
	}
	return e.svc, e.rem, e.targets, true
}
```

- [ ] **Step 8: Run the reconciler tests to verify they pass**

Run: `go test -tags unit -race ./cmd/ -run 'TestReconciler_ServiceForUnreachable|TestReconciler_ServiceForNoStoreStillErrNoStore|TestReconciler_ServiceForUnknownID|TestReconciler_ServiceForRouting|TestReconciler_NoActiveNoStoresDegraded'`
Expected: PASS (all listed tests).

- [ ] **Step 9: Write the failing handler tests (ErrStoreUnreachable → store-specific 503)**

Append to `pkg/server/workflows_test.go` (it already imports `context`, `fmt`, `io`, `net/http`, `net/http/httptest`, `strings`, `testing`, the `version`/`workflow` packages, and `require`):

```go
func TestWorkflowsListUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
	require.Contains(t, body, "statestore")
	require.Contains(t, body, "localhost:16379")
	// Must NOT be the generic no-store message.
	require.NotContains(t, body, "no state store detected")
}

func TestWorkflowsStatsUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/stats")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
}

func TestWorkflowDetailUnreachableStore(t *testing.T) {
	unreachable := workflow.NewUnreachableService("statestore", "localhost:16379")
	h := workflowsRouter(newFakeBackend(unreachable), nil)

	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "could not connect to state store")
	require.NotContains(t, body, "no state store detected")
}

func TestWorkflowsNoStoreMessageUnchanged(t *testing.T) {
	noStore := fakeWF{err: workflow.ErrNoStore}
	h := workflowsRouter(newFakeBackend(noStore), nil)

	res, body := get(t, h, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
	require.Contains(t, body, "no state store detected")
}
```

- [ ] **Step 10: Run the handler tests to verify they fail**

Run: `go test -tags unit -race ./pkg/server/ -run 'TestWorkflowsListUnreachableStore|TestWorkflowsStatsUnreachableStore|TestWorkflowDetailUnreachableStore|TestWorkflowsNoStoreMessageUnchanged'`
Expected: FAIL — the three "Unreachable" tests fail. With no `ErrStoreUnreachable` case, the handlers fall through to the generic `err != nil` branch and return `500`, not `503` (`TestWorkflowsNoStoreMessageUnchanged` already passes).

- [ ] **Step 11: Add the `ErrStoreUnreachable` → 503 case to all three GET handlers**

In `pkg/server/workflows.go`, the `r.Get("/")` handler currently has (lines 76–84):

```go
		res, err := svc.List(req.Context(), q)
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
```

Replace that block with (adds the unreachable case before the generic one):

```go
		res, err := svc.List(req.Context(), q)
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if errors.Is(err, workflow.ErrStoreUnreachable) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
```

The `r.Get("/stats")` handler currently has (lines 94–103):

```go
		res, err := svc.Stats(req.Context(), parseListQuery(req))
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
```

Replace it with:

```go
		res, err := svc.Stats(req.Context(), parseListQuery(req))
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if errors.Is(err, workflow.ErrStoreUnreachable) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
```

The `r.Get("/{appId}/{instanceId}")` handler currently has the switch (lines 112–122):

```go
		ex, err := svc.Get(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		switch {
		case errors.Is(err, workflow.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
		case errors.Is(err, workflow.ErrNoStore):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusOK, ex)
		}
```

Replace it with:

```go
		ex, err := svc.Get(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		switch {
		case errors.Is(err, workflow.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
		case errors.Is(err, workflow.ErrNoStore):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
		case errors.Is(err, workflow.ErrStoreUnreachable):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusOK, ex)
		}
```

- [ ] **Step 12: Run the handler tests to verify they pass**

Run: `go test -tags unit -race ./pkg/server/ -run 'TestWorkflowsListUnreachableStore|TestWorkflowsStatsUnreachableStore|TestWorkflowDetailUnreachableStore|TestWorkflowsNoStoreMessageUnchanged|TestWorkflowsList|TestWorkflowDetailAndNotFound|TestWorkflowUnknownStore'`
Expected: PASS (all listed tests).

- [ ] **Step 13: Run the full backend gates**

Run: `go build ./...`
Expected: builds with no errors.

Run: `go test -tags unit -race ./...`
Expected: PASS.

Run: `go test -tags integration ./cmd/...`
Expected: PASS.

- [ ] **Step 14: Commit**

```bash
git add pkg/workflow/service.go pkg/workflow/unreachable_test.go cmd/reconciler.go cmd/reconciler_test.go pkg/server/workflows.go pkg/server/workflows_test.go
git commit -m "feat(workflow): distinguish unreachable store from no store

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Frontend — StateStore id/source, enriched fetchJSON error, store selector + persistence + error rendering

**Files:**
- Modify: `web/src/types/workflow.ts:40-46` (`StateStore`)
- Modify: `web/src/lib/api.ts:9-16` (`fetchJSON`)
- Create: `web/src/lib/api.test.ts`
- Modify: `web/src/pages/Workflows.tsx` (store chip → select, persistence, error branch, list/stats `store` param)
- Modify: `web/src/pages/Workflows.test.tsx` (selector / persistence / unreachable tests; update the now-stale chip tests)

**Interfaces:**
- Consumes:
  - `useStateStores()` → `StateStore[]` with fields `id`, `name`, `type`, `source`, `path`, `active`, `connection` (existing hook, `web/src/hooks/useWorkflows.ts`).
  - `useWorkflows({ ..., store })` and `useWorkflowStats({ ..., store })` — both already accept an optional `store?: string` that becomes `?store=<value>` (existing).
  - `fetchJSON<T>(path): Promise<T>` (existing, `web/src/lib/api.ts`).
- Produces:
  - `StateStore.id: string`, `StateStore.source: string` (consumed by Task 3 implicitly via the same type).
  - `selectedStore: string` state in `Workflows.tsx` (a store **id**) persisted to `localStorage['devdash.workflowStore']`; threaded into the list/stats hooks and (Task 3) into the row links.

- [ ] **Step 1: Write the failing test for `StateStore` id/source typing + enriched fetchJSON error**

Create `web/src/lib/api.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { fetchJSON } from './api'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('fetchJSON error enrichment', () => {
  it('includes the response body error message and keeps the status prefix and path suffix', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'could not connect to state store "statestore" (localhost:16379)' }, { status: 503 }),
      ),
    )
    await expect(fetchJSON('/workflows')).rejects.toThrowError(
      /API error 503.*could not connect to state store.*localhost:16379.*for \/workflows/,
    )
  })

  it('still throws the status prefix when the body has no error field', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.text('boom', { status: 500 })))
    await expect(fetchJSON('/workflows')).rejects.toThrowError(/API error 500 for \/workflows/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run (from `web/`): `npx vitest run src/lib/api.test.ts`
Expected: FAIL — the first case fails because the current `fetchJSON` throws only `API error 503 for /workflows` (no body message).

- [ ] **Step 3: Enrich `fetchJSON` to include the body's `error` field**

In `web/src/lib/api.ts`, replace `fetchJSON` (lines 9–16) with:

```ts
/** Fetch JSON from the API and return the parsed body. Throws on non-2xx responses.
 *  The thrown Error keeps the `API error <status>` prefix and ` for <path>` suffix
 *  (so callers' `.includes('503')` checks still hold) and, when the response body
 *  carries an `error` field, embeds that server message between them. */
export async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path))
  if (!res.ok) {
    let detail = ''
    try {
      const body = (await res.json()) as { error?: unknown }
      if (body && typeof body.error === 'string') {
        detail = `: ${body.error}`
      }
    } catch {
      // Non-JSON or empty body: fall back to the status-only message.
    }
    throw new Error(`API error ${res.status}${detail} for ${path}`)
  }
  return (await res.json()) as T
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run (from `web/`): `npx vitest run src/lib/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Add `id` and `source` to the `StateStore` type**

In `web/src/types/workflow.ts`, replace the `StateStore` interface (lines 40–46) with:

```ts
export interface StateStore {
  id: string
  name: string
  type: string
  source: string // 'auto' | 'manual'
  path: string
  active: boolean
  connection: string
}
```

- [ ] **Step 6: Write the failing Workflows selector / persistence / error tests**

In `web/src/pages/Workflows.test.tsx`:

First update the shared fixture and the existing chip-oriented tests so they reflect the new selector (the read-only chip is gone). Replace the `activeStoreOnly` fixture (lines 12–14) with one carrying `id`/`source`:

```tsx
const activeStoreOnly = [
  { id: 'redis-auto', name: 'redis', type: 'state.redis', source: 'auto', path: '/components/redis.yaml', active: true, connection: 'localhost:6379' },
]
```

Replace the three now-stale tests — `'shows the active store type and connection as a label in the statestore chip'` (lines 91–101), `'renders the statestore as a label, not a select'` (lines 103–111), and `'keeps the colored status dot in the statestore chip'` (lines 113–120) — with these selector-based tests:

```tsx
  it('renders the store selector with the active store selected and an active marker', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    // value is the store id, not its name
    await waitFor(() => expect(storeSelect.value).toBe('redis-auto'))
    const opt = storeSelect.querySelector('option[value="redis-auto"]') as HTMLOptionElement
    // label: "name — type · connection (active)"
    expect(opt.textContent).toMatch(/redis — redis · localhost:6379 \(active\)/)
  })

  it('keeps a component link beside the store selector pointing at the selected store', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    const link = await screen.findByRole('link', { name: /open the .* component page/i })
    expect(link).toHaveAttribute('href', '/components/redis')
  })
```

Then append a new `describe` block at the end of the file (before the final `}` of the module, after the existing `describe('Workflows page — select all', …)` block):

```tsx
describe('Workflows page — store selector', () => {
  const twoStores = [
    { id: 'statestore-a', name: 'statestore', type: 'state.redis', source: 'auto', path: '/a', active: true, connection: 'localhost:6379' },
    { id: 'statestore-b', name: 'statestore', type: 'state.redis', source: 'manual', path: '/b', active: false, connection: 'localhost:16379' },
  ]

  beforeEach(() => {
    window.localStorage.clear()
  })

  it('lists every store with a disambiguating "name — type · connection" label', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    const labels = Array.from(storeSelect.querySelectorAll('option')).map((o) => o.textContent)
    expect(labels).toContain('statestore — redis · localhost:6379 (active)')
    expect(labels).toContain('statestore — redis · localhost:16379')
  })

  it('selecting a store sends ?store=<id>, shows that store rows, and resets the app filter', async () => {
    let capturedStore: string | null = null
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        capturedStore = url.searchParams.get('store')
        const rows =
          url.searchParams.get('store') === 'statestore-b'
            ? [{ appId: 'pr-digest', instanceId: 'b1', name: 'AgentRunWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }]
            : [{ appId: 'order', instanceId: 'a1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }]
        return HttpResponse.json({ items: rows })
      }),
    )
    renderAt('/workflows?app=order')
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await screen.findByRole('link', { name: 'a1' })
    await userEvent.selectOptions(storeSelect, 'statestore-b')
    await waitFor(() => expect(capturedStore).toBe('statestore-b'))
    expect(await screen.findByRole('link', { name: 'b1' })).toBeInTheDocument()
    // The app filter was reset to "All apps".
    const appSelect = screen.getByTestId('app-select') as HTMLSelectElement
    await waitFor(() => expect(appSelect.value).toBe(''))
  })

  it('persists the selection to localStorage and restores it on reload', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    )
    const first = renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await userEvent.selectOptions(storeSelect, 'statestore-b')
    await waitFor(() => expect(window.localStorage.getItem('devdash.workflowStore')).toBe('statestore-b'))
    first.unmount()

    // Reload: a fresh render reads the persisted id.
    renderAt()
    const restored = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await waitFor(() => expect(restored.value).toBe('statestore-b'))
  })

  it('falls back to the active store when the persisted id is no longer in the list', async () => {
    window.localStorage.setItem('devdash.workflowStore', 'gone-store-id')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () => HttpResponse.json({ items: [] })),
    )
    renderAt()
    const storeSelect = (await screen.findByTestId('store-select')) as HTMLSelectElement
    await waitFor(() => expect(storeSelect.value).toBe('statestore-a')) // the active one
  })

  it('shows the server "could not connect…" message on an unreachable 503 (not the no-store guidance)', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'could not connect to state store "statestore" (localhost:16379)' }, { status: 503 }),
      ),
    )
    renderAt()
    await waitFor(() => expect(screen.getByText(/could not connect to state store/i)).toBeInTheDocument())
    expect(screen.getByText(/localhost:16379/)).toBeInTheDocument()
    // The --statestore guidance is only for the genuine no-store case.
    expect(screen.queryByText(/--statestore/)).toBeNull()
  })
})
```

- [ ] **Step 7: Run the Workflows tests to verify they fail**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx`
Expected: FAIL — `store-select` is not in the DOM yet (the page still renders the read-only chip), and the unreachable-error test still shows the hard-coded "No state store detected" text.

- [ ] **Step 8: Implement the store selector, persistence, list/stats threading, and error rendering in `Workflows.tsx`**

In `web/src/pages/Workflows.tsx`, make the following edits.

(a) Add the localStorage key constant near the top of the file, immediately after the `ALL_STATUSES` constant (after line 11):

```tsx
const STORE_KEY = 'devdash.workflowStore'
```

(b) Replace the active-store block + stale comment (lines 76–86) — which currently is:

```tsx
  // Active state store (the one Dapr Workflow uses). The API returns only this
  // store, so there is no switching — we render it as a label.
  const { data: storeList } = useStateStores()
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]
  // Label: short type + secrets-free connection, e.g. "redis · localhost:6379".
  const storeTypeShort = activeStore
    ? (activeStore.type.split('.').pop() ?? activeStore.type)
    : ''
  const storeLabel = activeStore
    ? (activeStore.connection ? `${storeTypeShort} · ${activeStore.connection}` : storeTypeShort)
    : 'unknown'
```

with:

```tsx
  // State stores. The user can pick any listed store; the choice (a store id)
  // is threaded into the workflow list/stats/detail and persisted across reloads.
  const { data: storeList } = useStateStores()
  const activeStore = storeList?.find((s) => s.active) ?? storeList?.[0]

  // selectedStore is a store id. Initialize from localStorage when that id is
  // still in the list, else the active store's id. A stale persisted id falls
  // back to active. We resolve the default once the list is available.
  const [selectedStore, setSelectedStore] = useState<string>('')
  useEffect(() => {
    if (!storeList || storeList.length === 0) return
    if (selectedStore && storeList.some((s) => s.id === selectedStore)) return
    const persisted = window.localStorage.getItem(STORE_KEY)
    const fromPersisted = persisted && storeList.some((s) => s.id === persisted) ? persisted : undefined
    const fallback = activeStore?.id ?? storeList[0].id
    setSelectedStore(fromPersisted ?? fallback)
  }, [storeList, activeStore, selectedStore])

  // The currently-selected store object (for the component link + labels).
  const selectedStoreObj = useMemo(
    () => storeList?.find((s) => s.id === selectedStore),
    [storeList, selectedStore],
  )

  // Option label: "name — type · connection", with a short type (state.redis → redis).
  function storeOptionLabel(s: StateStore): string {
    const typeShort = s.type.split('.').pop() ?? s.type
    const head = `${s.name} — ${s.connection ? `${typeShort} · ${s.connection}` : typeShort}`
    return s.active ? `${head} (active)` : head
  }

  function onStoreChange(id: string) {
    setSelectedStore(id)
    window.localStorage.setItem(STORE_KEY, id)
    // A different store has different apps — reset the app filter to "All apps".
    setSelectedApp('')
    setPage(undefined)
    setPageIndex(0)
    setLoadedCount(0)
  }
```

(c) Add the `StateStore` type import. The current import on line 9 is:

```tsx
import type { WorkflowStatus, WorkflowSummary } from '../types/workflow'
```

Replace it with:

```tsx
import type { StateStore, WorkflowStatus, WorkflowSummary } from '../types/workflow'
```

(d) Thread `selectedStore` into the list and stats hooks. The `useWorkflows` call (lines 121–126) currently is:

```tsx
  const { data, isLoading, isError, error } = useWorkflows({
    status: activeStatus ? [activeStatus] : undefined,
    search: debouncedSearch || undefined,
    page,
    appId: selectedApp || undefined,
  })
```

Replace it with:

```tsx
  const { data, isLoading, isError, error } = useWorkflows({
    status: activeStatus ? [activeStatus] : undefined,
    search: debouncedSearch || undefined,
    page,
    appId: selectedApp || undefined,
    store: selectedStore || undefined,
  })
```

The `useWorkflowStats` call (lines 128–131) currently is:

```tsx
  const { data: stats } = useWorkflowStats({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
  })
```

Replace it with:

```tsx
  const { data: stats } = useWorkflowStats({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
    store: selectedStore || undefined,
  })
```

(e) Update the error branch to render the server message for unreachable stores. The `if (isError)` block (lines 246–264) currently is:

```tsx
  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      return (
        <div className="page">
          <p style={{ color: 'var(--fail-fg)', fontWeight: 600 }}>No state store detected</p>
          <p style={{ color: 'var(--muted)', marginTop: 8 }}>
            Dapr requires a state store to persist workflow state. Configure one with the{' '}
            <span className="mono">--statestore</span> flag or add a state store component.
          </p>
        </div>
      )
    }
    return (
      <div className="page">
        <p style={{ color: 'var(--fail-fg)' }}>Error loading workflows: {errStr}</p>
      </div>
    )
  }
```

Replace it with:

```tsx
  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      const isNoStore = errStr.includes('no state store detected')
      // The server message follows the "API error 503: <message> for <path>" shape.
      const serverMsg = errStr.replace(/^.*?503:\s*/, '').replace(/\s*for\s+\/\S*$/, '')
      return (
        <div className="page">
          <p style={{ color: 'var(--fail-fg)', fontWeight: 600 }}>
            {isNoStore ? 'No state store detected' : serverMsg}
          </p>
          {isNoStore && (
            <p style={{ color: 'var(--muted)', marginTop: 8 }}>
              Dapr requires a state store to persist workflow state. Configure one with the{' '}
              <span className="mono">--statestore</span> flag or add a state store component.
            </p>
          )}
        </div>
      )
    }
    return (
      <div className="page">
        <p style={{ color: 'var(--fail-fg)' }}>Error loading workflows: {errStr}</p>
      </div>
    )
  }
```

(f) Replace the read-only store chip in the header. The `<div className="ctrlset">` block (lines 278–290) currently is:

```tsx
        <div className="ctrlset">
          {activeStore ? (
            <Link className="chip link" to={`/components/${activeStore.name}`}>
              <span className="led" />
              statestore <b>{storeLabel}</b>
            </Link>
          ) : (
            <span className="chip">
              <span className="led" />
              statestore <b>unknown</b>
            </span>
          )}
        </div>
```

Replace it with:

```tsx
        <div className="ctrlset">
          {storeList && storeList.length > 0 ? (
            <>
              <span className="led" />
              <select
                className="select"
                data-testid="store-select"
                aria-label="Switch state store"
                value={selectedStore}
                onChange={(e) => onStoreChange(e.target.value)}
              >
                {storeList.map((s) => (
                  <option key={s.id} value={s.id}>
                    {storeOptionLabel(s)}
                  </option>
                ))}
              </select>
              {selectedStoreObj && (
                <Link
                  className="chip link"
                  to={`/components/${selectedStoreObj.name}`}
                  aria-label={`Open the ${selectedStoreObj.name} component page`}
                  title={`Open the ${selectedStoreObj.name} component page`}
                >
                  ↗
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
```

- [ ] **Step 9: Run the Workflows tests to verify they pass**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS.

- [ ] **Step 10: Typecheck and build the frontend**

Run (from `web/`): `npm run build`
Expected: `tsc -b && vite build` succeed with no type errors. (Note: `vite build` rewrites `dist/index.html` — do NOT stage it.)

- [ ] **Step 11: Run the full web suite**

Run (from `web/`): `npm test`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add web/src/types/workflow.ts web/src/lib/api.ts web/src/lib/api.test.ts web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): workflow-page store selector with persistence and accurate errors

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Frontend — thread the selected store into the detail-page links and detail copy-link

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (instance row `navigate(...)` ~line 478 and the row `<Link to=...>` ~line 503 append `?store=<id>`)
- Modify: `web/src/pages/Workflows.test.tsx` (row link carries `?store=<id>`)
- Modify: `web/src/pages/WorkflowDetail.tsx` (copy-link includes the `store` param)
- Modify: `web/src/pages/WorkflowDetail.test.tsx` (detail with `?store=<id>` requests `?store=<id>`; copy-link includes the store)

**Interfaces:**
- Consumes:
  - `selectedStore: string` state from `Workflows.tsx` (Task 2) — a store id.
  - `WorkflowDetail` already reads `?store=` via `useSearchParams` and passes it to `useWorkflow(appId, instanceId, store)` (existing, `web/src/pages/WorkflowDetail.tsx:222-224`).
- Produces:
  - Row links of the form `/workflows/<app>/<inst>?store=<id>` when a store is selected; plain `/workflows/<app>/<inst>` when not.
  - A detail-page "Copy link" button that copies `…/workflows/<app>/<inst>?store=<id>`.

- [ ] **Step 1: Write the failing test — the instance-row link carries `?store=<id>`**

In `web/src/pages/Workflows.test.tsx`, add this test to the `describe('Workflows page — store selector', …)` block (created in Task 2):

```tsx
  it('instance-row links carry ?store=<id> for the selected store', async () => {
    window.localStorage.setItem('devdash.workflowStore', 'statestore-b')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }] }),
      ),
    )
    renderAt()
    const link = await screen.findByRole('link', { name: 'abc' })
    expect(link).toHaveAttribute('href', '/workflows/order/abc?store=statestore-b')
  })
```

- [ ] **Step 2: Write the failing detail-page tests — `?store=` is forwarded and the copy-link includes it**

In `web/src/pages/WorkflowDetail.test.tsx`, change `renderDetail` (lines 14–28) so the initial entry can include a query string, then add two tests. Replace `renderDetail` with:

```tsx
function renderDetail(client?: QueryClient, entry = '/workflows/order/abc') {
  // Always use a fresh client to avoid cross-test cache pollution
  const qc = client ?? makeQueryClient()
  const router = createMemoryRouter(
    [{ path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> }],
    { initialEntries: [entry], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={qc}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}
```

Add a new `describe` block at the very end of the file (after the `describe('EventRow', …)` block):

```tsx
describe('WorkflowDetail — store threading', () => {
  beforeEach(() => {
    server.use(http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])))
  })

  it('forwards ?store=<id> to the workflow fetch', async () => {
    let capturedStore: string | null = null
    server.use(
      http.get('/api/workflows/order/abc', ({ request }) => {
        capturedStore = new URL(request.url).searchParams.get('store')
        return HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-26T10:00:00Z', replayCount: 0, history: [],
        })
      }),
    )
    renderDetail(undefined, '/workflows/order/abc?store=statestore-b')
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    expect(capturedStore).toBe('statestore-b')
  })

  it('the copy-link button copies a URL including the store param', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
          createdAt: '2026-06-26T10:00:00Z', replayCount: 0, history: [],
        }),
      ),
    )
    let copied = ''
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => { copied = t; return Promise.resolve() } },
    })
    renderDetail(undefined, '/workflows/order/abc?store=statestore-b')
    await waitFor(() => expect(screen.getByText('RUNNING')).toBeInTheDocument())
    await userEvent.click(screen.getByRole('button', { name: /copy link to this workflow/i }))
    expect(copied).toContain('store=statestore-b')
  })
})
```

- [ ] **Step 3: Run both test files to verify they fail**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx src/pages/WorkflowDetail.test.tsx`
Expected: FAIL — `instance-row links carry ?store=<id>` fails (links have no query); both detail store-threading tests fail (`...forwards ?store=` may already pass since the page reads `?store=`, but `...copy-link button copies a URL including the store param` fails because there is no such button yet).

- [ ] **Step 4: Thread `?store=` into the row navigate + link in `Workflows.tsx`**

In `web/src/pages/Workflows.tsx`, add a helper next to the existing row handlers — place it right after `onStoreChange` (added in Task 2 step 8b):

```tsx
  // Build the detail-page path for a row, carrying the selected store id so the
  // detail page reads from the same store.
  function detailPath(appId: string, instanceId: string): string {
    const base = `/workflows/${appId}/${instanceId}`
    return selectedStore ? `${base}?store=${encodeURIComponent(selectedStore)}` : base
  }
```

The row `<tr>`'s `onClick` (line 478) currently is:

```tsx
                      onClick={() => navigate(`/workflows/${wf.appId}/${wf.instanceId}`)}
```

Replace it with:

```tsx
                      onClick={() => navigate(detailPath(wf.appId, wf.instanceId))}
```

The instance-id `<Link>` (lines 501–507) currently is:

```tsx
                        <Link
                          className="celllink"
                          to={`/workflows/${wf.appId}/${wf.instanceId}`}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {wf.instanceId}
                        </Link>
```

Replace its `to` with the helper:

```tsx
                        <Link
                          className="celllink"
                          to={detailPath(wf.appId, wf.instanceId)}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {wf.instanceId}
                        </Link>
```

- [ ] **Step 5: Add the detail-page copy-link button that includes the store param**

In `web/src/pages/WorkflowDetail.tsx`, the `store` value is already available via `const store = searchParams.get('store') ?? undefined` (line 223) and `copyText` is already imported (line 12). Inside the `WorkflowDetail` component, add a copy-link handler. Place it immediately after `const lastRefreshed = useLastRefreshed(dataUpdatedAt)` (line 276):

```tsx
  const copyWorkflowLink = () => {
    const { origin, pathname } = window.location
    const qs = store ? `?store=${encodeURIComponent(store)}` : ''
    copyText(`${origin}${pathname}${qs}`)
    toast.show('Link copied')
  }
```

Then add the button to the `dactions` toolbar. The `<div className="dactions">` block (lines 384–404) currently starts with the Back button:

```tsx
        <div className="dactions">
          <button className="btn ghost" onClick={() => navigate(-1)}>
            ← Back
          </button>
```

Replace that opening with one that also has the copy-link button:

```tsx
        <div className="dactions">
          <button className="btn ghost" onClick={() => navigate(-1)}>
            ← Back
          </button>
          <button
            className="btn ghost"
            aria-label="Copy link to this workflow"
            title="Copy link to this workflow"
            onClick={copyWorkflowLink}
          >
            ⧉ Copy link
          </button>
```

- [ ] **Step 6: Run both test files to verify they pass**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx src/pages/WorkflowDetail.test.tsx`
Expected: PASS.

- [ ] **Step 7: Typecheck and build the frontend**

Run (from `web/`): `npm run build`
Expected: `tsc -b && vite build` succeed with no type errors. (Do NOT stage `dist/index.html`.)

- [ ] **Step 8: Run the full web suite**

Run (from `web/`): `npm test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(web): thread selected store into workflow detail links and copy-link

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

### 1. Spec coverage — each requirement mapped to a task

| Spec requirement (Design section) | Task |
| --- | --- |
| **1. Types** — `StateStore` gains `id` + `source` | Task 2, Step 5 |
| **2. Store selector** — `<select>`, value = `id`, label `name — type · connection`, ` (active)` suffix, `↗` link to `/components/<name>` | Task 2, Step 8 (b, f) |
| **3. Default + persistence** — init from `localStorage['devdash.workflowStore']` if in list else active; on change persist + reset app filter; thread through `useWorkflows`/`useWorkflowStats`; stale id falls back to active | Task 2, Step 8 (b, d) + tests Step 6 |
| **4. Detail-page threading** — row links append `?store=<id>`; `WorkflowDetail` uses it; copy-link includes `store` | Task 3, Steps 4–5 |
| **5. Error/empty states** — render server message for store-unavailable; keep `--statestore` guidance only for the no-store case | Task 2, Step 8 (e) + test Step 6 |
| **6. `workflow.ErrStoreUnreachable`** + unreachable service returning it with name+connection | Task 1, Steps 1–4 |
| **7. `reconciler.ServiceFor` branching** — known-but-unreachable → unreachable service (ok=true); no store → ErrNoStore; unknown id → ok=false | Task 1, Steps 5–8 |
| **8. Handler mapping** — `ErrStoreUnreachable` → 503 store-specific; `ErrNoStore` → 503 "no state store detected"; unknown → 404 | Task 1, Steps 9–12 |
| **Testing — frontend** (selector labels + active marker; ?store=<id> + rows + app reset; persistence/restore/stale fallback; row links ?store=<id>; unreachable 503 text; no-store guidance retained) | Task 2 Step 6 + Task 3 Step 1 |
| **Testing — backend** (ServiceFor failing-opener active + by-id → ErrStoreUnreachable; no store → ErrNoStore; unknown → ok=false; handler 503/404 mapping) | Task 1 Steps 5, 9 |
| **Out of scope** — connection-manager CRUD, per-store badges, PUT-returns-id, election/registry changes | Not implemented (correctly) |

No gaps found. The enriched `fetchJSON` (Task 2 Steps 1–4) is the mechanism that makes requirement 5's "server-provided message" reach the page; it is implied by the spec ("renders the server-provided `error` message") and the `lib/api.ts` note in the brief, so it is included.

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `similar to above`, `add appropriate`, `handle edge cases`, `etc.`, and bare "write tests for the above". None present. Every code step contains complete code; every run step gives an exact command and expected result.

### 3. Type-consistency check

- `ErrStoreUnreachable` — declared once in `pkg/workflow/service.go` (Task 1 Step 3) as `errors.New("could not connect to state store")`; referenced identically in `cmd/reconciler.go` (Step 7), `pkg/server/workflows.go` (Step 11), and all tests (Steps 1, 5, 9). Consistent.
- `NewUnreachableService(name, conn string) workflow.Service` — defined once (Step 3); called identically in `ServiceFor` as `workflow.NewUnreachableService(comp.Name, statestore.ConnInfo(comp))` (Step 7) and in tests (Steps 1, 9). Signature matches everywhere. Its error format `fmt.Errorf("%w %q (%s)", ErrStoreUnreachable, name, conn)` produces `could not connect to state store "statestore" (localhost:16379)` — matched by both the Go handler-test substring assertions and the web `could not connect to state store` / `localhost:16379` assertions.
- `StateStore.id` / `StateStore.source` — added in Task 2 Step 5; used as `s.id` (option value, selection, fallback) and as the field that exists in the JSON payload. `source` is typed (`'auto' | 'manual'` as a `string`) but not read by the UI in 2c-i (correct — badges are 2c-ii); it is present so the type matches the API contract the backend already serialises (`StoreInfo.Source`, verified in `pkg/server/workflows_test.go` `TestStateStoresEndpoint`).
- `selectedStore` (a store **id**) + localStorage key `'devdash.workflowStore'` — written via `STORE_KEY` constant in Task 2 Step 8a; the tests in Task 2 Step 6 and Task 3 Step 1 read/write the literal `'devdash.workflowStore'`. Consistent.
- `?store=` threading — Task 2 passes `store: selectedStore || undefined` to `useWorkflows`/`useWorkflowStats` (which set `?store=`); Task 3's `detailPath()` appends `?store=${encodeURIComponent(selectedStore)}`; `WorkflowDetail` reads `searchParams.get('store')` and forwards it to `useWorkflow(..., store)` and the copy-link. The id flows end-to-end identically across Tasks 2 and 3.
- `detailPath(appId, instanceId)` and `onStoreChange(id)` and `storeOptionLabel(s)` — each defined once in `Workflows.tsx` and referenced by name only where defined; no name drift.
- Test helpers reused as-is: Go `get`/`postJSON`/`newFakeBackend`/`fakeWF` and web `renderAt`/`renderDetail` — `renderDetail` gains an optional `entry` param (Task 3 Step 2) with a default that preserves all existing call sites.

No inconsistencies found.
