# Control Plane Page Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Control Plane page that lists the local Dapr control-plane services (scheduler, placement) with health/status/ports/memory/log-path, lets the user start/restart/stop them, and streams their logs through the existing Logs page — working with both Docker and Podman.

**Architecture:** A new isolated `pkg/controlplane` domain package shells out to the resolved container runtime CLI (`docker` or `podman`) to list, inspect, and control the known `dapr_*` containers. HTTP wiring lives in `pkg/server/controlplane.go` and is threaded through `server.Options`. The React SPA gets a new polling page composed from the existing class vocabulary, a mutation hook for lifecycle actions, and a Logs-page source for control-plane containers. Lifecycle actions are the first sanctioned mutation beyond workflow terminate/purge and the connection registry, and are strictly allowlisted.

**Tech Stack:** Go 1.26 (chi router, `os/exec`), React 18 + TypeScript + Vite, TanStack Query, Vitest.

## Global Constraints

- **`pkg/*` must not import `cmd/`.** New domain logic goes in `pkg/controlplane`; HTTP wiring in `pkg/server` (one file per domain).
- **Go tests are build-tag-gated.** Unit tests need `//go:build unit`; run with `go test -tags unit -race ./...`. A bare `go test ./...` runs nothing.
- **Frontend must compose existing classes/tokens** from `web/src/styles/theme.css` (see `web/STYLEGUIDE.md`) — no hardcoded colors, reuse the `health`/`led ok`/`card`/`chip` primitives.
- **Lifecycle actions are allowlisted** to the four known control-plane container names only — never arbitrary containers.
- **Container runtime is resolved once**: honor `DASH_CONTAINER_RUNTIME` (`docker`|`podman`), else prefer `docker` on PATH, else `podman`, else "unavailable".
- **Known control-plane container names:** `dapr_scheduler`, `dapr_placement` (live self-hosted); `dapr_sentry`, `dapr_injector` (Kubernetes-only placeholders — no live data, no actions).
- **Commit style:** Conventional Commits (`feat:`, `test:`, `docs:`, `refactor:`). Do NOT commit `web/dist`.
- **Verification gate:** `make test` (Go-unit + web) before claiming done; `make test-integration` if server wiring changed.

---

## File Structure

**Created:**
- `pkg/controlplane/types.go` — `Service`, `ServiceStatus`, `RuntimeKind`, allowlist, name/action validation.
- `pkg/controlplane/runtime.go` — runtime resolution + subprocess wrappers (`runner` seam).
- `pkg/controlplane/parse.go` — pure parsers for `inspect` / `stats` output.
- `pkg/controlplane/service.go` — `Service`-layer `List()` and `Do(action, name)`.
- `pkg/controlplane/*_test.go` — unit tests per file above.
- `pkg/controlplane/testdata/` — captured runtime output fixtures.
- `pkg/server/controlplane.go` — chi sub-router: list, action, logs stream.
- `pkg/server/controlplane_test.go` — route tests with a fake service.
- `web/src/types/controlplane.ts` — `ControlPlaneService` + `RuntimeStatus` types.
- `web/src/hooks/useControlPlane.ts` — list-poll query + action mutation.
- `web/src/hooks/useControlPlane.test.tsx` — hook tests.
- `web/src/pages/ControlPlane.tsx` — the page.
- `web/src/pages/ControlPlane.test.tsx` — page tests.

**Modified:**
- `pkg/server/api.go` — mount `/controlplane`.
- `pkg/server/server.go` — add `ControlPlane` to `Options`, thread into `apiRouter`.
- `cmd/serve.go` — construct `controlplane.New(...)` and set `Options.ControlPlane`.
- `web/src/router.tsx` — add `control-plane` route.
- `web/src/components/TopNav.tsx` — add nav item.
- `web/src/hooks/useLogStream.ts` — accept an explicit stream path (generalize).
- `web/src/pages/Logs.tsx` — control-plane source option + `?cp=` deep-link.
- `AGENTS.md` — carve out the control-plane lifecycle exception.

---

## Task 1: Control-plane types, allowlist, and validation

**Files:**
- Create: `pkg/controlplane/types.go`
- Test: `pkg/controlplane/types_test.go`

**Interfaces:**
- Produces:
  - `type RuntimeKind string` with consts `RuntimeDocker = "docker"`, `RuntimePodman = "podman"`, `RuntimeNone = ""`.
  - `type ServiceStatus string` with consts `StatusRunning = "running"`, `StatusStopped = "stopped"`, `StatusK8sOnly = "kubernetes-only"`, `StatusUnknown = "unknown"`.
  - `type Service struct` with JSON tags: `Name string`, `Status ServiceStatus`, `Healthy bool`, `Ports []string`, `MemoryBytes uint64`, `MemoryHuman string`, `LogPath string`, `Actionable bool`.
  - `var LiveServiceNames = []string{"dapr_scheduler", "dapr_placement"}`
  - `var K8sOnlyServiceNames = []string{"dapr_sentry", "dapr_injector"}`
  - `func IsControlPlaneName(name string) bool` — true only for the four known names.
  - `func IsLiveName(name string) bool` — true only for `LiveServiceNames`.
  - `func ValidAction(action string) bool` — true for `start`, `stop`, `restart`.

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package controlplane

import "testing"

func TestIsControlPlaneName(t *testing.T) {
	cases := map[string]bool{
		"dapr_scheduler": true,
		"dapr_placement": true,
		"dapr_sentry":    true,
		"dapr_injector":  true,
		"dapr_redis":     false,
		"":               false,
		"scheduler":      false,
	}
	for name, want := range cases {
		if got := IsControlPlaneName(name); got != want {
			t.Errorf("IsControlPlaneName(%q) = %v, want %v", name, got, want)
		}
	}
}

func TestIsLiveName(t *testing.T) {
	if !IsLiveName("dapr_scheduler") {
		t.Error("scheduler should be live")
	}
	if IsLiveName("dapr_sentry") {
		t.Error("sentry is k8s-only, not live")
	}
}

