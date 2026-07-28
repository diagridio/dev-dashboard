# Clear Inactive Applications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give users one global, coherent action to remove all fully-stopped ("inactive") scan-detected applications from the dashboard, plus a per-row remove on the Applications list — without deleting anything from Docker.

**Architecture:** All retained inactive state flows through the lifecycle overlay (`pkg/lifecycle/overlay.go`), which decorates the stateless discovery service. We add an in-memory **suppression set** to the shared `lifecycle.Registry`. A unified `Manager.Dismiss(key)` drops any registry "ghost" and suppresses the `InstanceKey`; the overlay filters out suppressed instances while they are fully stopped and auto-un-suppresses any that reappear running. `Manager.ClearInactive` dismisses every fully-stopped instance at once. The frontend gets a global "Clear inactive · N" button in the Applications page header and a per-row remove; because components/subscriptions/actors/resources all re-derive from the app list, suppression is coherent across every page for free.

**Tech Stack:** Go (chi router, testify), React 19 + TypeScript, TanStack Query, Vitest + Testing Library + msw.

## Global Constraints

- **Non-destructive:** never run `docker rm` or delete real Docker/container state. "Remove" means suppress from the dashboard view only.
- **Fully-stopped predicate:** eligible = `AppStatus == "stopped" && DaprdStatus == "stopped"` (backend `discovery.StatusStopped`; frontend `isStopped`). Nothing else is removable.
- **Ephemeral:** suppression lives in backend process memory only; it resets on dashboard restart (same lifetime as the existing registry). No disk persistence.
- **Auto-un-hide:** a suppressed instance seen running again reappears and is pruned from the suppression set.
- **Copy rule:** user-facing text says "Remove from dashboard" and "reappear if it runs again or when the dashboard restarts". Never "delete", "remove container", or "docker rm".
- **Verification:** run `make build` (which runs `tsc -b`) after any `.ts(x)` change — Vitest alone does not typecheck. Go tests run with `-tags unit`.

---

### Task 1: Registry suppression set

**Files:**
- Modify: `pkg/lifecycle/registry.go`
- Test: `pkg/lifecycle/registry_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `(*Registry).Suppress(key string)`, `(*Registry).Unsuppress(key string)`, `(*Registry).IsSuppressed(key string) bool`. `NewRegistry()` now also initializes the suppression set.

- [ ] **Step 1: Write the failing test**

Add to `pkg/lifecycle/registry_test.go` (package `lifecycle`, no build tag — matches the existing file):

```go
func TestRegistrySuppression(t *testing.T) {
	r := NewRegistry()
	require.False(t, r.IsSuppressed("orders"))

	r.Suppress("orders")
	require.True(t, r.IsSuppressed("orders"))

	// Idempotent.
	r.Suppress("orders")
	require.True(t, r.IsSuppressed("orders"))

	r.Unsuppress("orders")
	require.False(t, r.IsSuppressed("orders"))

	// Unsuppressing an unknown key is a no-op.
	r.Unsuppress("never")
	require.False(t, r.IsSuppressed("never"))
}
```

If `registry_test.go` does not already import testify, add `"github.com/stretchr/testify/require"` and `"testing"` to its imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/lifecycle/ -run TestRegistrySuppression`
Expected: FAIL — `r.Suppress undefined (type *Registry has no field or method Suppress)`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/lifecycle/registry.go`, add a `suppressed` field to the struct and initialize it in `NewRegistry`:

```go
type Registry struct {
	mu         sync.Mutex
	entries    map[string]*Entry   // keyed by InstanceKey
	suppressed map[string]struct{} // InstanceKeys the user cleared; hidden while stopped
}

func NewRegistry() *Registry {
	return &Registry{entries: map[string]*Entry{}, suppressed: map[string]struct{}{}}
}
```

Then add the three methods (e.g. just below `Drop`):

```go
// Suppress hides an InstanceKey from the overlay while it remains fully
// stopped. It is cleared automatically when the instance is seen running
// again (see overlay.List) or on dashboard restart (the set is not persisted).
func (r *Registry) Suppress(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.suppressed[key] = struct{}{}
}

