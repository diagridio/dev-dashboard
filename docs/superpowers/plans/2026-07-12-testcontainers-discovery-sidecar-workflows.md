# Testcontainers Discovery + Sidecar-gRPC Workflow Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover Dapr Testcontainers apps (e.g. `mvn spring-boot:test-run` with `dapr-spring-boot-starter-test`) and make the Workflows pages work for any app whose state store the dashboard cannot open — including `state.in-memory` — by reading workflow data from the sidecar's gRPC API.

**Architecture:** Part 1 adds a `TestcontainersSource` scanner (modeled on `ComposeSource`) that finds `org.testcontainers=true`-labeled daprd containers and pairs the host app process via the app port. Part 2 adds a `SidecarService` (durabletask-go `workflow.Client` over daprd's gRPC port) and a `composite` workflow service that routes per app: testcontainers apps always via sidecar, everything else via the store when openable, via sidecar otherwise.

**Tech Stack:** Go (chi server, gopsutil, cobra), `github.com/dapr/durabletask-go v0.12.1` (already a direct dependency), React/TypeScript (vitest), docker CLI via `containerruntime.Runner`.

**Spec:** `docs/superpowers/specs/2026-07-12-testcontainers-discovery-sidecar-workflows-design.md`

## Global Constraints

- Run all commands from the repo root (`.claude/worktrees/testcontainers-discovery`).
- Vitest does NOT typecheck: any `.ts`/`.tsx` change (test files included) requires `cd web && npx tsc -b`.
- Go tests: `go test ./...`. Web tests: `cd web && npx vitest run`.
- Lifecycle controls stay disabled for testcontainers apps (ryuk owns the containers; Maven owns the JVM).
- Aspire mode is untouched: its env contract has no gRPC endpoint, so its `Capabilities.Workflows = StateStore != ""` gate stays.
- The daprd gRPC dial is always plaintext loopback (`127.0.0.1:<published port>`).
- Commit messages end with: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`

## Verified environment facts (from the live quickstart run)

- Testcontainers daprd container labels: `org.testcontainers=true`, `org.testcontainers.sessionId=<uuid>` (no compose labels). Placement/scheduler/ryuk/sshd containers share the session labels but do not run daprd.
- daprd argv (entrypoint+cmd): `./daprd --app-id workflow-patterns-app --dapr-listen-addresses=0.0.0.0 --placement-host-address placement:50005 --scheduler-host-address scheduler:51005 --app-channel-address host.testcontainers.internal --app-port 8080 --app-protocol http --enable-app-health-check --app-health-check-path /actuator/health --app-health-probe-interval 5 --app-health-probe-timeout 500 --app-health-threshold 3 --log-level INFO --resources-path /dapr-resources` — `parseDaprdArgs` parses this verbatim (verified).
- Ports 3500/50001 publish to random host ports (e.g. 58444/58445), new every run.
- daprd 1.18 answers `ListInstanceIDs`, `GetInstance` (= `FetchWorkflowMetadata`), and `GetInstanceHistory` on the published gRPC port, backed purely by `state.in-memory` (verified live). Pre-1.17 returns `codes.Unimplemented`.
- `protos.WorkflowMetadata` carries `ParentInstanceId string` — the children filter works from metadata alone, no history fetch needed for lists.

---

### Task 1: Generalize docker-inspect parsing (Labels field + unfiltered parse)

**Files:**
- Modify: `pkg/discovery/compose_inspect.go`
- Test: `pkg/discovery/compose_inspect_test.go` (add cases)

**Interfaces:**
- Consumes: existing `rawComposeContainer`, `composeContainer`, `parseComposeContainers`.
- Produces: `composeContainer.Labels map[string]string`; `parseInspectContainers(data []byte) ([]composeContainer, error)` — decodes ALL containers (no label filter), `Project`/`Service` populated from compose labels when present (else ""). `parseComposeContainers` keeps its exact current behavior (only compose-labeled containers).

- [ ] **Step 1: Write the failing test**

Add to `pkg/discovery/compose_inspect_test.go`:

```go
func TestParseInspectContainers_KeepsUnlabeledAndExposesLabels(t *testing.T) {
	data := []byte(`[
  {
    "Id": "tc1",
    "Name": "/crazy_lamport",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.sessionId": "efeba7ba"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "--app-id", "workflow-patterns-app"]
    },
    "NetworkSettings": { "Ports": { "3500/tcp": [ { "HostPort": "58444" } ] } },
    "Mounts": []
  },
  {
    "Id": "c1",
    "Name": "/checkout-dapr-1",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.15.0",
      "Labels": { "com.docker.compose.project": "checkout", "com.docker.compose.service": "checkout" },
      "Entrypoint": null,
      "Cmd": ["./daprd"]
    },
    "NetworkSettings": { "Ports": {} },
    "Mounts": []
  }
]`)
	all, err := parseInspectContainers(data)
	require.NoError(t, err)
	require.Len(t, all, 2)
	require.Equal(t, "true", all[0].Labels["org.testcontainers"])
	require.Equal(t, "efeba7ba", all[0].Labels["org.testcontainers.sessionId"])
	require.Empty(t, all[0].Project)
	require.Equal(t, "checkout", all[1].Project)

	// parseComposeContainers keeps filtering to compose-labeled containers only.
	compose, err := parseComposeContainers(data)
	require.NoError(t, err)
	require.Len(t, compose, 1)
	require.Equal(t, "checkout", compose[0].Project)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestParseInspectContainers_KeepsUnlabeledAndExposesLabels -v`
Expected: FAIL — `undefined: parseInspectContainers` (compile error).

- [ ] **Step 3: Implement**

In `pkg/discovery/compose_inspect.go`:

1. Add `Labels map[string]string` to `composeContainer` (after `Service string`), with comment `// Labels is the full container label map (compose, testcontainers, …).`
2. Rename the body of `parseComposeContainers` into a new function and re-implement `parseComposeContainers` as a filter over it:

```go
// parseInspectContainers decodes a batched inspect array, keeping every
// container. Project/Service are populated from compose labels when present.
func parseInspectContainers(data []byte) ([]composeContainer, error) {
	var raw []rawComposeContainer
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	out := make([]composeContainer, 0, len(raw))
	for _, r := range raw {
		c := composeContainer{
			ID:      r.ID,
			Name:    strings.TrimPrefix(r.Name, "/"),
			Image:   r.Config.Image,
			Project: r.Config.Labels[labelComposeProject],
			Service: r.Config.Labels[labelComposeService],
			Labels:  r.Config.Labels,
			Running: r.State.Status == "running",
			Argv:    append(append([]string{}, r.Config.Entrypoint...), r.Config.Cmd...),
			Ports:   map[int]int{},
			Mounts:  map[string]string{},

			Env:         r.Config.Env,
			ConfigFiles: r.Config.Labels[labelComposeConfigFiles],
			WorkingDir:  r.Config.Labels[labelComposeWorkingDir],
		}
		c.StartedAt, _ = time.Parse(time.RFC3339Nano, r.State.StartedAt)
		for spec, bindings := range r.NetworkSettings.Ports {
			proto := strings.SplitN(spec, "/", 2)
			if len(proto) != 2 || proto[1] != "tcp" || len(bindings) == 0 {
				continue
			}
			cp, err1 := strconv.Atoi(proto[0])
			hp, err2 := strconv.Atoi(bindings[0].HostPort)
			if err1 != nil || err2 != nil {
				continue
			}
			c.Ports[cp] = hp
		}
		for _, m := range r.Mounts {
			if m.Type == "bind" {
				c.Mounts[m.Destination] = m.Source
			}
		}
		out = append(out, c)
	}
	return out, nil
}

// parseComposeContainers decodes a batched inspect array, keeping only
// compose-labelled containers.
func parseComposeContainers(data []byte) ([]composeContainer, error) {
	all, err := parseInspectContainers(data)
	if err != nil {
		return nil, err
	}
	out := make([]composeContainer, 0, len(all))
	for _, c := range all {
		if c.Project == "" {
			continue
		}
		out = append(out, c)
	}
	return out, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -v -run 'TestParse'`
Expected: PASS (new test and all pre-existing parse tests).

- [ ] **Step 5: Run the full package + commit**

Run: `go test ./pkg/discovery/`
Expected: PASS.

```bash
git add pkg/discovery/compose_inspect.go pkg/discovery/compose_inspect_test.go
git commit -m "refactor(discovery): split label-agnostic inspect parsing from compose filter

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: `SourceTestcontainers` constant, session field, and `Key()` routing

**Files:**
- Modify: `pkg/discovery/service.go` (constant block at lines 16-22, `ScanResult` struct, `Key()` at lines 78-88)
- Modify: `pkg/discovery/types.go` (`Instance` struct)
- Test: `pkg/discovery/service_test.go` (add `Key()` cases)

**Interfaces:**
- Produces: `discovery.SourceTestcontainers = "testcontainers"`; `ScanResult.TestcontainersSession string`; `Instance.TestcontainersSession string` (JSON `testcontainersSession,omitempty`); `Key()` returns `DaprdContainerName` (fallback `AppID`) for testcontainers results.

- [ ] **Step 1: Write the failing test**

Add to `pkg/discovery/service_test.go`:

```go
func TestScanResultKey_Testcontainers(t *testing.T) {
	r := ScanResult{AppID: "workflow-patterns-app", Source: SourceTestcontainers, DaprdContainerName: "crazy_lamport"}
	if got := r.Key(); got != "crazy_lamport" {
		t.Fatalf("expected container-name key, got %q", got)
	}
	r.DaprdContainerName = ""
	if got := r.Key(); got != "workflow-patterns-app" {
		t.Fatalf("expected app-id fallback, got %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestScanResultKey_Testcontainers -v`
Expected: FAIL — `undefined: SourceTestcontainers`.

- [ ] **Step 3: Implement**

In `pkg/discovery/service.go`:

1. Extend the constant block:

```go
const (
	SourceStandalone = "standalone"
	SourceCompose    = "compose"
	// SourceAspire marks apps injected via the DEVDASHBOARD_APP_* env
	// contract (aspire mode, or mode-unset with the contract present).
	SourceAspire = "aspire"
	// SourceTestcontainers marks daprd sidecars run by Testcontainers
	// (org.testcontainers=true label), e.g. dapr-spring-boot-starter-test.
	SourceTestcontainers = "testcontainers"
)
```

2. Add to `ScanResult` (after the `Label` field):

```go
	// TestcontainersSession groups one Testcontainers run's containers
	// (org.testcontainers.sessionId label; "" for other sources).
	TestcontainersSession string
```

3. Extend `Key()` — container names are unique per host, and concurrent test
   sessions can reuse one app-id:

```go
func (r ScanResult) Key() string {
	if r.Source == SourceCompose {
		if r.AppContainerName != "" {
			return r.AppContainerName
		}
		if r.DaprdContainerName != "" {
			return r.DaprdContainerName
		}
	}
	if r.Source == SourceTestcontainers && r.DaprdContainerName != "" {
		return r.DaprdContainerName
	}
	return r.AppID
}
```

In `pkg/discovery/types.go`, add to `Instance` after `Label`:

```go
	// TestcontainersSession groups one Testcontainers run's containers
	// (org.testcontainers.sessionId label; "" for other sources).
	TestcontainersSession string `json:"testcontainersSession,omitempty"`
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/types.go pkg/discovery/service_test.go
git commit -m "feat(discovery): SourceTestcontainers constant, session field, container-name keying

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 3: Testcontainers scanner

**Files:**
- Create: `pkg/discovery/scan_testcontainers.go`
- Test: `pkg/discovery/scan_testcontainers_test.go`

**Interfaces:**
- Consumes: `parseInspectContainers` (Task 1), `parseDaprdArgs`, `composeStatus`, `SourceTestcontainers`/`TestcontainersSession` (Task 2), `containerruntime.Runner` (`Run(ctx, args ...string) ([]byte, error)`), `fakeCRT` test fake (already in `pkg/discovery/scan_compose_test.go`, same package).
- Produces: `NewTestcontainersSource(run containerruntime.Runner) *TestcontainersSource` with `Scanner() Scanner`. Emits `ScanResult` with `Source: SourceTestcontainers`, published `HTTPPort`/`GRPCPort`, `AppPort`, `DaprdContainerID/Name`, `DaprdStatus`, `DaprdStartedAt`, `TestcontainersSession`, `SidecarReachable = HTTPPort != 0`.

- [ ] **Step 1: Write the failing test**

Create `pkg/discovery/scan_testcontainers_test.go`. The inspect JSON is trimmed verbatim from the live capture (daprd + scheduler in one session):

```go
package discovery

import (
	"testing"

	"github.com/stretchr/testify/require"
)

// testcontainersInspectJSON is trimmed from a live `docker inspect` of a
// dapr-spring-boot-starter-test session (daprd 1.18 + scheduler; the scheduler
// exercises the "session container without daprd argv" exclusion path).
const testcontainersInspectJSON = `[
  {
    "Id": "28af628017d1",
    "Name": "/crazy_lamport",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:28:40.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.lang": "java",
        "org.testcontainers.sessionId": "efeba7ba-5fdd-4713-ae0c-38f4a462cf46"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "--app-id", "workflow-patterns-app", "--dapr-listen-addresses=0.0.0.0", "--placement-host-address", "placement:50005", "--scheduler-host-address", "scheduler:51005", "--app-channel-address", "host.testcontainers.internal", "--app-port", "8080", "--app-protocol", "http", "--log-level", "INFO", "--resources-path", "/dapr-resources"]
    },
    "NetworkSettings": {
      "Ports": {
        "3500/tcp": [ { "HostPort": "58444" } ],
        "50001/tcp": [ { "HostPort": "58445" } ]
      }
    },
    "Mounts": []
  },
  {
    "Id": "636f969c5645",
    "Name": "/jolly_franklin",
    "State": { "Status": "running", "StartedAt": "2026-07-12T14:28:35.000000000Z" },
    "Config": {
      "Image": "daprio/scheduler:1.18.0",
      "Labels": {
        "org.testcontainers": "true",
        "org.testcontainers.sessionId": "efeba7ba-5fdd-4713-ae0c-38f4a462cf46"
      },
      "Entrypoint": ["./scheduler"],
      "Cmd": ["--port", "51005", "--etcd-data-dir", "/var/lock/dapr/scheduler"]
    },
    "NetworkSettings": { "Ports": { "51005/tcp": [ { "HostPort": "58413" } ] } },
    "Mounts": []
  }
]`

func fakeTestcontainersRunner(t *testing.T) *fakeCRT {
	t.Helper()
	return &fakeCRT{responses: map[string][]byte{
		"ps -aq":              []byte("28af628017d1\n636f969c5645\n"),
		"inspect 28af628017d1": []byte(testcontainersInspectJSON),
	}}
}

func TestTestcontainersScanner_DiscoversDaprdAndExcludesHelpers(t *testing.T) {
	src := NewTestcontainersSource(fakeTestcontainersRunner(t))
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Len(t, results, 1)
	r := results[0]
	require.Equal(t, "workflow-patterns-app", r.AppID)
	require.Equal(t, SourceTestcontainers, r.Source)
	require.Equal(t, 58444, r.HTTPPort)
	require.Equal(t, 58445, r.GRPCPort)
	require.Equal(t, 8080, r.AppPort)
	require.Equal(t, "28af628017d1", r.DaprdContainerID)
	require.Equal(t, "crazy_lamport", r.DaprdContainerName)
	require.Equal(t, StatusRunning, r.DaprdStatus)
	require.Equal(t, "efeba7ba-5fdd-4713-ae0c-38f4a462cf46", r.TestcontainersSession)
	require.True(t, r.SidecarReachable)
	require.Equal(t, "crazy_lamport", r.Key())
}

func TestTestcontainersScanner_NilRunnerIsEmptyAndErrorFree(t *testing.T) {
	src := NewTestcontainersSource(nil)
	results, err := src.Scanner()()
	require.NoError(t, err)
	require.Empty(t, results)
}
```

Note: `fakeCRT.key` joins the first two args, so the batched `inspect 28af628017d1 636f969c5645` call keys as `"inspect 28af628017d1"` — the fixture map above matches that. If the existing `fakeCRT` behaves differently, adapt the map keys, not the fake.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/discovery/ -run TestTestcontainersScanner -v`
Expected: FAIL — `undefined: NewTestcontainersSource`.

- [ ] **Step 3: Implement**

Create `pkg/discovery/scan_testcontainers.go`:

```go
package discovery

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
)

const (
	// labelTestcontainers marks every container the Testcontainers library
	// starts (value "true"); labelTestcontainersSessionID groups one run.
	labelTestcontainers          = "org.testcontainers"
	labelTestcontainersSessionID = "org.testcontainers.sessionId"

	testcontainersScanTimeout = 3 * time.Second
	// testcontainersCacheTTL keeps 1s SPA polling from causing exec storms.
	testcontainersCacheTTL = 2 * time.Second
)

// TestcontainersSource discovers daprd sidecars run by Testcontainers (e.g.
// dapr-spring-boot-starter-test): containers labeled org.testcontainers=true
// whose argv invokes daprd. The paired app is a host process reached via
// host.testcontainers.internal; enrichment resolves it from the app port.
// A nil runner (no docker/podman) degrades to an empty, error-free scan.
type TestcontainersSource struct {
	run   containerruntime.Runner
	clock func() time.Time // injectable for cache tests

	mu      sync.Mutex
	last    time.Time
	results []ScanResult
	lastErr error
}

func NewTestcontainersSource(run containerruntime.Runner) *TestcontainersSource {
	return &TestcontainersSource{run: run, clock: time.Now}
}

// Scanner returns the testcontainers scan as a discovery.Scanner.
func (s *TestcontainersSource) Scanner() Scanner { return s.scan }

func (s *TestcontainersSource) scan() ([]ScanResult, error) {
	if s.run == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.last.IsZero() && s.clock().Sub(s.last) < testcontainersCacheTTL {
		return s.results, s.lastErr
	}
	results, err := s.scanOnce()
	s.last = s.clock()
	s.results, s.lastErr = results, err
	return results, err
}

func (s *TestcontainersSource) scanOnce() ([]ScanResult, error) {
	ctx, cancel := context.WithTimeout(context.Background(), testcontainersScanTimeout)
	defer cancel()

	out, err := s.run.Run(ctx, "ps", "-aq", "--filter", "label="+labelTestcontainers+"=true")
	if err != nil {
		return nil, fmt.Errorf("testcontainers ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, nil
	}
	raw, err := s.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, fmt.Errorf("testcontainers inspect: %w", err)
	}
	containers, err := parseInspectContainers(raw)
	if err != nil {
		return nil, fmt.Errorf("testcontainers inspect parse: %w", err)
	}

	var results []ScanResult
	for _, c := range containers {
		args, ok := parseDaprdArgs(c.Argv)
		if !ok || args.AppID == "" {
			continue // ryuk, sshd, placement, scheduler, app containers
		}
		r := ScanResult{
			AppID:                 args.AppID,
			HTTPPort:              c.Ports[args.HTTPPort],
			GRPCPort:              c.Ports[args.GRPCPort],
			AppPort:               args.AppPort,
			Created:               c.StartedAt,
			Command:               strings.Join(c.Argv, " "),
			Source:                SourceTestcontainers,
			TestcontainersSession: c.Labels[labelTestcontainersSessionID],
			DaprdContainerID:      c.ID,
			DaprdContainerName:    c.Name,
			DaprdStatus:           composeStatus(c.Running),
		}
		if c.Running {
			r.DaprdStartedAt = c.StartedAt
		}
		r.SidecarReachable = r.HTTPPort != 0
		results = append(results, r)
	}
	return results, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/scan_testcontainers.go pkg/discovery/scan_testcontainers_test.go
git commit -m "feat(discovery): testcontainers daprd scanner

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 4: Enrichment for testcontainers apps (host-app pairing + runtime inference)

**Files:**
- Modify: `pkg/discovery/service.go` (`enrich()`, lines ~182-319)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Consumes: `service` struct's injectable `portOpen func(port int) bool` and `appProc appProcResolver` (`CommandForPort(port int) (string, bool)`); `InferRuntime` (a java command infers "java").
- Produces: enriched testcontainers `Instance` with `AppStatus` from the app-port probe, `Runtime` from the app-port listener command, `TestcontainersSession` passed through, `RunTemplate` from metadata; standalone-only PID/orphan/log logic skipped.

- [ ] **Step 1: Write the failing test**

Add to `pkg/discovery/service_test.go` (in-package; the `service` struct fields are directly settable — mirror existing tests in this file for the metadata stub pattern; if the file already has an HTTP-stub helper for metadata, reuse it, otherwise keep `SidecarReachable: false` variants that skip probes and use a second reachable case against `httptest`):

```go
type fakeAppProc struct{ cmd string }

func (f fakeAppProc) CommandForPort(int) (string, bool) { return f.cmd, f.cmd != "" }

func TestEnrich_TestcontainersHostAppPairing(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "workflow-patterns-app", Source: SourceTestcontainers,
			AppPort: 8080, HTTPPort: 0, // HTTP port unpublished => probes skipped
			DaprdContainerName: "crazy_lamport", DaprdStatus: StatusRunning,
			TestcontainersSession: "efeba7ba",
			Command:               "./daprd --app-id workflow-patterns-app --app-port 8080",
		}}, nil
	}
	svc := &service{
		scan:     scan,
		appProc:  fakeAppProc{cmd: "/opt/homebrew/bin/java -cp app.jar io.dapr.Example"},
		portOpen: func(port int) bool { return port == 8080 },
	}
	out, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, out, 1)
	in := out[0]
	require.Equal(t, "java", in.Runtime)
	require.Equal(t, StatusRunning, in.AppStatus)
	require.Equal(t, "efeba7ba", in.TestcontainersSession)
	require.Equal(t, "crazy_lamport", in.InstanceKey)
	require.False(t, in.SidecarOrphaned)
}

func TestEnrich_TestcontainersStoppedApp(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "workflow-patterns-app", Source: SourceTestcontainers,
			AppPort: 8080, DaprdContainerName: "crazy_lamport",
		}}, nil
	}
	svc := &service{scan: scan, appProc: fakeAppProc{}, portOpen: func(int) bool { return false }}
	out, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Equal(t, StatusStopped, out[0].AppStatus)
}
```

If `service_test.go` already defines an equivalent `CommandForPort` fake, reuse it instead of adding `fakeAppProc`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/discovery/ -run TestEnrich_Testcontainers -v`
Expected: FAIL — `Runtime` is "unknown" and `AppStatus` is "" (no testcontainers branch yet).

