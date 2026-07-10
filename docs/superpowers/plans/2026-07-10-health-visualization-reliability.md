# Health Visualization Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make app/sidecar health truthful — verify app-process liveness (PID + port probes), show a combined LED with a reason label, flag orphaned sidecars, and funnel daprd-only actions to whole-instance for `dapr run` apps.

**Architecture:** Liveness probes live inside discovery `enrich` as injectable functions (`pidAlive`, `portOpen`), following the existing `procStart` pattern; a new `SidecarOrphaned` Instance field is computed there too. The lifecycle manager remaps `TargetDaprd → TargetAll` for non-Aspire standalone instances. The frontend derives one display state per instance in a shared `appDisplayState` helper used by both pages.

**Tech Stack:** Go (gopsutil, net, testify, httptest), React + TypeScript (vitest, msw, testing-library).

**Spec:** `docs/superpowers/specs/2026-07-10-health-visualization-reliability-design.md`

## Global Constraints

- Run `make build` (includes `tsc -b`) before claiming any frontend task done — vitest does not typecheck.
- Go tests are build-tagged: `go test -tags unit ./...` (and `-tags integration` where noted); bare `go test` finds nothing. Check the tag line at the top of the test file you edit and keep it.
- Status strings: `"running"` / `"stopped"`; empty = unknown. Health values: `healthy|starting|unhealthy|unknown`.
- Probes: `pidAlive` = gopsutil `PidExists`; `portOpen` = `net.DialTimeout("tcp", "127.0.0.1:<port>", 200ms)`, never called for port 0. Probes run only on the metadata-success path for `SourceStandalone`; metadata-failure and sidecar-unreachable early returns unchanged.
- Orphan rule (all must hold): `Source == SourceStandalone`, `!IsAspire`, `CLIPID == 0`, `AppStatus == StatusStopped`. JSON field `sidecarOrphaned,omitempty`.
- Funnel rule: non-Aspire standalone `TargetDaprd` → `TargetAll` in the manager. Aspire and compose dispatch unchanged.
- Display precedence: stopped (both) → grey `stopped`; `sidecarOrphaned` → amber `orphaned`; healthy sidecar + stopped app → amber `app down`; else existing health.
- Exact copy strings: orphan tooltip "sidecar has no supervising dapr CLI and no app — safe to stop"; app-down tooltip "app process is not running"; orphan banner "Orphaned sidecar — this daprd has no supervising dapr CLI and its app is gone. Stopping it is safe."
- Commit after every task, message ending with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

---

### Task 1: Discovery — app-liveness probes → truthful `appStatus`

**Files:**
- Modify: `pkg/discovery/service.go` (service struct, `New`, enrich lines ~220-225)
- Modify: `pkg/discovery/appproc.go` (probe defaults)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Consumes: existing `service.procStart` pattern; `StatusRunning`/`StatusStopped` constants; metadata `Extended["appPID"]`.
- Produces: `service.pidAlive func(pid int) bool` and `service.portOpen func(port int) bool` (injectable; defaults `gopsutilPidAlive`, `tcpPortOpen`); nil-safe accessors `s.appAlive(pid)` (nil resolver → true, preserving old assume-alive behavior for bare test fixtures) and the port branch guarded by `s.portOpen != nil`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/discovery/service_test.go` (match its build tag and import style). First a local stub sidecar helper (skip if an equivalent metadata+health stub already exists in the file — reuse it instead):

```go
// stubSidecar serves /v1.0/healthz (204) and /v1.0/metadata with the given
// extended appPID ("" omits the field). Returns the listening port.
func stubSidecar(t *testing.T, appPID string) int {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(http.StatusNoContent)
		case "/v1.0/metadata":
			w.Header().Set("Content-Type", "application/json")
			ext := `{}`
			if appPID != "" {
				ext = fmt.Sprintf(`{"appPID":%q,"cliPID":"300"}`, appPID)
			}
			fmt.Fprintf(w, `{"id":"orders","extended":%s}`, ext)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	u, err := url.Parse(srv.URL)
	require.NoError(t, err)
	port, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return port
}