// Unsuppress removes a key from the suppression set.
func (r *Registry) Unsuppress(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.suppressed, key)
}

// IsSuppressed reports whether key is currently suppressed.
func (r *Registry) IsSuppressed(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	_, ok := r.suppressed[key]
	return ok
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/lifecycle/ -run TestRegistrySuppression`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/registry.go pkg/lifecycle/registry_test.go
git commit -m "feat(lifecycle): add suppression set to Registry"
```

---

### Task 2: Overlay hides suppressed stopped instances

**Files:**
- Modify: `pkg/lifecycle/overlay.go`
- Test: `pkg/lifecycle/overlay_test.go`

**Interfaces:**
- Consumes: `(*Registry).IsSuppressed`, `(*Registry).Unsuppress` (Task 1).
- Produces: package-level helper `fullyStopped(in discovery.Instance) bool` (reused by Task 3). `overlay.List` now filters suppressed instances.

- [ ] **Step 1: Write the failing test**

Add to `pkg/lifecycle/overlay_test.go`:

```go
func TestOverlayHidesSuppressedStoppedInstance(t *testing.T) {
	reg := NewRegistry()
	stopped := standaloneInst()
	stopped.AppStatus, stopped.DaprdStatus = discovery.StatusStopped, discovery.StatusStopped
	reg.Suppress(stopped.InstanceKey)

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": stopped}}, reg, newFakeProc())

	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Empty(t, items) // suppressed + fully stopped -> hidden
}

func TestOverlayUnsuppressesReactivatedInstance(t *testing.T) {
	reg := NewRegistry()
	live := standaloneInst()
	live.AppStatus, live.DaprdStatus = discovery.StatusRunning, discovery.StatusRunning
	reg.Suppress(live.InstanceKey)

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())

	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1) // running again -> shown
	require.False(t, reg.IsSuppressed(live.InstanceKey)) // and pruned
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/lifecycle/ -run 'TestOverlayHidesSuppressedStoppedInstance|TestOverlayUnsuppressesReactivatedInstance'`
Expected: FAIL — `TestOverlayHidesSuppressedStoppedInstance` returns 1 item (filter not implemented yet).

- [ ] **Step 3: Write minimal implementation**

In `pkg/lifecycle/overlay.go`, add the helper (e.g. just above `synthesize`):

```go
// fullyStopped reports whether both halves of an instance are stopped — the
// predicate the dashboard uses to treat an instance as inactive/removable.
func fullyStopped(in discovery.Instance) bool {
	return in.AppStatus == discovery.StatusStopped && in.DaprdStatus == discovery.StatusStopped
}
```

Then insert a suppression filter pass into `List`, immediately before the
`sort.SliceStable(...)` call:

```go
	// Suppression: instances the user cleared stay hidden while still stopped;
	// once one is seen running again it reappears and its suppression is pruned.
	out := items[:0]
	for _, in := range items {
		if o.reg.IsSuppressed(in.InstanceKey) {
			if fullyStopped(in) {
				continue
			}
			o.reg.Unsuppress(in.InstanceKey)
		}
		out = append(out, in)
	}
	items = out
```

(`items[:0]` reuses the backing array safely: the write index never passes the read index.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/lifecycle/ -run Overlay`
Expected: PASS (new tests plus all existing `Overlay*` tests still green).

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/overlay.go pkg/lifecycle/overlay_test.go
git commit -m "feat(lifecycle): overlay filters suppressed stopped instances"
```

---

### Task 3: Manager Dismiss + ClearInactive

**Files:**
- Modify: `pkg/lifecycle/manager.go`
- Test: `pkg/lifecycle/manager_test.go`

**Interfaces:**
- Consumes: `(*Registry).Drop`, `(*Registry).Suppress`, `(*Registry).Get` (Tasks 1 & existing); `fullyStopped` (Task 2); `manager.apps discovery.Service` (existing field, wired to the overlay in `cmd/root.go`).
- Produces: `Manager.Dismiss(ctx, key) error` (replaces `Forget`) and `Manager.ClearInactive(ctx) (int, error)`.

- [ ] **Step 1: Write the failing test**

In `pkg/lifecycle/manager_test.go`, replace any existing `Forget` test with these (if there is no existing `Forget` test in this file, just add them):

```go
func TestDismissSuppressesAndDropsGhost(t *testing.T) {
	reg := NewRegistry()
	ghost := standaloneInst() // InstanceKey "orders"
	reg.RecordStop(ghost, map[Target]ProcSnapshot{TargetAll: {PID: 300}})
	m := New(fakeApps{items: map[string]discovery.Instance{}}, reg, nil, newFakeProc(), nil)

	require.NoError(t, m.Dismiss(context.Background(), "orders"))

	_, ok := reg.Get("orders")
	require.False(t, ok) // ghost dropped
	require.True(t, reg.IsSuppressed("orders"))
}

func TestDismissSuppressesComposeKeyWithoutGhost(t *testing.T) {
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{}}, reg, nil, newFakeProc(), nil)

	require.NoError(t, m.Dismiss(context.Background(), "shop-checkout-app-1"))

	require.True(t, reg.IsSuppressed("shop-checkout-app-1"))
}

func TestClearInactiveDismissesEveryStoppedInstance(t *testing.T) {
	reg := NewRegistry()
	stopped1 := standaloneInst() // "orders"
	stopped1.AppStatus, stopped1.DaprdStatus = discovery.StatusStopped, discovery.StatusStopped
	stopped2 := composeInst() // "shop-checkout-app-1"
	stopped2.AppStatus, stopped2.DaprdStatus = discovery.StatusStopped, discovery.StatusStopped
	running := standaloneInst()
	running.InstanceKey, running.AppID = "live", "live"
	running.AppStatus, running.DaprdStatus = discovery.StatusRunning, discovery.StatusRunning

	m := New(fakeApps{items: map[string]discovery.Instance{
		"orders":              stopped1,
		"shop-checkout-app-1": stopped2,
		"live":                running,
	}}, reg, nil, newFakeProc(), nil)

	n, err := m.ClearInactive(context.Background())
	require.NoError(t, err)
	require.Equal(t, 2, n)
	require.True(t, reg.IsSuppressed("orders"))
	require.True(t, reg.IsSuppressed("shop-checkout-app-1"))
	require.False(t, reg.IsSuppressed("live"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/lifecycle/ -run 'Dismiss|ClearInactive'`
Expected: FAIL — `m.Dismiss undefined` / `m.ClearInactive undefined`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/lifecycle/manager.go`, update the `Manager` interface: remove `Forget` and add `Dismiss` + `ClearInactive`:

```go
// Manager starts, stops and restarts discovered app instances.
type Manager interface {
	Do(ctx context.Context, key string, target Target, action Action) error
	// Dismiss hides an inactive instance from the dashboard: it drops any
	// registry ghost and suppresses the InstanceKey so a natively-scanned
	// stopped instance (e.g. a stopped compose container) stops appearing.
	// The suppression auto-clears when the instance is seen running again.
	// It always succeeds and never touches Docker.
	Dismiss(ctx context.Context, key string) error
	// ClearInactive dismisses every currently fully-stopped instance and
	// returns how many distinct instances were dismissed.
	ClearInactive(ctx context.Context) (int, error)
}
```

Replace the existing `Forget` method with `Dismiss`, and add `ClearInactive`:

```go
// Dismiss resolves key to its canonical InstanceKey when a registry ghost
// exists (so suppression matches the key the scanner reports), drops that
// ghost, then suppresses the key. Suppressing a still-running instance is
// harmless: the overlay un-suppresses it on the next scan.
func (m *manager) Dismiss(ctx context.Context, key string) error {
	ik := key
	if e, ok := m.reg.Get(key); ok {
		ik = e.Instance.InstanceKey
	}
	logger().Info("dismissing inactive instance", "key", ik)
	m.reg.Drop(ik)
	m.reg.Suppress(ik)
	return nil
}

// ClearInactive lists the instances the dashboard currently serves (the
// manager's apps service is the overlay, so this includes synthesized ghosts
// and stopped compose containers) and dismisses each fully-stopped one.
func (m *manager) ClearInactive(ctx context.Context) (int, error) {
	items, err := m.apps.List(ctx)
	if err != nil {
		return 0, err
	}
	seen := map[string]bool{}
	for _, in := range items {
		if !fullyStopped(in) || seen[in.InstanceKey] {
			continue
		}
		seen[in.InstanceKey] = true
		m.reg.Drop(in.InstanceKey)
		m.reg.Suppress(in.InstanceKey)
	}
	return len(seen), nil
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/lifecycle/ -run 'Dismiss|ClearInactive'`
Expected: PASS. (The server package won't compile yet — that's Task 4.)

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/manager.go pkg/lifecycle/manager_test.go
git commit -m "feat(lifecycle): replace Forget with Dismiss + add ClearInactive"
```

---

### Task 4: Server routes — generalized DELETE + clear-inactive

**Files:**
- Modify: `pkg/server/apps.go:78-92` (DELETE handler) and add a new route
- Test: `pkg/server/apps_test.go`

**Interfaces:**
- Consumes: `Manager.Dismiss`, `Manager.ClearInactive` (Task 3).
- Produces: `DELETE /api/apps/{appId}` → `Dismiss` (204 always, 503 if no manager); `POST /api/apps/clear-inactive` → `{"cleared": N}` (503 if no manager).

- [ ] **Step 1: Write the failing test**

In `pkg/server/apps_test.go`, update the `fakeLifecycle` double (rename `forgetErr`→`dismissErr`, rename the method, add clear fields + method):

```go
// fakeLifecycle is a test double for lifecycle.Manager.
type fakeLifecycle struct {
	err        error
	dismissErr error
	clearErr   error
	cleared    int
	gotKey     string
	gotTgt     lifecycle.Target
	gotAct     lifecycle.Action
}

func (f *fakeLifecycle) Do(ctx context.Context, key string, target lifecycle.Target, action lifecycle.Action) error {
	f.gotKey, f.gotTgt, f.gotAct = key, target, action
	return f.err
}

func (f *fakeLifecycle) Dismiss(ctx context.Context, key string) error {
	f.gotKey = key
	return f.dismissErr
}

func (f *fakeLifecycle) ClearInactive(ctx context.Context) (int, error) {
	return f.cleared, f.clearErr
}
```

Replace `TestAppsForgetRoute` with:

```go
func TestAppsDismissRoute(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"ok", nil, http.StatusNoContent},
		{"exec failure", errors.New("boom"), http.StatusBadGateway},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := &fakeLifecycle{dismissErr: tc.err}
			h := appsRouter(newFakeApps(), nil, life, FullCapabilities())
			req := httptest.NewRequest(http.MethodDelete, "/orders", nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, tc.status, rec.Code)
			if tc.err == nil {
				require.Equal(t, "orders", life.gotKey)
			}
		})
	}
}

func TestAppsClearInactiveRoute(t *testing.T) {
	life := &fakeLifecycle{cleared: 3}
	h := appsRouter(newFakeApps(), nil, life, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/clear-inactive", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusOK, rec.Code)

	var body struct {
		Cleared int `json:"cleared"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &body))
	require.Equal(t, 3, body.Cleared)
}

