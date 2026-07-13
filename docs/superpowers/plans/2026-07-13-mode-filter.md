# Exclusive `--mode` Discovery Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `--mode` to four exclusive discovery filters — `dapr-run`, `compose`, `test-containers`, `aspire` — that restrict every dashboard surface (apps, control plane, logs) to one source, with `aspire` gaining a standalone host posture, and relabel the UI's "Run template" column to "Mode".

**Architecture:** Mode drives a scanner-selection helper in `cmd`; the aspire host filter is a post-enrichment `discovery.Service` wrapper (the `IsAspire` flag only exists after enrichment); the Control Plane manager gains a `Sources` family selector; the SPA learns the mode via the existing `window.__DASH_CAPABILITIES__` injection so the Logs page can gate its static `dapr_*` fallback.

**Tech Stack:** Go (cobra CLI, chi server), React + TypeScript (vitest), existing test conventions (`//go:build unit`, fakeRunner, Testing Library).

**Spec:** `docs/superpowers/specs/2026-07-13-mode-filter-design.md`

## Global Constraints

- CLI mode values are exactly `dapr-run`, `compose`, `test-containers`, `aspire`; unset means complete scan. Filters are exclusive, never combined.
- Pretty UI labels are exactly `Dapr run`, `Compose`, `TestContainers`, `Aspire`.
- `compose`/`test-containers` mode with no container runtime must FAIL at startup, not degrade to empty.
- Testcontainers control-plane detection is DEFERRED — the Control Plane view shows an honest empty list in `test-containers` mode.
- Container posture (8080/0.0.0.0/no registry/no browser) applies ONLY to `aspire` + `DEVDASHBOARD_APP_*` contract present; every other mode keeps host posture.
- Go tests run with `go test -tags unit -race ./<pkg>/...`; any `.ts(x)` change requires `make build` (vitest does not typecheck).
- Run `gofmt -w` on every touched Go file before committing.

---

### Task 1: Mode constants and validation

**Files:**
- Modify: `cmd/mode.go:11-35`
- Test: `cmd/mode_test.go:12-47`

**Interfaces:**
- Produces: `ModeDaprRun Mode = "dapr-run"`, `ModeCompose Mode = "compose"`, `ModeTestcontainers Mode = "test-containers"` (used by every later task); `resolveMode` unchanged signature, now accepting the new values.

- [ ] **Step 1: Update the tests to accept the new values**

In `cmd/mode_test.go`, replace the two "unknown" cases (lines 27-28) and extend the table inside `TestResolveMode`:

```go
		{name: "unset everywhere is default", flag: "", env: nil, want: ModeDefault},
		{name: "flag aspire", flag: "aspire", env: nil, want: ModeAspire},
		{name: "flag dapr-run", flag: "dapr-run", env: nil, want: ModeDaprRun},
		{name: "flag compose", flag: "compose", env: nil, want: ModeCompose},
		{name: "flag test-containers", flag: "test-containers", env: nil, want: ModeTestcontainers},
		{name: "env aspire", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "aspire"}, want: ModeAspire},
		{name: "env compose", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "compose"}, want: ModeCompose},
		{name: "flag wins over env", flag: "aspire", env: map[string]string{"DEVDASHBOARD_MODE": "bogus"}, want: ModeAspire},
		{name: "unknown flag value errors", flag: "dapr", wantErr: true},
		{name: "unknown env value errors", env: map[string]string{"DEVDASHBOARD_MODE": "docker"}, wantErr: true},
```

- [ ] **Step 2: Run tests to verify the new cases fail**

Run: `go test -tags unit -race ./cmd/ -run TestResolveMode -v`
Expected: FAIL — "flag dapr-run", "flag compose", "flag test-containers", "env compose" error with `unknown mode`.

- [ ] **Step 3: Add the constants and accept them in resolveMode**

In `cmd/mode.go`, replace the type comment + const block (lines 11-21):

```go
// Mode selects the dashboard's discovery and serving posture. ModeDefault
// (the zero value, mode unset) is the complete scan across all discovery
// sources with today's host behavior. Every other value is an exclusive
// single-source filter — they are never combined:
//
//   - ModeDaprRun: host `dapr run` process scan only.
//   - ModeCompose: Docker Compose container discovery only.
//   - ModeTestcontainers: Testcontainers container discovery only.
//   - ModeAspire: Aspire resources only. With the DEVDASHBOARD_APP_* env
//     contract present the dashboard is the AppHost-managed container
//     (container posture); without it the dashboard runs on the host and
//     filters the process scan to Aspire-managed instances.
//
// CLI values ("dapr-run", "test-containers") are user-facing names and
// intentionally differ from the discovery Source wire values ("standalone",
// "testcontainers") — do not unify them.
type Mode string

const (
	ModeDefault        Mode = ""
	ModeAspire         Mode = "aspire"
	ModeDaprRun        Mode = "dapr-run"
	ModeCompose        Mode = "compose"
	ModeTestcontainers Mode = "test-containers"
)
```

And in `resolveMode`, replace the switch + error (lines 30-34):