func standaloneScan(httpPort, appPort int) Scanner {
	return func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 200,
			HTTPPort: httpPort, AppPort: appPort, SidecarReachable: true}}, nil
	}
}

func TestEnrichDeadAppPIDMarksAppStopped(t *testing.T) {
	port := stubSidecar(t, "100")
	svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	svc.pidAlive = func(pid int) bool { return false } // 100 is dead
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	in := items[0]
	require.Equal(t, StatusStopped, in.AppStatus)
	require.Zero(t, in.AppPID, "dead PID must not be displayed")
	require.Empty(t, in.AppStartedAt)
}

func TestEnrichLiveAppPIDMarksAppRunning(t *testing.T) {
	port := stubSidecar(t, "100")
	svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	svc.pidAlive = func(pid int) bool { return pid == 100 }
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, StatusRunning, items[0].AppStatus)
	require.Equal(t, 100, items[0].AppPID)
}

func TestEnrichPortDialDecidesWhenPIDUnknown(t *testing.T) {
	for _, tc := range []struct {
		open bool
		want string
	}{{true, StatusRunning}, {false, StatusStopped}} {
		port := stubSidecar(t, "") // metadata without appPID
		svc := New(standaloneScan(port, 8080), &http.Client{Timeout: time.Second}).(*service)
		svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
		svc.portOpen = func(p int) bool { require.Equal(t, 8080, p); return tc.open }
		items, err := svc.List(context.Background())
		require.NoError(t, err)
		require.Equal(t, tc.want, items[0].AppStatus)
	}
}

func TestEnrichNoLivenessSignalStaysUnknown(t *testing.T) {
	port := stubSidecar(t, "") // no appPID
	svc := New(standaloneScan(port, 0), &http.Client{Timeout: time.Second}).(*service) // no app port
	svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, "", items[0].AppStatus)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/ -run 'TestEnrichDead|TestEnrichLive|TestEnrichPort|TestEnrichNoLiveness' -v`
Expected: FAIL (compile error: unknown fields `pidAlive`/`portOpen`)

- [ ] **Step 3: Implement**

`pkg/discovery/service.go` — extend the struct and constructor:

```go
type service struct {
	scan       Scanner
	client     *http.Client
	appProc    appProcResolver
	stdoutFile func(pid int) string
	procStart  func(pid int) (time.Time, bool)
	pidAlive   func(pid int) bool
	portOpen   func(port int) bool
}

func New(scan Scanner, client *http.Client) Service {
	return &service{scan: scan, client: client, appProc: gopsutilResolver{}, stdoutFile: lsofStdoutFile,
		procStart: gopsutilProcStart, pidAlive: gopsutilPidAlive, portOpen: tcpPortOpen}
}

// appAlive reports whether pid is a live process. A nil resolver (bare test
// fixtures) preserves the historical assume-alive behavior.
func (s *service) appAlive(pid int) bool {
	if s.pidAlive == nil {
		return true
	}
	return s.pidAlive(pid)
}
```

Replace the current standalone app-status block in `enrich` (after `in.Placement = md.Placement`):

```go
	if in.Source == SourceStandalone {
		switch {
		case in.AppPID != 0:
			if s.appAlive(in.AppPID) {
				in.AppStatus = StatusRunning
				if t, ok := s.procStartTime(in.AppPID); ok {
					in.AppStartedAt = t.UTC().Format(time.RFC3339)
				}
			} else {
				// Stale metadata: daprd still reports a PID that has exited.
				in.AppStatus = StatusStopped
				in.AppPID = 0
				in.AppStartedAt = ""
			}
		case in.AppPort != 0 && s.portOpen != nil:
			if s.portOpen(in.AppPort) {
				in.AppStatus = StatusRunning
			} else {
				in.AppStatus = StatusStopped
			}
		}
	}