- [ ] **Step 3: Implement**

In `pkg/discovery/service.go`, three edits to `enrich()`:

1. Pass the session through — in the `Instance` literal at the top of `enrich()` add after `DaprHTTPBaseURL: r.DaprHTTPBaseURL, Namespace: r.Namespace, Label: r.Label,`:

```go
		TestcontainersSession: r.TestcontainersSession,
```

2. Immediately after the existing `if in.Source == SourceCompose && in.Runtime == "unknown" { ... }` block (before the `if !in.SidecarReachable` check), add:

```go
	if in.Source == SourceTestcontainers {
		// The app is a host process reached via host.testcontainers.internal:
		// probe the app port for liveness and infer the runtime from its
		// listener's command (metadata carries no app command here).
		if in.AppPort != 0 && s.portOpen != nil {
			if s.portOpen(in.AppPort) {
				in.AppStatus = StatusRunning
			} else {
				in.AppStatus = StatusStopped
			}
		}
		if in.Runtime == "unknown" && s.appProc != nil && in.AppPort != 0 {
			if cmd, ok := s.appProc.CommandForPort(in.AppPort); ok {
				if rt := InferRuntime(cmd); rt != "unknown" {
					in.Runtime = rt
				}
			}
		}
	}
```

3. After the existing `if in.Source == SourceCompose { ... return in }` post-metadata block, add:

```go
	if in.Source == SourceTestcontainers {
		// Container sidecar + host app: metadata Extended PIDs/log paths
		// describe the container's own view; daprd logs stream from the
		// container runtime, and the app's stdout belongs to the test process.
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): enrich testcontainers apps via app-port host pairing

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 5: Wire the scanner; guard lifecycle; route container logs

**Files:**
- Modify: `cmd/root.go` (default-mode scanner list, lines ~144-164)
- Modify: `pkg/lifecycle/manager.go` (`Do`, lines ~39-55)
- Modify: `pkg/lifecycle/overlay.go` (`applyEntry`, line ~74)
- Modify: `pkg/server/logs.go` (source switch, line ~58)
- Test: `pkg/lifecycle/manager_test.go`, `pkg/server/logs_test.go` (add cases following each file's existing patterns)

**Interfaces:**
- Consumes: `discovery.NewTestcontainersSource` (Task 3), `discovery.SourceTestcontainers` (Task 2), existing `ErrUnsupported` in pkg/lifecycle.
- Produces: testcontainers apps appear in default-mode discovery; `lifecycle.Manager.Do` returns `ErrUnsupported` for them; daprd logs stream from the container runtime.

- [ ] **Step 1: Write the failing tests**

In `pkg/lifecycle/manager_test.go` (follow the file's existing fake `discovery.Service` pattern for `Do` tests — there will be one for the compose path; mirror it):

```go
func TestDo_TestcontainersUnsupported(t *testing.T) {
	apps := fakeApps{instances: []discovery.Instance{{
		AppID: "workflow-patterns-app", InstanceKey: "crazy_lamport",
		Source: discovery.SourceTestcontainers, DaprdContainerID: "28af628017d1",
	}}}
	m := New(apps, NewRegistry(), nil, nil, nil)
	err := m.Do(context.Background(), "crazy_lamport", TargetAll, ActionStop)
	require.ErrorIs(t, err, ErrUnsupported)
}
```

(Adapt the fake-apps constructor name to whatever `manager_test.go` already uses.)

In `pkg/server/logs_test.go`, mirror the existing compose container-logs test with `Source: discovery.SourceTestcontainers` and assert the daprd log stream is served from the `containerLogs` func.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/lifecycle/ ./pkg/server/ -run 'Testcontainers' -v`
Expected: lifecycle test FAILS (falls through to `doStandalone`, which won't return `ErrUnsupported`); logs test FAILS (testcontainers source falls into the standalone file-tail path).

- [ ] **Step 3: Implement**

`pkg/lifecycle/manager.go` — in `Do`, after the compose branch:

```go
	if in.Source == discovery.SourceCompose {
		return m.doCompose(ctx, in, target, action)
	}
	if in.Source == discovery.SourceTestcontainers {
		// Testcontainers owns these containers (ryuk reaps them) and the test
		// process owns the app; the dashboard must not fight either.
		return fmt.Errorf("%w: testcontainers-managed app", ErrUnsupported)
	}
	return m.doStandalone(ctx, in, target, action)
```

`pkg/lifecycle/overlay.go` — in `applyEntry`, widen the early return:

```go
	if !ok || in.Source == discovery.SourceCompose || in.Source == discovery.SourceTestcontainers {
		return
	}
```

`pkg/server/logs.go` — widen the container-log branch:

```go
		if in.Source == discovery.SourceCompose || in.Source == discovery.SourceTestcontainers {
```

(The body already picks `DaprdContainerID` and falls back to `AppContainerID`; testcontainers apps have no app container, so an `app` log request yields the existing "no container" error path — the app's stdout belongs to the Maven process.)

`cmd/root.go` — in the `default:` mode case, register the scanner:

```go
		_, crtRunner := containerruntime.Detect()
		composeSrc := discovery.NewComposeSource(crtRunner)
		tcSrc := discovery.NewTestcontainersSource(crtRunner)
		scanners := []discovery.Scanner{discovery.StandaloneScanner(), composeSrc.Scanner(), tcSrc.Scanner()}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/lifecycle/ ./pkg/server/ ./cmd/ ./pkg/discovery/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/root.go pkg/lifecycle/manager.go pkg/lifecycle/overlay.go pkg/server/logs.go pkg/lifecycle/manager_test.go pkg/server/logs_test.go
git commit -m "feat(discovery): register testcontainers scanner; guard lifecycle; stream container logs

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 6: Sidecar-gRPC workflow source

**Files:**
- Create: `pkg/workflow/sidecar.go`
- Test: `pkg/workflow/sidecar_test.go`

**Interfaces:**
- Consumes: `durabletask-go` — `dtwf "github.com/dapr/durabletask-go/workflow"` (`NewClient(conn)`, `ListInstanceIDs`, `FetchWorkflowMetadata`, `GetInstanceHistory`, `WithListInstanceIDsContinuationToken`), `"github.com/dapr/durabletask-go/api"` (`ErrInstanceNotFound`), `"github.com/dapr/durabletask-go/api/protos"`; existing `DecodeExecution`, `NormalizeStatus`, `matches`, `afterOrZero`, `ErrNotFound`.
- Produces:
  - `type SidecarEndpoint struct { AppID, Addr string }`
  - `type EndpointsFunc func(ctx context.Context) []SidecarEndpoint`
  - `NewSidecarPool() *SidecarPool` with `Close() error` and `Service(eps EndpointsFunc) *SidecarService`
  - `*SidecarService` implements `Service` and adds `Owns(ctx context.Context, appID string) bool` and `HasEndpoints(ctx context.Context) bool`
  - `var ErrSidecarUnsupported = errors.New("workflow inspection via the sidecar requires Dapr 1.17 or newer")`

- [ ] **Step 1: Write the failing test**

Create `pkg/workflow/sidecar_test.go` with a fake TaskHub gRPC server. The three RPCs the durabletask client uses are `ListInstanceIDs`, `GetInstance` (behind `FetchWorkflowMetadata`), and `GetInstanceHistory`. For history-event construction, crib from `pkg/workflow/decode_test.go` (it builds `protos.HistoryEvent` values already).

```go
package workflow

import (
	"context"
	"net"
	"strconv"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

type fakeHub struct {
	protos.UnimplementedTaskHubSidecarServiceServer
	// pages served by ListInstanceIDs; the continuation token is the next
	// page index, so paging is stateless and every fresh query restarts at
	// page 0 (a mutable cursor would corrupt the second List call).
	pages         [][]string
	states        map[string]*protos.WorkflowState
	history       map[string][]*protos.HistoryEvent
	unimplemented bool
}

func (f *fakeHub) ListInstanceIDs(_ context.Context, req *protos.ListInstanceIDsRequest) (*protos.ListInstanceIDsResponse, error) {
	if f.unimplemented {
		return nil, status.Error(codes.Unimplemented, "not implemented")
	}
	page := 0
	if tok := req.GetContinuationToken(); tok != "" {
		page, _ = strconv.Atoi(tok)
	}
	if page >= len(f.pages) {
		return &protos.ListInstanceIDsResponse{}, nil
	}
	resp := &protos.ListInstanceIDsResponse{InstanceIds: f.pages[page]}
	if page < len(f.pages)-1 {
		tok := strconv.Itoa(page + 1)
		resp.ContinuationToken = &tok
	}
	return resp, nil
}

func (f *fakeHub) GetInstance(_ context.Context, req *protos.GetInstanceRequest) (*protos.GetInstanceResponse, error) {
	st, ok := f.states[req.GetInstanceId()]
	if !ok {
		return &protos.GetInstanceResponse{Exists: false}, nil
	}
	return &protos.GetInstanceResponse{Exists: true, WorkflowState: st}, nil
}

func (f *fakeHub) GetInstanceHistory(_ context.Context, req *protos.GetInstanceHistoryRequest) (*protos.GetInstanceHistoryResponse, error) {
	if f.unimplemented {
		return nil, status.Error(codes.Unimplemented, "not implemented")
	}
	return &protos.GetInstanceHistoryResponse{Events: f.history[req.GetInstanceId()]}, nil
}

// startFakeHub serves hub on a random loopback port and returns its address.
func startFakeHub(t *testing.T, hub *fakeHub) string {
	t.Helper()
	lis, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	srv := grpc.NewServer()
	protos.RegisterTaskHubSidecarServiceServer(srv, hub)
	go func() { _ = srv.Serve(lis) }()
	t.Cleanup(srv.Stop)
	return lis.Addr().String()
}

func wfState(id, name string, st protos.OrchestrationStatus, parent string) *protos.WorkflowState {
	s := &protos.WorkflowState{
		InstanceId:       id,
		Name:             name,
		WorkflowStatus:   st,
		CreatedTimestamp: timestamppb.Now(),
	}
	if parent != "" {
		s.ParentInstanceId = wrapperspb.String(parent)
	}
	return s
}

func fixedEndpoints(appID, addr string) EndpointsFunc {
	return func(context.Context) []SidecarEndpoint {
		return []SidecarEndpoint{{AppID: appID, Addr: addr}}
	}
}

func TestSidecarList_PagesAndFiltersChildren(t *testing.T) {
	hub := &fakeHub{
		pages: [][]string{{"parent-1"}, {"child-1"}},
		states: map[string]*protos.WorkflowState{
			"parent-1": wfState("parent-1", "ParentWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, ""),
			"child-1":  wfState("child-1", "ChildWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "parent-1"),
		},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("workflow-patterns-app", addr))

	// Default view hides children.
	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "parent-1", res.Items[0].InstanceID)
	require.Equal(t, StatusCompleted, res.Items[0].Status)
	require.Equal(t, "workflow-patterns-app", res.Items[0].AppID)

	// IncludeChildren surfaces both (proves pagination followed the token).
	res, err = svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Empty(t, res.NextToken)
}

func TestSidecarStats_TalliesStatuses(t *testing.T) {
	hub := &fakeHub{
		pages: [][]string{{"a", "b"}},
		states: map[string]*protos.WorkflowState{
			"a": wfState("a", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, ""),
			"b": wfState("b", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED, ""),
		},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	stats, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 2, stats.Total)
	require.Equal(t, 1, stats.Counts[StatusCompleted])
	require.Equal(t, 1, stats.Counts[StatusFailed])
}

func TestSidecarGet_DecodesHistoryAndMapsNotFound(t *testing.T) {
	// Build a minimal real history: started + completed (see decode_test.go).
	events := []*protos.HistoryEvent{
		{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
				Name: "ParentWorkflow", OrchestrationInstance: &protos.OrchestrationInstance{InstanceId: "parent-1"},
			}},
		},
		{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
				OrchestrationStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			}},
		},
	}
	hub := &fakeHub{
		pages:   [][]string{{"parent-1"}},
		states:  map[string]*protos.WorkflowState{"parent-1": wfState("parent-1", "ParentWorkflow", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
		history: map[string][]*protos.HistoryEvent{"parent-1": events},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	ex, err := svc.Get(context.Background(), "app", "parent-1")
	require.NoError(t, err)
	require.Equal(t, "ParentWorkflow", ex.Name)
	require.Equal(t, StatusCompleted, ex.Status)
	require.NotEmpty(t, ex.History)

	_, err = svc.Get(context.Background(), "app", "missing")
	require.ErrorIs(t, err, ErrNotFound)

	_, err = svc.Get(context.Background(), "unknown-app", "parent-1")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestSidecarList_UnimplementedSkipsApp(t *testing.T) {
	hub := &fakeHub{unimplemented: true, pages: [][]string{{}}}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("old-app", addr))

	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err) // per-app failure skips the app, never errors the page
	require.Empty(t, res.Items)
}

func TestSidecarOwnsAndAppIDs(t *testing.T) {
	hub := &fakeHub{
		pages:  [][]string{{"a"}},
		states: map[string]*protos.WorkflowState{"a": wfState("a", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_RUNNING, "")},
	}
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	svc := pool.Service(fixedEndpoints("app", addr))

	require.True(t, svc.Owns(context.Background(), "app"))
	require.False(t, svc.Owns(context.Background(), "other"))
	require.True(t, svc.HasEndpoints(context.Background()))

	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"app"}, ids)
}
```

Field-name caveat: `protos.WorkflowState` / `protos.ExecutionStartedEvent` field spellings above were read from `durabletask-go@v0.12.1` generated code (`WorkflowStatus`, `CreatedTimestamp`, `ParentInstanceId` as `*wrapperspb.StringValue`). If the compiler disagrees, check `api/protos/orchestrator_service.pb.go` in the module cache — fix the test, not by inventing new shapes.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/workflow/ -run TestSidecar -v`
Expected: FAIL — `undefined: NewSidecarPool` etc.