```go
	switch Mode(v) {
	case ModeDefault, ModeAspire, ModeDaprRun, ModeCompose, ModeTestcontainers:
		return Mode(v), nil
	}
	return ModeDefault, fmt.Errorf("unknown mode %q: supported values are \"dapr-run\", \"compose\", \"test-containers\", \"aspire\" (or unset for the complete scan)", v)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/ -run TestResolveMode -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/mode.go cmd/mode_test.go
git commit -m "feat(mode): accept dapr-run, compose, test-containers mode values"
```

---

### Task 2: Container posture split (aspire dual semantics)

**Files:**
- Modify: `cmd/mode.go:50-100` (`resolveServeSettings`), add `containerPosture` helper
- Modify: `cmd/root.go:53-62` (RunE), `cmd/root.go:85` (runServe signature), `cmd/root.go:100,116,137,183,188,210` (posture checks)
- Test: `cmd/mode_test.go` (`TestResolveServeSettings`, new `TestContainerPosture`)

**Interfaces:**
- Consumes: `discovery.AspireContractPresent(getenv func(string) string) bool` (existing, `pkg/discovery/scan_aspire.go:18`).
- Produces: `containerPosture(mode Mode, getenv func(string) string) bool`; `resolveServeSettings(containerPosture bool, flagChanged func(string) bool, port int, bind, stateStore, namespace string, getenv func(string) string) (serveSettings, error)`; `runServe(ctx context.Context, mode Mode, containerPosture bool, settings serveSettings, basePath string, noOpen, verbose bool) error`. Task 6 relies on `runServe` receiving both `mode` and `containerPosture`.

- [ ] **Step 1: Write the failing tests**

In `cmd/mode_test.go`, add after `TestResolveMode`:

```go
func TestContainerPosture(t *testing.T) {
	withContract := func(k string) string {
		if k == "DEVDASHBOARD_APP_COUNT" {
			return "2"
		}
		return ""
	}
	none := func(string) string { return "" }
	if !containerPosture(ModeAspire, withContract) {
		t.Fatal("aspire + contract must be container posture")
	}
	if containerPosture(ModeAspire, none) {
		t.Fatal("aspire without the contract must stay host posture")
	}
	if containerPosture(ModeCompose, withContract) {
		t.Fatal("non-aspire modes are never container posture")
	}
	if containerPosture(ModeDefault, withContract) {
		t.Fatal("mode-unset is never container posture")
	}
}
```

In `TestResolveServeSettings`, change the table field `mode Mode` to `container bool`, set `container: true` on the five cases currently using `mode: ModeAspire`, drop `mode: ModeDefault` from the rest (zero value false), and update the two call sites:

```go
			got, err := resolveServeSettings(tc.container, tc.changed, tc.port, tc.bind, tc.stateStore, ns, getenv)
```

and in the "bad DEVDASHBOARD_PORT errors" subtest:

```go
		_, err := resolveServeSettings(true, noneChanged, 9090, "127.0.0.1", "", "default",
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./cmd/ -run 'TestContainerPosture|TestResolveServeSettings' -v`
Expected: FAIL to compile — `undefined: containerPosture`, wrong argument type for `resolveServeSettings`.

- [ ] **Step 3: Implement the posture split**

In `cmd/mode.go`, add the import `"github.com/diagridio/dev-dashboard/pkg/discovery"` and, below `resolveMode`:

```go
// containerPosture reports whether the dashboard serves as the
// AppHost-managed container: aspire mode with the DEVDASHBOARD_APP_* env
// contract present. Aspire mode without the contract is a host-run dashboard
// filtered to Aspire resources and keeps host serving defaults.
func containerPosture(mode Mode, getenv func(string) string) bool {
	return mode == ModeAspire && discovery.AspireContractPresent(getenv)
}
```

Change `resolveServeSettings`'s first parameter from `mode Mode` to `containerPosture bool` and replace its three `mode == ModeAspire` checks (lines 64, 71, 89) with `containerPosture`. Update its doc comment's "mode default" wording to "posture default".

In `cmd/root.go` RunE (lines 53-62):

```go
			mode, err := resolveMode(modeFlag, os.Getenv)
			if err != nil {
				return err
			}
			posture := containerPosture(mode, os.Getenv)
			settings, err := resolveServeSettings(posture, cmd.Flags().Changed, port, bind, stateStore, namespace, os.Getenv)
			if err != nil {
				return err
			}
			return runServe(cmd.Context(), mode, posture, settings, basePath, noOpen, verbose)
```

In `runServe`, change the signature to `func runServe(ctx context.Context, mode Mode, containerPosture bool, settings serveSettings, basePath string, noOpen, verbose bool) error` and replace every aspire-keyed posture check:

- line 100: `if !containerPosture && !isLoopbackBind(settings.Bind) {` (warning text: change "without aspire mode" to "without container posture" and keep the `--mode aspire` hint)
- line 116: `if !containerPosture {` (home dir)
- lines 137-138: replace `switch mode { case ModeAspire:` with `switch { case containerPosture:` and `default:` stays (aspire host mode intentionally falls to the default branch here; Task 6 adds its filter)
- line 183: `AllowNonLoopback: containerPosture,`
- line 188: `QuietRegistry:    containerPosture,`
- line 210: `if !noOpen && !containerPosture {`

- [ ] **Step 4: Run the package tests**

Run: `go test -tags unit -race ./cmd/...`
Expected: PASS (including the untouched workflow/serve tests).