```

`pkg/discovery/appproc.go` — probe defaults (add `fmt`, `net`, `time` imports):

```go
// gopsutilPidAlive reports whether pid exists in the process table.
func gopsutilPidAlive(pid int) bool {
	ok, err := gproc.PidExists(int32(pid))
	return err == nil && ok
}

// tcpPortOpen probes a loopback TCP port; a refused dial fails immediately,
// so the timeout only bites for half-open ports (absent on loopback).
func tcpPortOpen(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 200*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
```

- [ ] **Step 4: Run the whole package**

Run: `go test -tags unit ./pkg/discovery/ -v -run TestEnrich` then `go test -tags unit ./pkg/discovery/`
Expected: PASS. If a pre-existing test constructs the service via `New(...)` with metadata-reported PIDs and now fails (real `PidExists` on a fake PID), inject `svc.pidAlive = func(int) bool { return true }` in that test — behavior-preserving.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/appproc.go pkg/discovery/service_test.go
git commit -m "feat(discovery): verify app liveness with PID and port probes"
```

---

### Task 2: Discovery — `SidecarOrphaned` detection

**Files:**
- Modify: `pkg/discovery/types.go` (Instance field)
- Modify: `pkg/discovery/service.go` (enrich)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Consumes: Task 1's truthful `AppStatus`; `in.IsAspire` (computed by `appRuntime` in enrich), `in.CLIPID` (post-metadata override).
- Produces: `Instance.SidecarOrphaned bool` (json `sidecarOrphaned,omitempty`), true iff standalone && !IsAspire && CLIPID==0 && AppStatus==stopped.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/discovery/service_test.go` (reuses Task 1's `stubSidecar`/`standaloneScan`). Note `stubSidecar` with `appPID=""` also omits `cliPID`, so `CLIPID` stays at the scan value:

```go
// fakeAspireResolver makes appRuntime classify the app-port listener as the
// Aspire DCP proxy.
type fakeAspireResolver struct{}

func (fakeAspireResolver) CommandForPort(port int) (string, bool) {
	return "dotnet Aspire.Hosting.Orchestration.dcp run-controllers", true
}

func TestSidecarOrphanedDetection(t *testing.T) {
	newSvc := func(cliPID int) *service {
		port := stubSidecar(t, "") // no appPID, no cliPID in metadata
		scan := func() ([]ScanResult, error) {
			return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 200,
				CLIPID: cliPID, HTTPPort: port, AppPort: 8080, SidecarReachable: true}}, nil
		}
		svc := New(scan, &http.Client{Timeout: time.Second}).(*service)
		svc.procStart = func(int) (time.Time, bool) { return time.Time{}, false }
		svc.portOpen = func(int) bool { return false } // app is dead
		return svc
	}

	t.Run("no CLI + dead app -> orphaned", func(t *testing.T) {
		items, err := newSvc(0).List(context.Background())
		require.NoError(t, err)
		require.True(t, items[0].SidecarOrphaned)
	})
	t.Run("supervising CLI present -> not orphaned", func(t *testing.T) {
		items, err := newSvc(300).List(context.Background())
		require.NoError(t, err)
		require.False(t, items[0].SidecarOrphaned)
	})
	t.Run("app alive -> not orphaned", func(t *testing.T) {
		svc := newSvc(0)
		svc.portOpen = func(int) bool { return true }
		items, err := svc.List(context.Background())
		require.NoError(t, err)
		require.False(t, items[0].SidecarOrphaned)
	})
	t.Run("aspire excluded", func(t *testing.T) {
		svc := newSvc(0)
		svc.appProc = fakeAspireResolver{}
		items, err := svc.List(context.Background())
		require.NoError(t, err)
		require.True(t, items[0].IsAspire, "fixture must classify as Aspire")
		require.False(t, items[0].SidecarOrphaned)
	})
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestSidecarOrphaned -v`
Expected: FAIL (unknown field `SidecarOrphaned`)

- [ ] **Step 3: Implement**

`pkg/discovery/types.go` — add to `Instance` after `DaprdStartedAt`:

```go
	// SidecarOrphaned marks a standalone daprd with no supervising dapr CLI
	// and no live app (e.g. an external stop missed a detached sidecar).
	SidecarOrphaned bool `json:"sidecarOrphaned,omitempty"`
