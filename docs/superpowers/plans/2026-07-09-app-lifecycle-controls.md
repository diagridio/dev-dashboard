# App Lifecycle Controls & Uptime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Start/Stop/Restart controls for the application and its Dapr sidecar on the AppDetail page (dapr run, Aspire, Docker Compose), plus live-ticking uptime fields that reset on stop.

**Architecture:** A new `pkg/lifecycle` package (mirroring `pkg/controlplane`) owns mutation: compose actions delegate to `containerruntime.Runner` (`docker start|stop|restart <container>`), standalone actions snapshot process command lines then signal PIDs, and an in-memory registry keeps stopped standalone apps visible via a `discovery.Service` decorator (`lifecycle.Overlay`). Discovery gains per-target status/started-at fields; the compose scanner switches to `docker ps -a` so stopped containers stay visible natively. The frontend adds a `useAppAction` mutation hook and per-panel + whole-instance buttons on AppDetail.

**Tech Stack:** Go (chi, gopsutil, testify), React + TypeScript (react-query, vitest, msw, testing-library).

**Spec:** `docs/superpowers/specs/2026-07-09-app-lifecycle-controls-design.md`

## Global Constraints

- Run `make build` (includes `tsc -b`) before claiming any frontend task done — vitest does not typecheck (see memory: PR #42).
- Go tests: `go test ./pkg/...` (unit); golden/integration tests use `-tags integration`.
- Frontend tests: `cd web && npx vitest run <file>`.
- Sentinel errors compared with `errors.Is`, never message text (repo convention).
- JSON field names are camelCase with `omitempty` for optional fields.
- API endpoint shape: `POST /api/apps/{key}/{target}/{action}`, target ∈ `app|daprd|all`, action ∈ `start|stop|restart`.
- Status strings: `"running"` / `"stopped"`; empty string = unknown.
- Aspire instances: `stop` only; `start`/`restart` rejected with 400.
- Commit after every task with a conventional-commits message ending in `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Discovery — per-target status & started-at fields

Add `AppStatus`, `DaprdStatus`, `AppStartedAt`, `DaprdStartedAt` to `ScanResult` and `Instance`, and map them through `enrich`. Compose values flow from the scanner (Task 2 populates them); standalone values are computed in Task 3.

**Files:**
- Modify: `pkg/discovery/types.go`
- Modify: `pkg/discovery/service.go` (ScanResult struct + enrich)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Produces: `Instance.AppStatus, Instance.DaprdStatus string` (json `appStatus`/`daprdStatus`, omitempty), `Instance.AppStartedAt, Instance.DaprdStartedAt string` (RFC3339, json `appStartedAt`/`daprdStartedAt`, omitempty). Constants `discovery.StatusRunning = "running"`, `discovery.StatusStopped = "stopped"`. `ScanResult` gains `AppStatus, DaprdStatus string` and `AppStartedAt, DaprdStartedAt time.Time`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/discovery/service_test.go` (reuse the file's existing helpers for constructing a service with a fake scanner — look at how existing tests build `New(scanner, client)`; the test below shows the required behavior):

```go
func TestEnrichMapsPerTargetStatusAndStartedAt(t *testing.T) {
	started := time.Date(2026, 7, 9, 10, 0, 0, 0, time.UTC)
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID:          "checkout",
			Source:         SourceCompose,
			DaprdStatus:    StatusRunning,
			AppStatus:      StatusStopped,
			DaprdStartedAt: started,
			// AppStartedAt zero: stopped targets expose no start time
		}}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Second})
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	in := items[0]
	require.Equal(t, StatusRunning, in.DaprdStatus)
	require.Equal(t, StatusStopped, in.AppStatus)
	require.Equal(t, "2026-07-09T10:00:00Z", in.DaprdStartedAt)
	require.Equal(t, "", in.AppStartedAt)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestEnrichMapsPerTargetStatusAndStartedAt -v`
Expected: FAIL (compile error: unknown fields `DaprdStatus` etc.)

- [ ] **Step 3: Implement**

In `pkg/discovery/types.go`, add below the `Health` constants:

```go
// Per-target process status. Empty string means unknown.
const (
	StatusRunning = "running"
	StatusStopped = "stopped"
)
```

Add to the `Instance` struct (after `CLIPID`):

```go
	AppStatus      string `json:"appStatus,omitempty"`      // "running" | "stopped"; "" unknown
	DaprdStatus    string `json:"daprdStatus,omitempty"`    // "running" | "stopped"; "" unknown
	AppStartedAt   string `json:"appStartedAt,omitempty"`   // RFC3339 UTC; "" when stopped/unknown
	DaprdStartedAt string `json:"daprdStartedAt,omitempty"` // RFC3339 UTC; "" when stopped/unknown
```

In `pkg/discovery/service.go`, add to `ScanResult` (after `SidecarReachable`):

```go
	// Per-target lifecycle status ("" = unknown; compose scanner sets these).
	AppStatus      string
	DaprdStatus    string
	AppStartedAt   time.Time
	DaprdStartedAt time.Time
```

In `enrich`, extend the initial `Instance{...}` literal with:

```go
		AppStatus: r.AppStatus, DaprdStatus: r.DaprdStatus,
```

and immediately after the literal (before the `if in.Source == ""` block):

```go
	if !r.AppStartedAt.IsZero() && r.AppStatus != StatusStopped {
		in.AppStartedAt = r.AppStartedAt.UTC().Format(time.RFC3339)
	}
	if !r.DaprdStartedAt.IsZero() && r.DaprdStatus != StatusStopped {
		in.DaprdStartedAt = r.DaprdStartedAt.UTC().Format(time.RFC3339)
	}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/discovery/ -v -run TestEnrich`
Expected: PASS (new test and any existing enrich tests)

- [ ] **Step 5: Run the whole package and commit**

Run: `go test ./pkg/discovery/`
Expected: PASS

```bash
git add pkg/discovery/types.go pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): per-target status and started-at fields on Instance"
```

---

### Task 2: Compose scanner — include stopped containers

Switch the compose scan to `ps -aq`, keep non-running containers, and populate per-target status/started-at from container state.

**Files:**
- Modify: `pkg/discovery/scan_compose.go`
- Test: `pkg/discovery/scan_compose_test.go`

**Interfaces:**
- Consumes: `ScanResult.AppStatus/DaprdStatus/AppStartedAt/DaprdStartedAt` from Task 1; `composeContainer.Running/StartedAt` (already exist in `compose_inspect.go`).
- Produces: scan results for stopped compose sidecars/apps with `Status*` set; `SidecarReachable` stays `HTTPPort != 0` (stopped containers publish no ports, so probes are skipped automatically).

- [ ] **Step 1: Write the failing test**

Look at `pkg/discovery/scan_compose_test.go` for the existing fake-runner pattern (a `containerruntime.Runner` fake keyed on args that returns canned `ps`/`inspect` JSON). Add a test with two containers — a running daprd sidecar paired with a **stopped** app container, using inspect JSON where the app container has `"State": {"Status": "exited", "StartedAt": "0001-01-01T00:00:00Z"}`:

```go
func TestComposeScanIncludesStoppedContainers(t *testing.T) {
	// Fake runner must answer:
	//   "ps -aq --filter label=com.docker.compose.project" -> "id1\nid2"
	//   "inspect id1 id2" -> JSON array with:
	//     id1: running daprd container (argv with ./daprd -app-id checkout
	//          -app-channel-address checkout-app), State.Status "running",
	//          StartedAt "2026-07-09T10:00:00Z"
	//     id2: exited app container, compose service "checkout-app",
	//          State.Status "exited"
	// (Build the JSON with the same fixture style the existing tests use.)
	src := NewComposeSource(fakeRunnerWithStoppedApp(t))
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Len(t, results, 1)
	r := results[0]
	require.Equal(t, StatusRunning, r.DaprdStatus)
	require.Equal(t, StatusStopped, r.AppStatus)
	require.False(t, r.DaprdStartedAt.IsZero())
	require.True(t, r.AppStartedAt.IsZero())
	require.Equal(t, "checkout-app", r.ComposeService+"-app") // app container paired
}
```

Also add the inverse case — a **stopped daprd** container still yields a scan result:

```go
func TestComposeScanStoppedSidecarStillDiscovered(t *testing.T) {
	// daprd container State.Status "exited", no published ports.
	src := NewComposeSource(fakeRunnerWithStoppedDaprd(t))
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Len(t, results, 1)
	require.Equal(t, StatusStopped, results[0].DaprdStatus)
	require.False(t, results[0].SidecarReachable)
	require.Equal(t, 0, results[0].HTTPPort)
}
```

Adjust the fixture-builder names/assertions to match the real helpers in the existing test file — the behaviors above are the contract.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/discovery/ -run TestComposeScan -v`
Expected: FAIL (`ps -q` fake mismatch and/or stopped containers filtered out)

- [ ] **Step 3: Implement**

In `pkg/discovery/scan_compose.go` `scanOnce`:

1. Change the ps invocation:

```go
	out, err := s.run.Run(ctx, "ps", "-aq", "--filter", "label="+labelComposeProject)
```

2. Delete the `if !c.Running { continue }` skip in the results loop.

3. In the `ScanResult` construction, set the new fields:

```go
		r := ScanResult{
			AppID:              args.AppID,
			HTTPPort:           c.Ports[args.HTTPPort],
			GRPCPort:           c.Ports[args.GRPCPort],
			AppPort:            args.AppPort,
			Created:            c.StartedAt,
			Command:            strings.Join(c.Argv, " "),
			Source:             SourceCompose,
			ComposeProject:     c.Project,
			ComposeService:     c.Service,
			DaprdContainerID:   c.ID,
			DaprdContainerName: c.Name,
			DaprdStatus:        composeStatus(c.Running),
		}
		if c.Running {
			r.DaprdStartedAt = c.StartedAt
		}
```

4. In the app-container pairing block, add:

```go
		if app, ok := byProjSvc[c.Project+"/"+appSvc]; ok {
			r.AppContainerID = app.ID
			r.AppContainerName = app.Name
			r.AppImage = app.Image
			r.AppRuntime = composeAppRuntime(app)
			r.AppStatus = composeStatus(app.Running)
			if app.Running {
				r.AppStartedAt = app.StartedAt
			}
		}
```

5. Add the helper at the bottom of the file:

```go
func composeStatus(running bool) string {
	if running {
		return StatusRunning
	}
	return StatusStopped
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/discovery/ -v -run TestComposeScan`
Expected: PASS. Also run the full package: `go test ./pkg/discovery/` — existing compose tests must still pass (they now go through `ps -aq`; update their fake runners' expected args from `ps -q` to `ps -aq`).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/scan_compose.go pkg/discovery/scan_compose_test.go
git commit -m "feat(discovery): compose scan includes stopped containers with per-target status"
```

---

### Task 3: Standalone — per-PID start times & statuses

For standalone instances, set `DaprdStatus=running` (the scanner saw the process), derive `DaprdStartedAt`/`AppStartedAt` from per-PID create times via an injectable resolver, and set `AppStatus=running` when metadata reports a live AppPID.

**Files:**
- Modify: `pkg/discovery/service.go` (service struct, enrich)
- Modify: `pkg/discovery/appproc.go` (gopsutil-backed start-time lookup)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Produces: `service.procStart func(pid int) (time.Time, bool)` (injectable, defaults to gopsutil `Process.CreateTime`). Standalone instances always report `DaprdStatus: "running"`; `AppStatus: "running"` only when `AppPID != 0` after metadata.

- [ ] **Step 1: Write the failing test**

The existing `service_test.go` tests construct `New(...)` — the service struct is package-internal, so the test can set fields directly on `&service{...}` or via a small test helper. Follow whichever pattern the existing enrich tests use (they access `s.enrich` or go through `List` with a metadata stub server). Behavior to pin:

```go
func TestEnrichStandaloneStatusesAndStartTimes(t *testing.T) {
	daprdStart := time.Date(2026, 7, 9, 9, 0, 0, 0, time.UTC)
	created := time.Date(2026, 7, 9, 8, 59, 0, 0, time.UTC)
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "orders", Source: SourceStandalone, DaprdPID: 111, Created: created, SidecarReachable: true}}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Second}).(*service)
	svc.procStart = func(pid int) (time.Time, bool) {
		if pid == 111 {
			return daprdStart, true
		}
		return time.Time{}, false
	}
	items, err := svc.List(context.Background())
	require.NoError(t, err)
	in := items[0]
	require.Equal(t, StatusRunning, in.DaprdStatus)
	require.Equal(t, "2026-07-09T09:00:00Z", in.DaprdStartedAt)
	// no metadata -> app pid unknown -> app status unknown
	require.Equal(t, "", in.AppStatus)
}
```

Also pin the fallback: when `procStart` returns false, `DaprdStartedAt` falls back to `r.Created` formatted RFC3339.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestEnrichStandalone -v`
Expected: FAIL (no `procStart` field)

- [ ] **Step 3: Implement**

In `pkg/discovery/service.go`:

```go
type service struct {
	scan       Scanner
	client     *http.Client
	appProc    appProcResolver
	stdoutFile func(pid int) string
	procStart  func(pid int) (time.Time, bool)
}

func New(scan Scanner, client *http.Client) Service {
	return &service{scan: scan, client: client, appProc: gopsutilResolver{}, stdoutFile: lsofStdoutFile, procStart: gopsutilProcStart}
}
```

In `enrich`, after the started-at mapping added in Task 1, add the standalone branch:

```go
	if in.Source == SourceStandalone {
		in.DaprdStatus = StatusRunning // the process scan saw daprd alive
		if in.DaprdStartedAt == "" {
			if t, ok := s.procStartTime(r.DaprdPID); ok {
				in.DaprdStartedAt = t.UTC().Format(time.RFC3339)
			} else if !r.Created.IsZero() {
				in.DaprdStartedAt = r.Created.UTC().Format(time.RFC3339)
			}
		}
	}
```

Add a nil-safe accessor (test fixtures build bare `&service{}`):

```go
func (s *service) procStartTime(pid int) (time.Time, bool) {
	if s.procStart == nil || pid == 0 {
		return time.Time{}, false
	}
	return s.procStart(pid)
}
```

After `in.AppPID = md.AppPID` (the metadata-ok path), add:

```go
	if in.Source == SourceStandalone && in.AppPID != 0 {
		in.AppStatus = StatusRunning
		if t, ok := s.procStartTime(in.AppPID); ok {
			in.AppStartedAt = t.UTC().Format(time.RFC3339)
		}
	}
```

In `pkg/discovery/appproc.go`, add:

```go
// gopsutilProcStart resolves a process's start time from its PID.
func gopsutilProcStart(pid int) (time.Time, bool) {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return time.Time{}, false
	}
	ms, err := p.CreateTime() // milliseconds since epoch
	if err != nil || ms <= 0 {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}
```

- [ ] **Step 4: Run the package tests**

Run: `go test ./pkg/discovery/`
Expected: PASS. If any golden test (`-tags integration`) pins Instance JSON, regenerate with `go test -tags integration ./pkg/discovery -run Golden -update` and inspect the diff — only the new fields should appear.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/appproc.go pkg/discovery/service_test.go
git commit -m "feat(discovery): standalone per-PID start times and statuses"
```

---

### Task 4: `pkg/lifecycle` — types, errors, registry

**Files:**
- Create: `pkg/lifecycle/types.go`
- Create: `pkg/lifecycle/registry.go`
- Test: `pkg/lifecycle/registry_test.go`

**Interfaces:**
- Produces:

```go
type Target string // TargetApp "app" | TargetDaprd "daprd" | TargetAll "all"
type Action string // ActionStart "start" | ActionStop "stop" | ActionRestart "restart"
func ValidTarget(t Target) bool
func ValidAction(a Action) bool
var ErrInvalidTarget, ErrInvalidAction, ErrUnsupported, ErrRuntimeUnavailable error

type ProcSnapshot struct{ PID int; Argv []string; Dir string; LogPath string }
type Entry struct{ Instance discovery.Instance; Procs map[Target]ProcSnapshot }
func NewRegistry() *Registry
func (r *Registry) RecordStop(in discovery.Instance, snaps map[Target]ProcSnapshot)
func (r *Registry) Get(key string) (Entry, bool)   // by InstanceKey, AppID fallback
func (r *Registry) DropTarget(key string, t Target)
func (r *Registry) Drop(key string)
func (r *Registry) List() []Entry                  // sorted by InstanceKey
```

- [ ] **Step 1: Write the failing test**

`pkg/lifecycle/registry_test.go`:

```go
package lifecycle

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func inst(key, appID string) discovery.Instance {
	return discovery.Instance{AppID: appID, InstanceKey: key, Source: discovery.SourceStandalone}
}

func TestRegistryRecordGetDrop(t *testing.T) {
	r := NewRegistry()
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{
		TargetApp: {PID: 42, Argv: []string{"go", "run", "."}, Dir: "/src/orders"},
	})

	e, ok := r.Get("orders")
	require.True(t, ok)
	require.Equal(t, 42, e.Procs[TargetApp].PID)

	// second stop merges targets without losing the first snapshot
	r.RecordStop(inst("orders", "orders"), map[Target]ProcSnapshot{TargetDaprd: {PID: 43}})
	e, _ = r.Get("orders")
	require.Len(t, e.Procs, 2)

	r.DropTarget("orders", TargetApp)
	e, ok = r.Get("orders")
	require.True(t, ok)
	require.Len(t, e.Procs, 1)

	r.DropTarget("orders", TargetDaprd)
	_, ok = r.Get("orders") // dropping the last target removes the entry
	require.False(t, ok)
}

func TestRegistryGetFallsBackToAppID(t *testing.T) {
	r := NewRegistry()
	r.RecordStop(inst("orders-1", "orders"), map[Target]ProcSnapshot{TargetAll: {PID: 7}})
	_, ok := r.Get("orders")
	require.True(t, ok)
}

func TestValidTargetAndAction(t *testing.T) {
	require.True(t, ValidTarget(TargetApp))
	require.True(t, ValidTarget(TargetDaprd))
	require.True(t, ValidTarget(TargetAll))
	require.False(t, ValidTarget("cli"))
	require.True(t, ValidAction(ActionStart))
	require.True(t, ValidAction(ActionStop))
	require.True(t, ValidAction(ActionRestart))
	require.False(t, ValidAction("pause"))
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/lifecycle/ -v`
Expected: FAIL (package doesn't exist)

- [ ] **Step 3: Implement**

`pkg/lifecycle/types.go`:

```go
// Package lifecycle starts, stops and restarts discovered Dapr applications
// and their sidecars. Compose instances act on containers via the container
// runtime; standalone (dapr run) instances signal processes and re-run
// captured commands. An in-memory registry keeps standalone instances the
// dashboard stopped visible until they are started again.
package lifecycle

import "errors"

// Target selects which half of an instance an action applies to.
type Target string

const (
	TargetApp   Target = "app"
	TargetDaprd Target = "daprd"
	TargetAll   Target = "all"
)

// Action is the lifecycle operation.
type Action string

const (
	ActionStart   Action = "start"
	ActionStop    Action = "stop"
	ActionRestart Action = "restart"
)

func ValidTarget(t Target) bool { return t == TargetApp || t == TargetDaprd || t == TargetAll }
func ValidAction(a Action) bool {
	return a == ActionStart || a == ActionStop || a == ActionRestart
}

var (
	ErrInvalidTarget      = errors.New("invalid target")
	ErrInvalidAction      = errors.New("invalid action")
	ErrUnsupported        = errors.New("action not supported for this app")
	ErrRuntimeUnavailable = errors.New("no container runtime available")
)

// ProcSnapshot captures what is needed to re-run a stopped process.
type ProcSnapshot struct {
	PID     int
	Argv    []string
	Dir     string
	LogPath string // stdout/stderr destination for the re-run; "" discards
}
```

`pkg/lifecycle/registry.go`:

```go
package lifecycle

import (
	"sort"
	"sync"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// Entry is one stopped (fully or partially) standalone instance.
type Entry struct {
	Instance discovery.Instance
	Procs    map[Target]ProcSnapshot
}

// Registry is the in-memory record of instances the dashboard stopped. It is
// intentionally not persisted: after a dashboard restart the processes are
// genuinely gone and unknowable.
type Registry struct {
	mu      sync.Mutex
	entries map[string]*Entry // keyed by InstanceKey
}

func NewRegistry() *Registry { return &Registry{entries: map[string]*Entry{}} }

// RecordStop merges snaps into the entry for in's InstanceKey, storing in as
// the display snapshot.
func (r *Registry) RecordStop(in discovery.Instance, snaps map[Target]ProcSnapshot) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[in.InstanceKey]
	if !ok {
		e = &Entry{Procs: map[Target]ProcSnapshot{}}
		r.entries[in.InstanceKey] = e
	}
	e.Instance = in
	for t, s := range snaps {
		e.Procs[t] = s
	}
}

// Get resolves key by InstanceKey first, then by AppID (first match, sorted).
func (r *Registry) Get(key string) (Entry, bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if e, ok := r.entries[key]; ok {
		return e.clone(), true
	}
	for _, k := range r.sortedKeys() {
		if r.entries[k].Instance.AppID == key {
			return r.entries[k].clone(), true
		}
	}
	return Entry{}, false
}

// DropTarget removes one target's snapshot; the entry disappears with its
// last target.
func (r *Registry) DropTarget(key string, t Target) {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.entries[key]
	if !ok {
		return
	}
	delete(e.Procs, t)
	if len(e.Procs) == 0 {
		delete(r.entries, key)
	}
}

// Drop removes the whole entry.
func (r *Registry) Drop(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.entries, key)
}

// List returns all entries sorted by InstanceKey.
func (r *Registry) List() []Entry {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]Entry, 0, len(r.entries))
	for _, k := range r.sortedKeys() {
		out = append(out, r.entries[k].clone())
	}
	return out
}

func (r *Registry) sortedKeys() []string {
	keys := make([]string, 0, len(r.entries))
	for k := range r.entries {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func (e *Entry) clone() Entry {
	procs := make(map[Target]ProcSnapshot, len(e.Procs))
	for t, s := range e.Procs {
		procs[t] = s
	}
	return Entry{Instance: e.Instance, Procs: procs}
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): registry and target/action types"
```

---

### Task 5: `pkg/lifecycle` — process controller & starter

OS-facing seams: snapshot/signal/liveness via gopsutil, and a detached command starter. Both are interfaces so the manager tests use fakes.

**Files:**
- Create: `pkg/lifecycle/proc.go`
- Create: `pkg/lifecycle/start_unix.go`
- Create: `pkg/lifecycle/start_windows.go`
- Test: `pkg/lifecycle/proc_test.go`

**Interfaces:**
- Produces:

```go
type ProcController interface {
	Snapshot(pid int) (ProcSnapshot, error)
	Terminate(pid int) error // graceful (SIGTERM)
	Kill(pid int) error      // forceful
	Alive(pid int) bool
}
type Starter interface {
	Start(argv []string, dir, logPath string) error
}
func NewProcController() ProcController // gopsutil-backed
func NewStarter() Starter               // exec-backed, detached
```

- [ ] **Step 1: Write a smoke test for the real implementations**

`pkg/lifecycle/proc_test.go` — spawn a real `sleep` and control it (unix-only guard):

```go
package lifecycle

import (
	"os/exec"
	"runtime"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestProcControllerLifecycle(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("unix-only smoke test")
	}
	cmd := exec.Command("sleep", "30")
	require.NoError(t, cmd.Start())
	pid := cmd.Process.Pid
	t.Cleanup(func() { _ = cmd.Process.Kill(); _, _ = cmd.Process.Wait() })

	pc := NewProcController()
	require.True(t, pc.Alive(pid))

	snap, err := pc.Snapshot(pid)
	require.NoError(t, err)
	require.Equal(t, pid, snap.PID)
	require.NotEmpty(t, snap.Argv)

	require.NoError(t, pc.Terminate(pid))
	_, _ = cmd.Process.Wait() // reap
	require.Eventually(t, func() bool { return !pc.Alive(pid) }, 3*time.Second, 50*time.Millisecond)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/lifecycle/ -run TestProcController -v`
Expected: FAIL (undefined: NewProcController)

- [ ] **Step 3: Implement**

`pkg/lifecycle/proc.go`:

```go
package lifecycle

import (
	"fmt"
	"os"
	"os/exec"

	gproc "github.com/shirou/gopsutil/process"
)

// ProcController isolates OS process operations so the manager is testable.
type ProcController interface {
	Snapshot(pid int) (ProcSnapshot, error)
	Terminate(pid int) error
	Kill(pid int) error
	Alive(pid int) bool
}

// Starter launches a captured command detached from the dashboard process.
type Starter interface {
	Start(argv []string, dir, logPath string) error
}

type gopsutilProc struct{}

// NewProcController returns the gopsutil-backed ProcController.
func NewProcController() ProcController { return gopsutilProc{} }

func (gopsutilProc) Snapshot(pid int) (ProcSnapshot, error) {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return ProcSnapshot{}, fmt.Errorf("process %d: %w", pid, err)
	}
	argv, err := p.CmdlineSlice()
	if err != nil || len(argv) == 0 {
		return ProcSnapshot{}, fmt.Errorf("command line of %d unavailable: %w", pid, err)
	}
	dir, _ := p.Cwd() // best effort; "" runs the restart from the dashboard's cwd
	return ProcSnapshot{PID: pid, Argv: argv, Dir: dir}, nil
}

func (gopsutilProc) Terminate(pid int) error {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return err
	}
	return p.Terminate()
}

func (gopsutilProc) Kill(pid int) error {
	p, err := gproc.NewProcess(int32(pid))
	if err != nil {
		return err
	}
	return p.Kill()
}

func (gopsutilProc) Alive(pid int) bool {
	ok, err := gproc.PidExists(int32(pid))
	return err == nil && ok
}

type execStarter struct{}

// NewStarter returns the exec-backed Starter.
func NewStarter() Starter { return execStarter{} }

func (execStarter) Start(argv []string, dir, logPath string) error {
	if len(argv) == 0 {
		return fmt.Errorf("empty command")
	}
	cmd := exec.Command(argv[0], argv[1:]...)
	cmd.Dir = dir
	cmd.SysProcAttr = detachedProcAttr()
	if logPath != "" {
		f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			cmd.Stdout, cmd.Stderr = f, f
			defer f.Close() // the child holds its own fd after Start
		}
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }() // reap; the process outlives the request
	return nil
}
```

`pkg/lifecycle/start_unix.go`:

```go
//go:build !windows

package lifecycle

import "syscall"

// detachedProcAttr puts the child in its own process group so it survives the
// dashboard and never receives the dashboard's terminal signals.
func detachedProcAttr() *syscall.SysProcAttr { return &syscall.SysProcAttr{Setpgid: true} }
```

`pkg/lifecycle/start_windows.go`:

```go
//go:build windows

package lifecycle

import "syscall"

const createNewProcessGroup = 0x00000200

func detachedProcAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{CreationFlags: createNewProcessGroup}
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): gopsutil process controller and detached starter"
```

---

### Task 6: `pkg/lifecycle` — manager, compose actions

**Files:**
- Create: `pkg/lifecycle/manager.go`
- Test: `pkg/lifecycle/manager_test.go`

**Interfaces:**
- Consumes: `discovery.Service.Get`, `containerruntime.Runner`, Task 4/5 types.
- Produces:

```go
type Manager interface {
	Do(ctx context.Context, key string, target Target, action Action) error
}
func New(apps discovery.Service, reg *Registry, run containerruntime.Runner,
	proc ProcController, start Starter) Manager
```

Compose semantics: single target → `docker <action> <containerID>`; `all` → stop app→daprd, start daprd→app, restart = stop both then start both. Missing container id for the requested target → `ErrUnsupported`. Nil runner → `ErrRuntimeUnavailable`.

- [ ] **Step 1: Write the failing tests**

`pkg/lifecycle/manager_test.go`:

```go
package lifecycle

import (
	"context"
	"errors"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

// fakeApps serves canned instances by key.
type fakeApps struct{ items map[string]discovery.Instance }

func (f fakeApps) List(ctx context.Context) ([]discovery.Instance, error) {
	out := make([]discovery.Instance, 0, len(f.items))
	for _, in := range f.items {
		out = append(out, in)
	}
	return out, nil
}
func (f fakeApps) Get(ctx context.Context, key string) (discovery.Instance, error) {
	if in, ok := f.items[key]; ok {
		return in, nil
	}
	return discovery.Instance{}, discovery.ErrNotFound
}

// fakeRunner records docker invocations.
type fakeRunner struct{ calls [][]string }

func (f *fakeRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	return nil, nil
}
func (f *fakeRunner) Stream(ctx context.Context, args ...string) (<-chan string, error) {
	return nil, nil
}

func composeInst() discovery.Instance {
	return discovery.Instance{
		AppID: "checkout", InstanceKey: "shop-checkout-app-1",
		Source:           discovery.SourceCompose,
		AppContainerID:   "appC", DaprdContainerID: "daprdC",
	}
}

func TestComposeSingleTargetActions(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"shop-checkout-app-1": composeInst()}},
		NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetApp, ActionStop))
	require.NoError(t, m.Do(context.Background(), "shop-checkout-app-1", TargetDaprd, ActionRestart))
	require.Equal(t, [][]string{{"stop", "appC"}, {"restart", "daprdC"}}, run.calls)
}

func TestComposeAllOrdering(t *testing.T) {
	run := &fakeRunner{}
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), run, nil, nil)

	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStop))
	require.NoError(t, m.Do(context.Background(), "k", TargetAll, ActionStart))
	require.Equal(t, [][]string{
		{"stop", "appC"}, {"stop", "daprdC"}, // stop: app first
		{"start", "daprdC"}, {"start", "appC"}, // start: sidecar first
	}, run.calls)
}

func TestComposeValidation(t *testing.T) {
	m := New(fakeApps{items: map[string]discovery.Instance{"k": composeInst()}}, NewRegistry(), nil, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", "bogus", ActionStop), ErrInvalidTarget)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, "bogus"), ErrInvalidAction)
	require.ErrorIs(t, m.Do(context.Background(), "missing", TargetApp, ActionStop), discovery.ErrNotFound)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrRuntimeUnavailable) // nil runner

	// unpaired app container
	in := composeInst()
	in.AppContainerID = ""
	run := &fakeRunner{}
	m = New(fakeApps{items: map[string]discovery.Instance{"k": in}}, NewRegistry(), run, nil, nil)
	require.ErrorIs(t, m.Do(context.Background(), "k", TargetApp, ActionStop), ErrUnsupported)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/lifecycle/ -run TestCompose -v`
Expected: FAIL (undefined: New / Manager)

- [ ] **Step 3: Implement**

`pkg/lifecycle/manager.go`:

```go
package lifecycle

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

func logger() *slog.Logger { return slog.Default().With("component", "lifecycle") }

// Manager starts, stops and restarts discovered app instances.
type Manager interface {
	Do(ctx context.Context, key string, target Target, action Action) error
}

type manager struct {
	apps  discovery.Service
	reg   *Registry
	run   containerruntime.Runner
	proc  ProcController
	start Starter
	grace time.Duration // SIGTERM -> SIGKILL escalation window
}

// New builds the Manager. run may be nil (no container runtime): compose
// actions then fail with ErrRuntimeUnavailable.
func New(apps discovery.Service, reg *Registry, run containerruntime.Runner, proc ProcController, start Starter) Manager {
	return &manager{apps: apps, reg: reg, run: run, proc: proc, start: start, grace: 5 * time.Second}
}

func (m *manager) Do(ctx context.Context, key string, target Target, action Action) error {
	if !ValidTarget(target) {
		return fmt.Errorf("%w: %s", ErrInvalidTarget, target)
	}
	if !ValidAction(action) {
		return fmt.Errorf("%w: %s", ErrInvalidAction, action)
	}
	in, err := m.apps.Get(ctx, key)
	if err != nil {
		return err
	}
	logger().Info("lifecycle action", "key", in.InstanceKey, "target", target, "action", action, "source", in.Source)
	if in.Source == discovery.SourceCompose {
		return m.doCompose(ctx, in, target, action)
	}
	return m.doStandalone(ctx, in, target, action)
}

// doCompose maps targets to container ids and shells out to the runtime,
// exactly like pkg/controlplane does for placement/scheduler.
func (m *manager) doCompose(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	if m.run == nil {
		return ErrRuntimeUnavailable
	}
	ids, err := composeTargets(in, target, action)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if _, err := m.run.Run(ctx, string(actionForCompose(action)), id); err != nil {
			return err
		}
	}
	return nil
}

// composeTargets returns container ids in execution order. Stop tears the app
// down before its sidecar; start brings the sidecar up first so the app finds
// it on boot.
func composeTargets(in discovery.Instance, target Target, action Action) ([]string, error) {
	app, daprd := in.AppContainerID, in.DaprdContainerID
	switch target {
	case TargetApp:
		if app == "" {
			return nil, fmt.Errorf("%w: no app container", ErrUnsupported)
		}
		return []string{app}, nil
	case TargetDaprd:
		if daprd == "" {
			return nil, fmt.Errorf("%w: no daprd container", ErrUnsupported)
		}
		return []string{daprd}, nil
	}
	// TargetAll: tolerate a missing app container (sidecar-only instances)
	var stopOrder, startOrder []string
	if app != "" {
		stopOrder = append(stopOrder, app)
	}
	if daprd != "" {
		stopOrder = append(stopOrder, daprd)
		startOrder = append(startOrder, daprd)
	}
	if app != "" {
		startOrder = append(startOrder, app)
	}
	if len(stopOrder) == 0 {
		return nil, fmt.Errorf("%w: no containers", ErrUnsupported)
	}
	if action == ActionStart {
		return startOrder, nil
	}
	if action == ActionRestart {
		// docker restart per container, app-last so it reconnects to daprd
		return startOrder, nil
	}
	return stopOrder, nil
}

func actionForCompose(a Action) Action { return a } // start|stop|restart map 1:1 to docker verbs

// doStandalone is implemented in the standalone tasks.
func (m *manager) doStandalone(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	return fmt.Errorf("%w: standalone lifecycle not yet implemented", ErrUnsupported)
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS (TestCompose*, registry, proc tests)

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): manager with compose start/stop/restart"
```

---

### Task 7: `pkg/lifecycle` — standalone stop & Aspire rejection

**Files:**
- Modify: `pkg/lifecycle/manager.go` (replace the `doStandalone` stub)
- Test: `pkg/lifecycle/manager_test.go`

**Interfaces:**
- Consumes: `ProcController`, `Registry.RecordStop`.
- Produces: standalone stop semantics — snapshot argv/dir of app+daprd+CLI *before* signalling; `all` terminates the CLI PID (fallback: app+daprd PIDs); single targets terminate that PID; SIGKILL escalation after `m.grace`; every stop records a registry entry. Aspire: `start`/`restart` → `ErrUnsupported`; `stop` allowed and recorded.

- [ ] **Step 1: Write the failing tests**

Append to `manager_test.go`:

```go
// fakeProc is a scriptable ProcController.
type fakeProc struct {
	snaps      map[int]ProcSnapshot
	terminated []int
	killed     []int
	alive      map[int]bool
}

func newFakeProc() *fakeProc {
	return &fakeProc{snaps: map[int]ProcSnapshot{}, alive: map[int]bool{}}
}
func (f *fakeProc) Snapshot(pid int) (ProcSnapshot, error) {
	if s, ok := f.snaps[pid]; ok {
		return s, nil
	}
	return ProcSnapshot{}, errors.New("no such process")
}
func (f *fakeProc) Terminate(pid int) error {
	f.terminated = append(f.terminated, pid)
	f.alive[pid] = false
	return nil
}
func (f *fakeProc) Kill(pid int) error { f.killed = append(f.killed, pid); f.alive[pid] = false; return nil }
func (f *fakeProc) Alive(pid int) bool { return f.alive[pid] }

func standaloneInst() discovery.Instance {
	return discovery.Instance{
		AppID: "orders", InstanceKey: "orders", Source: discovery.SourceStandalone,
		AppPID: 100, DaprdPID: 200, CLIPID: 300,
		AppLogPath: "/tmp/app.log", DaprdLogPath: "/tmp/daprd.log",
	}
}

func TestStandaloneStopAllSignalsCLIAndSnapshotsEverything(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.snaps[200] = ProcSnapshot{PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"}
	proc.snaps[300] = ProcSnapshot{PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"}
	proc.alive[100], proc.alive[200], proc.alive[300] = true, true, true

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStop))
	require.Equal(t, []int{300}, proc.terminated) // CLI only; it tears down children

	e, ok := reg.Get("orders")
	require.True(t, ok)
	require.Equal(t, []string{"dapr", "run", "--app-id", "orders"}, e.Procs[TargetAll].Argv)
	require.Equal(t, []string{"go", "run", "."}, e.Procs[TargetApp].Argv) // snapshotted before kill
	require.Equal(t, []string{"daprd", "--app-id", "orders"}, e.Procs[TargetDaprd].Argv)
}

func TestStandaloneStopSingleTargetEscalatesToKill(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}}
	proc.alive[100] = true
	stubborn := &stubbornProc{fakeProc: proc} // Terminate does not clear alive

	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, stubborn, nil).(*manager)
	m.grace = 20 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStop))
	require.Equal(t, []int{100}, proc.terminated)
	require.Equal(t, []int{100}, proc.killed) // escalated after grace
}

// stubbornProc ignores Terminate (process stays alive) to exercise escalation.
type stubbornProc struct{ *fakeProc }

func (s *stubbornProc) Terminate(pid int) error {
	s.terminated = append(s.terminated, pid)
	return nil // alive stays true
}
func (s *stubbornProc) Kill(pid int) error { return s.fakeProc.Kill(pid) }

func TestAspireStartRejectedStopAllowed(t *testing.T) {
	in := standaloneInst()
	in.IsAspire = true
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"dotnet", "run"}}
	proc.alive[100] = true
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": in}}, reg, nil, proc, nil).(*manager)
	m.grace = 10 * time.Millisecond

	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetApp, ActionStart), ErrUnsupported)
	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetAll, ActionRestart), ErrUnsupported)
	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStop))
	e, _ := reg.Get("orders")
	require.True(t, e.Instance.IsAspire)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/lifecycle/ -run 'TestStandalone|TestAspire' -v`
Expected: FAIL (`ErrUnsupported: standalone lifecycle not yet implemented`)

- [ ] **Step 3: Implement**

Replace the `doStandalone` stub in `manager.go`:

```go
func (m *manager) doStandalone(ctx context.Context, in discovery.Instance, target Target, action Action) error {
	if in.IsAspire && action != ActionStop {
		return fmt.Errorf("%w: Aspire manages this app's lifecycle — restart it from the Aspire dashboard", ErrUnsupported)
	}
	switch action {
	case ActionStop:
		return m.standaloneStop(ctx, in, target)
	case ActionStart:
		return m.standaloneStart(ctx, in, target)
	default: // restart
		if err := m.standaloneStop(ctx, in, target); err != nil {
			return err
		}
		return m.standaloneStart(ctx, in, target)
	}
}

// standaloneStop snapshots every process it may kill (directly or as a CLI
// child), records them, then signals with SIGTERM -> SIGKILL escalation.
func (m *manager) standaloneStop(ctx context.Context, in discovery.Instance, target Target) error {
	snaps := map[Target]ProcSnapshot{}
	snapshot := func(t Target, pid int, logPath string) {
		if pid == 0 {
			return
		}
		s, err := m.proc.Snapshot(pid)
		if err != nil {
			logger().Warn("process snapshot failed; restart via dashboard won't be possible", "pid", pid, "err", err)
			return
		}
		s.LogPath = logPath
		snaps[t] = s
	}

	var pids []int
	switch target {
	case TargetApp:
		if in.AppPID == 0 {
			return fmt.Errorf("%w: app process unknown", ErrUnsupported)
		}
		snapshot(TargetApp, in.AppPID, in.AppLogPath)
		pids = []int{in.AppPID}
	case TargetDaprd:
		if in.DaprdPID == 0 {
			return fmt.Errorf("%w: daprd process unknown", ErrUnsupported)
		}
		snapshot(TargetDaprd, in.DaprdPID, in.DaprdLogPath)
		pids = []int{in.DaprdPID}
	default: // all: snapshot everything, signal the CLI which reaps children
		snapshot(TargetApp, in.AppPID, in.AppLogPath)
		snapshot(TargetDaprd, in.DaprdPID, in.DaprdLogPath)
		snapshot(TargetAll, in.CLIPID, "")
		if in.CLIPID != 0 {
			pids = []int{in.CLIPID}
		} else {
			for _, p := range []int{in.AppPID, in.DaprdPID} {
				if p != 0 {
					pids = append(pids, p)
				}
			}
		}
		if len(pids) == 0 {
			return fmt.Errorf("%w: no processes to stop", ErrUnsupported)
		}
	}
	m.reg.RecordStop(in, snaps)
	for _, pid := range pids {
		if err := m.terminateWithEscalation(ctx, pid); err != nil {
			return fmt.Errorf("stop pid %d: %w", pid, err)
		}
	}
	return nil
}

// terminateWithEscalation SIGTERMs, waits up to m.grace for exit, then SIGKILLs.
func (m *manager) terminateWithEscalation(ctx context.Context, pid int) error {
	if err := m.proc.Terminate(pid); err != nil {
		return err
	}
	deadline := time.Now().Add(m.grace)
	for time.Now().Before(deadline) {
		if !m.proc.Alive(pid) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(25 * time.Millisecond):
		}
	}
	if m.proc.Alive(pid) {
		logger().Warn("process ignored SIGTERM; killing", "pid", pid)
		return m.proc.Kill(pid)
	}
	return nil
}

// standaloneStart is implemented in the next task.
func (m *manager) standaloneStart(ctx context.Context, in discovery.Instance, target Target) error {
	return fmt.Errorf("%w: standalone start not yet implemented", ErrUnsupported)
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS (all so far)

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): standalone stop with snapshot, escalation and Aspire guard"
```

---

### Task 8: `pkg/lifecycle` — standalone start & restart

**Files:**
- Modify: `pkg/lifecycle/manager.go` (replace `standaloneStart` stub)
- Test: `pkg/lifecycle/manager_test.go`

**Interfaces:**
- Consumes: `Starter.Start(argv, dir, logPath)`, `Registry.Get/DropTarget/Drop`.
- Produces: start semantics — `all` prefers the CLI snapshot (`dapr run …` re-runs both halves) and drops the whole entry; single targets re-run that snapshot and drop that target. No snapshot → `ErrUnsupported` with a "was not stopped by the dashboard" message.

- [ ] **Step 1: Write the failing tests**

Append to `manager_test.go`:

```go
type fakeStarter struct {
	started [][]string
	dirs    []string
	err     error
}

func (f *fakeStarter) Start(argv []string, dir, logPath string) error {
	if f.err != nil {
		return f.err
	}
	f.started = append(f.started, argv)
	f.dirs = append(f.dirs, dir)
	return nil
}

func TestStandaloneStartAllRerunsCLICommand(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetAll:   {PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"},
		TargetApp:   {PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"},
		TargetDaprd: {PID: 200, Argv: []string{"daprd", "--app-id", "orders"}, Dir: "/src"},
	})
	st := &fakeStarter{}
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, newFakeProc(), st)

	require.NoError(t, m.Do(context.Background(), "orders", TargetAll, ActionStart))
	require.Equal(t, [][]string{{"dapr", "run", "--app-id", "orders"}}, st.started)
	require.Equal(t, []string{"/src"}, st.dirs)
	_, ok := reg.Get("orders")
	require.False(t, ok, "whole entry dropped after start")
}

func TestStandaloneStartSingleTarget(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetApp:   {PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src", LogPath: "/tmp/app.log"},
		TargetDaprd: {PID: 200, Argv: []string{"daprd", "--app-id", "orders"}},
	})
	st := &fakeStarter{}
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, newFakeProc(), st)

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionStart))
	require.Equal(t, [][]string{{"go", "run", "."}}, st.started)
	e, ok := reg.Get("orders")
	require.True(t, ok, "daprd snapshot remains")
	require.Len(t, e.Procs, 1)
}

func TestStandaloneStartWithoutSnapshotRejected(t *testing.T) {
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}},
		NewRegistry(), nil, newFakeProc(), &fakeStarter{})
	require.ErrorIs(t, m.Do(context.Background(), "orders", TargetApp, ActionStart), ErrUnsupported)
}

func TestStandaloneRestartStopsThenStarts(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.alive[100] = true
	st := &fakeStarter{}
	reg := NewRegistry()
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, st).(*manager)
	m.grace = 10 * time.Millisecond

	require.NoError(t, m.Do(context.Background(), "orders", TargetApp, ActionRestart))
	require.Equal(t, []int{100}, proc.terminated)
	require.Equal(t, [][]string{{"go", "run", "."}}, st.started)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/lifecycle/ -run TestStandaloneStart -v`
Expected: FAIL (`standalone start not yet implemented`)

- [ ] **Step 3: Implement**

Replace the `standaloneStart` stub:

```go
// standaloneStart re-runs the snapshot captured at stop time. TargetAll
// prefers the dapr CLI command (it starts both halves); the entry is dropped
// so the next scan's live data wins.
func (m *manager) standaloneStart(ctx context.Context, in discovery.Instance, target Target) error {
	entry, ok := m.reg.Get(in.InstanceKey)
	if !ok {
		return fmt.Errorf("%w: this app was not stopped by the dashboard, so there is no command to re-run", ErrUnsupported)
	}
	if target == TargetAll {
		if snap, ok := entry.Procs[TargetAll]; ok {
			if err := m.start.Start(snap.Argv, snap.Dir, snap.LogPath); err != nil {
				return err
			}
			m.reg.Drop(in.InstanceKey)
			return nil
		}
		// No CLI snapshot: bring the halves up individually, sidecar first.
		started := false
		for _, t := range []Target{TargetDaprd, TargetApp} {
			snap, ok := entry.Procs[t]
			if !ok {
				continue
			}
			if err := m.start.Start(snap.Argv, snap.Dir, snap.LogPath); err != nil {
				return err
			}
			m.reg.DropTarget(in.InstanceKey, t)
			started = true
		}
		if !started {
			return fmt.Errorf("%w: no captured command to re-run", ErrUnsupported)
		}
		return nil
	}
	snap, ok := entry.Procs[target]
	if !ok {
		return fmt.Errorf("%w: no captured command for %s", ErrUnsupported, target)
	}
	if err := m.start.Start(snap.Argv, snap.Dir, snap.LogPath); err != nil {
		return err
	}
	m.reg.DropTarget(in.InstanceKey, target)
	return nil
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): standalone start and restart from captured commands"
```

---

### Task 9: `pkg/lifecycle` — Overlay discovery decorator

Keeps stopped standalone instances visible and marks partial stops on live instances.

**Files:**
- Create: `pkg/lifecycle/overlay.go`
- Test: `pkg/lifecycle/overlay_test.go`

**Interfaces:**
- Produces: `func Overlay(inner discovery.Service, reg *Registry, proc ProcController) discovery.Service`.
- Rules:
  - **Live instance with registry entry:** drop `TargetDaprd`/`TargetAll` snapshots (the scanner keys off daprd, so a live key means daprd is back). For a `TargetApp` snapshot: if the live `AppPID` is nonzero and differs from the killed PID, the user restarted it externally → drop the snapshot; otherwise mark `AppStatus=stopped`, `AppPID=0`, `AppStartedAt=""`.
  - **Registry entry with no live instance:** synthesize from the stored snapshot — `Health=unknown`, `DaprdStatus=stopped`, `DaprdPID=0`, `DaprdStartedAt=""`, `Age=""`, `Created=""`, `SidecarReachable=false`; `AppStatus=stopped` (and PID zeroed) unless the app process is still alive (`proc.Alive`), in which case it stays `running`.
  - `Get` falls back to the registry (InstanceKey then AppID) when the inner service returns `discovery.ErrNotFound`.

- [ ] **Step 1: Write the failing tests**

`pkg/lifecycle/overlay_test.go`:

```go
package lifecycle

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestOverlayAppendsFullyStoppedInstances(t *testing.T) {
	reg := NewRegistry()
	stopped := standaloneInst()
	stopped.DaprdStatus, stopped.AppStatus = discovery.StatusRunning, discovery.StatusRunning
	reg.RecordStop(stopped, map[Target]ProcSnapshot{TargetAll: {PID: 300}})

	proc := newFakeProc() // nothing alive
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{}}, reg, proc)

	items, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, items, 1)
	in := items[0]
	require.Equal(t, discovery.StatusStopped, in.DaprdStatus)
	require.Equal(t, discovery.StatusStopped, in.AppStatus)
	require.Equal(t, discovery.HealthUnknown, in.Health)
	require.Zero(t, in.DaprdPID)
	require.Empty(t, in.DaprdStartedAt)

	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusStopped, got.DaprdStatus)
}

func TestOverlayMarksPartialAppStopOnLiveInstance(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetApp: {PID: 100}})

	live := standaloneInst() // scanner still sees daprd; stale metadata may echo AppPID 100
	live.DaprdStatus = discovery.StatusRunning
	live.AppStatus = discovery.StatusRunning

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusStopped, got.AppStatus)
	require.Zero(t, got.AppPID)
	require.Equal(t, discovery.StatusRunning, got.DaprdStatus)
}

func TestOverlayDropsEntryWhenAppExternallyRestarted(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetApp: {PID: 100}})

	live := standaloneInst()
	live.AppPID = 555 // new pid: restarted outside the dashboard
	live.AppStatus = discovery.StatusRunning

	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	got, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, discovery.StatusRunning, got.AppStatus)
	_, ok := reg.Get("orders")
	require.False(t, ok, "stale entry dropped")
}

func TestOverlayDropsDaprdEntryWhenKeyLiveAgain(t *testing.T) {
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{TargetDaprd: {PID: 200}})

	live := standaloneInst()
	live.DaprdStatus = discovery.StatusRunning
	svc := Overlay(fakeApps{items: map[string]discovery.Instance{"orders": live}}, reg, newFakeProc())
	_, err := svc.List(context.Background())
	require.NoError(t, err)
	_, ok := reg.Get("orders")
	require.False(t, ok)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/lifecycle/ -run TestOverlay -v`
Expected: FAIL (undefined: Overlay)

- [ ] **Step 3: Implement**

`pkg/lifecycle/overlay.go`:

```go
package lifecycle

import (
	"context"
	"errors"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// Overlay decorates a discovery.Service with the stopped-app registry:
// partially stopped live instances get their statuses corrected, and fully
// stopped instances (invisible to the process scan) are appended from their
// stop-time snapshots. Compose instances never hit the registry — stopped
// containers are discovered natively.
func Overlay(inner discovery.Service, reg *Registry, proc ProcController) discovery.Service {
	return &overlay{inner: inner, reg: reg, proc: proc}
}

type overlay struct {
	inner discovery.Service
	reg   *Registry
	proc  ProcController
}

func (o *overlay) List(ctx context.Context) ([]discovery.Instance, error) {
	items, err := o.inner.List(ctx)
	if err != nil {
		return nil, err
	}
	liveKeys := make(map[string]bool, len(items))
	for i := range items {
		liveKeys[items[i].InstanceKey] = true
		o.applyEntry(&items[i])
	}
	for _, e := range o.reg.List() {
		if !liveKeys[e.Instance.InstanceKey] {
			items = append(items, o.synthesize(e))
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		if items[a].AppID != items[b].AppID {
			return items[a].AppID < items[b].AppID
		}
		return items[a].InstanceKey < items[b].InstanceKey
	})
	return items, nil
}

func (o *overlay) Get(ctx context.Context, key string) (discovery.Instance, error) {
	in, err := o.inner.Get(ctx, key)
	if err == nil {
		o.applyEntry(&in)
		return in, nil
	}
	if !errors.Is(err, discovery.ErrNotFound) {
		return discovery.Instance{}, err
	}
	if e, ok := o.reg.Get(key); ok {
		return o.synthesize(e), nil
	}
	return discovery.Instance{}, err
}

// applyEntry reconciles a live instance against its registry entry. The
// scanner keys off daprd, so a live key proves daprd is back: daprd/all
// snapshots are stale. An app snapshot survives only while the app process
// has not reappeared under a new PID.
func (o *overlay) applyEntry(in *discovery.Instance) {
	e, ok := o.reg.Get(in.InstanceKey)
	if !ok || in.Source == discovery.SourceCompose {
		return
	}
	o.reg.DropTarget(in.InstanceKey, TargetDaprd)
	o.reg.DropTarget(in.InstanceKey, TargetAll)
	snap, ok := e.Procs[TargetApp]
	if !ok {
		return
	}
	if in.AppPID != 0 && in.AppPID != snap.PID {
		o.reg.DropTarget(in.InstanceKey, TargetApp) // restarted externally
		return
	}
	in.AppStatus = discovery.StatusStopped
	in.AppPID = 0
	in.AppStartedAt = ""
}

// synthesize renders a fully stopped instance from its stop-time snapshot.
func (o *overlay) synthesize(e Entry) discovery.Instance {
	in := e.Instance
	in.Health = discovery.HealthUnknown
	in.SidecarReachable = false
	in.MetadataOK = false
	in.DaprdStatus = discovery.StatusStopped
	in.DaprdPID = 0
	in.DaprdStartedAt = ""
	in.CLIPID = 0
	in.Age = ""
	in.Created = ""
	appAlive := in.AppPID != 0 && o.proc != nil && o.proc.Alive(in.AppPID)
	if _, appStopped := e.Procs[TargetApp]; appStopped || !appAlive {
		in.AppStatus = discovery.StatusStopped
		in.AppPID = 0
		in.AppStartedAt = ""
	}
	return in
}
```

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/lifecycle/ -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/lifecycle/
git commit -m "feat(lifecycle): overlay keeps dashboard-stopped apps visible"
```

---

### Task 10: Server — POST route with error mapping

**Files:**
- Modify: `pkg/server/apps.go`
- Modify: `pkg/server/api.go` (apiRouter signature + mount)
- Modify: `pkg/server/server.go` (Options field + NewRouter call)
- Test: `pkg/server/apps_test.go`

**Interfaces:**
- Consumes: `lifecycle.Manager`, sentinel errors from Tasks 4/6.
- Produces: `POST /api/apps/{appId}/{target}/{action}` → 200 `{"status":"ok"}`; 400 for `ErrInvalidTarget`/`ErrInvalidAction`/`ErrUnsupported`; 404 for `discovery.ErrNotFound`; 503 for `ErrRuntimeUnavailable` or nil manager; 502 otherwise. `server.Options` gains `Lifecycle lifecycle.Manager`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/server/apps_test.go` (mirror the file's existing router-test setup):

```go
type fakeLifecycle struct {
	err    error
	gotKey string
	gotTgt lifecycle.Target
	gotAct lifecycle.Action
}

func (f *fakeLifecycle) Do(ctx context.Context, key string, target lifecycle.Target, action lifecycle.Action) error {
	f.gotKey, f.gotTgt, f.gotAct = key, target, action
	return f.err
}

func TestAppsLifecycleRoute(t *testing.T) {
	cases := []struct {
		name   string
		err    error
		status int
	}{
		{"ok", nil, http.StatusOK},
		{"invalid target", lifecycle.ErrInvalidTarget, http.StatusBadRequest},
		{"invalid action", lifecycle.ErrInvalidAction, http.StatusBadRequest},
		{"unsupported", lifecycle.ErrUnsupported, http.StatusBadRequest},
		{"not found", discovery.ErrNotFound, http.StatusNotFound},
		{"runtime unavailable", lifecycle.ErrRuntimeUnavailable, http.StatusServiceUnavailable},
		{"exec failure", errors.New("boom"), http.StatusBadGateway},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			life := &fakeLifecycle{err: tc.err}
			// build appsRouter with the fake discovery service the existing
			// tests use, plus the fake lifecycle manager
			h := appsRouter(fakeAppsService(), nil, life)
			req := httptest.NewRequest(http.MethodPost, "/orders/app/stop", nil)
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			require.Equal(t, tc.status, rec.Code)
			if tc.err == nil {
				require.Equal(t, "orders", life.gotKey)
				require.Equal(t, lifecycle.TargetApp, life.gotTgt)
				require.Equal(t, lifecycle.ActionStop, life.gotAct)
			}
		})
	}
}

func TestAppsLifecycleRouteNilManager(t *testing.T) {
	h := appsRouter(fakeAppsService(), nil, nil)
	req := httptest.NewRequest(http.MethodPost, "/orders/app/stop", nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	require.Equal(t, http.StatusServiceUnavailable, rec.Code)
}
```

(`fakeAppsService()` stands for whatever fake `discovery.Service` the existing apps tests construct — reuse it.)

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/server/ -run TestAppsLifecycle -v`
Expected: FAIL (appsRouter takes 2 args)

- [ ] **Step 3: Implement**

`pkg/server/apps.go` — new signature and route:

```go
// appsRouter builds the /apps sub-router backed by the given discovery
// service and lifecycle manager (nil disables lifecycle actions).
func appsRouter(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), life lifecycle.Manager) http.Handler {
```

Add after the `GET /{appId}` route:

```go
	r.Post("/{appId}/{target}/{action}", func(w http.ResponseWriter, req *http.Request) {
		if life == nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "lifecycle actions unavailable"})
			return
		}
		err := life.Do(req.Context(),
			chi.URLParam(req, "appId"),
			lifecycle.Target(chi.URLParam(req, "target")),
			lifecycle.Action(chi.URLParam(req, "action")))
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case errors.Is(err, lifecycle.ErrInvalidTarget), errors.Is(err, lifecycle.ErrInvalidAction), errors.Is(err, lifecycle.ErrUnsupported):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, discovery.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
		case errors.Is(err, lifecycle.ErrRuntimeUnavailable):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		}
	})
```

Add the import `"github.com/diagridio/dev-dashboard/pkg/lifecycle"`.

`pkg/server/server.go` — add to `Options`:

```go
	// Lifecycle starts/stops/restarts discovered apps; nil disables the
	// POST /api/apps/{key}/{target}/{action} route.
	Lifecycle lifecycle.Manager
```

`pkg/server/api.go` — thread it through: add `life lifecycle.Manager` parameter to `apiRouter` (after `apps`), pass `opts.Lifecycle` at the call site in `server.go`, and change the mount to `appsRouter(apps, containerLogs, life)`.

- [ ] **Step 4: Run tests**

Run: `go test ./pkg/server/`
Expected: PASS (fix any other `appsRouter`/`apiRouter` call sites in tests by passing `nil`)

- [ ] **Step 5: Commit**

```bash
git add pkg/server/
git commit -m "feat(server): POST /api/apps/{key}/{target}/{action} lifecycle route"
```

---

### Task 11: Wiring in cmd

**Files:**
- Modify: `cmd/root.go` (runServe: build registry, overlay, manager)
- Modify: `cmd/serve.go` (serveDeps + assembleOptions pass-through)
- Test: build + existing test suites

**Interfaces:**
- Consumes: everything above.
- Produces: running server with lifecycle enabled; `deps.Lifecycle lifecycle.Manager` on `serveDeps`.

- [ ] **Step 1: Implement the wiring**

In `cmd/root.go` `runServe`, replace the `Apps:` construction:

```go
	_, crtRunner := containerruntime.Detect()
	composeSrc := discovery.NewComposeSource(crtRunner)
	lifeReg := lifecycle.NewRegistry()
	lifeProc := lifecycle.NewProcController()
	appsSvc := lifecycle.Overlay(
		discovery.New(
			discovery.Merge(discovery.StandaloneScanner(), composeSrc.Scanner()),
			&http.Client{Timeout: 2 * time.Second}),
		lifeReg, lifeProc)
	lifeMgr := lifecycle.New(appsSvc, lifeReg, crtRunner, lifeProc, lifecycle.NewStarter())
```

and pass `Apps: appsSvc, Lifecycle: lifeMgr` in the `serveDeps` literal. Import `"github.com/diagridio/dev-dashboard/pkg/lifecycle"`.

In `cmd/serve.go`, add to `serveDeps`:

```go
	// Lifecycle starts/stops discovered apps; nil disables the actions API.
	Lifecycle lifecycle.Manager
```

and in `assembleOptions`'s returned `server.Options`, add `Lifecycle: deps.Lifecycle,`.

- [ ] **Step 2: Build and run all backend tests**

Run: `go build ./... && go test ./...`
Expected: PASS everywhere (cmd integration tests construct `serveDeps` without Lifecycle — nil is fine).

- [ ] **Step 3: Smoke-test manually (optional but recommended)**

Run: `make run` (or `go run . serve`) with a compose or dapr-run app up; `curl -X POST localhost:<port>/api/apps/<key>/daprd/stop` and confirm the sidecar stops and the app stays listed as stopped.

- [ ] **Step 4: Commit**

```bash
git add cmd/
git commit -m "feat(cmd): wire lifecycle manager and overlay into serve"
```

---

### Task 12: Web — types & useAppAction hook

**Files:**
- Modify: `web/src/types/api.ts`
- Create: `web/src/hooks/useAppAction.ts`
- Test: `web/src/hooks/useAppAction.test.tsx`

**Interfaces:**
- Produces:

```ts
export type ProcStatus = 'running' | 'stopped'
// AppSummary gains: appStatus?, daprdStatus?: ProcStatus; appStartedAt?, daprdStartedAt?: string
export type AppTarget = 'app' | 'daprd' | 'all'
export type AppLifecycleAction = 'start' | 'stop' | 'restart'
export function useAppAction(key: string): UseMutationResult<void, Error, { target: AppTarget; action: AppLifecycleAction }>
```

- [ ] **Step 1: Write the failing test**

`web/src/hooks/useAppAction.test.tsx` (mirror `useControlPlane.test.tsx` / `useStoreMutations.test.tsx` setup — msw `server`, `makeQueryClient`, `QueryProvider`, `renderHook`):

```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { makeQueryClient, QueryProvider } from '../lib/query'
import { useAppAction } from './useAppAction'

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryProvider client={makeQueryClient()}>{children}</QueryProvider>
}