func TestValidAction(t *testing.T) {
	for _, a := range []string{"start", "stop", "restart"} {
		if !ValidAction(a) {
			t.Errorf("ValidAction(%q) should be true", a)
		}
	}
	for _, a := range []string{"", "kill", "rm", "pause"} {
		if ValidAction(a) {
			t.Errorf("ValidAction(%q) should be false", a)
		}
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/controlplane/ -run 'TestIsControlPlaneName|TestIsLiveName|TestValidAction' -v`
Expected: FAIL — `undefined: IsControlPlaneName` (package/functions don't exist).

- [ ] **Step 3: Write minimal implementation**

```go
package controlplane

// RuntimeKind identifies the resolved container runtime.
type RuntimeKind string

const (
	RuntimeDocker RuntimeKind = "docker"
	RuntimePodman RuntimeKind = "podman"
	RuntimeNone   RuntimeKind = ""
)

// ServiceStatus is the coarse lifecycle state shown in the UI.
type ServiceStatus string

const (
	StatusRunning ServiceStatus = "running"
	StatusStopped ServiceStatus = "stopped"
	StatusK8sOnly ServiceStatus = "kubernetes-only"
	StatusUnknown ServiceStatus = "unknown"
)

// Service is one control-plane service row returned by GET /api/controlplane.
type Service struct {
	Name        string        `json:"name"`
	Status      ServiceStatus `json:"status"`
	Healthy     bool          `json:"healthy"`
	Ports       []string      `json:"ports"`
	MemoryBytes uint64        `json:"memoryBytes"`
	MemoryHuman string        `json:"memoryHuman"`
	LogPath     string        `json:"logPath"`
	Actionable  bool          `json:"actionable"`
}

// LiveServiceNames are the self-hosted control-plane containers this dashboard manages.
var LiveServiceNames = []string{"dapr_scheduler", "dapr_placement"}

// K8sOnlyServiceNames exist only on Kubernetes; shown as disabled placeholders.
var K8sOnlyServiceNames = []string{"dapr_sentry", "dapr_injector"}

func IsControlPlaneName(name string) bool {
	return IsLiveName(name) || contains(K8sOnlyServiceNames, name)
}

func IsLiveName(name string) bool {
	return contains(LiveServiceNames, name)
}

// ValidAction reports whether action is one of the allowed lifecycle verbs.
func ValidAction(action string) bool {
	switch action {
	case "start", "stop", "restart":
		return true
	default:
		return false
	}
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/controlplane/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/controlplane/types.go pkg/controlplane/types_test.go
git commit -m "feat(controlplane): service types, name allowlist, action validation"
```

---

## Task 2: Runtime resolution (Docker/Podman detection)

**Files:**
- Create: `pkg/controlplane/runtime.go`
- Test: `pkg/controlplane/runtime_test.go`

**Interfaces:**
- Consumes: `RuntimeKind` from Task 1.
- Produces:
  - `type runner interface { run(ctx context.Context, args ...string) ([]byte, error) }`
  - `type lookPathFunc func(string) (string, error)`
  - `func resolveRuntime(env string, look lookPathFunc) RuntimeKind` — pure resolver: env override (validated against docker/podman), else docker-before-podman via `look`, else `RuntimeNone`.
  - `type execRunner struct { bin string }` implementing `runner` via `os/exec` (`exec.CommandContext(ctx, r.bin, args...).Output()`).
  - `func newExecRunner(kind RuntimeKind) *execRunner`

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package controlplane

import (
	"errors"
	"testing"
)

func fakeLook(present map[string]bool) lookPathFunc {
	return func(bin string) (string, error) {
		if present[bin] {
			return "/usr/bin/" + bin, nil
		}
		return "", errors.New("not found")
	}
}

func TestResolveRuntime(t *testing.T) {
	both := fakeLook(map[string]bool{"docker": true, "podman": true})
	onlyPodman := fakeLook(map[string]bool{"podman": true})
	none := fakeLook(map[string]bool{})

	if got := resolveRuntime("", both); got != RuntimeDocker {
		t.Errorf("both present: got %q, want docker", got)
	}
	if got := resolveRuntime("", onlyPodman); got != RuntimePodman {
		t.Errorf("only podman: got %q, want podman", got)
	}
	if got := resolveRuntime("", none); got != RuntimeNone {
		t.Errorf("none present: got %q, want empty", got)
	}
	// Env override wins, even when the other runtime is on PATH.
	if got := resolveRuntime("podman", both); got != RuntimePodman {
		t.Errorf("env override: got %q, want podman", got)
	}
	// Invalid env override is ignored and falls back to PATH probing.
	if got := resolveRuntime("nerdctl", both); got != RuntimeDocker {
		t.Errorf("invalid env override: got %q, want docker", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/controlplane/ -run TestResolveRuntime -v`
Expected: FAIL — `undefined: resolveRuntime`.

- [ ] **Step 3: Write minimal implementation**

```go
package controlplane

import (
	"context"
	"os/exec"
)

// runner executes a single runtime subcommand and returns its stdout.
type runner interface {
	run(ctx context.Context, args ...string) ([]byte, error)
}

// lookPathFunc mirrors exec.LookPath; injectable for tests.
type lookPathFunc func(string) (string, error)

// resolveRuntime picks the container runtime: an explicit valid env override,
// else docker (preferred) then podman via look, else RuntimeNone.
func resolveRuntime(env string, look lookPathFunc) RuntimeKind {
	switch RuntimeKind(env) {
	case RuntimeDocker, RuntimePodman:
		return RuntimeKind(env)
	}
	if _, err := look(string(RuntimeDocker)); err == nil {
		return RuntimeDocker
	}
	if _, err := look(string(RuntimePodman)); err == nil {
		return RuntimePodman
	}
	return RuntimeNone
}

// execRunner runs the resolved runtime binary via os/exec.
type execRunner struct{ bin string }

func newExecRunner(kind RuntimeKind) *execRunner { return &execRunner{bin: string(kind)} }

func (r *execRunner) run(ctx context.Context, args ...string) ([]byte, error) {
	return exec.CommandContext(ctx, r.bin, args...).Output()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/controlplane/ -run TestResolveRuntime -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/controlplane/runtime.go pkg/controlplane/runtime_test.go
git commit -m "feat(controlplane): resolve docker/podman runtime with env override"
```

---

## Task 3: Parsers for inspect + stats output

**Files:**
- Create: `pkg/controlplane/parse.go`
- Create: `pkg/controlplane/testdata/inspect_running.json`
- Create: `pkg/controlplane/testdata/stats.json`
- Test: `pkg/controlplane/parse_test.go`

**Interfaces:**
- Consumes: `ServiceStatus`, `Service` from Task 1.
- Produces:
  - `type inspectData struct { State ServiceStatus; Healthy bool; Ports []string; LogPath string }`
  - `func parseInspect(data []byte) (inspectData, error)` — parses the JSON array emitted by `<runtime> inspect <name>` (a one-element array of container objects). Maps `.State.Status == "running"` → `StatusRunning` (else `StatusStopped`); `Healthy` = running AND (`.State.Health.Status` is empty OR `"healthy"`); `Ports` from `.NetworkSettings.Ports` keys (e.g. `"50006/tcp"`); `LogPath` from `.LogPath`.
  - `func parseMemUsage(s string) uint64` — parses the used side of a `docker stats` MemUsage string like `"12.34MiB / 7.667GiB"` into bytes.
  - `func parseStats(data []byte) map[string]memStat` where `type memStat struct { Bytes uint64; Human string }`, keyed by container name — parses newline-delimited `{{json .}}` objects from `<runtime> stats --no-stream`.

**Fixtures:**

`pkg/controlplane/testdata/inspect_running.json`:
```json
[
  {
    "State": { "Status": "running", "Health": { "Status": "healthy" } },
    "NetworkSettings": { "Ports": { "50006/tcp": [{ "HostPort": "50006" }] } },
    "LogPath": "/var/lib/docker/containers/abc/abc-json.log"
  }
]
```

`pkg/controlplane/testdata/stats.json` (two newline-delimited objects, as `stats --format '{{json .}}'` emits):
```json
{"Name":"dapr_scheduler","MemUsage":"12.34MiB / 7.667GiB"}
{"Name":"dapr_placement","MemUsage":"8.5MiB / 7.667GiB"}
```

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package controlplane

import (
	"os"
	"testing"
)

func TestParseInspectRunning(t *testing.T) {
	data, err := os.ReadFile("testdata/inspect_running.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseInspect(data)
	if err != nil {
		t.Fatalf("parseInspect: %v", err)
	}
	if got.State != StatusRunning {
		t.Errorf("State = %q, want running", got.State)
	}
	if !got.Healthy {
		t.Error("Healthy = false, want true")
	}
	if len(got.Ports) != 1 || got.Ports[0] != "50006/tcp" {
		t.Errorf("Ports = %v, want [50006/tcp]", got.Ports)
	}
	if got.LogPath == "" {
		t.Error("LogPath empty, want a path")
	}
}

func TestParseMemUsage(t *testing.T) {
	cases := map[string]uint64{
		"12.34MiB / 7.667GiB": 12939428, // 12.34 * 1024 * 1024
		"8.5MiB / 7.667GiB":   8912896,  // 8.5 * 1024 * 1024
		"1.5GiB / 7.667GiB":   1610612736,
		"512KiB / 7.667GiB":   524288,
		"0B / 7.667GiB":       0,
		"garbage":             0,
	}
	for in, want := range cases {
		if got := parseMemUsage(in); got != want {
			t.Errorf("parseMemUsage(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestParseStats(t *testing.T) {
	data, err := os.ReadFile("testdata/stats.json")
	if err != nil {
		t.Fatal(err)
	}
	got := parseStats(data)
	s, ok := got["dapr_scheduler"]
	if !ok {
		t.Fatal("dapr_scheduler missing from stats")
	}
	if s.Human != "12.34MiB" {
		t.Errorf("Human = %q, want 12.34MiB", s.Human)
	}
	if s.Bytes == 0 {
		t.Error("Bytes = 0, want > 0")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/controlplane/ -run 'TestParseInspect|TestParseMemUsage|TestParseStats' -v`
Expected: FAIL — `undefined: parseInspect`.

- [ ] **Step 3: Write minimal implementation**

```go
package controlplane

import (
	"bytes"
	"encoding/json"
	"sort"
	"strconv"
	"strings"
)

type inspectData struct {
	State   ServiceStatus
	Healthy bool
	Ports   []string
	LogPath string
}

// rawInspect mirrors the subset of `<runtime> inspect` we consume.
type rawInspect struct {
	State struct {
		Status string `json:"Status"`
		Health struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	NetworkSettings struct {
		Ports map[string]any `json:"Ports"`
	} `json:"NetworkSettings"`
	LogPath string `json:"LogPath"`
}

func parseInspect(data []byte) (inspectData, error) {
	var arr []rawInspect
	if err := json.Unmarshal(data, &arr); err != nil {
		return inspectData{}, err
	}
	if len(arr) == 0 {
		return inspectData{State: StatusUnknown}, nil
	}
	c := arr[0]
	out := inspectData{LogPath: c.LogPath}
	running := c.State.Status == "running"
	if running {
		out.State = StatusRunning
	} else {
		out.State = StatusStopped
	}
	h := c.State.Health.Status
	out.Healthy = running && (h == "" || h == "healthy")
	for p := range c.NetworkSettings.Ports {
		out.Ports = append(out.Ports, p)
	}
	sort.Strings(out.Ports)
	return out, nil
}

type memStat struct {
	Bytes uint64
	Human string
}

// parseMemUsage converts the used side of a docker/podman MemUsage string
// (e.g. "12.34MiB / 7.667GiB") into bytes. Returns 0 on any parse failure.
func parseMemUsage(s string) uint64 {
	used := strings.TrimSpace(strings.SplitN(s, "/", 2)[0])
	units := []struct {
		suffix string
		mult   float64
	}{
		{"GiB", 1 << 30}, {"MiB", 1 << 20}, {"KiB", 1 << 10},
		{"GB", 1e9}, {"MB", 1e6}, {"kB", 1e3}, {"B", 1},
	}
	for _, u := range units {
		if strings.HasSuffix(used, u.suffix) {
			num := strings.TrimSpace(strings.TrimSuffix(used, u.suffix))
			f, err := strconv.ParseFloat(num, 64)
			if err != nil {
				return 0
			}
			return uint64(f * u.mult)
		}
	}
	return 0
}

// rawStat mirrors one `<runtime> stats --format '{{json .}}'` line.
type rawStat struct {
	Name     string `json:"Name"`
	MemUsage string `json:"MemUsage"`
}

func parseStats(data []byte) map[string]memStat {
	out := map[string]memStat{}
	for _, line := range bytes.Split(data, []byte("\n")) {
		line = bytes.TrimSpace(line)
		if len(line) == 0 {
			continue
		}
		var r rawStat
		if err := json.Unmarshal(line, &r); err != nil || r.Name == "" {
			continue
		}
		used := strings.TrimSpace(strings.SplitN(r.MemUsage, "/", 2)[0])
		out[r.Name] = memStat{Bytes: parseMemUsage(r.MemUsage), Human: used}
	}
	return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/controlplane/ -run 'TestParseInspect|TestParseMemUsage|TestParseStats' -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/controlplane/parse.go pkg/controlplane/parse_test.go pkg/controlplane/testdata/
git commit -m "feat(controlplane): parse inspect + stats runtime output"
```

---

## Task 4: Service layer — List() and Do(action, name)

**Files:**
- Create: `pkg/controlplane/service.go`
- Test: `pkg/controlplane/service_test.go`

**Interfaces:**
- Consumes: `runner`, `resolveRuntime`, `parseInspect`, `parseStats`, `Service`, status/name helpers (Tasks 1–3).
- Produces:
  - `type Service interface { List(ctx context.Context) (ListResult, error); Do(ctx context.Context, action, name string) error }` — **NOTE:** rename the data struct from Task 1 to avoid colliding with this interface name. The data row stays `Service` **struct**; call the interface `Manager` instead. Final names: data row = `Service` struct (Task 1); interface = `Manager`.
  - `type ListResult struct { Runtime RuntimeKind ` + "`json:\"runtime\"`" + `; Available bool ` + "`json:\"available\"`" + `; Services []Service ` + "`json:\"services\"`" + ` }`
  - `type manager struct { runtime RuntimeKind; run runner }`
  - `func New() Manager` — resolves runtime from `os.Getenv("DASH_CONTAINER_RUNTIME")` + `exec.LookPath`, builds an `execRunner`. Returns a manager with `RuntimeNone` + nil runner when no runtime is present.
  - `func newManager(kind RuntimeKind, run runner) *manager` — injectable constructor for tests.
  - `var ErrRuntimeUnavailable = errors.New("no container runtime available")`
  - `var ErrUnknownService = errors.New("unknown control-plane service")`
  - `var ErrInvalidAction = errors.New("invalid action")`

Behavior:
- `List`: if `runtime == RuntimeNone`, return `ListResult{Available: false}` (no error). Otherwise, for each live name run `inspect`; a non-nil error means the container is absent → status `StatusStopped` with `Actionable=true` is wrong (absent ≠ stopped). Represent absent containers as `StatusStopped`, `Actionable=true` (Start is still valid — `docker start` on a non-existent container simply fails, surfaced to the user). Then run one `stats --no-stream` for memory and merge. Append k8s-only names as `StatusK8sOnly`, `Actionable=false`.
- `Do`: validate `ValidAction(action)` (else `ErrInvalidAction`) and `IsLiveName(name)` (else `ErrUnknownService`); if runtime is none, `ErrRuntimeUnavailable`; else `run.run(ctx, action, name)`.

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package controlplane

import (
	"context"
	"errors"
	"os"
	"testing"
)

// fakeRunner returns canned output/err keyed by the first two args joined.
type fakeRunner struct {
	calls   [][]string
	outputs map[string][]byte
	errs    map[string]error
}

func (f *fakeRunner) run(_ context.Context, args ...string) ([]byte, error) {
	f.calls = append(f.calls, args)
	key := args[0]
	if len(args) > 1 {
		key = args[0] + " " + args[1]
	}
	return f.outputs[key], f.errs[key]
}

func TestListUnavailableWhenNoRuntime(t *testing.T) {
	m := newManager(RuntimeNone, nil)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if res.Available {
		t.Error("Available = true, want false when no runtime")
	}
}

func TestListRunningService(t *testing.T) {
	inspect, _ := os.ReadFile("testdata/inspect_running.json")
	stats, _ := os.ReadFile("testdata/stats.json")
	f := &fakeRunner{
		outputs: map[string][]byte{
			"inspect dapr_scheduler": inspect,
			"inspect dapr_placement": inspect,
			"stats":                  stats,
		},
	}
	m := newManager(RuntimeDocker, f)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("List: %v", err)
	}
	if !res.Available {
		t.Fatal("Available = false, want true")
	}
	// 2 live + 2 k8s-only placeholders
	if len(res.Services) != 4 {
		t.Fatalf("len(Services) = %d, want 4", len(res.Services))
	}
	sched := res.Services[0]
	if sched.Name != "dapr_scheduler" || sched.Status != StatusRunning || !sched.Healthy {
		t.Errorf("scheduler = %+v, want running+healthy", sched)
	}
	if sched.MemoryBytes == 0 {
		t.Error("scheduler MemoryBytes = 0, want > 0")
	}
	// last two are k8s-only, non-actionable
	k8s := res.Services[3]
	if k8s.Status != StatusK8sOnly || k8s.Actionable {
		t.Errorf("k8s placeholder = %+v, want kubernetes-only + non-actionable", k8s)
	}
}

func TestDoValidation(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{}}
	m := newManager(RuntimeDocker, f)
	if err := m.Do(context.Background(), "kill", "dapr_scheduler"); !errors.Is(err, ErrInvalidAction) {
		t.Errorf("kill: got %v, want ErrInvalidAction", err)
	}
	if err := m.Do(context.Background(), "start", "dapr_redis"); !errors.Is(err, ErrUnknownService) {
		t.Errorf("dapr_redis: got %v, want ErrUnknownService", err)
	}
	if err := m.Do(context.Background(), "restart", "dapr_scheduler"); err != nil {
		t.Errorf("valid restart: got %v, want nil", err)
	}
	last := f.calls[len(f.calls)-1]
	if last[0] != "restart" || last[1] != "dapr_scheduler" {
		t.Errorf("ran %v, want [restart dapr_scheduler]", last)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/controlplane/ -run 'TestList|TestDo' -v`
Expected: FAIL — `undefined: newManager`.

- [ ] **Step 3: Write minimal implementation**

```go
package controlplane

import (
	"context"
	"errors"
	"os"
	"os/exec"
)

var (
	ErrRuntimeUnavailable = errors.New("no container runtime available")
	ErrUnknownService     = errors.New("unknown control-plane service")
	ErrInvalidAction      = errors.New("invalid action")
)

// ListResult is the payload of GET /api/controlplane.
type ListResult struct {
	Runtime   RuntimeKind `json:"runtime"`
	Available bool        `json:"available"`
	Services  []Service   `json:"services"`
}

// Manager lists and controls the local control-plane services.
type Manager interface {
	List(ctx context.Context) (ListResult, error)
	Do(ctx context.Context, action, name string) error
}

type manager struct {
	runtime RuntimeKind
	run     runner
}

// New resolves the container runtime from the environment and PATH.
func New() Manager {
	kind := resolveRuntime(os.Getenv("DASH_CONTAINER_RUNTIME"), exec.LookPath)
	if kind == RuntimeNone {
		return newManager(RuntimeNone, nil)
	}
	return newManager(kind, newExecRunner(kind))
}

func newManager(kind RuntimeKind, run runner) *manager {
	return &manager{runtime: kind, run: run}
}

func (m *manager) List(ctx context.Context) (ListResult, error) {
	if m.runtime == RuntimeNone {
		return ListResult{Runtime: RuntimeNone, Available: false}, nil
	}
	mem := m.memory(ctx)
	services := make([]Service, 0, len(LiveServiceNames)+len(K8sOnlyServiceNames))
	for _, name := range LiveServiceNames {
		svc := Service{Name: name, Status: StatusStopped, Actionable: true}
		out, err := m.run.run(ctx, "inspect", name)
		if err == nil {
			if info, perr := parseInspect(out); perr == nil {
				svc.Status = info.State
				svc.Healthy = info.Healthy
				svc.Ports = info.Ports
				svc.LogPath = info.LogPath
			}
		}
		if ms, ok := mem[name]; ok {
			svc.MemoryBytes = ms.Bytes
			svc.MemoryHuman = ms.Human
		}
		services = append(services, svc)
	}
	for _, name := range K8sOnlyServiceNames {
		services = append(services, Service{Name: name, Status: StatusK8sOnly, Actionable: false})
	}
	return ListResult{Runtime: m.runtime, Available: true, Services: services}, nil
}

// memory fetches a single stats snapshot; failures degrade to empty (no memory shown).
func (m *manager) memory(ctx context.Context) map[string]memStat {
	args := append([]string{"stats", "--no-stream", "--format", "{{json .}}"}, LiveServiceNames...)
	out, err := m.run.run(ctx, args...)
	if err != nil {
		return map[string]memStat{}
	}
	return parseStats(out)
}

func (m *manager) Do(ctx context.Context, action, name string) error {
	if !ValidAction(action) {
		return ErrInvalidAction
	}
	if !IsLiveName(name) {
		return ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return ErrRuntimeUnavailable
	}
	_, err := m.run.run(ctx, action, name)
	return err
}
```

**Also update `pkg/controlplane/types.go`:** the interface is named `Manager` and the row struct stays `Service` — no rename needed in types.go. Confirm no symbol named `Service` interface exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/controlplane/ -v`
Expected: PASS (all controlplane tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/controlplane/service.go pkg/controlplane/service_test.go
git commit -m "feat(controlplane): manager List + allowlisted lifecycle Do"
```

---

## Task 5: HTTP wiring — list + action routes

**Files:**
- Create: `pkg/server/controlplane.go`
- Create: `pkg/server/controlplane_test.go`
- Modify: `pkg/server/server.go` (add `ControlPlane` to `Options`; pass to `apiRouter`)
- Modify: `pkg/server/api.go` (accept the manager; mount `/controlplane`)
- Modify: `cmd/serve.go` (construct `controlplane.New()`; set `Options.ControlPlane`)

**Interfaces:**
- Consumes: `controlplane.Manager`, `controlplane.ListResult`, error sentinels (Task 4).
- Produces:
  - `func controlPlaneRouter(mgr controlplane.Manager) http.Handler` with:
    - `GET /` → `mgr.List` → 200 JSON `ListResult`; 500 on error.
    - `POST /{name}/{action}` → validate via `mgr.Do`; 400 on `ErrInvalidAction`/`ErrUnknownService`; 503 on `ErrRuntimeUnavailable`; 502 on other runtime errors; 200 `{"status":"ok"}` on success.

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
)

type fakeManager struct {
	list    controlplane.ListResult
	doErr   error
	lastDo  [2]string
}

func (f *fakeManager) List(context.Context) (controlplane.ListResult, error) { return f.list, nil }
func (f *fakeManager) Do(_ context.Context, action, name string) error {
	f.lastDo = [2]string{action, name}
	return f.doErr
}

func TestControlPlaneListRoute(t *testing.T) {
	mgr := &fakeManager{list: controlplane.ListResult{
		Available: true,
		Services:  []controlplane.Service{{Name: "dapr_scheduler", Status: controlplane.StatusRunning}},
	}}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	var got controlplane.ListResult
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if len(got.Services) != 1 || got.Services[0].Name != "dapr_scheduler" {
		t.Errorf("body = %+v", got)
	}
}

func TestControlPlaneActionRoute(t *testing.T) {
	mgr := &fakeManager{}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodPost, "/dapr_scheduler/restart", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if mgr.lastDo != [2]string{"restart", "dapr_scheduler"} {
		t.Errorf("Do called with %v", mgr.lastDo)
	}
}

func TestControlPlaneActionBadRequest(t *testing.T) {
	mgr := &fakeManager{doErr: controlplane.ErrUnknownService}
	r := controlPlaneRouter(mgr)
	req := httptest.NewRequest(http.MethodPost, "/dapr_redis/start", nil)
	w := httptest.NewRecorder()
	r.ServeHTTP(w, req)
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestControlPlane -v`
Expected: FAIL — `undefined: controlPlaneRouter`.

- [ ] **Step 3: Write minimal implementation**

Create `pkg/server/controlplane.go`:

```go
package server

import (
	"errors"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
	"github.com/go-chi/chi/v5"
)

func controlPlaneRouter(mgr controlplane.Manager) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		res, err := mgr.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})
	r.Post("/{name}/{action}", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		action := chi.URLParam(req, "action")
		err := mgr.Do(req.Context(), action, name)
		switch {
		case err == nil:
			writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		case errors.Is(err, controlplane.ErrInvalidAction), errors.Is(err, controlplane.ErrUnknownService):
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
		case errors.Is(err, controlplane.ErrRuntimeUnavailable):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
		}
	})
	return r
}
```

Modify `pkg/server/server.go` — add field to `Options` and pass into `apiRouter`:

```go
// in Options struct, after News:
	ControlPlane controlplane.Manager
```
Add the import `"github.com/diagridio/dev-dashboard/pkg/controlplane"`. Update the `mount` closure's `apiRouter(...)` call to pass `opts.ControlPlane` as the final argument.

Modify `pkg/server/api.go` — extend the signature and mount:

```go
func apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service, cp controlplane.Manager) http.Handler {
	// ...existing body...
	r.Mount("/news", newsRouter(newsSvc))
	r.Mount("/controlplane", controlPlaneRouter(cp))
	return r
}
```
Add the `controlplane` import to `api.go`.

Modify `cmd/serve.go` — in `assembleOptions`, after `newsSvc`:

```go
	return server.Options{
		BasePath:     deps.BasePath,
		DistFS:       dist,
		Version:      version.Get(),
		Apps:         decorated,
		Backend:      rc,
		Stores:       rc,
		Resources:    resources.New(rc.Paths),
		News:         newsSvc,
		ControlPlane: controlplane.New(),
	}, []func() error{rc.Close}
```
Add the import `"github.com/diagridio/dev-dashboard/pkg/controlplane"` to `cmd/serve.go`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/server/ -run TestControlPlane -v && go build ./...`
Expected: PASS and a clean build (confirms `server.go`, `api.go`, `serve.go` all compile with the new arg).

- [ ] **Step 5: Commit**

```bash
git add pkg/server/controlplane.go pkg/server/controlplane_test.go pkg/server/server.go pkg/server/api.go cmd/serve.go
git commit -m "feat(server): mount /api/controlplane list + action routes"
```

---

## Task 6: Control-plane log streaming endpoint

**Files:**
- Modify: `pkg/controlplane/service.go` (add `LogStream`)
- Modify: `pkg/controlplane/service_test.go` (test arg construction via a streaming-capable fake)
- Modify: `pkg/server/controlplane.go` (add `GET /{name}/logs` SSE handler)
- Modify: `pkg/server/controlplane_test.go` (route smoke test)

**Interfaces:**
- Produces:
  - Add to `Manager`: `LogStream(ctx context.Context, name string) (<-chan string, error)`.
  - `manager.LogStream` validates `IsLiveName(name)` (else `ErrUnknownService`) and runtime present (else `ErrRuntimeUnavailable`), then runs `<runtime> logs -f --tail 200 <name>` via a streaming runner, emitting lines on the channel; closes the channel when the process exits or ctx is cancelled.
  - Extend the `runner` interface with `stream(ctx context.Context, args ...string) (<-chan string, error)`; implement on `execRunner` (wrap `cmd.StdoutPipe()` + `bufio.Scanner`, kill on ctx done). Update `fakeRunner` in tests to satisfy it.

> **Why `logs -f` and not the LogPath file:** `docker logs`/`podman logs` both work regardless of logging driver, so this sidesteps the Podman-journald case where `LogPath` is empty. `LogPath` is still returned in `List` as informational text.

- [ ] **Step 1: Write the failing test**

```go
//go:build unit

package controlplane

import (
	"context"
	"testing"
)

func TestLogStreamValidation(t *testing.T) {
	m := newManager(RuntimeDocker, &fakeRunner{outputs: map[string][]byte{}})
	if _, err := m.LogStream(context.Background(), "dapr_redis"); err != ErrUnknownService {
		t.Errorf("unknown name: got %v, want ErrUnknownService", err)
	}
	none := newManager(RuntimeNone, nil)
	if _, err := none.LogStream(context.Background(), "dapr_scheduler"); err != ErrRuntimeUnavailable {
		t.Errorf("no runtime: got %v, want ErrRuntimeUnavailable", err)
	}
}

func TestLogStreamEmitsLines(t *testing.T) {
	f := &fakeRunner{streamLines: []string{"line one", "line two"}}
	m := newManager(RuntimeDocker, f)
	ch, err := m.LogStream(context.Background(), "dapr_scheduler")
	if err != nil {
		t.Fatalf("LogStream: %v", err)
	}
	got := []string{}
	for l := range ch {
		got = append(got, l)
	}
	if len(got) != 2 || got[0] != "line one" {
		t.Errorf("lines = %v", got)
	}
	// confirm it invoked `logs -f ... dapr_scheduler`
	last := f.streamCalls[len(f.streamCalls)-1]
	if last[0] != "logs" {
		t.Errorf("stream args = %v, want logs ...", last)
	}
}
```

Add these fields/methods to `fakeRunner` in `service_test.go`:

```go
// add to fakeRunner struct:
	streamLines []string
	streamCalls [][]string

func (f *fakeRunner) stream(_ context.Context, args ...string) (<-chan string, error) {
	f.streamCalls = append(f.streamCalls, args)
	ch := make(chan string)
	go func() {
		defer close(ch)
		for _, l := range f.streamLines {
			ch <- l
		}
	}()
	return ch, nil
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/controlplane/ -run TestLogStream -v`
Expected: FAIL — `m.LogStream undefined` and `runner` missing `stream`.

- [ ] **Step 3: Write minimal implementation**

Extend the `runner` interface and `execRunner` in `pkg/controlplane/runtime.go`:

```go
import (
	"bufio"
	"context"
	"os/exec"
)

type runner interface {
	run(ctx context.Context, args ...string) ([]byte, error)
	stream(ctx context.Context, args ...string) (<-chan string, error)
}

func (r *execRunner) stream(ctx context.Context, args ...string) (<-chan string, error) {
	cmd := exec.CommandContext(ctx, r.bin, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	ch := make(chan string)
	go func() {
		defer close(ch)
		sc := bufio.NewScanner(stdout)
		sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
		for sc.Scan() {
			select {
			case ch <- sc.Text():
			case <-ctx.Done():
				_ = cmd.Process.Kill()
				return
			}
		}
		_ = cmd.Wait()
	}()
	return ch, nil
}
```

Add `LogStream` to `manager` (in `service.go`) and to the `Manager` interface:

```go
// add to Manager interface:
	LogStream(ctx context.Context, name string) (<-chan string, error)

func (m *manager) LogStream(ctx context.Context, name string) (<-chan string, error) {
	if !IsLiveName(name) {
		return nil, ErrUnknownService
	}
	if m.runtime == RuntimeNone {
		return nil, ErrRuntimeUnavailable
	}
	return m.run.stream(ctx, "logs", "-f", "--tail", "200", name)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/controlplane/ -run TestLogStream -v`
Expected: PASS.

- [ ] **Step 5: Add the SSE route**

In `pkg/server/controlplane.go`, add inside `controlPlaneRouter` before `return r`:

```go
	r.Get("/{name}/logs", func(w http.ResponseWriter, req *http.Request) {
		name := chi.URLParam(req, "name")
		ch, err := mgr.LogStream(req.Context(), name)
		if err != nil {
			status := http.StatusBadGateway
			if errors.Is(err, controlplane.ErrUnknownService) {
				status = http.StatusBadRequest
			} else if errors.Is(err, controlplane.ErrRuntimeUnavailable) {
				status = http.StatusServiceUnavailable
			}
			writeJSON(w, status, map[string]string{"error": err.Error()})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		for {
			select {
			case line, open := <-ch:
				if !open {
					return
				}
				_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
				flusher.Flush()
			case <-req.Context().Done():
				return
			}
		}
	})
```

Add `"fmt"` to the imports of `controlplane.go`. In `pkg/server/controlplane_test.go`, extend `fakeManager` with a `LogStream` method returning a closed channel so it satisfies the interface:

```go
func (f *fakeManager) LogStream(context.Context, string) (<-chan string, error) {
	ch := make(chan string)
	close(ch)
	return ch, nil
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/controlplane/ ./pkg/server/ -v && go build ./...`
Expected: PASS + clean build.

- [ ] **Step 7: Commit**

```bash
git add pkg/controlplane/ pkg/server/controlplane.go pkg/server/controlplane_test.go
git commit -m "feat(controlplane): stream control-plane logs via runtime logs -f"
```

---

## Task 7: Frontend types + hooks

**Files:**
- Create: `web/src/types/controlplane.ts`
- Create: `web/src/hooks/useControlPlane.ts`
- Create: `web/src/hooks/useControlPlane.test.tsx`

**Interfaces:**
- Produces:
  - `controlplane.ts`:
    ```ts
    export type ServiceStatus = 'running' | 'stopped' | 'kubernetes-only' | 'unknown'
    export interface ControlPlaneService {
      name: string
      status: ServiceStatus
      healthy: boolean
      ports: string[]
      memoryBytes: number
      memoryHuman: string
      logPath: string
      actionable: boolean
    }
    export interface ControlPlaneList {
      runtime: string
      available: boolean
      services: ControlPlaneService[]
    }
    export type ControlPlaneAction = 'start' | 'stop' | 'restart'
    ```
  - `useControlPlane.ts`:
    - `useControlPlane()` → `useQuery<ControlPlaneList>` keyed `['controlplane']`, `queryFn: () => fetchJSON<ControlPlaneList>('/controlplane')`, `refetchInterval: refetchMs(useRefreshInterval())`.
    - `useControlPlaneAction()` → `useMutation` that POSTs `/controlplane/{name}/{action}` and invalidates `['controlplane']` on success. Reuse the `send` helper shape from `useStoreMutations.ts`.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useControlPlane } from './useControlPlane'

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>
}

describe('useControlPlane', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(
        JSON.stringify({ runtime: 'docker', available: true, services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    ))
  })

  it('fetches the control plane list', async () => {
    const { result } = renderHook(() => useControlPlane(), { wrapper })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.services[0].name).toBe('dapr_scheduler')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useControlPlane.test.tsx`
Expected: FAIL — cannot resolve `./useControlPlane`.

- [ ] **Step 3: Write minimal implementation**

`web/src/types/controlplane.ts` — the interfaces above.

`web/src/hooks/useControlPlane.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { fetchJSON, apiUrl } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { ControlPlaneList, ControlPlaneAction } from '../types/controlplane'

export function useControlPlane() {
  const ctx = useRefreshInterval()
  return useQuery<ControlPlaneList>({
    queryKey: ['controlplane'],
    queryFn: () => fetchJSON<ControlPlaneList>('/controlplane'),
    refetchInterval: refetchMs(ctx),
  })
}

async function sendAction(name: string, action: ControlPlaneAction): Promise<void> {
  const res = await fetch(apiUrl(`/controlplane/${encodeURIComponent(name)}/${action}`), { method: 'POST' })
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

export function useControlPlaneAction() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: ({ name, action }: { name: string; action: ControlPlaneAction }) => sendAction(name, action),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['controlplane'] }),
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/hooks/useControlPlane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/controlplane.ts web/src/hooks/useControlPlane.ts web/src/hooks/useControlPlane.test.tsx
git commit -m "feat(web): control-plane types + list/action hooks"
```

---

## Task 8: ControlPlane page

**Files:**
- Create: `web/src/pages/ControlPlane.tsx`
- Create: `web/src/pages/ControlPlane.test.tsx`

**Interfaces:**
- Consumes: `useControlPlane`, `useControlPlaneAction` (Task 7); `ControlPlaneService` type.
- Produces: `export function ControlPlane()`.

Behavior:
- Uses `useDocumentTitle('Control Plane')`.
- Loading → `<p className="muted">Loading…</p>`.
- `data.available === false` → an "unavailable" empty state: `No container runtime (Docker/Podman) detected. Run `dapr init` to start the control plane.` (className `muted`).
- Otherwise a grid of `<ServiceCard>` (class `card`), one per service:
  - Health: reuse `<span className="health"><span className={led ${healthy ? 'ok' : 'bad'}} /></span>`.
  - Status badge (text of `status`).
  - Ports as `mono` text joined by `, ` or `—`.
  - Memory: `memoryHuman || '—'`.
  - Log path: `mono` text or `—`; a **View logs** `<Link to={/logs?cp=${name}}>` shown when `status !== 'kubernetes-only'`.
  - Actions (only when `actionable`): **Start** when `status === 'stopped'`; **Restart** and **Stop** when `status === 'running'`. Each button calls `window.confirm(...)` with the resolved command text, then `action.mutate({ name, action })`.
  - k8s-only cards: render greyed with a `Kubernetes only` label, no actions.

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ControlPlane } from './ControlPlane'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ControlPlane />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function mockList(body: unknown) {
  vi.stubGlobal('fetch', vi.fn(async () =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ))
}

describe('ControlPlane', () => {
  beforeEach(() => vi.unstubAllGlobals())

  it('shows an unavailable state when no runtime', async () => {
    mockList({ runtime: '', available: false, services: [] })
    renderPage()
    expect(await screen.findByText(/no container runtime/i)).toBeInTheDocument()
  })

  it('renders a running service with a Restart action', async () => {
    mockList({
      runtime: 'docker', available: true,
      services: [{ name: 'dapr_scheduler', status: 'running', healthy: true, ports: ['50006/tcp'], memoryBytes: 1, memoryHuman: '12MiB', logPath: '/x.log', actionable: true }],
    })
    renderPage()
    expect(await screen.findByText('dapr_scheduler')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /restart/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument()
  })

  it('renders k8s-only services without actions', async () => {
    mockList({
      runtime: 'docker', available: true,
      services: [{ name: 'dapr_sentry', status: 'kubernetes-only', healthy: false, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: false }],
    })
    renderPage()
    expect(await screen.findByText('dapr_sentry')).toBeInTheDocument()
    expect(screen.getByText(/kubernetes only/i)).toBeInTheDocument()
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/ControlPlane.test.tsx`
Expected: FAIL — cannot resolve `./ControlPlane`.

- [ ] **Step 3: Write minimal implementation**

```tsx
import { Link } from 'react-router-dom'
import { useControlPlane, useControlPlaneAction } from '../hooks/useControlPlane'
import { useDocumentTitle } from '../lib/useDocumentTitle'
import type { ControlPlaneService, ControlPlaneAction } from '../types/controlplane'

export function ControlPlane() {
  useDocumentTitle('Control Plane')
  const { data, isLoading } = useControlPlane()
  const action = useControlPlaneAction()

  const header = (
    <div className="phead">
      <div>
        <h1>Control Plane</h1>
        <div className="sub">Local Dapr control-plane services · via container runtime</div>
      </div>
    </div>
  )

  if (isLoading) {
    return <div className="page">{header}<p className="muted">Loading…</p></div>
  }

  if (!data || !data.available) {
    return (
      <div className="page">
        {header}
        <p className="muted">
          No container runtime (Docker/Podman) detected. Run <span className="mono">dapr init</span> to
          start the control plane.
        </p>
      </div>
    )
  }

  const runAction = (name: string, act: ControlPlaneAction) => {
    if (window.confirm(`Run "${data.runtime} ${act} ${name}"?`)) {
      action.mutate({ name, action: act })
    }
  }

  return (
    <div className="page">
      {header}
      <div className="cards">
        {data.services.map((svc) => (
          <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
        ))}
      </div>
    </div>
  )
}

function ServiceCard({
  svc,
  onAction,
}: {
  svc: ControlPlaneService
  onAction: (name: string, act: ControlPlaneAction) => void
}) {
  const isK8s = svc.status === 'kubernetes-only'
  return (
    <div className={isK8s ? 'card faint' : 'card'}>
      <div className="b">{svc.name}</div>
      {isK8s ? (
        <div className="sub">Kubernetes only</div>
      ) : (
        <>
          <div>
            <span className="health">
              <span className={svc.healthy ? 'led ok' : 'led bad'} />
            </span>{' '}
            {svc.status}
          </div>
          <div className="mono">{svc.ports.length ? svc.ports.join(', ') : '—'}</div>
          <div className="mono">{svc.memoryHuman || '—'}</div>
          <div className="mono faint">{svc.logPath || '—'}</div>
          <Link className="celllink" to={`/logs?cp=${encodeURIComponent(svc.name)}`}>
            View logs
          </Link>
          {svc.actionable && (
            <div className="actions">
              {svc.status === 'stopped' && (
                <button onClick={() => onAction(svc.name, 'start')}>Start</button>
              )}
              {svc.status === 'running' && (
                <>
                  <button onClick={() => onAction(svc.name, 'restart')}>Restart</button>
                  <button onClick={() => onAction(svc.name, 'stop')}>Stop</button>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
```

> If `.cards` / `.actions` / `.led.bad` are not already in `web/src/styles/theme.css`, add minimal rules there composing existing tokens (grid gap for `.cards`, flex gap for `.actions`, the existing danger color token for `.led.bad`). Check first with `grep -n "\.led\|\.cards\|\.actions" web/src/styles/theme.css` and reuse what exists.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/pages/ControlPlane.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/ControlPlane.tsx web/src/pages/ControlPlane.test.tsx web/src/styles/theme.css
git commit -m "feat(web): Control Plane page with per-service cards + actions"
```

---

## Task 9: Route + nav entry

**Files:**
- Modify: `web/src/router.tsx`
- Modify: `web/src/components/TopNav.tsx`
- Modify: `web/src/components/TopNav.test.tsx` (if it asserts the nav item list)

**Interfaces:**
- Consumes: `ControlPlane` page (Task 8).

- [ ] **Step 1: Write the failing test**

Add to `web/src/components/TopNav.test.tsx` (or create an assertion if the file exists — check first with `grep -n "Logs\|NAV_ITEMS" web/src/components/TopNav.test.tsx`):

```tsx
it('includes a Control Plane nav item', () => {
  expect(NAV_ITEMS.some((i) => i.to === '/control-plane')).toBe(true)
})
```
Ensure `NAV_ITEMS` is imported in that test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx`
Expected: FAIL — no item with `to === '/control-plane'`.

- [ ] **Step 3: Write minimal implementation**

In `web/src/components/TopNav.tsx`, add to `NAV_ITEMS` after the `Resiliency` entry:

```ts
  { label: 'Control Plane', to: '/control-plane' },
```

In `web/src/router.tsx`, add the import and route:

```tsx
import { ControlPlane } from './pages/ControlPlane'
// ...inside children, after the resiliency routes:
      { path: 'control-plane', element: <ControlPlane /> },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/router.tsx web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -m "feat(web): route + nav entry for Control Plane page"
```

---

## Task 10: Logs page — control-plane source + deep-link

**Files:**
- Modify: `web/src/hooks/useLogStream.ts` (generalize to an explicit stream path)
- Modify: `web/src/pages/Logs.tsx` (control-plane source option; read `?cp=`)
- Modify: `web/src/hooks/useLogStream.test.tsx` (path-based stream test)

**Interfaces:**
- Produces: an overload/variant of the stream hook that accepts a full API stream path, so a control-plane service can be streamed from `/controlplane/{name}/logs`. Keep the existing app-based call sites working.

Recommended concrete shape — add a sibling hook rather than break the existing one:

```ts
// New export in useLogStream.ts — streams an arbitrary API path via EventSource.
export function usePathLogStream(path: string | undefined, opts?: { max?: number }): UseLogStreamResult
```
Refactor the existing `useLogStream(appId, source)` to delegate to `usePathLogStream(appId ? '/apps/' + appId + '/logs?source=' + source : undefined, opts)`. This keeps `useLogStream`'s signature and tests intact while exposing the generic path variant.

- [ ] **Step 1: Write the failing test**

Add to `web/src/hooks/useLogStream.test.tsx` (mirror the existing EventSource-stub pattern already in that file — check with `grep -n "EventSource\|renderHook" web/src/hooks/useLogStream.test.tsx`):

```tsx
it('usePathLogStream connects to the given path', () => {
  const opened: string[] = []
  class FakeES {
    onopen: (() => void) | null = null
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: (() => void) | null = null
    constructor(url: string) { opened.push(url) }
    close() {}
  }
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource)
  renderHook(() => usePathLogStream('/controlplane/dapr_scheduler/logs'))
  expect(opened.some((u) => u.includes('/controlplane/dapr_scheduler/logs'))).toBe(true)
})
```
Import `usePathLogStream` in the test.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useLogStream.test.tsx`
Expected: FAIL — `usePathLogStream` is not exported.

- [ ] **Step 3: Write minimal implementation**

Refactor `web/src/hooks/useLogStream.ts` so the EventSource logic lives in `usePathLogStream(path)`; `useLogStream(appId, source)` computes the path and delegates:

```ts
export function usePathLogStream(
  path: string | undefined,
  opts?: { max?: number },
): UseLogStreamResult {
  const [lines, setLines] = useState<LogLine[]>([])
  const [status, setStatus] = useState<Status>('idle')
  const seqRef = useRef(0)
  const maxRef = useRef(opts?.max ?? 2000)
  maxRef.current = opts?.max ?? 2000
  const clear = useCallback(() => setLines([]), [])

  useEffect(() => {
    if (!path) { setStatus('idle'); setLines([]); return }
    setStatus('connecting'); setLines([])
    const ESConstructor = (globalThis as unknown as { EventSource: new (url: string) => EventSource }).EventSource
    const es = new ESConstructor(apiUrl(path))
    es.onopen = () => setStatus('open')
    es.onmessage = (e: MessageEvent) => {
      const line: LogLine = { seq: seqRef.current++, text: e.data, level: parseLogLevel(e.data) }
      const cap = maxRef.current
      setLines((prev) => {
        const next = [...prev, line]
        return next.length > cap ? next.slice(next.length - cap) : next
      })
    }
    es.onerror = () => setStatus('error')
    return () => es.close()
  }, [path])

  return { lines, status, clear }
}

export function useLogStream(
  appId: string | undefined,
  source: 'daprd' | 'app',
  opts?: { max?: number },
): UseLogStreamResult {
  const path = appId ? `/apps/${appId}/logs?source=${source}` : undefined
  return usePathLogStream(path, opts)
}
```

In `web/src/pages/Logs.tsx`:
- Read `const [params] = useSearchParams()` and `const cp = params.get('cp')`.
- When `cp` is set and is one of the control-plane names, render a control-plane view: stream via `usePathLogStream('/controlplane/' + cp + '/logs')`, show the lines with the existing line-rendering/list, a header naming the service, and a control to return to the app-based view (clear the `cp` param). Keep the existing app-log behavior unchanged when `cp` is absent.
- Add the control-plane service to the existing source selector (checkbox/segment) so a user can pick it manually as well; selecting it sets `?cp=<name>`.

> Follow the file's current source-selection structure — check `grep -n "source\|useSearchParams\|selectedApp" web/src/pages/Logs.tsx` and slot the control-plane branch alongside the existing daprd/app selection rather than rewriting the merge logic.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/hooks/useLogStream.test.tsx src/pages/Logs.test.tsx`
Expected: PASS (existing app-log tests still green; new path-stream test green).

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useLogStream.ts web/src/hooks/useLogStream.test.tsx web/src/pages/Logs.tsx
git commit -m "feat(web): stream control-plane logs on the Logs page via ?cp="
```

---

## Task 11: Document the read-only exception in AGENTS.md

**Files:**
- Modify: `AGENTS.md` (the "Read-only product surface" bullet under "Conventions for agents")

**Interfaces:** none (docs only).

- [ ] **Step 1: Update the read-only bullet**

Replace the existing "Read-only product surface" bullet's parenthetical of allowed mutations so it reads (keep surrounding wording):

> **Read-only product surface:** the dashboard never starts/stops apps and never edits app or
> component state. The mutating operations are limited to workflow terminate/purge, managing the
> user's own saved state-store connections (the `connections.yaml` registry under
> `~/.dapr/dev-dashboard/`, written `0600`), **and control-plane lifecycle actions
> (start/restart/stop of the known `dapr_*` control-plane containers via the resolved
> container runtime, allowlisted to those container names).** Don't add other side-effecting
> behavior without an explicit ask.

- [ ] **Step 2: Verify wording**

Run: `grep -n "control-plane lifecycle" AGENTS.md`
Expected: one match.

- [ ] **Step 3: Commit**

```bash
git add AGENTS.md
git commit -m "docs: carve out control-plane lifecycle in the read-only note"
```

---

## Final verification

- [ ] **Run the full gate**

Run: `make test`
Expected: Go-unit (`-tags unit -race`) and web (vitest) all pass.

- [ ] **Run integration (server wiring changed)**

Run: `make test-integration`
Expected: PASS (confirms the assembled server with the new route builds and serves).

- [ ] **Build the binary end-to-end**

Run: `make build`
Expected: SPA builds, then `bin/dev-dashboard` builds clean.

- [ ] **Manual smoke (optional, needs Docker/Podman + `dapr init`)**

Run: `./bin/dev-dashboard --no-open` then open `/control-plane`. Confirm scheduler/placement cards show status/ports/memory, actions respect state, "View logs" opens the Logs page streaming that container, and sentry/injector show as Kubernetes-only.

---

## Self-Review Notes

- **Spec §1 (scope/platform table):** Tasks 1 (k8s-only names), 4 (k8s placeholders in `List`), 8 (k8s-only card rendering). ✅
- **Spec §1 (unavailable states):** Task 4 (`Available:false`) + Task 8 (empty state). The three distinct sub-states (no runtime / daemon down / no containers) are collapsed to two surfaces: "runtime unavailable" (no binary) and, when the runtime is present but a container is absent, a `stopped` card. The "daemon down" case surfaces as inspect/stats errors → `stopped`/empty memory; acceptable and noted here rather than over-engineered.
- **Spec §2 (Docker+Podman resolution):** Task 2. ✅
- **Spec §3 (package layout, endpoints, health, data collection, LogPath best-effort):** Tasks 3–6. LogPath is surfaced in `List` (Task 4) and shown in the card (Task 8); logs are streamed via `logs -f` (Task 6), which supersedes the file path for viewing and covers Podman-journald. ✅
- **Spec §4 (read-only exception, allowlist, confirmation, refetch, AGENTS.md):** allowlist (Tasks 1/4), confirmation (Task 8 `window.confirm`), refetch (Task 7 `invalidateQueries`), AGENTS.md (Task 11). ✅
- **Spec §5 (page, nav, poll, deep-link):** Tasks 8, 9, 7 (poll), 10 (deep-link). ✅
- **Spec §6 (testing across unit/server/web):** every task is TDD; parsers/resolution/allowlist/routes/hooks/page all covered. ✅
- **Type consistency:** data row is `Service` struct throughout; the service interface is `Manager` (disambiguated in Task 4); `ListResult` shape matches the TS `ControlPlaneList`; action verbs `start|stop|restart` consistent across `ValidAction`, `ControlPlaneAction`, and routes. ✅