- [ ] **Step 3: Implement**

Create `pkg/workflow/sidecar.go`:

```go
package workflow

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"

	"github.com/dapr/durabletask-go/api"
	dtwf "github.com/dapr/durabletask-go/workflow"
	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
)

// ErrSidecarUnsupported marks a sidecar whose runtime predates the workflow
// management API (ListInstanceIDs/GetInstanceHistory, Dapr 1.17+).
var ErrSidecarUnsupported = errors.New("workflow inspection via the sidecar requires Dapr 1.17 or newer")

// SidecarEndpoint is one app's daprd gRPC endpoint.
type SidecarEndpoint struct {
	AppID string
	Addr  string // host:port, e.g. "127.0.0.1:58445"
}

// EndpointsFunc returns the current set of sidecar-sourced apps. It is called
// per query so discovery changes (new published ports after a test rerun)
// apply immediately.
type EndpointsFunc func(ctx context.Context) []SidecarEndpoint

const (
	// metadataConcurrency caps in-flight FetchWorkflowMetadata calls per app
	// listing (the dapr CLI uses 32; local sidecars need less headroom).
	metadataConcurrency = 16
	// maxSidecarInstances bounds instances read per app per query.
	maxSidecarInstances = 1000
)

func sidecarLogger() *slog.Logger { return slog.Default().With("component", "workflow-sidecar") }

// SidecarPool caches one gRPC client connection per endpoint address.
// grpc.NewClient is lazy, so entries are cheap; connections to ports from
// finished test runs stay idle until Close. Close on shutdown.
type SidecarPool struct {
	mu     sync.Mutex
	conns  map[string]*grpc.ClientConn
	closed bool
}

func NewSidecarPool() *SidecarPool {
	return &SidecarPool{conns: map[string]*grpc.ClientConn{}}
}

func (p *SidecarPool) client(addr string) (*dtwf.Client, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, errors.New("sidecar pool closed")
	}
	conn, ok := p.conns[addr]
	if !ok {
		c, err := grpc.NewClient(addr, grpc.WithTransportCredentials(insecure.NewCredentials()))
		if err != nil {
			return nil, err
		}
		p.conns[addr] = c
		conn = c
	}
	return dtwf.NewClient(conn), nil
}

func (p *SidecarPool) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil
	}
	p.closed = true
	var errs []error
	for _, c := range p.conns {
		if err := c.Close(); err != nil {
			errs = append(errs, err)
		}
	}
	p.conns = map[string]*grpc.ClientConn{}
	return errors.Join(errs...)
}

// Service returns a workflow Service reading from the sidecars selected by eps.
func (p *SidecarPool) Service(eps EndpointsFunc) *SidecarService {
	return &SidecarService{pool: p, eps: eps}
}

// SidecarService reads workflow data live from daprd's gRPC workflow
// management API instead of the state store. It works with any backing store —
// state.in-memory included — because the sidecar itself answers.
type SidecarService struct {
	pool *SidecarPool
	eps  EndpointsFunc
}

var _ Service = (*SidecarService)(nil)

// Owns reports whether appID is served by this sidecar source.
func (s *SidecarService) Owns(ctx context.Context, appID string) bool {
	_, ok := s.endpointFor(ctx, appID)
	return ok
}

// HasEndpoints reports whether any app is currently sidecar-sourced.
func (s *SidecarService) HasEndpoints(ctx context.Context) bool {
	return len(s.eps(ctx)) > 0
}

func (s *SidecarService) endpointFor(ctx context.Context, appID string) (SidecarEndpoint, bool) {
	for _, ep := range s.eps(ctx) {
		if ep.AppID == appID {
			return ep, true
		}
	}
	return SidecarEndpoint{}, false
}

// List returns every matching instance across the sidecar-sourced apps in one
// page (NextToken is always empty: local sidecars hold bounded instance
// counts, so store-style cursor paging buys nothing here). A failing app is
// skipped and logged — one down sidecar never empties the whole page.
func (s *SidecarService) List(ctx context.Context, q ListQuery) (ListResult, error) {
	var items []ExecutionSummary
	for _, ep := range s.eps(ctx) {
		if q.AppID != "" && ep.AppID != q.AppID {
			continue
		}
		sums, err := s.listApp(ctx, ep)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow list failed", "appID", ep.AppID, "addr", ep.Addr, "err", err)
			continue
		}
		for _, sum := range sums {
			if matches(sum, q) {
				items = append(items, sum)
			}
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	return ListResult{Items: items}, nil
}

// Stats tallies statuses across all matching instances (Status filter and
// paging ignored, mirroring the store-backed Stats contract).
func (s *SidecarService) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	lr, err := s.List(ctx, ListQuery{AppID: q.AppID, Search: q.Search, IncludeChildren: q.IncludeChildren})
	if err != nil {
		return StatsResult{}, err
	}
	res := StatsResult{Counts: map[Status]int{}}
	for _, it := range lr.Items {
		res.Counts[it.Status]++
		res.Total++
	}
	return res, nil
}

func (s *SidecarService) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	ep, ok := s.endpointFor(ctx, appID)
	if !ok {
		return Execution{}, ErrNotFound
	}
	cl, err := s.pool.client(ep.Addr)
	if err != nil {
		return Execution{}, err
	}
	md, err := cl.FetchWorkflowMetadata(ctx, instanceID)
	if err != nil {
		if errors.Is(err, api.ErrInstanceNotFound) {
			return Execution{}, ErrNotFound
		}
		return Execution{}, mapSidecarErr(err)
	}
	hist, err := cl.GetInstanceHistory(ctx, instanceID)
	if err != nil {
		return Execution{}, mapSidecarErr(err)
	}
	events := hist.Events
	// Order like the dapr CLI: EventId when both present, else timestamp.
	sort.SliceStable(events, func(i, j int) bool {
		ei, ej := events[i], events[j]
		if ei.EventId > 0 && ej.EventId > 0 {
			return ei.EventId < ej.EventId
		}
		ti, tj := ei.GetTimestamp().AsTime(), ej.GetTimestamp().AsTime()
		if !ti.Equal(tj) {
			return ti.Before(tj)
		}
		return ei.EventId < ej.EventId
	})
	customStatus := ""
	if md.CustomStatus != nil {
		customStatus = md.CustomStatus.Value
	}
	return DecodeExecution(appID, instanceID, events, customStatus), nil
}

// AppIDs returns the sidecar-sourced apps that hold at least one instance.
func (s *SidecarService) AppIDs(ctx context.Context) ([]string, error) {
	var ids []string
	for _, ep := range s.eps(ctx) {
		cl, err := s.pool.client(ep.Addr)
		if err != nil {
			continue
		}
		resp, err := cl.ListInstanceIDs(ctx)
		if err != nil {
			sidecarLogger().Warn("sidecar workflow app probe failed", "appID", ep.AppID, "err", err)
			continue
		}
		if len(resp.InstanceIds) > 0 || resp.ContinuationToken != nil {
			ids = append(ids, ep.AppID)
		}
	}
	sort.Strings(ids)
	return ids, nil
}

// listApp fetches an app's instance IDs (all pages, capped) and their
// metadata with bounded concurrency.
func (s *SidecarService) listApp(ctx context.Context, ep SidecarEndpoint) ([]ExecutionSummary, error) {
	cl, err := s.pool.client(ep.Addr)
	if err != nil {
		return nil, err
	}
	resp, err := cl.ListInstanceIDs(ctx)
	if err != nil {
		return nil, mapSidecarErr(err)
	}
	ids := append([]string{}, resp.InstanceIds...)
	for resp.ContinuationToken != nil && len(ids) < maxSidecarInstances {
		resp, err = cl.ListInstanceIDs(ctx, dtwf.WithListInstanceIDsContinuationToken(*resp.ContinuationToken))
		if err != nil {
			return nil, mapSidecarErr(err)
		}
		ids = append(ids, resp.InstanceIds...)
	}
	if len(ids) > maxSidecarInstances {
		sidecarLogger().Warn("sidecar instance list truncated", "appID", ep.AppID, "cap", maxSidecarInstances)
		ids = ids[:maxSidecarInstances]
	}

	sums := make([]*ExecutionSummary, len(ids))
	sem := make(chan struct{}, metadataConcurrency)
	var wg sync.WaitGroup
	for i, id := range ids {
		wg.Add(1)
		go func(idx int, instanceID string) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			md, err := cl.FetchWorkflowMetadata(ctx, instanceID)
			if err != nil {
				sidecarLogger().Warn("sidecar workflow metadata failed", "appID", ep.AppID, "instanceID", instanceID, "err", err)
				return
			}
			sum := summaryFromMetadata(ep.AppID, instanceID, md)
			sums[idx] = &sum
		}(i, id)
	}
	wg.Wait()
	out := make([]ExecutionSummary, 0, len(sums))
	for _, s := range sums {
		if s != nil {
			out = append(out, *s)
		}
	}
	return out, nil
}

func summaryFromMetadata(appID, instanceID string, md *dtwf.WorkflowMetadata) ExecutionSummary {
	sum := ExecutionSummary{
		AppID:            appID,
		InstanceID:       instanceID,
		Name:             md.Name,
		Status:           NormalizeStatus(md.RuntimeStatus.String()),
		ParentInstanceID: md.ParentInstanceId,
	}
	if md.CreatedAt != nil {
		t := md.CreatedAt.AsTime()
		sum.CreatedAt = &t
	}
	if md.LastUpdatedAt != nil {
		t := md.LastUpdatedAt.AsTime()
		sum.LastUpdatedAt = &t
	}
	return sum
}

// mapSidecarErr converts the pre-1.17 "not implemented" gRPC codes into
// ErrSidecarUnsupported (mirroring the dapr CLI's fallback detection).
func mapSidecarErr(err error) error {
	if c, ok := status.FromError(err); ok && (c.Code() == codes.Unimplemented || c.Code() == codes.Unknown) {
		return fmt.Errorf("%w (%v)", ErrSidecarUnsupported, err)
	}
	return err
}
```