```

`pkg/discovery/service.go` — in `enrich`, immediately after `in.Runtime, in.IsAspire = appRuntime(in.Command, in.AppPort, s.appProc)`:

```go
	// Orphan: nothing supervises this daprd and its app is gone. Aspire is
	// excluded — its daprd legitimately lacks CLI metadata.
	in.SidecarOrphaned = !in.IsAspire && in.CLIPID == 0 && in.AppStatus == StatusStopped
```

(This line only runs for standalone sources — compose returns earlier — and only on the metadata-success path, per the spec.)

- [ ] **Step 4: Run tests**

Run: `go test -tags unit ./pkg/discovery/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/types.go pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): detect orphaned standalone sidecars"
```

---

### Task 3: Lifecycle — funnel daprd actions to whole-instance for dapr run

**Files:**
- Modify: `pkg/lifecycle/manager.go` (`doStandalone`)
- Test: `pkg/lifecycle/manager_test.go`

**Interfaces:**
- Consumes: existing fakes `fakeApps`, `newFakeProc()`, `standaloneInst()` (AppPID 100, DaprdPID 200, CLIPID 300) in `manager_test.go`; `Registry.Get`.
- Produces: non-Aspire standalone `TargetDaprd` behaves exactly as `TargetAll` for every action. Aspire and compose dispatch unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/lifecycle/manager_test.go`:

```go
func TestStandaloneDaprdTargetFunnelsToAll(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"}
	proc.snaps[300] = ProcSnapshot{PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"}
	proc.alive[100], proc.alive[200], proc.alive[300] = true, true, true

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetDaprd, ActionStop))
	require.Equal(t, []int{300}, proc.terminated, "daprd target must signal the CLI, like TargetAll")
	e, ok := reg.Get("orders")
	require.True(t, ok)
	require.Contains(t, e.Procs, TargetAll, "whole-instance snapshot recorded")
}

func TestAspireDaprdStopNotFunneled(t *testing.T) {
	in := standaloneInst()
	in.IsAspire = true
	proc := newFakeProc()
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}}
	proc.alive[200] = true
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": in}}, NewRegistry(), nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetDaprd, ActionStop))
	require.Equal(t, []int{200}, proc.terminated, "Aspire keeps per-PID daprd stop")
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/lifecycle/ -run 'TestStandaloneDaprdTarget|TestAspireDaprdStop' -v`
Expected: `TestStandaloneDaprdTargetFunnelsToAll` FAILS (terminated is `[200]`, not `[300]`); the Aspire test may already pass.

- [ ] **Step 3: Implement**

`pkg/lifecycle/manager.go` — at the top of `doStandalone`, before the Aspire guard:

```go
	// dapr run supervises app + daprd together: stopping the sidecar alone
	// cascades to the app, and restarting it alone orphans daprd outside the
	// CLI. Funnel sidecar actions to the whole instance instead.
	if !in.IsAspire && target == TargetDaprd {
		target = TargetAll
	}
```

- [ ] **Step 4: Run tests**