describe('useAppAction', () => {
  it('POSTs to the lifecycle endpoint and resolves', async () => {
    let hit = ''
    server.use(
      http.post('/api/apps/orders/daprd/stop', () => {
        hit = 'orders/daprd/stop'
        return HttpResponse.json({ status: 'ok' })
      }),
    )
    const { result } = renderHook(() => useAppAction('orders'), { wrapper })
    result.current.mutate({ target: 'daprd', action: 'stop' })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(hit).toBe('orders/daprd/stop')
  })

  it('surfaces the API error body as the Error message', async () => {
    server.use(
      http.post('/api/apps/orders/app/start', () =>
        HttpResponse.json({ error: 'no captured command' }, { status: 400 }),
      ),
    )
    const { result } = renderHook(() => useAppAction('orders'), { wrapper })
    result.current.mutate({ target: 'app', action: 'start' })
    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(result.current.error?.message).toBe('no captured command')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useAppAction.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

`web/src/types/api.ts` — add above `AppSummary`:

```ts
/** Per-target process status; absent = unknown */
export type ProcStatus = 'running' | 'stopped'
```

and inside `AppSummary` (after `cliPid`):

```ts
  /** lifecycle status of the app process/container; absent = unknown */
  appStatus?: ProcStatus
  /** lifecycle status of the daprd process/container; absent = unknown */
  daprdStatus?: ProcStatus
  /** RFC3339 start time of the app process/container ("" while stopped) */
  appStartedAt?: string
  /** RFC3339 start time of the daprd process/container ("" while stopped) */
  daprdStartedAt?: string
```

`web/src/hooks/useAppAction.ts`:

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export type AppTarget = 'app' | 'daprd' | 'all'
export type AppLifecycleAction = 'start' | 'stop' | 'restart'

async function sendAppAction(key: string, target: AppTarget, action: AppLifecycleAction): Promise<void> {
  const res = await fetch(
    apiUrl(`/apps/${encodeURIComponent(key)}/${encodeURIComponent(target)}/${encodeURIComponent(action)}`),
    { method: 'POST' },
  )
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // keep status-only message
    }
    throw new Error(msg)
  }
}

/**
 * Start/stop/restart an app instance (or one half of it) via
 * POST /api/apps/:key/:target/:action. Invalidates all app queries on success.
 */
export function useAppAction(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ target, action }: { target: AppTarget; action: AppLifecycleAction }) =>
      sendAppAction(key, target, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['apps'] }),
  })
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/hooks/useAppAction.test.tsx && npx tsc -b`
Expected: PASS, no type errors

- [ ] **Step 5: Commit**

```bash
git add web/src/types/api.ts web/src/hooks/useAppAction.ts web/src/hooks/useAppAction.test.tsx
git commit -m "feat(web): app lifecycle types and useAppAction hook"
```

---

### Task 13: Web — uptime lib (`formatUptime` + `useNow`)

**Files:**
- Create: `web/src/lib/uptime.ts`
- Test: `web/src/lib/uptime.test.tsx`

**Interfaces:**
- Produces: `formatUptime(startedAt: string, nowMs: number): string | null` (null on unparseable input) and `useNow(intervalMs?: number): number` (ticking `Date.now()`).

- [ ] **Step 1: Write the failing test**

`web/src/lib/uptime.test.tsx`:

```tsx
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { formatUptime, useNow } from './uptime'