- [ ] **Step 5: Commit**

```bash
git add cmd/mode.go cmd/mode_test.go cmd/root.go
git commit -m "feat(mode): key container posture on aspire env contract, not mode alone"
```

---

### Task 3: Aspire post-enrichment service filter

**Files:**
- Create: `pkg/discovery/filter.go`
- Test: `pkg/discovery/filter_test.go`

**Interfaces:**
- Consumes: `discovery.Service` (List/Get, `pkg/discovery/service.go:100-104`), `Instance.IsAspire`, `ErrNotFound`.
- Produces: `discovery.FilterAspire(inner Service) Service` — Task 6 wraps the lifecycle-overlaid service with it in aspire host mode.

- [ ] **Step 1: Write the failing tests**

Create `pkg/discovery/filter_test.go`:

```go
//go:build unit

package discovery

import (
	"context"
	"errors"
	"testing"
)

type fakeFilterInner struct{ instances []Instance }

func (f fakeFilterInner) List(context.Context) ([]Instance, error) { return f.instances, nil }

func (f fakeFilterInner) Get(_ context.Context, key string) (Instance, error) {
	for _, in := range f.instances {
		if in.AppID == key {
			return in, nil
		}
	}
	return Instance{}, ErrNotFound
}

func newAspireFiltered() Service {
	return FilterAspire(fakeFilterInner{instances: []Instance{
		{AppID: "checkout", IsAspire: true},
		{AppID: "plain-daprd", IsAspire: false},
	}})
}

func TestFilterAspireListKeepsOnlyAspire(t *testing.T) {
	got, err := newAspireFiltered().List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(got) != 1 || got[0].AppID != "checkout" {
		t.Fatalf("want only the aspire instance, got %+v", got)
	}
}

func TestFilterAspireGet(t *testing.T) {
	svc := newAspireFiltered()
	if _, err := svc.Get(context.Background(), "checkout"); err != nil {
		t.Fatalf("aspire instance must resolve: %v", err)
	}
	if _, err := svc.Get(context.Background(), "plain-daprd"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-aspire instance must be ErrNotFound, got %v", err)
	}
	if _, err := svc.Get(context.Background(), "missing"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown key must stay ErrNotFound, got %v", err)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestFilterAspire -v`
Expected: FAIL to compile — `undefined: FilterAspire`.

- [ ] **Step 3: Implement the wrapper**

Create `pkg/discovery/filter.go`:

```go
package discovery

import "context"

// FilterAspire restricts a Service to Aspire-managed instances. Aspire host
// mode (dashboard on the host, no env contract) scans the full process table
// — IsAspire is only known after enrichment (the DCP-proxy heuristic in
// appproc.go), so the filter must wrap the Service rather than the Scanner.
// Wrap the outermost Service (after the lifecycle overlay) so every consumer
// — apps API, workflows, state-store election — sees the filtered view.
func FilterAspire(inner Service) Service { return aspireOnly{inner: inner} }

type aspireOnly struct{ inner Service }

func (a aspireOnly) List(ctx context.Context) ([]Instance, error) {
	all, err := a.inner.List(ctx)
	if err != nil {
		return nil, err
	}
	out := make([]Instance, 0, len(all))
	for _, in := range all {
		if in.IsAspire {
			out = append(out, in)
		}
	}
	return out, nil
}

func (a aspireOnly) Get(ctx context.Context, key string) (Instance, error) {
	in, err := a.inner.Get(ctx, key)
	if err != nil {
		return Instance{}, err
	}
	if !in.IsAspire {
		return Instance{}, ErrNotFound
	}
	return in, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/filter.go pkg/discovery/filter_test.go
git commit -m "feat(discovery): FilterAspire service wrapper for aspire host mode"
```

---

### Task 4: Control-plane family filtering

**Files:**
- Modify: `pkg/controlplane/types.go` (add `Sources`), `pkg/controlplane/service.go:34-101,162-184`
- Modify: `cmd/serve.go:150` (compile fix: `controlplane.New(controlplane.AllSources())`)
- Test: `pkg/controlplane/service_test.go`

**Interfaces:**
- Consumes: existing `newManager(kind, run)` test seam, `fakeRunner` (outputs keyed on `args[0]+" "+args[1]`).
- Produces: `type Sources struct { Init, Compose bool }`, `func AllSources() Sources`, `func New(src Sources) Manager`, `newManager(kind RuntimeKind, run containerruntime.Runner, src Sources) *manager`. Task 5's `cpSourcesFor` returns `controlplane.Sources`; Task 6 calls `controlplane.New(cpSourcesFor(mode))`.

- [ ] **Step 1: Write the failing tests**

In `pkg/controlplane/service_test.go`, add `AllSources()` as the third argument to every existing `newManager(...)` call, then append:

```go
func TestListInitOnlyExcludesCompose(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{
		"info":                []byte("ok"),
		"inspect dapr_scheduler": []byte("[]"),
		"inspect dapr_placement": []byte("[]"),
	}}
	m := newManager(RuntimeDocker, f, Sources{Init: true})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	for _, s := range res.Services {
		if s.ComposeProject != "" {
			t.Fatalf("init-only sources must not list compose services, got %+v", s)
		}
	}
	if len(res.Services) != len(LiveServiceNames) {
		t.Fatalf("want the %d init services, got %d", len(LiveServiceNames), len(res.Services))
	}
}

func TestListComposeOnlyExcludesInit(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{
		"info":  []byte("ok"),
		"ps -aq": []byte(""), // no compose containers running
	}}
	m := newManager(RuntimeDocker, f, Sources{Compose: true})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(res.Services) != 0 {
		t.Fatalf("compose-only sources must not list the dapr_* init services, got %+v", res.Services)
	}
}

func TestListEmptySourcesIsHonestEmpty(t *testing.T) {
	f := &fakeRunner{outputs: map[string][]byte{"info": []byte("ok")}}
	m := newManager(RuntimeDocker, f, Sources{})
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.Available || !res.Reachable || len(res.Services) != 0 {
		t.Fatalf("want available+reachable with zero services, got %+v", res)
	}
}

func TestDoAndLogStreamRespectSources(t *testing.T) {
	m := newManager(RuntimeDocker, &fakeRunner{outputs: map[string][]byte{}}, Sources{Compose: true})
	if err := m.Do(context.Background(), "restart", "dapr_placement"); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("Do must reject a filtered-out init service, got %v", err)
	}
	if _, err := m.LogStream(context.Background(), "dapr_scheduler"); !errors.Is(err, ErrUnknownService) {
		t.Fatalf("LogStream must reject a filtered-out init service, got %v", err)
	}
}
```