Run: `go test -tags unit ./pkg/lifecycle/`
Expected: PASS (no existing test exercises standalone `TargetDaprd`; if one does, its assertion now reflects funneled behavior — update it and note this in the report).

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/manager.go pkg/lifecycle/manager_test.go
git commit -m "feat(lifecycle): funnel daprd actions to whole instance for dapr run apps"
```

---

### Task 4: Web — types, `appDisplayState` helper, grey LED style

**Files:**
- Modify: `web/src/types/api.ts` (AppSummary field)
- Create: `web/src/lib/appDisplayState.ts`
- Modify: `web/src/styles/theme.css` (`.led.off`)
- Test: `web/src/lib/appDisplayState.test.ts`

**Interfaces:**
- Consumes: `ledClass` from `web/src/lib/runtimeSwatch` (`ok|warn|bad`); `AppSummary.health/appStatus/daprdStatus`.
- Produces: `appDisplayState(app): DisplayState` where `DisplayState = { label: string; led: string; hint?: string }` and `AppSummary.sidecarOrphaned?: boolean`. New CSS class `led off` (grey).

- [ ] **Step 1: Write the failing test**

`web/src/lib/appDisplayState.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { appDisplayState } from './appDisplayState'

describe('appDisplayState', () => {
  it('both halves stopped -> grey stopped', () => {
    expect(appDisplayState({ health: 'unknown', appStatus: 'stopped', daprdStatus: 'stopped' }))
      .toEqual({ label: 'stopped', led: 'off' })
  })
  it('orphaned sidecar -> amber orphaned with hint', () => {
    const s = appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true })
    expect(s.label).toBe('orphaned')
    expect(s.led).toBe('warn')
    expect(s.hint).toBe('sidecar has no supervising dapr CLI and no app — safe to stop')
  })
  it('healthy sidecar but app stopped -> amber app down with hint', () => {
    const s = appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running' })
    expect(s.label).toBe('app down')
    expect(s.led).toBe('warn')
    expect(s.hint).toBe('app process is not running')
  })
  it('falls back to plain health', () => {
    expect(appDisplayState({ health: 'healthy', appStatus: 'running', daprdStatus: 'running' }))
      .toEqual({ label: 'healthy', led: 'ok' })
    expect(appDisplayState({ health: 'unhealthy' })).toEqual({ label: 'unhealthy', led: 'bad' })
  })
  it('precedence: stopped beats orphaned beats app down', () => {
    expect(appDisplayState({ health: 'unknown', appStatus: 'stopped', daprdStatus: 'stopped', sidecarOrphaned: true }).label)
      .toBe('stopped')
    expect(appDisplayState({ health: 'healthy', appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true }).label)
      .toBe('orphaned')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/appDisplayState.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

`web/src/types/api.ts` — in `AppSummary`, after `daprdStartedAt`:

```ts
  /** true when a standalone daprd has no supervising dapr CLI and no live app */
  sidecarOrphaned?: boolean
```

`web/src/lib/appDisplayState.ts`:

```ts
import type { AppSummary } from '../types/api'
import { ledClass } from './runtimeSwatch'

export interface DisplayState {
  label: string
  /** LED modifier class: 'ok' | 'warn' | 'bad' | 'off' */
  led: string
  /** tooltip explaining amber states */
  hint?: string
}

type HealthFields = Pick<AppSummary, 'health' | 'appStatus' | 'daprdStatus' | 'sidecarOrphaned'>

/**
 * Derives the single health state shown for an instance from both halves:
 * stopped (both) > orphaned > app down > plain sidecar health.
 */
export function appDisplayState(app: HealthFields): DisplayState {
  if (app.appStatus === 'stopped' && app.daprdStatus === 'stopped') {
    return { label: 'stopped', led: 'off' }
  }
  if (app.sidecarOrphaned) {
    return { label: 'orphaned', led: 'warn', hint: 'sidecar has no supervising dapr CLI and no app — safe to stop' }
  }
  if (app.health === 'healthy' && app.appStatus === 'stopped') {
    return { label: 'app down', led: 'warn', hint: 'app process is not running' }
  }
  return { label: app.health, led: ledClass(app.health) }
}
```

`web/src/styles/theme.css` — next to the other `.led.*` rules (around line 190):

```css
.led.off { background: var(--faint); }
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/lib/appDisplayState.test.ts && npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/types/api.ts web/src/lib/appDisplayState.ts web/src/lib/appDisplayState.test.ts web/src/styles/theme.css
git commit -m "feat(web): shared appDisplayState helper and grey stopped LED"
```

---

### Task 5: Web — Applications overview renders the derived state

**Files:**
- Modify: `web/src/pages/Applications.tsx` (AppRow health cell)
- Test: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `appDisplayState` from Task 4.
- Produces: Health cell shows `state.label` + `state.led`, `title` = `state.hint` (falling back to the compose-unreachable tooltip). `isStopped`/stats logic unchanged.

- [ ] **Step 1: Write the failing test**

Append to `Applications.test.tsx` (reuse its existing render helper and fixture style; base fixtures on the file's existing rows):

```tsx
it('renders app-down and orphaned states with tooltips', async () => {
  server.use(
    http.get('/api/apps', () =>
      HttpResponse.json([
        { appId: 'appdown', health: 'healthy', runtime: 'go', httpPort: 3500, grpcPort: 50001, appPort: 8080, daprdPid: 1, appPid: 0, cliPid: 3, age: '5m', created: '10:00:00', runTemplate: '', appStatus: 'stopped', daprdStatus: 'running' },
        { appId: 'ghost', health: 'healthy', runtime: 'go', httpPort: 3501, grpcPort: 50002, appPort: 8081, daprdPid: 2, appPid: 0, cliPid: 0, age: '5m', created: '10:00:00', runTemplate: '', appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true },
      ]),
    ),
  )
  renderApplications()
  await waitFor(() => expect(screen.getByText('appdown')).toBeInTheDocument())
  expect(screen.getByText('app down')).toBeInTheDocument()
  expect(screen.getByText('orphaned')).toBeInTheDocument()
  expect(screen.getByTitle('app process is not running')).toBeInTheDocument()
  expect(screen.getByTitle('sidecar has no supervising dapr CLI and no app — safe to stop')).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: FAIL (rows render plain 'healthy')

- [ ] **Step 3: Implement**

In `Applications.tsx`, import the helper:

```tsx
import { appDisplayState } from '../lib/appDisplayState'
```

In `AppRow`, replace the `stopped` const and health cell:

```tsx
  const state = appDisplayState(app)
  const unreachable = app.source === 'compose' && app.sidecarReachable === false && app.daprdStatus !== 'stopped'
```

```tsx
      <td>
        <span
          className="health"
          title={state.hint ?? (unreachable ? 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata' : undefined)}
        >
          <span className={`led ${state.led}`} /> {state.label}
          {unreachable && ' ⓘ'}
        </span>
      </td>
```

(`isStopped` and the `running` stat stay as they are; remove the now-unused `const stopped = isStopped(app)` and `ledClass` import from AppRow if nothing else uses them.)

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx && npx tsc -b`
Expected: PASS (the existing stopped-row test still passes — the label is unchanged)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): combined health state with reason on the applications list"
```

---

### Task 6: Web — AppDetail orphan banner, funneled sidecar buttons + final verification

**Files:**
- Modify: `web/src/pages/AppDetail.tsx`
- Test: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: `appDisplayState`; existing `panelActions(target, status, what)` and `runAction`; `useAppAction` posts to `/api/apps/{key}/{target}/{action}`.
- Produces: header health badge driven by `appDisplayState`; orphan banner; sidecar panel for non-Aspire `dapr run` apps sends `target: 'all'` with explanatory confirm copy.

- [ ] **Step 1: Write the failing tests**

Append to `AppDetail.test.tsx` (reuse `renderDetail()` and the `runningApp` fixture):

```tsx
it('shows the orphan banner and orphaned header state', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({ ...runningApp, appStatus: 'stopped', daprdStatus: 'running', sidecarOrphaned: true, cliPid: 0, appPid: 0 }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.getByText(/Orphaned sidecar — this daprd has no supervising dapr CLI/)).toBeInTheDocument()
  expect(screen.getByText('orphaned')).toBeInTheDocument()
})

it('funnels sidecar stop to the whole instance for dapr run apps', async () => {
  let posted = ''
  server.use(
    http.get('/api/apps/order', () => HttpResponse.json(runningApp)), // standalone, not Aspire
    http.post('/api/apps/order/all/stop', () => {
      posted = 'all/stop'
      return HttpResponse.json({ status: 'ok' })
    }),
  )
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  // Buttons render header-first, then app panel, then daprd panel — the
  // last Stop button is the daprd panel's.
  const stops = screen.getAllByRole('button', { name: 'Stop' })
  stops[stops.length - 1].click()
  await waitFor(() => expect(posted).toBe('all/stop'))
  expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('app + sidecar together'))
  confirmSpy.mockRestore()
})

it('keeps per-container sidecar target for compose apps', async () => {
  let posted = ''
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({ ...runningApp, source: 'compose', daprdContainerName: 'proj-daprd-1' }),
    ),
    http.post('/api/apps/order/daprd/stop', () => {
      posted = 'daprd/stop'
      return HttpResponse.json({ status: 'ok' })
    }),
  )
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  const stops = screen.getAllByRole('button', { name: 'Stop' })
  stops[stops.length - 1].click()
  await waitFor(() => expect(posted).toBe('daprd/stop'))
  confirmSpy.mockRestore()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: the orphan and funnel tests FAIL (no banner; POST goes to `/daprd/stop`)

- [ ] **Step 3: Implement**

In `AppDetail.tsx`:

1. Import: `import { appDisplayState } from '../lib/appDisplayState'`.

2. Header badge — replace the `<span className="health"><span className={`led ${ledClass(app.health)}`} /> {app.health}</span>` block:

```tsx
            {(() => {
              const state = appDisplayState(app)
              return (
                <span className="health" title={state.hint}>
                  <span className={`led ${state.led}`} /> {state.label}
                </span>
              )
            })()}
```

3. Orphan banner — after the Aspire hint block:

```tsx
      {app.sidecarOrphaned && (
        <div className="hint">
          Orphaned sidecar — this daprd has no supervising dapr CLI and its app is gone. Stopping it is safe.
        </div>
      )}
```

4. Funneled sidecar target — near the other derived consts:

```tsx
  // dapr run supervises app + daprd together; sidecar actions act on the
  // whole instance (see lifecycle manager funneling). Compose and Aspire
  // keep per-target semantics.
  const daprdTarget: AppTarget = isCompose || app.isAspire ? 'daprd' : 'all'
  const daprdWhat =
    isCompose || app.isAspire
      ? `sidecar of "${app.appId}"`
      : `"${app.appId}" (dapr run manages app + sidecar together)`
```

and change the daprd panel call to:

```tsx
            {panelActions(daprdTarget, app.daprdStatus, daprdWhat)}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx && npx tsc -b`
Expected: PASS (existing tests unaffected: `ledClass` header usage replaced, but labels for plain health values are identical)

- [ ] **Step 5: Full final verification (whole branch)**

```bash
make build
go test -tags unit ./... && go test -tags integration ./...
cd web && npx vitest run
```
Expected: everything green. Paste command tails in the report.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): orphan banner and funneled sidecar actions on app detail"
```

---

## Self-Review Notes

- **Spec coverage:** truthful appStatus (T1), sidecarOrphaned (T2), funneling (T3), combined LED + reason via shared helper on both pages (T4/T5/T6 — header badge included), orphan flag + Stop (T2/T6; cleanup uses the existing whole-instance Stop, no new plumbing), exact copy strings carried into Global Constraints. Backfill intentionally absent (spec decision 5).
- **Type consistency:** `DisplayState { label, led, hint? }` used identically in T4-T6; probe fields `pidAlive`/`portOpen` named consistently; funnel uses existing `TargetDaprd`/`TargetAll`.
- **Known simplification:** AppDetail's per-panel `statusCell` LEDs keep their existing running/stopped styling (per-target, not instance-level) — the instance-level derivation applies to the header badge and list rows, per the spec's "used by both pages so the rule lives once".