Note: `NormalizeStatus` expects `ORCHESTRATION_STATUS_*` strings — `md.RuntimeStatus` is the `protos.OrchestrationStatus` enum whose `String()` yields exactly that form (do NOT use `md.String()`, the durabletask wrapper's short form).

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/workflow/ -run TestSidecar -v`
Expected: PASS (all five tests).

- [ ] **Step 5: Run the full package + commit**

Run: `go test ./pkg/workflow/`
Expected: PASS.

```bash
git add pkg/workflow/sidecar.go pkg/workflow/sidecar_test.go
git commit -m "feat(workflow): sidecar-gRPC workflow source via durabletask client

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 7: Composite workflow service (per-app routing + merge)

**Files:**
- Create: `pkg/workflow/composite.go`
- Test: `pkg/workflow/composite_test.go`

**Interfaces:**
- Consumes: `Service` interface, `*SidecarService` (Task 6: `Owns`, `HasEndpoints`, `List`, `Stats`, `Get`, `AppIDs`), sentinels `ErrNoStore`, `ErrStoreUnreachable`, `ErrNotFound`.
- Produces: `NewComposite(base Service, sc *SidecarService) Service`. Routing contract: app-scoped queries go to the owner (sidecar if `Owns`, else base); all-apps queries merge both, with sidecar items winning appID/instanceID collisions; base errors `ErrNoStore`/`ErrStoreUnreachable` are suppressed when the sidecar has endpoints (else propagated unchanged, preserving today's banner UX).

- [ ] **Step 1: Write the failing test**

Create `pkg/workflow/composite_test.go`:

```go
package workflow

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// fakeBase is a canned store-backed Service.
type fakeBase struct {
	items []ExecutionSummary
	err   error
}

func (f fakeBase) List(context.Context, ListQuery) (ListResult, error) {
	return ListResult{Items: f.items, NextToken: "tok"}, f.err
}
func (f fakeBase) Stats(context.Context, ListQuery) (StatsResult, error) {
	if f.err != nil {
		return StatsResult{}, f.err
	}
	res := StatsResult{Counts: map[Status]int{}}
	for _, it := range f.items {
		res.Counts[it.Status]++
		res.Total++
	}
	return res, nil
}
func (f fakeBase) Get(_ context.Context, appID, id string) (Execution, error) {
	if f.err != nil {
		return Execution{}, f.err
	}
	for _, it := range f.items {
		if it.AppID == appID && it.InstanceID == id {
			return Execution{ExecutionSummary: it}, nil
		}
	}
	return Execution{}, ErrNotFound
}
func (f fakeBase) AppIDs(context.Context) ([]string, error) {
	if f.err != nil {
		return nil, f.err
	}
	seen := map[string]bool{}
	var ids []string
	for _, it := range f.items {
		if !seen[it.AppID] {
			seen[it.AppID] = true
			ids = append(ids, it.AppID)
		}
	}
	return ids, nil
}

// sidecarWith builds a *SidecarService over a fakeHub (Task 6 helpers).
func sidecarWith(t *testing.T, appID string, hub *fakeHub) *SidecarService {
	t.Helper()
	addr := startFakeHub(t, hub)
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	return pool.Service(fixedEndpoints(appID, addr))
}

func emptySidecar(t *testing.T) *SidecarService {
	t.Helper()
	pool := NewSidecarPool()
	t.Cleanup(func() { _ = pool.Close() })
	return pool.Service(func(context.Context) []SidecarEndpoint { return nil })
}

func TestComposite_MergesAndSidecarWinsCollisions(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{
		{AppID: "store-app", InstanceID: "s1", Name: "StoreWF", Status: StatusCompleted, CreatedAt: &now},
		{AppID: "tc-app", InstanceID: "dup", Name: "Stale", Status: StatusFailed, CreatedAt: &now},
	}}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"dup"}},
		states: map[string]*protos.WorkflowState{"dup": wfState("dup", "LiveWF", protos.OrchestrationStatus_ORCHESTRATION_STATUS_RUNNING, "")},
	})
	svc := NewComposite(base, sc)

	res, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 2) // s1 + dup (sidecar copy), stale store dup dropped
	byID := map[string]ExecutionSummary{}
	for _, it := range res.Items {
		byID[it.InstanceID] = it
	}
	require.Equal(t, "LiveWF", byID["dup"].Name) // sidecar won
	require.Equal(t, "tok", res.NextToken)       // base cursor preserved

	// App-scoped queries route to the owner.
	res, err = svc.List(context.Background(), ListQuery{AppID: "tc-app", IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "LiveWF", res.Items[0].Name)

	ids, err := svc.AppIDs(context.Background())
	require.NoError(t, err)
	require.Equal(t, []string{"store-app", "tc-app"}, ids)
}

func TestComposite_NoStoreSuppressedWhenSidecarHasEndpoints(t *testing.T) {
	base := fakeBase{err: ErrNoStore}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
	})
	svc := NewComposite(base, sc)

	res, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)

	stats, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 1, stats.Total)
}

func TestComposite_NoStorePropagatedWithoutEndpoints(t *testing.T) {
	base := fakeBase{err: ErrNoStore}
	svc := NewComposite(base, emptySidecar(t))

	_, err := svc.List(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.Stats(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.AppIDs(context.Background())
	require.ErrorIs(t, err, ErrNoStore)
	_, err = svc.Get(context.Background(), "any", "x")
	require.ErrorIs(t, err, ErrNoStore)
}

func TestComposite_GetRoutesToOwner(t *testing.T) {
	now := time.Now()
	base := fakeBase{items: []ExecutionSummary{{AppID: "store-app", InstanceID: "s1", Status: StatusCompleted, CreatedAt: &now}}}
	sc := sidecarWith(t, "tc-app", &fakeHub{
		pages:  [][]string{{"w1"}},
		states: map[string]*protos.WorkflowState{"w1": wfState("w1", "W", protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED, "")},
		history: map[string][]*protos.HistoryEvent{"w1": {{
			EventId: -1, Timestamp: timestamppb.Now(),
			EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
				Name: "W", OrchestrationInstance: &protos.OrchestrationInstance{InstanceId: "w1"},
			}},
		}}},
	})
	svc := NewComposite(base, sc)

	ex, err := svc.Get(context.Background(), "store-app", "s1")
	require.NoError(t, err)
	require.Equal(t, "s1", ex.InstanceID)

	ex, err = svc.Get(context.Background(), "tc-app", "w1")
	require.NoError(t, err)
	require.Equal(t, "W", ex.Name)
}
```

Delete the pseudocode block flagged by the NOTE before running — it exists only so this plan stays honest about the one literal you must write with real proto types (imports: `"github.com/dapr/durabletask-go/api/protos"`, `"google.golang.org/protobuf/types/known/timestamppb"`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./pkg/workflow/ -run TestComposite -v`
Expected: FAIL — `undefined: NewComposite`.

- [ ] **Step 3: Implement**

Create `pkg/workflow/composite.go`:

```go
package workflow

import (
	"context"
	"errors"
	"sort"
)

// composite routes workflow reads per app between the store-backed service
// and the sidecar-gRPC service:
//   - an app the sidecar source owns (testcontainers apps always; every
//     reachable app when no store is openable) is served by the sidecar;
//   - everything else is served by the store;
//   - all-apps queries merge both, the sidecar winning collisions (it is
//     live; the store copy may be a stale earlier run).
//
// Base errors ErrNoStore/ErrStoreUnreachable are suppressed when the sidecar
// currently has endpoints — otherwise they propagate unchanged so the
// existing store banners keep firing.
type composite struct {
	base Service
	sc   *SidecarService
}

// NewComposite builds the per-app routing service. base is the store-backed
// service (possibly degraded/unreachable); sc is the sidecar source.
func NewComposite(base Service, sc *SidecarService) Service {
	return &composite{base: base, sc: sc}
}

// storeMissing reports base errors the sidecar source may stand in for.
func storeMissing(err error) bool {
	return errors.Is(err, ErrNoStore) || errors.Is(err, ErrStoreUnreachable)
}

func (c *composite) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if q.AppID != "" {
		if c.sc.Owns(ctx, q.AppID) {
			return c.sc.List(ctx, q)
		}
		return c.base.List(ctx, q)
	}
	baseRes, baseErr := c.base.List(ctx, q)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return ListResult{}, baseErr
	}
	scRes, scErr := c.sc.List(ctx, q)
	if scErr != nil {
		if baseErr != nil {
			return ListResult{}, baseErr
		}
		return baseRes, nil
	}
	if baseErr != nil {
		return scRes, nil
	}
	seen := make(map[string]struct{}, len(scRes.Items))
	items := make([]ExecutionSummary, 0, len(scRes.Items)+len(baseRes.Items))
	for _, it := range scRes.Items {
		seen[it.AppID+"/"+it.InstanceID] = struct{}{}
		items = append(items, it)
	}
	for _, it := range baseRes.Items {
		if _, dup := seen[it.AppID+"/"+it.InstanceID]; dup {
			continue
		}
		items = append(items, it)
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	return ListResult{Items: items, NextToken: baseRes.NextToken}, nil
}

func (c *composite) Stats(ctx context.Context, q ListQuery) (StatsResult, error) {
	if q.AppID != "" {
		if c.sc.Owns(ctx, q.AppID) {
			return c.sc.Stats(ctx, q)
		}
		return c.base.Stats(ctx, q)
	}
	baseRes, baseErr := c.base.Stats(ctx, q)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return StatsResult{}, baseErr
	}
	scRes, scErr := c.sc.Stats(ctx, q)
	if scErr != nil {
		if baseErr != nil {
			return StatsResult{}, baseErr
		}
		return baseRes, nil
	}
	if baseErr != nil {
		return scRes, nil
	}
	// Counts are summed; an app-id present in both sources (a testcontainers
	// app whose id also has stale store data) can double-count — instance
	// identity is not available at stats granularity. Rare and benign locally.
	out := StatsResult{Counts: map[Status]int{}}
	for k, v := range baseRes.Counts {
		out.Counts[k] += v
	}
	for k, v := range scRes.Counts {
		out.Counts[k] += v
	}
	out.Total = baseRes.Total + scRes.Total
	return out, nil
}

func (c *composite) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	if c.sc.Owns(ctx, appID) {
		return c.sc.Get(ctx, appID, instanceID)
	}
	return c.base.Get(ctx, appID, instanceID)
}