func TestAppsClearInactiveRouteError(t *testing.T) {
	life := &fakeLifecycle{clearErr: errors.New("boom")}
	h := appsRouter(newFakeApps(), nil, life, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/clear-inactive", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusBadGateway, rec.Code)
}

func TestAppsClearInactiveRouteNilManager(t *testing.T) {
	h := appsRouter(newFakeApps(), nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/clear-inactive", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
```

Keep the existing `TestAppsForgetRouteNilManager` but rename it to
`TestAppsDismissRouteNilManager` (its body is unchanged — DELETE `/orders`
with a nil manager still expects 503).

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run 'TestAppsDismissRoute|TestAppsClearInactive'`
Expected: FAIL — compile error (`life.ClearInactive` route not handled / no `/clear-inactive` route returns 404).

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/apps.go`, replace the existing `r.Delete("/{appId}", ...)` block (lines 78-92) with a Dismiss-based handler, and add the clear-inactive route right after it:

```go
	r.Delete("/{appId}", func(w http.ResponseWriter, req *http.Request) {
		if life == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
			return
		}
		if err := life.Dismiss(req.Context(), chi.URLParam(req, "appId")); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})

	r.Post("/clear-inactive", func(w http.ResponseWriter, req *http.Request) {
		if life == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
			return
		}
		n, err := life.ClearInactive(req.Context())
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]int{"cleared": n})
	})