describe('formatUptime', () => {
  const t0 = Date.parse('2026-07-09T10:00:00Z')
  it('formats seconds, minutes, hours and days', () => {
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 42_000)).toBe('42s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 3 * 60_000 + 7_000)).toBe('3m 07s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 2 * 3_600_000 + 14 * 60_000 + 5_000)).toBe('2h 14m 05s')
    expect(formatUptime('2026-07-09T10:00:00Z', t0 + 26 * 3_600_000)).toBe('1d 2h 0m')
  })
  it('clamps negative durations to 0s and rejects garbage', () => {
    expect(formatUptime('2026-07-09T10:00:00Z', t0 - 5_000)).toBe('0s')
    expect(formatUptime('not-a-date', t0)).toBeNull()
    expect(formatUptime('', t0)).toBeNull()
  })
})

describe('useNow', () => {
  afterEach(() => vi.useRealTimers())
  it('ticks on the interval', () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useNow(1000))
    const first = result.current
    act(() => vi.advanceTimersByTime(3000))
    expect(result.current).toBeGreaterThanOrEqual(first + 3000)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/uptime.test.tsx`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

`web/src/lib/uptime.ts`:

```ts
import { useEffect, useState } from 'react'

/**
 * Formats the elapsed time since an RFC3339 timestamp: "42s", "3m 07s",
 * "2h 14m 05s", "1d 2h 0m". Returns null when startedAt is unparseable.
 */
export function formatUptime(startedAt: string, nowMs: number): string | null {
  const t = Date.parse(startedAt)
  if (Number.isNaN(t)) return null
  let s = Math.max(0, Math.floor((nowMs - t) / 1000))
  const d = Math.floor(s / 86_400)
  s -= d * 86_400
  const h = Math.floor(s / 3_600)
  s -= h * 3_600
  const m = Math.floor(s / 60)
  s -= m * 60
  const ss = String(s).padStart(2, '0')
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m ${ss}s`
  if (m > 0) return `${m}m ${ss}s`
  return `${s}s`
}

/** Current time in ms, re-rendering every intervalMs (default 1s). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/lib/uptime.test.tsx && npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/uptime.ts web/src/lib/uptime.test.tsx
git commit -m "feat(web): uptime formatting and ticking clock hook"
```

---

### Task 14: Web — AppDetail status & uptime rows

**Files:**
- Modify: `web/src/pages/AppDetail.tsx`
- Test: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: `app.appStatus/daprdStatus/appStartedAt/daprdStartedAt`, `formatUptime`, `useNow`, `ledClass`.
- Produces: a Status row and an Uptime row at the top of both panels' `kv` grids; uptime shows `—` when the target is not running.

- [ ] **Step 1: Write the failing test**

Append to `AppDetail.test.tsx`:

```tsx
it('shows per-target status and ticking uptime', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(new Date('2026-07-09T10:05:00Z'))
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({
        appId: 'order',
        health: 'healthy',
        runtime: 'go',
        httpPort: 3500,
        grpcPort: 50001,
        appPort: 8080,
        daprdPid: 48230,
        appPid: 48213,
        cliPid: 48201,
        command: 'go run ./cmd/order',
        runtimeVersion: '1.14.4',
        metadataOk: true,
        appStatus: 'running',
        daprdStatus: 'stopped',
        appStartedAt: '2026-07-09T10:00:00Z',
      }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.getByText('running')).toBeInTheDocument()
  expect(screen.getByText('stopped')).toBeInTheDocument()
  expect(screen.getByText('5m 00s')).toBeInTheDocument() // app uptime ticks from startedAt
  vi.useRealTimers()
})
```

(Import `vi` from vitest at the top if not present.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL (no status/uptime rows)

- [ ] **Step 3: Implement**

In `AppDetail.tsx`:

1. Imports:

```tsx
import { formatUptime, useNow } from '../lib/uptime'
```

2. Inside `AppDetailContent`, after `const unreachable = ...`:

```tsx
  const now = useNow()
  const appRunning = app.appStatus === 'running'
  const daprdRunning = app.daprdStatus === 'running'

  const statusCell = (status?: string) =>
    status ? (
      <span className="health">
        <span className={`led ${ledClass(status === 'running' ? 'healthy' : 'unknown')}`} /> {status}
      </span>
    ) : (
      <span className="faint">—</span>
    )

  const uptimeCell = (running: boolean, startedAt?: string) => {
    const text = running && startedAt ? formatUptime(startedAt, now) : null
    return text ? <span>{text}</span> : <span className="faint">—</span>
  }
```

3. At the top of the Application panel's `kv` grid (before the Runtime row):

```tsx
            <div className="kk">Status</div>
            <div className="vv">{statusCell(app.appStatus)}</div>

            <div className="kk">Uptime</div>
            <div className="vv mono">{uptimeCell(appRunning, app.appStartedAt)}</div>
```

4. At the top of the Dapr sidecar panel's `kv` grid (before the Runtime ver. row):

```tsx
            <div className="kk">Status</div>
            <div className="vv">{statusCell(app.daprdStatus)}</div>

            <div className="kk">Uptime</div>
            <div className="vv mono">{uptimeCell(daprdRunning, app.daprdStartedAt)}</div>
```

5. Suppress the unreachable hint for deliberately stopped sidecars — change the condition:

```tsx
  const unreachable = isCompose && app.sidecarReachable === false && app.daprdStatus !== 'stopped'
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx && npx tsc -b`
Expected: PASS (existing tests included — apps without the new fields render `—`)

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): status and live uptime rows on app detail panels"
```

---

### Task 15: Web — AppDetail lifecycle buttons

**Files:**
- Modify: `web/src/pages/AppDetail.tsx`
- Test: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: `useAppAction`, `useToast` (already imported), statuses from Task 14.
- Produces:
  - Header (whole-instance): when either half is running → `Restart` (`btn ghost`, hidden for Aspire) + `Stop` (`btn danger`); when both halves stopped → `Start` (`btn ghost`, hidden for Aspire).
  - Each panel header: `Start` when that target is `stopped` (hidden for Aspire), `Restart` + `Stop` when `running` (Restart hidden for Aspire). No buttons when status unknown (absent).
  - `window.confirm` before every action; buttons disabled while the mutation is pending; errors toast.
  - Aspire + anything stopped → hint: "Managed by Aspire — restart it from the Aspire dashboard."

- [ ] **Step 1: Write the failing tests**

Append to `AppDetail.test.tsx`:

```tsx
const runningApp = {
  appId: 'order',
  health: 'healthy',
  runtime: 'go',
  httpPort: 3500,
  grpcPort: 50001,
  appPort: 8080,
  daprdPid: 48230,
  appPid: 48213,
  cliPid: 48201,
  command: 'go run ./cmd/order',
  runtimeVersion: '1.14.4',
  metadataOk: true,
  appStatus: 'running',
  daprdStatus: 'running',
}

it('stops the whole instance from the header after confirm', async () => {
  let posted = ''
  server.use(
    http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
    http.post('/api/apps/order/all/stop', () => {
      posted = 'all/stop'
      return HttpResponse.json({ status: 'ok' })
    }),
  )
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  const stopButtons = screen.getAllByRole('button', { name: 'Stop' })
  stopButtons[0].click() // header button renders first
  await waitFor(() => expect(posted).toBe('all/stop'))
  confirmSpy.mockRestore()
})

it('does not act when confirm is declined', async () => {
  let posted = false
  server.use(
    http.get('/api/apps/order', () => HttpResponse.json(runningApp)),
    http.post('/api/apps/order/all/stop', () => {
      posted = true
      return HttpResponse.json({ status: 'ok' })
    }),
  )
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  screen.getAllByRole('button', { name: 'Stop' })[0].click()
  await new Promise((r) => setTimeout(r, 50))
  expect(posted).toBe(false)
  confirmSpy.mockRestore()
})

it('offers Start for a stopped target and hides Start for Aspire', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({ ...runningApp, appStatus: 'stopped', daprdStatus: 'stopped', isAspire: true }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  expect(screen.getByText(/Managed by Aspire/)).toBeInTheDocument()
})

it('offers per-panel Start for a stopped non-Aspire target', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({ ...runningApp, daprdStatus: 'stopped' }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.getAllByRole('button', { name: 'Start' }).length).toBeGreaterThan(0)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL (no Stop/Start buttons)

- [ ] **Step 3: Implement**

In `AppDetailContent`:

1. Imports and setup (top of component, after `useNow`):

```tsx
import { useAppAction, type AppTarget, type AppLifecycleAction } from '../hooks/useAppAction'
```

```tsx
  const action = useAppAction(key)
  const runAction = (target: AppTarget, act: AppLifecycleAction, what: string) => {
    if (!window.confirm(`${act.charAt(0).toUpperCase() + act.slice(1)} ${what}?`)) return
    action.mutate(
      { target, action: act },
      { onError: (e) => toast.show(e instanceof Error ? e.message : 'Action failed') },
    )
  }
  const appStopped = app.appStatus === 'stopped'
  const daprdStopped = app.daprdStatus === 'stopped'
  const anyRunning = appRunning || daprdRunning
  const allStopped = (appStopped || daprdStopped) && !appRunning && !daprdRunning
  const busy = action.isPending
```

2. Header buttons — inside the existing `<div style={{ display: 'flex', gap: 8 }}>` before `← Back`:

```tsx
          {anyRunning && (
            <>
              {!app.isAspire && (
                <button className="btn ghost" disabled={busy} onClick={() => runAction('all', 'restart', `"${app.appId}" (app + sidecar)`)}>
                  Restart
                </button>
              )}
              <button className="btn danger" disabled={busy} onClick={() => runAction('all', 'stop', `"${app.appId}" (app + sidecar)`)}>
                Stop
              </button>
            </>
          )}
          {allStopped && !app.isAspire && (
            <button className="btn ghost" disabled={busy} onClick={() => runAction('all', 'start', `"${app.appId}" (app + sidecar)`)}>
              Start
            </button>
          )}
```

3. Aspire hint — after the unreachable/metadata hint block:

```tsx
      {app.isAspire && (appStopped || daprdStopped) && (
        <div className="hint">Managed by Aspire — restart it from the Aspire dashboard.</div>
      )}
```

4. Panel button group helper (near `statusCell`):

```tsx
  const panelActions = (target: AppTarget, status: string | undefined, what: string) => (
    <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
      {status === 'running' && (
        <>
          {!app.isAspire && (
            <button className="btn ghost" disabled={busy} onClick={() => runAction(target, 'restart', what)}>
              Restart
            </button>
          )}
          <button className="btn danger" disabled={busy} onClick={() => runAction(target, 'stop', what)}>
            Stop
          </button>
        </>
      )}
      {status === 'stopped' && !app.isAspire && (
        <button className="btn ghost" disabled={busy} onClick={() => runAction(target, 'start', what)}>
          Start
        </button>
      )}
    </span>
  )
```

5. Attach to the panel headers (the `.ph` divs — make them flex if the CSS doesn't already):

```tsx
          <div className="ph" style={{ display: 'flex', alignItems: 'center' }}>
            <span className="ic" style={{ background: 'var(--surface-2)', color: 'var(--accent2)' }}>A</span>
            Application
            {panelActions('app', app.appStatus, `application "${app.appId}"`)}
          </div>
```

and

```tsx
          <div className="ph" style={{ display: 'flex', alignItems: 'center' }}>
            <span className="ic" style={{ background: 'var(--dapr)', color: '#fff' }}>d</span>
            Dapr sidecar (daprd)
            {panelActions('daprd', app.daprdStatus, `sidecar of "${app.appId}"`)}
          </div>
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx && npx tsc -b`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx web/src/hooks/useAppAction.ts
git commit -m "feat(web): start/stop/restart buttons on app detail page"
```

---

### Task 16: Web — Applications list stopped-state handling + final verification

**Files:**
- Modify: `web/src/pages/Applications.tsx`
- Test: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `appStatus`/`daprdStatus` on `AppSummary`.
- Produces: fully stopped instances show "stopped" in the Health column (unknown-style LED) and are excluded from the "Apps running" stat; the ⓘ unreachable tooltip is suppressed for stopped sidecars.

- [ ] **Step 1: Write the failing test**

Append to `Applications.test.tsx` (mirror its existing msw + render setup):

```tsx
it('renders stopped instances distinctly and excludes them from the running count', async () => {
  server.use(
    http.get('/api/apps', () =>
      HttpResponse.json([
        { appId: 'live', health: 'healthy', runtime: 'go', httpPort: 3500, grpcPort: 50001, appPort: 8080, daprdPid: 1, appPid: 2, cliPid: 3, age: '5m', created: '10:00:00', runTemplate: '', appStatus: 'running', daprdStatus: 'running' },
        { appId: 'halted', health: 'unknown', runtime: 'go', httpPort: 0, grpcPort: 0, appPort: 0, daprdPid: 0, appPid: 0, cliPid: 0, age: '', created: '', runTemplate: '', appStatus: 'stopped', daprdStatus: 'stopped' },
      ]),
    ),
  )
  renderApplications()
  await waitFor(() => expect(screen.getByText('halted')).toBeInTheDocument())
  expect(screen.getByText('stopped')).toBeInTheDocument()
  const runningStat = screen.getByText('Apps running').previousElementSibling
  expect(runningStat).toHaveTextContent('1')
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement**

In `Applications.tsx`:

1. Running stat excludes fully stopped instances:

```tsx
  const isStopped = (a: AppSummary) => a.appStatus === 'stopped' && a.daprdStatus === 'stopped'
  const running = apps.filter((a) => !isStopped(a)).length
```

(Keep `apps.length` semantics everywhere else.)

2. In `AppRow`, render stopped state in the Health cell and drop the unreachable marker for stopped sidecars:

```tsx
  const stopped = app.appStatus === 'stopped' && app.daprdStatus === 'stopped'
  const unreachable = app.source === 'compose' && app.sidecarReachable === false && app.daprdStatus !== 'stopped'
```

and in the health `<td>`:

```tsx
        <span
          className="health"
          title={unreachable ? 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata' : undefined}
        >
          <span className={`led ${ledClass(stopped ? 'unknown' : app.health)}`} /> {stopped ? 'stopped' : app.health}
          {unreachable && ' ⓘ'}
        </span>
```

- [ ] **Step 4: Run tests**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: PASS

- [ ] **Step 5: Full verification**

```bash
make build          # Go build + tsc -b + web build
go test ./...
cd web && npx vitest run
```
Expected: everything green.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): stopped-instance rendering on the applications list"
```

---

## Self-Review Notes

- **Spec coverage:** compose start/stop/restart (T6), standalone stop/snapshot/escalation (T7), standalone start/restart (T8), Aspire stop-only + hint (T7, T15), registry + overlay visibility (T4, T9), `docker ps -a` (T2), startedAt/status fields (T1–T3), API + error mapping (T10), wiring (T11), hook + types (T12), uptime ticking + reset (T13–T14), per-panel + header buttons + confirm + pending-disable (T15), list rendering + suppressed unreachable hint (T14, T16). Dashboard-restart trade-off needs no code.
- **Sidecar-start-order on compose restart:** `docker restart` per container app-last approximates stop-all/start-all; acceptable per spec ("restart = stop + start in one call").
- **Known simplification:** overlay drops daprd/all snapshots whenever the instance key is live (scanner keys off daprd) — matches the spec's "live data wins."