func (c *composite) AppIDs(ctx context.Context) ([]string, error) {
	baseIDs, baseErr := c.base.AppIDs(ctx)
	if baseErr != nil && !(storeMissing(baseErr) && c.sc.HasEndpoints(ctx)) {
		return nil, baseErr
	}
	scIDs, scErr := c.sc.AppIDs(ctx)
	if scErr != nil && baseErr != nil {
		return nil, baseErr
	}
	seen := map[string]struct{}{}
	var ids []string
	for _, id := range append(baseIDs, scIDs...) {
		if _, dup := seen[id]; dup {
			continue
		}
		seen[id] = struct{}{}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/workflow/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/workflow/composite.go pkg/workflow/composite_test.go
git commit -m "feat(workflow): composite service routing per app between store and sidecar

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 8: Wire the composite into the reconciler

**Files:**
- Modify: `cmd/reconciler.go` (`reconciler` struct, `newReconciler`, `ServiceFor` at lines ~410-451, `Close`)
- Test: `cmd/reconciler_test.go` (extend `TestReconciler_ServiceForRouting` patterns)

**Interfaces:**
- Consumes: `workflow.NewSidecarPool`, `pool.Service(eps)`, `workflow.NewComposite`, `workflow.SidecarEndpoint`, `discovery.SourceTestcontainers` / `SourceAspire`, `newTargetResolver(apps, svc)`.
- Produces: `ServiceFor` returns the composite; selection rule — testcontainers apps always sidecar-eligible; every reachable non-aspire sidecar with a gRPC port becomes eligible when `id == ""` and no active store opened.

- [ ] **Step 1: Write the failing test**

Add to `cmd/reconciler_test.go` (reuse the file's existing fake apps-service and reconciler construction helpers — look at `TestReconciler_ServiceForRouting` for the established pattern; the fake discovery service must return an instance with `Source: discovery.SourceTestcontainers` and a `GRPCPort` pointing at a fake hub — but a fake hub lives in pkg/workflow's tests, so at cmd level assert ROUTING, not data):

```go
// TestServiceFor_SidecarComposite asserts the selection rule wiring, not the
// gRPC data path (covered in pkg/workflow): with no store elected, a
// testcontainers app with a gRPC port must make ServiceFor("") return a
// service whose List does NOT fail with ErrNoStore.
func TestServiceFor_SidecarComposite(t *testing.T) {
	apps := staticApps{instances: []discovery.Instance{{
		AppID: "tc-app", InstanceKey: "crazy_lamport",
		Source: discovery.SourceTestcontainers, GRPCPort: 1, SidecarReachable: true,
	}}}
	pool := newConnPool("default", &http.Client{}, apps, failingOpener, nil)
	rc := newReconciler(context.Background(), apps, "default", "", "", &http.Client{}, nil, pool, nil, nil)

	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	// The gRPC endpoint (port 1) is unreachable, so the sidecar source skips
	// the app — but the composite must swallow ErrNoStore because a sidecar
	// endpoint exists. An empty page, not an error, is the contract.
	res, err := svc.List(context.Background(), workflow.ListQuery{})
	require.NoError(t, err)
	require.Empty(t, res.Items)
}

// TestServiceFor_NoEndpointsPreservesErrNoStore keeps the existing no-store
// banner behavior when nothing is sidecar-eligible.
func TestServiceFor_NoEndpointsPreservesErrNoStore(t *testing.T) {
	apps := staticApps{instances: []discovery.Instance{{
		AppID: "plain-app", Source: discovery.SourceStandalone,
	}}}
	pool := newConnPool("default", &http.Client{}, apps, failingOpener, nil)
	rc := newReconciler(context.Background(), apps, "default", "", "", &http.Client{}, nil, pool, nil, nil)

	svc, _, _, ok := rc.ServiceFor("")
	require.True(t, ok)
	_, err := svc.List(context.Background(), workflow.ListQuery{})
	require.ErrorIs(t, err, workflow.ErrNoStore)
}
```

Adapt `staticApps`/`failingOpener` to the fakes already defined in `cmd`'s test files (`reconciler_test.go`/`connpool_test.go` define equivalents — reuse, don't duplicate). Note the standalone instance in the second test has `GRPCPort: 0`, so even the include-all rule yields no endpoints.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test ./cmd/ -run TestServiceFor_ -v`
Expected: first test FAILS with `ErrNoStore` (no composite yet); second PASSES (guards the regression).

- [ ] **Step 3: Implement**

In `cmd/reconciler.go`:

1. Add a field to `reconciler`: `sidecarPool *workflow.SidecarPool` (immutable section). In `newReconciler`, set `sidecarPool: workflow.NewSidecarPool()`. In `Close()`, before the pool close, add:

```go
	if rc.sidecarPool != nil {
		_ = rc.sidecarPool.Close()
	}
```

2. Add the endpoints provider:

```go
// sidecarEndpoints returns the workflow sidecar endpoints eligible under the
// selection rule. Testcontainers apps are always eligible (their store lives
// inside the container and is never host-readable). When includeAll is true
// (no openable active store), every reachable non-aspire sidecar with a
// published gRPC port becomes eligible. The list is computed per query from
// live discovery so re-published random ports apply immediately.
func (rc *reconciler) sidecarEndpoints(includeAll bool) workflow.EndpointsFunc {
	return func(ctx context.Context) []workflow.SidecarEndpoint {
		apps, err := rc.apps.List(ctx)
		if err != nil {
			return nil
		}
		var eps []workflow.SidecarEndpoint
		seen := map[string]bool{}
		for _, in := range apps {
			if in.GRPCPort == 0 || seen[in.AppID] {
				continue
			}
			include := in.Source == discovery.SourceTestcontainers ||
				(includeAll && in.SidecarReachable && in.Source != discovery.SourceAspire)
			if !include {
				continue
			}
			seen[in.AppID] = true
			eps = append(eps, workflow.SidecarEndpoint{
				AppID: in.AppID,
				Addr:  "127.0.0.1:" + strconv.Itoa(in.GRPCPort),
			})
		}
		return eps
	}
}
```

3. Split `ServiceFor` into a base resolver plus composition. Replace the current `ServiceFor` with:

```go
// baseServiceFor resolves the store-backed service exactly as ServiceFor
// historically did. storeUp reports whether a store actually opened (false
// for the degraded no-store entry and the unreachable service).
func (rc *reconciler) baseServiceFor(id string) (svc workflow.Service, rem server.WorkflowRemover, storeUp, known bool) {
	var comp statestore.Component
	if id == "" {
		active := rc.activeComponent()
		if active == nil {
			return rc.degraded.svc, rc.degraded.rem, false, true
		}
		comp = *active
	} else {
		c, ok := rc.componentFor(id)
		if !ok {
			return nil, nil, false, false
		}
		comp = c
	}

	// Apply compose address translation (no-op for non-compose stores) so the
	// pool key matches the pre-warmed translated entry and the dial uses the
	// host-reachable address rather than the in-container service name.
	comp = rc.translate(comp)

	// Derive from baseCtx so shutdown aborts an in-flight dial here too.
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

// ServiceFor satisfies server.WorkflowBackend. The store-backed service is
// composed with the sidecar-gRPC source: testcontainers apps always read via
// their sidecar; when the active store is missing or unopenable (id == ""),
// every reachable sidecar with a gRPC port becomes sidecar-sourced.
func (rc *reconciler) ServiceFor(id string) (workflow.Service, server.WorkflowRemover, server.TargetResolver, bool) {
	baseSvc, rem, storeUp, known := rc.baseServiceFor(id)
	if !known {
		return nil, nil, nil, false
	}
	sc := rc.sidecarPool.Service(rc.sidecarEndpoints(id == "" && !storeUp))
	svc := workflow.NewComposite(baseSvc, sc)
	return svc, rem, newTargetResolver(rc.apps, svc), true
}
```

Note the target resolver now wraps the composite, so Resolve sees sidecar-sourced statuses too. The removers are unchanged: HTTP purge works against any healthy sidecar (discovery supplies the published HTTP port); store force-delete simply has nothing to delete for sidecar-sourced apps.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/`
Expected: PASS (both new tests and all pre-existing reconciler/integration tests — the composite must not change behavior when the sidecar has no endpoints).

- [ ] **Step 5: Run the whole Go suite + commit**

Run: `go test ./...`
Expected: PASS.

```bash
git add cmd/reconciler.go cmd/reconciler_test.go
git commit -m "feat(cmd): compose sidecar-gRPC workflow source into the reconciler

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — source union, label, lifecycle hiding

**Files:**
- Modify: `web/src/types/api.ts` (line 24)
- Modify: `web/src/pages/Applications.tsx` (line 116 `sourceLabel`)
- Modify: `web/src/pages/AppDetail.tsx` (lifecycle gating around lines 34, 99, 160)
- Test: `web/src/pages/Applications.test.tsx`, `web/src/pages/AppDetail.test.tsx` (add cases following each file's existing fixture patterns)

**Interfaces:**
- Consumes: backend now emits `source: "testcontainers"` and `testcontainersSession` on app payloads.
- Produces: `AppSummary.source` union includes `'aspire'` and `'testcontainers'`; optional `testcontainersSession?: string`; Applications rows label testcontainers apps; AppDetail renders no lifecycle controls for them.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/Applications.test.tsx`, add (reusing the file's existing app-fixture builder):

```tsx
it('labels testcontainers apps', () => {
  renderWithApps([
    makeApp({ appId: 'workflow-patterns-app', source: 'testcontainers' }),
  ])
  expect(screen.getByText('Testcontainers')).toBeInTheDocument()
})
```

In `web/src/pages/AppDetail.test.tsx`, add:

```tsx
it('hides lifecycle controls for testcontainers apps', async () => {
  renderDetail(makeApp({
    appId: 'workflow-patterns-app',
    source: 'testcontainers',
    appStatus: 'running',
    daprdStatus: 'running',
  }))
  expect(screen.queryByRole('button', { name: /stop/i })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /restart/i })).not.toBeInTheDocument()
})
```

Adapt `renderWithApps` / `renderDetail` / `makeApp` to the helpers those test files actually define (they exist under other names — mirror the nearest existing compose test case).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx src/pages/AppDetail.test.tsx`
Expected: FAIL — 'Testcontainers' label absent; lifecycle buttons still render. (TS may also reject `source: 'testcontainers'` — that is the union gap, fixed next.)

- [ ] **Step 3: Implement**

`web/src/types/api.ts` line 23-24:

```ts
  /** discovery source: process table, docker compose, aspire env contract, or testcontainers */
  source?: 'standalone' | 'compose' | 'aspire' | 'testcontainers'
```

Also add near the other optional identity fields (after `label?`):

```ts
  /** org.testcontainers.sessionId grouping one Testcontainers run (source === 'testcontainers' only) */
  testcontainersSession?: string
```

`web/src/pages/Applications.tsx` line 116:

```tsx
  const sourceLabel =
    app.runTemplate ||
    (app.isAspire ? 'Aspire' : app.source === 'compose' ? 'Compose' : app.source === 'testcontainers' ? 'Testcontainers' : '—')
```

`web/src/pages/AppDetail.tsx`:

1. After line 34 (`const isCompose = ...`):

```tsx
  const isTestcontainers = app.source === 'testcontainers'
```

2. In the per-panel controls function (line ~99), widen the guard:

```tsx
    if (!caps.lifecycle || isTestcontainers) return null
```

3. In the header controls (line ~160), widen the condition:

```tsx
          {caps.lifecycle && !isTestcontainers && anyRunning && (
```

Check the file for any other `caps.lifecycle`-gated render (e.g. a whole-instance Start button for stopped apps around line 117) and apply the same `!isTestcontainers` guard so no lifecycle affordance leaks.

- [ ] **Step 4: Run tests + typecheck to verify they pass**

Run: `cd web && npx vitest run && npx tsc -b`
Expected: all tests PASS, tsc clean.

- [ ] **Step 5: Commit**

```bash
git add web/src/types/api.ts web/src/pages/Applications.tsx web/src/pages/AppDetail.tsx web/src/pages/Applications.test.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): testcontainers source label and lifecycle hiding

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 10: Full verification (suite + live end-to-end)

**Files:** none created (verification only; fix regressions where found).

- [ ] **Step 1: Full build and test suite**

```bash
go build ./... && go test ./...
cd web && npx vitest run && npx tsc -b && cd ..
make build
```

Expected: everything passes. (`make build` also compiles the embedded UI — required by the vitest-no-typecheck rule.)

- [ ] **Step 2: Live end-to-end against the Java quickstart**

Preconditions: Docker running. In a second terminal:

```bash
cd /Users/marcduiker/dev/dapr/quickstarts/tutorials/workflow/java/child-workflows
mvn spring-boot:test-run
```

Wait for Spring Boot to report starting on port 8080, then:

```bash
# Start a workflow instance
curl -sS -X POST localhost:8080/start -H 'Content-Type: application/json' -d '["one","two","three"]'
# Run the dashboard (no state store configured!)
go run . --no-open --port 9095
```

Verify via API (UI checks equivalent):

```bash
# 1. The app is discovered with source=testcontainers and a java runtime
curl -s localhost:9095/api/apps | jq '.[] | {appId, source, runtime, appStatus, grpcPort}'
# expect: workflow-patterns-app / testcontainers / java / running / non-zero port

# 2. Workflows list works with NO store (in-memory!) — parent + children with IncludeChildren
curl -s 'localhost:9095/api/workflows?includeChildren=true' | jq '.items | length'
# expect: >= 3 (ParentWorkflow + ChildWorkflow instances)

# 3. Detail + history
ID=$(curl -s 'localhost:9095/api/workflows' | jq -r '.items[0].instanceId')
curl -s "localhost:9095/api/workflows/workflow-patterns-app/$ID" | jq '{name, status, history: (.history | length)}'
# expect: name set, status Completed/Running, history non-empty
```

(Confirm the exact API paths against `pkg/server/workflows.go` route mounts before cURLing; adjust query parameter names to what `parseListQuery` reads.)

- [ ] **Step 3: Verify lifecycle is guarded**

```bash
curl -s -X POST localhost:9095/api/apps/crazy_lamport/actions -H 'Content-Type: application/json' -d '{"target":"all","action":"stop"}' | jq
```

(Adjust path/instance key to the actions route in `pkg/server/apps.go` and the real container name from step 2.) Expect an unsupported-action error, not a stopped container.

- [ ] **Step 4: Stop the quickstart (Ctrl-C the mvn process) and confirm graceful disappearance**

Ryuk removes the containers; within a few seconds `curl -s localhost:9095/api/apps` no longer lists the app, and the workflows list returns to the no-store banner state (`ErrNoStore`) without crashing.

- [ ] **Step 5: Commit any fixes; do not commit if clean**

If steps 1-4 surfaced fixes, commit them individually with descriptive messages. Then hand off to superpowers:finishing-a-development-branch.

---

## Deferred (documented, deliberately out of scope)

- Aspire contract gRPC extension (would let aspire mode use the sidecar source).
- Generic "any containerized daprd" scanner (classify-by-label refactor).
- Upstream `testcontainers-dapr` integration launching the dashboard as a session container.
- "via sidecar" annotation on workflow views (cosmetic; cut per spec option).
- Sidecar connection pruning for dead ports within one session (idle lazy conns are bounded by test reruns; pool closes on shutdown).