```

(`/clear-inactive` is a single static POST segment; there is no `POST /{appId}` route, so chi routes it without collision.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/server/ ./pkg/lifecycle/`
Expected: PASS (whole server + lifecycle packages green).

- [ ] **Step 5: Verify the binary still builds (interface rename reaches cmd)**

Run: `go build ./...`
Expected: no errors. (`cmd/root.go` uses the `Manager` interface only via `lifecycle.New`; no call sites reference `Forget`. If the compiler flags a stray `Forget` reference anywhere, rename it to `Dismiss`.)

- [ ] **Step 6: Commit**

```bash
git add pkg/server/apps.go pkg/server/apps_test.go
git commit -m "feat(server): DELETE dismisses (incl. compose) + POST /apps/clear-inactive"
```

---

### Task 5: Frontend hook — useClearInactive

**Files:**
- Modify: `web/src/hooks/useAppAction.ts`
- Test: `web/src/hooks/useAppAction.test.tsx`

**Interfaces:**
- Consumes: `apiUrl` (existing), `throwIfNotOK` (existing, module-private).
- Produces: `useClearInactive(): UseMutationResult<ClearInactiveResult, Error, void>` where `ClearInactiveResult = { cleared: number }`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/hooks/useAppAction.test.tsx` (extend the import to include `useClearInactive`):

```tsx
describe('useClearInactive', () => {
  it('POSTs to /apps/clear-inactive and returns the cleared count', async () => {
    let hit = false
    server.use(
      http.post('/api/apps/clear-inactive', () => {
        hit = true
        return HttpResponse.json({ cleared: 2 })
      }),
    )
    const { result } = renderHook(() => useClearInactive(), { wrapper })
    result.current.mutate()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hit).toBe(true)
    expect(result.current.data?.cleared).toBe(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useAppAction.test.tsx`
Expected: FAIL — `useClearInactive` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `web/src/hooks/useAppAction.ts`:

```ts
export interface ClearInactiveResult {
  cleared: number
}

async function sendClearInactive(): Promise<ClearInactiveResult> {
  const res = await fetch(apiUrl('/apps/clear-inactive'), { method: 'POST' })
  await throwIfNotOK(res)
  return (await res.json()) as ClearInactiveResult
}

/**
 * Removes every fully-stopped instance from the dashboard via
 * POST /api/apps/clear-inactive. Invalidates all app queries on success.
 */
export function useClearInactive() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => sendClearInactive(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apps'] }),
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/hooks/useAppAction.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useAppAction.ts web/src/hooks/useAppAction.test.tsx
git commit -m "feat(web): add useClearInactive hook"
```

---

### Task 6: Applications page — global Clear inactive button + per-row remove

**Files:**
- Modify: `web/src/pages/Applications.tsx`
- Test: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `useClearInactive` (Task 5), `useAppForget` (existing), `ConfirmDialog` (existing), `useToast` (existing `../lib/toast`), `getCapabilities` (existing), `trackAction` (existing `../lib/telemetry`), module-level `isStopped` and `appKey` (existing in file).
- Produces: UI only.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Applications.test.tsx`. The file already has `renderAt`, `mockApps`, and `baseApp`. Add a stopped fixture and tests (import `userEvent` and `within` if not already imported — `import userEvent from '@testing-library/user-event'` and add `within` to the `@testing-library/react` import):

```tsx
const stoppedApp = {
  ...baseApp,
  appId: 'orders',
  appStatus: 'stopped',
  daprdStatus: 'stopped',
  daprdPid: 0,
  appPid: 0,
}

it('shows the global Clear inactive button with the stopped count', async () => {
  mockApps([{ ...baseApp }, stoppedApp])
  renderAt()
  expect(await screen.findByRole('button', { name: /clear inactive · 1/i })).toBeInTheDocument()
})

it('hides the Clear inactive button when nothing is stopped', async () => {
  mockApps([{ ...baseApp }])
  renderAt()
  await screen.findByText('order') // list rendered
  expect(screen.queryByRole('button', { name: /clear inactive/i })).not.toBeInTheDocument()
})

it('confirms then POSTs clear-inactive', async () => {
  mockApps([{ ...baseApp }, stoppedApp])
  let hit = false
  server.use(
    http.post('/api/apps/clear-inactive', () => {
      hit = true
      return HttpResponse.json({ cleared: 1 })
    }),
  )
  renderAt()
  await userEvent.click(await screen.findByRole('button', { name: /clear inactive · 1/i }))
  // ConfirmDialog confirm button
  await userEvent.click(await screen.findByRole('button', { name: /^clear inactive$/i }))
  await waitFor(() => expect(hit).toBe(true))
})

it('shows a per-row Remove only for stopped rows and DELETEs it', async () => {
  mockApps([{ ...baseApp }, stoppedApp])
  let deleted = ''
  server.use(
    http.delete('/api/apps/:key', ({ params }) => {
      deleted = String(params.key)
      return new HttpResponse(null, { status: 204 })
    }),
  )
  renderAt()
  const rows = await screen.findAllByRole('row')
  // Exactly one row (the stopped one) exposes a Remove button.
  const removeButtons = screen.getAllByRole('button', { name: /^remove$/i })
  expect(removeButtons).toHaveLength(1)
  await userEvent.click(removeButtons[0])
  await userEvent.click(await screen.findByRole('button', { name: /^remove$/i, hidden: false }))
  await waitFor(() => expect(deleted).toBe('orders'))
  expect(rows.length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: FAIL — no "Clear inactive" button / no per-row Remove button.

- [ ] **Step 3: Write minimal implementation**

Edit `web/src/pages/Applications.tsx`.

3a. Extend the imports at the top of the file:

```tsx
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useApps } from '../hooks/useApps'
import { useClearInactive, useAppForget } from '../hooks/useAppAction'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import { runtimeSwatch } from '../lib/runtimeSwatch'
import { appKey } from '../lib/appKey'
import { appDisplayState } from '../lib/appDisplayState'
import { modeLabel } from '../lib/modeLabel'
import { getCapabilities } from '../lib/capabilities'
import { trackAction } from '../lib/telemetry'
import { useToast } from '../lib/toast'
import { ConfirmDialog } from '../components/ConfirmDialog'
import type { AppSummary } from '../types/api'
```

3b. In `Applications()`, declare the new hooks BEFORE the loading/empty early
returns (hooks must run unconditionally). Replace the top of the function:

```tsx
export function Applications() {
  const navigate = useNavigate()
  const { data: apps, isLoading } = useApps()
  const caps = getCapabilities()
  const { toast, toastNode } = useToast()
  const clearInactive = useClearInactive()
  const [confirmClear, setConfirmClear] = useState(false)

  useDocumentTitle('Applications')
```

(The existing `if (isLoading)` and `if (!apps || apps.length === 0)` early
returns stay unchanged — they render `PAGE_HEADER`, which has no button; the
count is zero there anyway.)

3c. In the main `return`, replace `{PAGE_HEADER}` with a header that includes
the global button, and add the confirm dialog + toast node. Compute the
inactive list just above the `return` (after the existing stats calculations):

```tsx
  const inactive = apps.filter(isStopped)
```

Then the header + dialog:

```tsx
  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Applications</h1>
          <div className="sub">Dapr apps &amp; sidecars discovered on this machine</div>
        </div>
        {caps.lifecycle && inactive.length > 0 && (
          <button
            className="btn ghost"
            disabled={clearInactive.isPending}
            onClick={() => setConfirmClear(true)}
          >
            Clear inactive · {inactive.length}
          </button>
        )}
      </div>
      <ConfirmDialog
        open={confirmClear}
        title={`Remove ${inactive.length} stopped application${inactive.length === 1 ? '' : 's'} from the dashboard?`}
        confirmLabel="Clear inactive"
        onCancel={() => setConfirmClear(false)}
        onConfirm={() => {
          trackAction('clear_inactive', { count: inactive.length })
          clearInactive.mutate(undefined, {
            onError: (e) => toast.show(e instanceof Error ? e.message : 'Clear failed'),
          })
          setConfirmClear(false)
        }}
      >
        <p className="muted">
          They&rsquo;ll reappear if they run again or when the dashboard restarts. Nothing is deleted from Docker.
        </p>
      </ConfirmDialog>
      {/* ...existing <div className="stats"> ... </div> and card/table stay unchanged... */}
      {toastNode}
    </div>
  )
```

Keep everything between the stats block and the closing `</div>` exactly as it
is; only the header, the dialog, and `{toastNode}` are added.

3d. Add the per-row Remove control in `AppRow`. Update `AppRow` to declare its
own hooks and replace the trailing kebab cell:

```tsx
function AppRow({ app, onOpen }: { app: AppSummary; onOpen: () => void }) {
  const caps = getCapabilities()
  const forget = useAppForget(appKey(app))
  const [confirmRemove, setConfirmRemove] = useState(false)
  const removable = caps.lifecycle && isStopped(app)
  const num = (v: number) =>
    v ? <td className="mono tabnum">{v}</td> : <td className="mono tabnum faint">—</td>
  // ...existing state/secondary/etc. unchanged...
```

Replace the final `<td className="kebab">⋯</td>` with:

```tsx
      <td className="kebab" onClick={(e) => e.stopPropagation()}>
        {removable ? (
          <button
            className="tbtn"
            disabled={forget.isPending}
            aria-label={`Remove ${app.appId} from the dashboard`}
            onClick={() => setConfirmRemove(true)}
          >
            Remove
          </button>
        ) : (
          '⋯'
        )}
        <ConfirmDialog
          open={confirmRemove}
          title={`Remove "${app.appId}" from the dashboard?`}
          confirmLabel="Remove"
          onCancel={() => setConfirmRemove(false)}
          onConfirm={() => {
            forget.mutate()
            setConfirmRemove(false)
          }}
        >
          <p className="muted">It&rsquo;ll reappear if it runs again or when the dashboard restarts.</p>
        </ConfirmDialog>
      </td>
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx && npm run build`
Expected: tests PASS and `tsc -b` reports no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): global Clear inactive button + per-row remove on Applications"
```

---

### Task 7: AppDetail — allow removing stopped compose apps

**Files:**
- Modify: `web/src/pages/AppDetail.tsx:84` (and the confirm body copy)
- Test: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: existing `useAppForget`, `removable` gate.
- Produces: UI behavior change only.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/AppDetail.test.tsx` a test that a fully-stopped **compose**
app shows the "Remove from list" button. Mirror the existing render helper in
that file (it already mounts `AppDetail` with a mocked `/api/apps/:appId`). Use
the file's existing fixture shape; the key fields are `source: 'compose'`,
`appStatus: 'stopped'`, `daprdStatus: 'stopped'`:

```tsx
it('offers Remove from list for a fully-stopped compose app', async () => {
  // renderDetail is this file's existing helper; match its fixture shape.
  renderDetail({
    appId: 'checkout',
    instanceKey: 'shop-checkout-app-1',
    source: 'compose',
    appStatus: 'stopped',
    daprdStatus: 'stopped',
    health: 'unknown',
    runtime: 'go',
  })
  expect(await screen.findByRole('button', { name: /remove from list/i })).toBeInTheDocument()
})
```

If `AppDetail.test.tsx` has no reusable `renderDetail` helper, follow the
exact render pattern already used by the other tests in that file (mock
`GET /api/apps/checkout` via `server.use(http.get(...))` and render at
`/apps/checkout`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL — button absent because the current `removable` gate excludes compose (`!isCompose`).

- [ ] **Step 3: Write minimal implementation**

In `web/src/pages/AppDetail.tsx`, change line 84 to drop the `!isCompose` term:

```tsx
  // Fully stopped instances exist only as suppressible dashboard state; offer
  // removing them from the list (compose included — nothing is deleted from Docker).
  const removable = appStopped && daprdStopped
```

And update the confirm body copy in `removeFromList` (the `body` field) to the
non-destructive wording:

```tsx
      body: 'It will be hidden until it runs again or the dashboard restarts. Nothing is deleted from Docker.',
```

- [ ] **Step 4: Run test + typecheck**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx && npm run build`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): allow removing fully-stopped compose apps from AppDetail"
```

---

### Task 8: Full verification gate

**Files:** none (verification only).

- [ ] **Step 1: Go — format, vet, unit tests with race**

Run: `gofmt -l pkg/ cmd/ && go vet -tags unit ./... && go test -tags unit -race ./...`
Expected: `gofmt -l` prints nothing; vet clean; all packages `ok`.

- [ ] **Step 2: Web — lint, tests, typecheck build**

Run: `cd web && npm run lint && npm test && npm run build`
Expected: lint clean; all Vitest files pass; `tsc -b && vite build` succeeds.

- [ ] **Step 3: Full build (embeds web into the binary)**

Run: `make build`
Expected: builds `bin/diagrid-dev-dashboard` with no errors.

- [ ] **Step 4: Manual smoke (documented, run if a live environment is available)**

With compose apps running, stop one container (`docker stop <name>`); confirm
it shows as stopped, click its row Remove → it disappears; restart it
(`docker start <name>`) → it reappears within one refresh (auto-un-hide). Then
with several stopped instances, click "Clear inactive · N" → all clear at once
and the button disappears.

- [ ] **Step 5: Commit any formatting fixups**

```bash
git add -A && git commit -m "chore: verification fixups for clear-inactive" || echo "nothing to commit"
```

---

## Self-Review

**Spec coverage:**
- Core mechanism (unified Dismiss + suppression filter + auto-un-hide): Tasks 1, 2, 3. ✓
- Fully-stopped predicate (`fullyStopped` / `isStopped`): Task 2 (backend), reused frontend Task 6. ✓
- Backend, in-memory, until-restart lifetime: Task 1 (set lives on `Registry`, not persisted). ✓
- Generalized `DELETE /apps/{appId}` + new `POST /apps/clear-inactive`: Task 4. ✓
- Global button in Applications header + per-row remove: Task 6. ✓
- AppDetail `!isCompose` gate removed: Task 7. ✓
- Non-destructive copy: Tasks 6 & 7 (bodies), constraint restated in header. ✓
- Telemetry `clear_inactive`: Task 6 (`trackAction`). ✓
- Tests for overlay filter/auto-un-hide, manager, handlers, hook, pages: Tasks 1-7. ✓
- Edge cases (zero inactive → button hidden + `{cleared:0}`; dismiss unknown key harmless; concurrency via mutex): covered by Task 1 mutex, Task 3 `ClearInactive` count, Task 6 hidden-button test. ✓

**Placeholder scan:** No TBD/TODO; every code step shows real code and exact commands. ✓

**Type consistency:** `Dismiss(ctx, key) error` and `ClearInactive(ctx) (int,error)` are defined identically in the interface (Task 3), the impl (Task 3), and the `fakeLifecycle` double (Task 4). `ClearInactiveResult = { cleared: number }` defined in Task 5, consumed in Task 6. `fullyStopped` defined in Task 2, used in Tasks 2 & 3. `isStopped`/`appKey` are pre-existing module-level exports reused in Task 6. ✓