(Adapt the `fakeRunner` output keys to the file's existing conventions — the fixtures at the top of the file show the exact key format; if inspect output must be valid JSON for `parseInspect`, reuse the file's existing inspect fixture instead of `[]`. Add `"errors"` to the test imports if missing.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/controlplane/ -v`
Expected: FAIL to compile — `undefined: Sources`, wrong arg count for `newManager`.

- [ ] **Step 3: Implement Sources**

In `pkg/controlplane/types.go`, add below `LiveServiceNames`:

```go
// Sources selects which control-plane families List reports and Do/LogStream
// accept. The zero value shows nothing — e.g. test-containers mode, which has
// no control-plane detection yet (deferred to a future iteration).
type Sources struct {
	Init    bool // fixed dapr_* containers created by `dapr init`
	Compose bool // compose-labeled placement/scheduler containers
}

// AllSources is the mode-unset default: every family.
func AllSources() Sources { return Sources{Init: true, Compose: true} }
```

In `pkg/controlplane/service.go`:

```go
type manager struct {
	runtime RuntimeKind
	run     containerruntime.Runner
	src     Sources

	mu           sync.Mutex
	composeNames map[string]bool // compose CP containers found by the last List
}

// New resolves the container runtime from the environment and PATH.
func New(src Sources) Manager {
	kind, run := containerruntime.Detect()
	return newManager(kind, run, src)
}

func newManager(kind RuntimeKind, run containerruntime.Runner, src Sources) *manager {
	return &manager{runtime: kind, run: run, src: src}
}
```

In `List`, gate the families (replacing lines 60-65's setup and the fixed-name loop's range):

```go
	var composeSvcs []Service
	if m.src.Compose {
		composeSvcs = m.composeControlPlane(ctx)
	}
	var liveNames []string
	if m.src.Init {
		liveNames = LiveServiceNames
	}
	statNames := append(append([]string{}, liveNames...), serviceNames(composeSvcs)...)
	mem := m.memory(ctx, statNames)
	services := make([]Service, 0, len(liveNames)+len(composeSvcs))
	present := false
	for _, name := range liveNames {
```

Add an allowlist helper and use it in `Do` (line 166) and `LogStream` (line 177):

```go
// allowed reports whether name belongs to a family this manager serves.
func (m *manager) allowed(name string) bool {
	return (m.src.Init && IsLiveName(name)) || (m.src.Compose && m.isComposeName(name))
}
```

replacing both `if !IsLiveName(name) && !m.isComposeName(name) {` with `if !m.allowed(name) {`.

In `cmd/serve.go` line 150, fix the call: `ControlPlane: controlplane.New(controlplane.AllSources()),` (Task 6 threads the real mode).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/controlplane/ ./cmd/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add pkg/controlplane/types.go pkg/controlplane/service.go pkg/controlplane/service_test.go cmd/serve.go
git commit -m "feat(controlplane): filter listed/actionable families by Sources"
```

---

### Task 5: Mode → source-selection helpers

**Files:**
- Create: `cmd/sources.go`
- Test: `cmd/sources_test.go`

**Interfaces:**
- Consumes: `Mode` constants (Task 1), `controlplane.Sources`/`AllSources` (Task 4).
- Produces: `sourceSet{Standalone, Compose, Testcontainers, AspireContract, AspireFilter, NeedsRuntime bool}`, `sourcesFor(mode Mode, contractPresent bool) sourceSet`, `cpSourcesFor(mode Mode) controlplane.Sources`. Task 6 wires `runServe` from both.

- [ ] **Step 1: Write the failing tests**

Create `cmd/sources_test.go`:

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/controlplane"
)

func TestSourcesFor(t *testing.T) {
	tests := []struct {
		name     string
		mode     Mode
		contract bool
		want     sourceSet
	}{
		{name: "default scans everything", mode: ModeDefault,
			want: sourceSet{Standalone: true, Compose: true, Testcontainers: true}},
		{name: "default joins the env contract when present", mode: ModeDefault, contract: true,
			want: sourceSet{Standalone: true, Compose: true, Testcontainers: true, AspireContract: true}},
		{name: "dapr-run is standalone only", mode: ModeDaprRun,
			want: sourceSet{Standalone: true}},
		{name: "compose is compose only and needs a runtime", mode: ModeCompose,
			want: sourceSet{Compose: true, NeedsRuntime: true}},
		{name: "test-containers is tc only and needs a runtime", mode: ModeTestcontainers,
			want: sourceSet{Testcontainers: true, NeedsRuntime: true}},
		{name: "aspire host filters the standalone scan", mode: ModeAspire,
			want: sourceSet{Standalone: true, AspireFilter: true}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := sourcesFor(tc.mode, tc.contract); got != tc.want {
				t.Fatalf("sourcesFor(%q,%v)=%+v want %+v", tc.mode, tc.contract, got, tc.want)
			}
		})
	}
}

func TestCPSourcesFor(t *testing.T) {
	tests := []struct {
		mode Mode
		want controlplane.Sources
	}{
		{ModeDefault, controlplane.AllSources()},
		{ModeDaprRun, controlplane.Sources{Init: true}},
		{ModeAspire, controlplane.Sources{Init: true}},
		{ModeCompose, controlplane.Sources{Compose: true}},
		{ModeTestcontainers, controlplane.Sources{}},
	}
	for _, tc := range tests {
		if got := cpSourcesFor(tc.mode); got != tc.want {
			t.Fatalf("cpSourcesFor(%q)=%+v want %+v", tc.mode, got, tc.want)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./cmd/ -run 'TestSourcesFor|TestCPSourcesFor' -v`
Expected: FAIL to compile — `undefined: sourceSet`, `sourcesFor`, `cpSourcesFor`.

- [ ] **Step 3: Implement the helpers**

Create `cmd/sources.go`:

```go
package cmd

import "github.com/diagridio/dev-dashboard/pkg/controlplane"

// sourceSet describes which discovery sources a host-posture mode enables.
// Filter modes set exactly one source; ModeDefault sets everything.
type sourceSet struct {
	Standalone     bool // host `dapr run` process scan
	Compose        bool // Docker Compose container discovery
	Testcontainers bool // Testcontainers container discovery
	AspireContract bool // env-contract scanner joins the merge (mode unset only)
	AspireFilter   bool // post-enrichment IsAspire filter (aspire host mode)
	NeedsRuntime   bool // startup fails when no container runtime is found
}

// sourcesFor maps a host-posture mode to its discovery sources. Container
// posture (aspire + env contract) never reaches this function — runServe
// branches to the env-contract scanner before consulting it.
func sourcesFor(mode Mode, contractPresent bool) sourceSet {
	switch mode {
	case ModeDaprRun:
		return sourceSet{Standalone: true}
	case ModeCompose:
		return sourceSet{Compose: true, NeedsRuntime: true}
	case ModeTestcontainers:
		return sourceSet{Testcontainers: true, NeedsRuntime: true}
	case ModeAspire:
		return sourceSet{Standalone: true, AspireFilter: true}
	default:
		return sourceSet{Standalone: true, Compose: true, Testcontainers: true, AspireContract: contractPresent}
	}
}

// cpSourcesFor maps a mode to the control-plane families the dashboard shows
// and manages. dapr-run and aspire sidecars use the `dapr init` containers;
// test-containers has no control-plane detection yet (deferred), so it gets
// the zero value — an honest empty list.
func cpSourcesFor(mode Mode) controlplane.Sources {
	switch mode {
	case ModeDaprRun, ModeAspire:
		return controlplane.Sources{Init: true}
	case ModeCompose:
		return controlplane.Sources{Compose: true}
	case ModeTestcontainers:
		return controlplane.Sources{}
	default:
		return controlplane.AllSources()
	}
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./cmd/...`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add cmd/sources.go cmd/sources_test.go
git commit -m "feat(mode): source-selection helpers for discovery and control plane"
```

---

### Task 6: Wire runServe — filtered scanners, fail-fast, capabilities mode

**Files:**
- Modify: `cmd/root.go:66-68` (flag help), `cmd/root.go:137-191` (runServe branch + deps)
- Modify: `cmd/serve.go` (serveDeps gains `ControlPlane`; assembleOptions uses it)
- Modify: `pkg/server/server.go:62-72` (Capabilities gains `Mode`), `pkg/server/spa.go:64` (comment)
- Test: `cmd/sources_test.go` (compile-level), existing suites

**Interfaces:**
- Consumes: `sourcesFor`/`cpSourcesFor` (Task 5), `discovery.FilterAspire` (Task 3), `controlplane.New(Sources)` (Task 4), `containerPosture` bool param on `runServe` (Task 2).
- Produces: `server.Capabilities.Mode string` (json `mode`) — Task 7's frontend reads it from `window.__DASH_CAPABILITIES__`.

- [ ] **Step 1: Add Mode to server.Capabilities**

In `pkg/server/server.go`, extend the struct (keep FullCapabilities as-is — `Mode` zero value `""` is the complete scan):

```go
type Capabilities struct {
	Lifecycle    bool `json:"lifecycle"`
	ControlPlane bool `json:"controlPlane"`
	Logs         bool `json:"logs"`
	Workflows    bool `json:"workflows"`
	// Mode echoes the CLI --mode value ("" = complete scan) so the SPA can
	// adapt static fallbacks (e.g. the Logs page's dapr_* targets) to the
	// server's discovery filter.
	Mode string `json:"mode"`
}
```

In `pkg/server/spa.go`, update the stale comment above `json.Marshal(caps)` from "caps is a bool-only struct, so marshaling cannot fail" to "caps holds only bools and a plain string, so marshaling cannot fail".

- [ ] **Step 2: Thread the control-plane manager through serveDeps**

In `cmd/serve.go`, add to `serveDeps` (after `Lifecycle`):

```go
	// ControlPlane lists/controls the placement+scheduler services, already
	// filtered to the mode's families (cpSourcesFor).
	ControlPlane controlplane.Manager
```

and in `assembleOptions` replace `ControlPlane: controlplane.New(controlplane.AllSources()),` with `ControlPlane: deps.ControlPlane,`.

- [ ] **Step 3: Rebuild the runServe host branch**

In `cmd/root.go`, replace the mode switch (Task 2 left it as `switch { case containerPosture: ... default: ... }`) so the default branch becomes:

```go
	default:
		src := sourcesFor(mode, discovery.AspireContractPresent(os.Getenv))
		_, crtRunner := containerruntime.Detect()
		if src.NeedsRuntime && crtRunner == nil {
			return fmt.Errorf("--mode %s requires a container runtime: install docker or podman (or set DASH_CONTAINER_RUNTIME)", mode)
		}
		var scanners []discovery.Scanner
		if src.Standalone {
			scanners = append(scanners, discovery.StandaloneScanner())
		}
		if src.Compose {
			composeSrc := discovery.NewComposeSource(crtRunner)
			scanners = append(scanners, composeSrc.Scanner())
			composeEnv = composeSrc.Env
		}
		if src.Testcontainers {
			tcSrc := discovery.NewTestcontainersSource(crtRunner)
			scanners = append(scanners, tcSrc.Scanner())
			extraRes = tcExtraResources(tcSrc)
		}
		if src.AspireContract {
			as, err := discovery.NewAspireScanner(os.Getenv)
			if err != nil {
				return err
			}
			appNS = contractNamespaces(as)
			scanners = append(scanners, as)
		}
		lifeReg := lifecycle.NewRegistry()
		lifeProc := lifecycle.NewProcController()
		appsSvc = lifecycle.Overlay(
			discovery.New(discovery.Merge(scanners...), client), lifeReg, lifeProc)
		if src.AspireFilter {
			appsSvc = discovery.FilterAspire(appsSvc)
		}
		lifeMgr = lifecycle.New(appsSvc, lifeReg, crtRunner, lifeProc, lifecycle.NewStarter())
		if src.Compose || src.Testcontainers {
			containerLogs = containerLogStream(crtRunner)
		}
		updateCheck = updatecheck.New(&http.Client{Timeout: 5 * time.Second}, "https://api.github.com", "diagridio/dev-dashboard", version.Get().Version, time.Hour)
```

Set capabilities in both branches so `Mode` always reaches the SPA. In the `containerPosture` branch, extend the existing line:

```go
		caps = &server.Capabilities{Workflows: settings.StateStore != "", Mode: string(ModeAspire)}
```

At the end of the default branch:

```go
		c := server.FullCapabilities()
		c.Mode = string(mode)
		caps = &c
```

Add `ControlPlane` to the `assembleOptions` deps literal (near `Lifecycle`):

```go
		ControlPlane:     controlplane.New(cpSourcesFor(mode)),
```

and add `"github.com/diagridio/dev-dashboard/pkg/controlplane"` to `cmd/root.go` imports.

- [ ] **Step 4: Update the --mode flag help**

`cmd/root.go` line 68:

```go
	c.Flags().StringVar(&modeFlag, "mode", "", `discovery filter: "dapr-run", "compose", "test-containers", or "aspire" show only that source's resources ("aspire" also switches to container posture when the DEVDASHBOARD_APP_* contract is present); unset scans every source`)
```

- [ ] **Step 5: Build and run the full Go suite**

Run: `go build ./... && go test -tags unit -race ./...`
Expected: PASS. If `pkg/server` tests construct `Capabilities` literals positionally they will fail to compile — convert those literals to keyed fields.

- [ ] **Step 6: Smoke-check the fail-fast and mode flows**

Run: `go run . --mode bogus 2>&1 | head -2`
Expected: `unknown mode "bogus": supported values are "dapr-run", "compose", "test-containers", "aspire" (or unset for the complete scan)`

Run: `PATH=/usr/bin:/bin go run . --mode compose --no-open 2>&1 | head -2` (a PATH without docker/podman)
Expected: `--mode compose requires a container runtime: install docker or podman (or set DASH_CONTAINER_RUNTIME)`

Run: `go run . --mode dapr-run --no-open &` then `curl -s localhost:9090/api/controlplane | head -c 300`; kill the server.
Expected: JSON listing only `dapr_scheduler`/`dapr_placement` services (no `composeProject` entries).

- [ ] **Step 7: Commit**

```bash
git add cmd/root.go cmd/serve.go pkg/server/server.go pkg/server/spa.go
git commit -m "feat(mode): wire exclusive discovery filters through runServe"
```

---

### Task 7: Frontend — capabilities.mode gates the Logs static CP fallback

**Files:**
- Modify: `web/src/lib/capabilities.ts`
- Modify: `web/src/pages/Logs.tsx:17-19,370-378`
- Test: `web/src/pages/Logs.test.tsx`

**Interfaces:**
- Consumes: `window.__DASH_CAPABILITIES__.mode` (Task 6).
- Produces: `Capabilities.mode?: string`; `staticCpForMode(mode: string): readonly string[]` (module-local to Logs.tsx).

- [ ] **Step 1: Write the failing test**

`web/src/pages/Logs.test.tsx` renders through its `renderAt(initialEntry)` helper (line 113) and stubs `/api/controlplane` with msw in `beforeEach`. Add a test that sets the injected capabilities before rendering and restores them after; override the CP endpoint to return no services so only the static fallback could produce `dapr_*` entries:

```tsx
it('omits the static dapr_* control-plane targets in compose mode', async () => {
  window.__DASH_CAPABILITIES__ = { lifecycle: true, controlPlane: true, logs: true, workflows: true, mode: 'compose' }
  server.use(http.get('/api/controlplane', () => HttpResponse.json({ ...CP_LIST_BASE, services: [] })))
  try {
    renderAt('/logs')
    await screen.findByText('Logs') // page settled
    expect(screen.queryByText('dapr_scheduler')).not.toBeInTheDocument()
    expect(screen.queryByText('dapr_placement')).not.toBeInTheDocument()
  } finally {
    delete window.__DASH_CAPABILITIES__
  }
})
```

(Adapt the settle-assertion and how the CP selector's options are queried to whatever the file's existing CP-selector tests do — mirror them exactly.) Also add the inverse assertion for the default mode (no `__DASH_CAPABILITIES__` set → `dapr_scheduler` offered), again mirroring the existing CP-selector assertions.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `cd web && npm test -- src/pages/Logs.test.tsx`
Expected: FAIL — dapr_scheduler is still offered in compose mode.

- [ ] **Step 3: Implement**

`web/src/lib/capabilities.ts`:

```ts
export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
  /** CLI --mode value ('' = complete scan); lets the UI adapt static fallbacks. */
  mode?: string
}

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: Capabilities
  }
}

const FULL: Capabilities = { lifecycle: true, controlPlane: true, logs: true, workflows: true, mode: '' }
```

(`getCapabilities` unchanged.)

`web/src/pages/Logs.tsx` — import `getCapabilities` from `../lib/capabilities`, then replace the static-list block (lines 17-19):

```ts
// Static fallback so the selector renders before /api/controlplane answers;
// compose-managed placement/scheduler containers are merged in from the API.
// Only modes whose sidecars use the `dapr init` containers get the fallback —
// compose / test-containers modes must not offer dapr_* targets.
const CP_SERVICES = ['dapr_scheduler', 'dapr_placement'] as const
const NO_CP_SERVICES: readonly string[] = []
const staticCpForMode = (mode: string): readonly string[] =>
  mode === '' || mode === 'dapr-run' || mode === 'aspire' ? CP_SERVICES : NO_CP_SERVICES
```

and in the component, replace the `cpNames` memo (lines 375-378):

```ts
  const staticCp = staticCpForMode(getCapabilities().mode ?? '')
  const cpNames = useMemo(() => {
    const fetched = (cpList?.services ?? []).filter(s => s.actionable).map(s => s.name)
    return [...new Set<string>([...staticCp, ...fetched])]
  }, [cpList, staticCp])
```

- [ ] **Step 4: Run web tests and the typecheck**

Run: `cd web && npm test` then `make build` (vitest does not typecheck).
Expected: PASS both.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/capabilities.ts web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx
git commit -m "feat(web): mode-aware control-plane targets on the Logs page"
```

---

### Task 8: Frontend — "Run template" → "Mode" relabel

**Files:**
- Create: `web/src/lib/modeLabel.ts`
- Create: `web/src/lib/modeLabel.test.ts`
- Modify: `web/src/pages/Applications.tsx:96,113-124,168-170`
- Modify: `web/src/pages/AppDetail.tsx:257-258` (add row), imports
- Test: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `AppSummary.source` / `AppSummary.isAspire` (`web/src/types/api.ts`).
- Produces: `modeLabel(app: Pick<AppSummary, 'source' | 'isAspire'>): string` returning exactly `'Aspire' | 'Compose' | 'TestContainers' | 'Dapr run' | '—'`.

- [ ] **Step 1: Write the failing helper test**

Create `web/src/lib/modeLabel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { modeLabel } from './modeLabel'

describe('modeLabel', () => {
  it('maps sources to pretty mode names', () => {
    expect(modeLabel({ source: 'standalone' })).toBe('Dapr run')
    expect(modeLabel({ source: 'compose' })).toBe('Compose')
    expect(modeLabel({ source: 'testcontainers' })).toBe('TestContainers')
    expect(modeLabel({ source: 'aspire' })).toBe('Aspire')
  })
  it('prefers the Aspire flag over the standalone source', () => {
    expect(modeLabel({ source: 'standalone', isAspire: true })).toBe('Aspire')
  })
  it('falls back to a dash for unknown sources', () => {
    expect(modeLabel({ source: undefined })).toBe('—')
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm test -- src/lib/modeLabel.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

Create `web/src/lib/modeLabel.ts`:

```ts
import type { AppSummary } from '../types/api'

/**
 * Pretty discovery-mode label for an instance. Maps the wire `source` values
 * to the CLI mode names (standalone → "Dapr run", testcontainers →
 * "TestContainers"); host-mode Aspire apps arrive with source 'standalone'
 * and isAspire set, so the flag wins.
 */
export function modeLabel(app: Pick<AppSummary, 'source' | 'isAspire'>): string {
  if (app.isAspire || app.source === 'aspire') return 'Aspire'
  switch (app.source) {
    case 'compose':
      return 'Compose'
    case 'testcontainers':
      return 'TestContainers'
    case 'standalone':
      return 'Dapr run'
    default:
      return '—'
  }
}
```

(If `AppSummary.source`/`isAspire` are not optional in `web/src/types/api.ts`, adjust the `Pick` accordingly — do not change the API type.)

- [ ] **Step 4: Relabel the Applications column**

In `web/src/pages/Applications.tsx`: import `{ modeLabel }` from `'../lib/modeLabel'`; change line 96 `<th>Run template</th>` → `<th>Mode</th>`; delete the `sourceLabel` ternary (lines 116-124); replace the cell (lines 168-170):

```tsx
      <td
        className="mono muted"
        title={
          app.runTemplate
            ? `run template: ${app.runTemplate}`
            : app.composeProject
              ? `compose project: ${app.composeProject}`
              : undefined
        }
      >
        {modeLabel(app)}
      </td>
```

- [ ] **Step 5: Add the Mode row on AppDetail**

In `web/src/pages/AppDetail.tsx`, import `{ modeLabel }` from `'../lib/modeLabel'` and insert after the Runtime row (lines 257-258):

```tsx
            <div className="kk">Mode</div>
            <div className="vv">{modeLabel(app)}</div>
```

- [ ] **Step 6: Update Applications tests and run everything**

In `web/src/pages/Applications.test.tsx`, update any assertion on the `Run template` header to `Mode`, and any assertion expecting a run-template name or `Testcontainers` in that column to the new labels (`Dapr run`, `TestContainers`, …).

Run: `cd web && npm test` then `make build`.
Expected: PASS both.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/modeLabel.ts web/src/lib/modeLabel.test.ts web/src/pages/Applications.tsx web/src/pages/AppDetail.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): relabel Run template column to Mode with pretty source names"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `README.md:104,166-171` (and the aspire-mode sections that say `dapr`/`compose` are reserved)
- Modify: `docs/aspire-discovery.md` (host-mode note)

**Interfaces:** none — docs only.

- [ ] **Step 1: Update README**

Line 104's table row becomes:

```markdown
| `--mode` flag / `DEVDASHBOARD_MODE` env | `dapr-run`, `compose`, `test-containers`, `aspire` | unset (complete scan) |
```

Replace the mode paragraph at lines 166-171 with:

```markdown
With `--mode`/`DEVDASHBOARD_MODE` unset (the default for host use), the dashboard performs the
complete scan across all discovery sources described above. Setting a mode restricts every
dashboard surface — applications, workflows, state stores, the Control Plane view, and log
targets — to a single source; filters are exclusive and never combined:

- `--mode dapr-run` — host `dapr run` processes only (Control Plane shows the `dapr init` containers).
- `--mode compose` — Docker Compose containers only (Control Plane shows compose-run placement/scheduler).
- `--mode test-containers` — Testcontainers discovery only (no control-plane detection yet).
- `--mode aspire` — Aspire resources only. Inside an AppHost-managed container (the
  `DEVDASHBOARD_APP_*` contract is present) this is the container serving posture described
  below; on a plain host it filters the process scan to Aspire-managed apps.

`compose` and `test-containers` require a container runtime (docker or podman) and fail at
startup without one. `--bind` (default `127.0.0.1`, `0.0.0.0` in aspire container posture)
controls the listen address alongside `--port`.
```

Search the README for other "reserved for future" mode phrasing (`grep -n "reserved" README.md`) and align it.

- [ ] **Step 2: Note the host posture in docs/aspire-discovery.md**

Add a short section stating: `--mode aspire` without the `DEVDASHBOARD_APP_*` contract runs the dashboard on the host with normal host defaults and filters the standalone process scan to instances flagged `IsAspire` (DCP-proxy heuristic); the env-contract container flow is unchanged; heuristic limitations (apps without an app port are missed; stopped apps drop out) are listed in `docs/superpowers/specs/2026-07-13-mode-filter-design.md`.

- [ ] **Step 3: Full verification**

Run: `make build && make test`
Expected: build succeeds, Go + web suites PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/aspire-discovery.md
git commit -m "docs: document exclusive --mode discovery filters"
```
