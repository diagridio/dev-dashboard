# Docker Compose App Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-detect Dapr apps started with `docker compose` and give them full dashboard parity: apps list, health, metadata, container logs, resources, workflow browsing, and compose control-plane services.

**Architecture:** A new `ComposeSource` in `pkg/discovery` shells out to docker/podman (`ps` + batched `inspect`), parses daprd flags from sidecar container argv, maps published host ports and bind-mount host paths, and is merged with the existing process-table scanner. A per-project endpoint map feeds connect-time state-store address translation (`compose-host:port` → `localhost:published-port`). The shared exec machinery is extracted from `pkg/controlplane` into `pkg/containerruntime`.

**Tech Stack:** Go (chi, gopsutil, components-contrib), React 19 + TypeScript + Vite, Vitest, docker/podman CLI.

**Spec:** `docs/superpowers/specs/2026-07-04-compose-discovery-design.md`

## Global Constraints

- Go tests are build-tag-gated: every new Go test file starts with `//go:build unit` (or `//go:build integration`); run with `go test -tags unit ./<pkg>/ -run <Name> -v`. The full gate is `make test` (unit + web); `make test-integration` is CI-only.
- **Nothing in `pkg/*` may import `cmd/`.** `pkg/discovery` may import `pkg/containerruntime` but NOT `pkg/controlplane`.
- The dashboard is read-only except allowlisted actions: never allow lifecycle verbs on arbitrary containers — only fixed `dapr_*` names plus container names the compose scan itself identified as placement/scheduler.
- No new Go module dependencies (docker is invoked via CLI, never via SDK). No compose YAML parsing.
- Frontend follows `web/STYLEGUIDE.md` (theme.css tokens, no hex literals, className prefixes); `src/test/styleguide.test.ts` enforces this.
- Frontend API types mirror Go JSON tags exactly (camelCase).
- Commit after every task; conventional-commit messages.

---

### Task 1: Extract `pkg/containerruntime` from `pkg/controlplane`

The docker/podman resolution + exec runner currently live unexported in `pkg/controlplane/runtime.go`. Move them to a shared package so `pkg/discovery` can use them without importing `controlplane`.

**Files:**
- Create: `pkg/containerruntime/runtime.go`
- Create: `pkg/containerruntime/runtime_test.go`
- Delete: `pkg/controlplane/runtime.go`, `pkg/controlplane/runtime_test.go`
- Modify: `pkg/controlplane/types.go` (RuntimeKind becomes an alias)
- Modify: `pkg/controlplane/service.go` (use the new package)
- Modify: `pkg/controlplane/service_test.go` (fakeRunner method names)

**Interfaces:**
- Produces: `containerruntime.Kind` (string; constants `Docker`, `Podman`, `None`), `containerruntime.Runner` interface with `Run(ctx context.Context, args ...string) ([]byte, error)` and `Stream(ctx context.Context, args ...string) (<-chan string, error)`, `containerruntime.Resolve(env string, look func(string) (string, error)) Kind`, `containerruntime.NewExecRunner(kind Kind) Runner`, `containerruntime.Detect() (Kind, Runner)` (Runner is nil when Kind is None). Tasks 4, 5, 7, and 9 consume these.

- [ ] **Step 1: Write the failing test**

Create `pkg/containerruntime/runtime_test.go`. Port the existing resolve tests from `pkg/controlplane/runtime_test.go` (read that file first — keep its cases) under the new exported names, plus a `Detect` nil-runner assertion:

```go
//go:build unit

package containerruntime

import (
	"errors"
	"testing"
)

func TestResolve(t *testing.T) {
	found := func(string) (string, error) { return "/usr/bin/x", nil }
	notFound := func(string) (string, error) { return "", errors.New("not found") }
	onlyPodman := func(bin string) (string, error) {
		if bin == "podman" {
			return "/usr/bin/podman", nil
		}
		return "", errors.New("not found")
	}

	if got := Resolve("docker", notFound); got != Docker {
		t.Fatalf("env override docker: got %q", got)
	}
	if got := Resolve("podman", notFound); got != Podman {
		t.Fatalf("env override podman: got %q", got)
	}
	if got := Resolve("", found); got != Docker {
		t.Fatalf("docker preferred: got %q", got)
	}
	if got := Resolve("", onlyPodman); got != Podman {
		t.Fatalf("podman fallback: got %q", got)
	}
	if got := Resolve("", notFound); got != None {
		t.Fatalf("none: got %q", got)
	}
	if got := Resolve("nonsense", notFound); got != None {
		t.Fatalf("invalid env ignored: got %q", got)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/containerruntime/ -v`
Expected: FAIL — package does not exist.

- [ ] **Step 3: Create the package**

Create `pkg/containerruntime/runtime.go` by moving the entire contents of `pkg/controlplane/runtime.go` and exporting the names. The `Stream` body is moved **verbatim** from the old `stream` (keep every comment — the pipe/cancellation logic is subtle and battle-tested):

```go
// Package containerruntime resolves the local container runtime (docker or
// podman) and executes its CLI. Shared by pkg/controlplane and pkg/discovery.
package containerruntime

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Kind identifies the resolved container runtime.
type Kind string

const (
	Docker Kind = "docker"
	Podman Kind = "podman"
	None   Kind = ""
)

// Runner executes runtime subcommands: Run returns stdout; Stream emits lines.
type Runner interface {
	Run(ctx context.Context, args ...string) ([]byte, error)
	Stream(ctx context.Context, args ...string) (<-chan string, error)
}

// Resolve picks the container runtime: an explicit valid env override, else
// docker (preferred) then podman via look, else None.
func Resolve(env string, look func(string) (string, error)) Kind {
	switch Kind(env) {
	case Docker, Podman:
		return Kind(env)
	}
	if _, err := look(string(Docker)); err == nil {
		return Docker
	}
	if _, err := look(string(Podman)); err == nil {
		return Podman
	}
	return None
}

// Detect resolves from DASH_CONTAINER_RUNTIME + PATH. Runner is nil when Kind
// is None.
func Detect() (Kind, Runner) {
	kind := Resolve(os.Getenv("DASH_CONTAINER_RUNTIME"), exec.LookPath)
	if kind == None {
		return None, nil
	}
	return kind, NewExecRunner(kind)
}

// execRunner runs the resolved runtime binary via os/exec.
type execRunner struct{ bin string }

// NewExecRunner returns a Runner invoking the kind's CLI binary.
func NewExecRunner(kind Kind) Runner { return &execRunner{bin: string(kind)} }

func (r *execRunner) Run(ctx context.Context, args ...string) ([]byte, error) {
	// ... body of the old run(), verbatim ...
}

func (r *execRunner) Stream(ctx context.Context, args ...string) (<-chan string, error) {
	// ... body of the old stream(), verbatim, including all comments ...
}
```

- [ ] **Step 4: Point `pkg/controlplane` at the new package**

Delete `pkg/controlplane/runtime.go` and `pkg/controlplane/runtime_test.go` (their resolve tests now live in the new package; if `runtime_test.go` also tested `stream` behavior, move those tests to `pkg/containerruntime/runtime_test.go` too, renaming `run`/`stream` → `Run`/`Stream`).

In `pkg/controlplane/types.go`:

```go
import "github.com/diagridio/dev-dashboard/pkg/containerruntime"

// RuntimeKind identifies the resolved container runtime.
type RuntimeKind = containerruntime.Kind

const (
	RuntimeDocker = containerruntime.Docker
	RuntimePodman = containerruntime.Podman
	RuntimeNone   = containerruntime.None
)
```

In `pkg/controlplane/service.go`:
- change the `manager.run` field type from `runner` to `containerruntime.Runner`
- change `New()` to `kind, run := containerruntime.Detect(); return newManager(kind, run)` (nil run when None — same as before)
- change `newManager` parameter type to `containerruntime.Runner`
- rename every `m.run.run(` → `m.run.Run(` and `m.run.stream(` → `m.run.Stream(`

In `pkg/controlplane/service_test.go`, rename the `fakeRunner` methods `run` → `Run` and `stream` → `Stream` (signatures unchanged) so it satisfies `containerruntime.Runner`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/containerruntime/ ./pkg/controlplane/ ./cmd/... -count=1`
Expected: PASS (all pre-existing controlplane behavior intact).

- [ ] **Step 6: Commit**

```bash
git add pkg/containerruntime pkg/controlplane
git commit -m "refactor(controlplane): extract shared pkg/containerruntime"
```

---

### Task 2: daprd argv flag parsing

**Files:**
- Create: `pkg/discovery/compose_args.go`
- Create: `pkg/discovery/compose_args_test.go`

**Interfaces:**
- Produces: `parseDaprdArgs(argv []string) (daprdArgs, bool)` where `daprdArgs{AppID, AppChannelAddress, ResourcesPath, ConfigPath string; AppPort, HTTPPort, GRPCPort int}`. `ok` is false when argv doesn't invoke daprd. HTTPPort defaults to 3500, GRPCPort to 50001 (daprd's own defaults) when flags are absent. Task 4 consumes this.

- [ ] **Step 1: Write the failing test**

Create `pkg/discovery/compose_args_test.go`:

```go
//go:build unit

package discovery

import (
	"reflect"
	"testing"
)

func TestParseDaprdArgs(t *testing.T) {
	tests := []struct {
		name string
		argv []string
		want daprdArgs
		ok   bool
	}{
		{
			name: "saga compose style single-dash space-separated",
			argv: []string{"./daprd", "-app-id", "primes-go", "-app-channel-address", "primes-go",
				"-app-port", "8080", "-dapr-http-port", "3500", "-dapr-grpc-port", "50001",
				"-placement-host-address", "placement:50005",
				"-resources-path", "/components", "-config", "/dapr_config/config.yml",
				"-log-level", "info"},
			want: daprdArgs{AppID: "primes-go", AppChannelAddress: "primes-go",
				ResourcesPath: "/components", ConfigPath: "/dapr_config/config.yml",
				AppPort: 8080, HTTPPort: 3500, GRPCPort: 50001},
			ok: true,
		},
		{
			name: "double-dash equals forms with absolute binary path",
			argv: []string{"/daprd", "--app-id=orders", "--dapr-http-port=3501", "--components-path=/comps"},
			want: daprdArgs{AppID: "orders", ResourcesPath: "/comps", HTTPPort: 3501, GRPCPort: 50001},
			ok:   true,
		},
		{
			name: "defaults applied when port flags absent",
			argv: []string{"./daprd", "-app-id", "web"},
			want: daprdArgs{AppID: "web", HTTPPort: 3500, GRPCPort: 50001},
			ok:   true,
		},
		{
			name: "not daprd",
			argv: []string{"./placement", "-port", "50005"},
			ok:   false,
		},
		{
			name: "empty argv",
			argv: nil,
			ok:   false,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := parseDaprdArgs(tt.argv)
			if ok != tt.ok {
				t.Fatalf("ok = %v, want %v", ok, tt.ok)
			}
			if ok && !reflect.DeepEqual(got, tt.want) {
				t.Fatalf("got %+v, want %+v", got, tt.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestParseDaprdArgs -v`
Expected: FAIL — `undefined: daprdArgs`.

- [ ] **Step 3: Implement**

Create `pkg/discovery/compose_args.go`:

```go
package discovery

import (
	"path"
	"strconv"
	"strings"
)

// daprdArgs is the subset of daprd flags the compose scanner consumes.
type daprdArgs struct {
	AppID             string
	AppChannelAddress string
	ResourcesPath     string
	ConfigPath        string
	AppPort           int
	HTTPPort          int // container-internal; defaults to 3500 like daprd itself
	GRPCPort          int // container-internal; defaults to 50001 like daprd itself
}

// parseDaprdArgs extracts daprd flags from a container's argv (entrypoint+cmd).
// ok is false when argv does not invoke daprd (no token whose basename is
// "daprd"). Accepts -flag value, --flag value, and -flag=value forms.
func parseDaprdArgs(argv []string) (daprdArgs, bool) {
	start := -1
	for i, tok := range argv {
		if path.Base(tok) == "daprd" {
			start = i
			break
		}
	}
	if start == -1 {
		return daprdArgs{}, false
	}
	flags := map[string]string{}
	rest := argv[start+1:]
	for i := 0; i < len(rest); i++ {
		tok := rest[i]
		if !strings.HasPrefix(tok, "-") {
			continue
		}
		name := strings.TrimLeft(tok, "-")
		if eq := strings.IndexByte(name, '='); eq >= 0 {
			flags[name[:eq]] = name[eq+1:]
			continue
		}
		if i+1 < len(rest) && !strings.HasPrefix(rest[i+1], "-") {
			flags[name] = rest[i+1]
			i++
		}
	}
	atoi := func(s string) int { n, _ := strconv.Atoi(s); return n }
	d := daprdArgs{
		AppID:             flags["app-id"],
		AppChannelAddress: flags["app-channel-address"],
		ResourcesPath:     flags["resources-path"],
		ConfigPath:        flags["config"],
		AppPort:           atoi(flags["app-port"]),
		HTTPPort:          atoi(flags["dapr-http-port"]),
		GRPCPort:          atoi(flags["dapr-grpc-port"]),
	}
	if d.ResourcesPath == "" {
		d.ResourcesPath = flags["components-path"] // legacy daprd flag
	}
	if d.HTTPPort == 0 {
		d.HTTPPort = 3500
	}
	if d.GRPCPort == 0 {
		d.GRPCPort = 50001
	}
	return d, true
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestParseDaprdArgs -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/compose_args.go pkg/discovery/compose_args_test.go
git commit -m "feat(discovery): parse daprd flags from container argv"
```

---

### Task 3: Compose `docker inspect` parsing + mount path translation

**Files:**
- Create: `pkg/discovery/compose_inspect.go`
- Create: `pkg/discovery/compose_inspect_test.go`
- Create: `pkg/discovery/testdata/compose_inspect.json`

**Interfaces:**
- Produces: `parseComposeContainers(data []byte) ([]composeContainer, error)` with `composeContainer{ID, Name, Image, Project, Service string; Running bool; StartedAt time.Time; Argv []string; Ports map[int]int; Mounts map[string]string}` (Ports: container tcp port → published host port; Mounts: container destination → host source, bind mounts only). Also `TranslateMountPath(mounts map[string]string, containerPath string) (string, bool)` (exported — Task 8's reconciler uses it too). Task 4 consumes both.

- [ ] **Step 1: Create the fixture**

Create `pkg/discovery/testdata/compose_inspect.json` — a trimmed 3-container batched inspect (sidecar + app + postgres) mirroring the saga compose file's shapes:

```json
[
  {
    "Id": "aaa111",
    "Name": "/saga-primes-go-dapr-1",
    "State": { "Status": "running", "StartedAt": "2026-07-04T09:00:00.000000000Z" },
    "Config": {
      "Image": "daprio/daprd:1.15.0",
      "Labels": {
        "com.docker.compose.project": "saga",
        "com.docker.compose.service": "primes-go-dapr",
        "com.docker.compose.project.config_files": "/Users/dev/saga/docker-compose.yml"
      },
      "Entrypoint": null,
      "Cmd": ["./daprd", "-app-id", "primes-go", "-app-channel-address", "primes-go", "-app-port", "8080", "-dapr-http-port", "3500", "-dapr-grpc-port", "50001", "-resources-path", "/components", "-config", "/dapr_config/config.yml"]
    },
    "NetworkSettings": { "Ports": { "3500/tcp": [ { "HostIp": "0.0.0.0", "HostPort": "3500" } ], "50001/tcp": null } },
    "Mounts": [
      { "Type": "bind", "Source": "/Users/dev/saga/components", "Destination": "/components" },
      { "Type": "bind", "Source": "/Users/dev/saga/dapr_config", "Destination": "/dapr_config" }
    ]
  },
  {
    "Id": "bbb222",
    "Name": "/saga-primes-go-1",
    "State": { "Status": "running", "StartedAt": "2026-07-04T08:59:58.000000000Z" },
    "Config": {
      "Image": "saga-primes-go",
      "Labels": { "com.docker.compose.project": "saga", "com.docker.compose.service": "primes-go" },
      "Entrypoint": ["/app/server"],
      "Cmd": null
    },
    "NetworkSettings": { "Ports": { "8080/tcp": [ { "HostIp": "0.0.0.0", "HostPort": "8081" } ] } },
    "Mounts": []
  },
  {
    "Id": "ccc333",
    "Name": "/saga-postgres-db-1",
    "State": { "Status": "running", "StartedAt": "2026-07-04T08:59:50.000000000Z" },
    "Config": {
      "Image": "postgres:16.2-alpine",
      "Labels": { "com.docker.compose.project": "saga", "com.docker.compose.service": "postgres-db" },
      "Entrypoint": ["docker-entrypoint.sh"],
      "Cmd": ["postgres"]
    },
    "NetworkSettings": { "Ports": { "5432/tcp": [ { "HostIp": "0.0.0.0", "HostPort": "5432" } ] } },
    "Mounts": [ { "Type": "volume", "Source": "saga_postgres-data", "Destination": "/var/lib/postgresql/data" } ]
  }
]
```

- [ ] **Step 2: Write the failing test**

Create `pkg/discovery/compose_inspect_test.go`:

```go
//go:build unit

package discovery

import (
	"os"
	"testing"
)

func TestParseComposeContainers(t *testing.T) {
	data, err := os.ReadFile("testdata/compose_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	got, err := parseComposeContainers(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 {
		t.Fatalf("want 3 containers, got %d", len(got))
	}
	sc := got[0]
	if sc.Name != "saga-primes-go-dapr-1" || sc.Project != "saga" || sc.Service != "primes-go-dapr" {
		t.Fatalf("sidecar identity: %+v", sc)
	}
	if !sc.Running || sc.StartedAt.IsZero() {
		t.Fatalf("sidecar state: %+v", sc)
	}
	if sc.Argv[0] != "./daprd" {
		t.Fatalf("argv should combine entrypoint+cmd: %v", sc.Argv)
	}
	if sc.Ports[3500] != 3500 {
		t.Fatalf("published port: %v", sc.Ports)
	}
	if _, ok := sc.Ports[50001]; ok {
		t.Fatalf("unpublished port must be absent: %v", sc.Ports)
	}
	if sc.Mounts["/components"] != "/Users/dev/saga/components" {
		t.Fatalf("mounts: %v", sc.Mounts)
	}
	app := got[1]
	if app.Argv[0] != "/app/server" {
		t.Fatalf("entrypoint-only argv: %v", app.Argv)
	}
	pg := got[2]
	if len(pg.Mounts) != 0 {
		t.Fatalf("named volume must not appear in bind mounts: %v", pg.Mounts)
	}
	if pg.Ports[5432] != 5432 {
		t.Fatalf("postgres port: %v", pg.Ports)
	}
}

func TestParseComposeContainersSkipsUnlabelled(t *testing.T) {
	data := []byte(`[{"Id":"x","Name":"/plain","Config":{"Labels":{}}}]`)
	got, err := parseComposeContainers(data)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("unlabelled container must be skipped, got %d", len(got))
	}
}

func TestTranslateMountPath(t *testing.T) {
	mounts := map[string]string{"/components": "/host/components", "/dapr_config": "/host/cfg"}
	tests := []struct {
		in   string
		want string
		ok   bool
	}{
		{"/components", "/host/components", true},
		{"/dapr_config/config.yml", "/host/cfg/config.yml", true},
		{"/components/sub/state.yaml", "/host/components/sub/state.yaml", true},
		{"/componentsX", "", false},
		{"/elsewhere/db.sqlite", "", false},
	}
	for _, tt := range tests {
		got, ok := TranslateMountPath(mounts, tt.in)
		if ok != tt.ok || got != tt.want {
			t.Fatalf("TranslateMountPath(%q) = %q,%v want %q,%v", tt.in, got, ok, tt.want, tt.ok)
		}
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/ -run 'TestParseComposeContainers|TestTranslateMountPath' -v`
Expected: FAIL — `undefined: parseComposeContainers`.

- [ ] **Step 4: Implement**

Create `pkg/discovery/compose_inspect.go`:

```go
package discovery

import (
	"encoding/json"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	labelComposeProject = "com.docker.compose.project"
	labelComposeService = "com.docker.compose.service"
)

// composeContainer is the parsed subset of `docker inspect` for one
// compose-managed container.
type composeContainer struct {
	ID        string
	Name      string
	Image     string
	Project   string
	Service   string
	Running   bool
	StartedAt time.Time
	Argv      []string          // entrypoint + cmd
	Ports     map[int]int       // container tcp port -> published host port
	Mounts    map[string]string // container destination -> host source (bind only)
}

// rawComposeContainer mirrors the subset of `<runtime> inspect` we consume.
type rawComposeContainer struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	State struct {
		Status    string `json:"Status"`
		StartedAt string `json:"StartedAt"`
	} `json:"State"`
	Config struct {
		Image      string            `json:"Image"`
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
	NetworkSettings struct {
		Ports map[string][]struct {
			HostPort string `json:"HostPort"`
		} `json:"Ports"`
	} `json:"NetworkSettings"`
	Mounts []struct {
		Type        string `json:"Type"`
		Source      string `json:"Source"`
		Destination string `json:"Destination"`
	} `json:"Mounts"`
}

// parseComposeContainers decodes a batched inspect array, keeping only
// compose-labelled containers.
func parseComposeContainers(data []byte) ([]composeContainer, error) {
	var raw []rawComposeContainer
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	out := make([]composeContainer, 0, len(raw))
	for _, r := range raw {
		project := r.Config.Labels[labelComposeProject]
		if project == "" {
			continue
		}
		c := composeContainer{
			ID:      r.ID,
			Name:    strings.TrimPrefix(r.Name, "/"),
			Image:   r.Config.Image,
			Project: project,
			Service: r.Config.Labels[labelComposeService],
			Running: r.State.Status == "running",
			Argv:    append(append([]string{}, r.Config.Entrypoint...), r.Config.Cmd...),
			Ports:   map[int]int{},
			Mounts:  map[string]string{},
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

// TranslateMountPath maps a container-internal path to its host path via a
// bind-mount table (exact destination match or destination-prefix match).
// Container paths are always slash-separated (Linux containers).
func TranslateMountPath(mounts map[string]string, containerPath string) (string, bool) {
	p := strings.TrimSuffix(containerPath, "/")
	for dest, src := range mounts {
		d := strings.TrimSuffix(dest, "/")
		if p == d {
			return src, true
		}
		if strings.HasPrefix(p, d+"/") {
			return filepath.Join(src, filepath.FromSlash(strings.TrimPrefix(p, d+"/"))), true
		}
	}
	return "", false
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/discovery/ -run 'TestParseComposeContainers|TestTranslateMountPath' -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery/compose_inspect.go pkg/discovery/compose_inspect_test.go pkg/discovery/testdata/compose_inspect.json
git commit -m "feat(discovery): parse compose container inspect data"
```

---

### Task 4: `ComposeSource` scanner + new ScanResult/Instance fields

**Files:**
- Modify: `pkg/discovery/service.go` (ScanResult fields)
- Modify: `pkg/discovery/types.go` (Instance fields)
- Modify: `pkg/discovery/scan_standalone.go` (set Source + SidecarReachable)
- Create: `pkg/discovery/scan_compose.go`
- Create: `pkg/discovery/scan_compose_test.go`

**Interfaces:**
- Consumes: `parseDaprdArgs` (Task 2), `parseComposeContainers` / `TranslateMountPath` (Task 3), `containerruntime.Runner` (Task 1).
- Produces:
  - constants `SourceStandalone = "standalone"`, `SourceCompose = "compose"`
  - `ScanResult` gains: `Source, ComposeProject, ComposeService, DaprdContainerID, DaprdContainerName, AppContainerID, AppContainerName, AppImage string; SidecarReachable bool`
  - `Instance` gains the same (minus AppImage) with JSON tags: `source`, `composeProject`, `composeService`, `daprdContainerId`, `daprdContainerName`, `appContainerId`, `appContainerName`, `sidecarReachable`
  - `NewComposeSource(run containerruntime.Runner) *ComposeSource` with `Scanner() Scanner` and `Env() ComposeEnv`
  - `ComposeEnv{Projects map[string]ComposeProject; PathProject map[string]string}` with `ProjectForPath(p string) (string, bool)`; `ComposeProject{ServicePorts map[string]map[int]int; Mounts map[string]string}`. Tasks 5, 6, 8 consume these.

- [ ] **Step 1: Add the new fields**

In `pkg/discovery/service.go`, extend `ScanResult`:

```go
type ScanResult struct {
	AppID         string
	HTTPPort      int
	GRPCPort      int
	AppPort       int
	DaprdPID      int
	CLIPID        int
	Created       time.Time
	RunTemplate   string
	ResourcePaths []string
	ConfigPath    string
	Command       string

	// Source is SourceStandalone (process table) or SourceCompose (containers).
	Source             string
	ComposeProject     string
	ComposeService     string
	DaprdContainerID   string
	DaprdContainerName string
	AppContainerID     string
	AppContainerName   string
	AppImage           string
	// SidecarReachable is false only for compose sidecars whose HTTP port is
	// not published to the host (metadata/health enrichment impossible).
	SidecarReachable bool
}
```

In `pkg/discovery/types.go`, add to `Instance` (after `IsAspire`):

```go
	Source             string `json:"source"`                       // "standalone" | "compose"
	ComposeProject     string `json:"composeProject,omitempty"`
	ComposeService     string `json:"composeService,omitempty"`
	DaprdContainerID   string `json:"daprdContainerId,omitempty"`
	DaprdContainerName string `json:"daprdContainerName,omitempty"`
	AppContainerID     string `json:"appContainerId,omitempty"`
	AppContainerName   string `json:"appContainerName,omitempty"`
	SidecarReachable   bool   `json:"sidecarReachable"`
```

In `pkg/discovery/scan_standalone.go`, add to the `ScanResult{...}` literal:

```go
	Source:           SourceStandalone,
	SidecarReachable: true,
```

Define the constants in `pkg/discovery/service.go` (next to `ErrNotFound`):

```go
const (
	SourceStandalone = "standalone"
	SourceCompose    = "compose"
)
```

- [ ] **Step 2: Write the failing scanner test**

Create `pkg/discovery/scan_compose_test.go`. `fakeCRT` keys commands on their first two args, like controlplane's fakeRunner:

```go
//go:build unit

package discovery

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"
)

type fakeCRT struct {
	responses map[string][]byte // key: first two args joined by space
	errs      map[string]error
	calls     []string
}

func (f *fakeCRT) key(args []string) string {
	if len(args) >= 2 {
		return args[0] + " " + args[1]
	}
	return strings.Join(args, " ")
}

func (f *fakeCRT) Run(_ context.Context, args ...string) ([]byte, error) {
	k := f.key(args)
	f.calls = append(f.calls, k)
	if err, ok := f.errs[k]; ok {
		return nil, err
	}
	return f.responses[k], nil
}

func (f *fakeCRT) Stream(context.Context, ...string) (<-chan string, error) {
	return nil, errors.New("not used")
}

func newFakeCRT(t *testing.T) *fakeCRT {
	t.Helper()
	inspect, err := os.ReadFile("testdata/compose_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	return &fakeCRT{responses: map[string][]byte{
		"ps -q":           []byte("aaa111\nbbb222\nccc333\n"),
		"inspect aaa111":  inspect,
	}}
}

func TestComposeSourceScan(t *testing.T) {
	crt := newFakeCRT(t)
	src := NewComposeSource(crt)
	results, err := src.Scanner()()
	if err != nil {
		t.Fatal(err)
	}
	if len(results) != 1 {
		t.Fatalf("want 1 sidecar, got %d: %+v", len(results), results)
	}
	r := results[0]
	if r.AppID != "primes-go" || r.Source != SourceCompose {
		t.Fatalf("identity: %+v", r)
	}
	if r.HTTPPort != 3500 {
		t.Fatalf("host http port: %+v", r)
	}
	if r.GRPCPort != 0 {
		t.Fatalf("unpublished grpc port must be 0: %+v", r)
	}
	if !r.SidecarReachable {
		t.Fatalf("published http port => reachable: %+v", r)
	}
	if r.ComposeProject != "saga" || r.ComposeService != "primes-go-dapr" {
		t.Fatalf("compose labels: %+v", r)
	}
	if r.DaprdContainerID != "aaa111" || r.AppContainerID != "bbb222" || r.AppContainerName != "saga-primes-go-1" {
		t.Fatalf("container pairing: %+v", r)
	}
	if r.AppImage != "saga-primes-go" {
		t.Fatalf("app image: %+v", r)
	}
	if len(r.ResourcePaths) != 1 || r.ResourcePaths[0] != "/Users/dev/saga/components" {
		t.Fatalf("host resource path: %+v", r.ResourcePaths)
	}
	if r.ConfigPath != "/Users/dev/saga/dapr_config/config.yml" {
		t.Fatalf("host config path: %q", r.ConfigPath)
	}

	env := src.Env()
	if env.Projects["saga"].ServicePorts["postgres-db"][5432] != 5432 {
		t.Fatalf("endpoint map: %+v", env.Projects)
	}
	if proj, ok := env.ProjectForPath("/Users/dev/saga/components/statestore.yaml"); !ok || proj != "saga" {
		t.Fatalf("ProjectForPath: %q %v", proj, ok)
	}
	if _, ok := env.ProjectForPath("/somewhere/else.yaml"); ok {
		t.Fatal("foreign path must not match")
	}
}

func TestComposeSourceNilRunner(t *testing.T) {
	src := NewComposeSource(nil)
	results, err := src.Scanner()()
	if err != nil || results != nil {
		t.Fatalf("nil runner must be a silent no-op, got %v %v", results, err)
	}
}

func TestComposeSourceNoContainers(t *testing.T) {
	crt := &fakeCRT{responses: map[string][]byte{"ps -q": []byte("")}}
	src := NewComposeSource(crt)
	results, err := src.Scanner()()
	if err != nil || len(results) != 0 {
		t.Fatalf("empty ps => no results, got %v %v", results, err)
	}
}

func TestComposeSourceCachesResults(t *testing.T) {
	crt := newFakeCRT(t)
	src := NewComposeSource(crt)
	now := time.Now()
	src.clock = func() time.Time { return now }
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	callsAfterFirst := len(crt.calls)
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	if len(crt.calls) != callsAfterFirst {
		t.Fatalf("second scan within TTL must hit the cache: %v", crt.calls)
	}
	now = now.Add(3 * time.Second)
	if _, err := src.Scanner()(); err != nil {
		t.Fatal(err)
	}
	if len(crt.calls) == callsAfterFirst {
		t.Fatal("scan after TTL must re-exec")
	}
}

func TestComposeSourceErrorPropagates(t *testing.T) {
	crt := &fakeCRT{errs: map[string]error{"ps -q": errors.New("daemon down")}}
	src := NewComposeSource(crt)
	if _, err := src.Scanner()(); err == nil {
		t.Fatal("ps failure must surface as an error (Merge handles it)")
	}
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/ -run TestComposeSource -v`
Expected: FAIL — `undefined: NewComposeSource`.

- [ ] **Step 4: Implement `pkg/discovery/scan_compose.go`**

```go
package discovery

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
)

const (
	composeScanTimeout = 3 * time.Second
	// composeCacheTTL keeps 1s SPA polling from causing exec storms.
	composeCacheTTL = 2 * time.Second
)

// ComposeProject is the host-reachable view of one compose project.
type ComposeProject struct {
	// ServicePorts maps service name -> container port -> published host port.
	ServicePorts map[string]map[int]int
	// Mounts maps container destination -> host source, merged across the
	// project's daprd sidecars (first destination wins). Used for SQLite
	// connection-path translation.
	Mounts map[string]string
}

// ComposeEnv is the compose network/mount context from the last scan. The
// reconciler uses it to translate store addresses to host-reachable ones.
type ComposeEnv struct {
	Projects map[string]ComposeProject
	// PathProject maps each host resource/config dir found on a sidecar to its
	// compose project name.
	PathProject map[string]string
}

// ProjectForPath returns the compose project owning p (p equal to, or nested
// under, one of the scanned host resource dirs).
func (e ComposeEnv) ProjectForPath(p string) (string, bool) {
	abs, err := filepath.Abs(p)
	if err != nil {
		abs = p
	}
	for dir, proj := range e.PathProject {
		d, err := filepath.Abs(dir)
		if err != nil {
			d = dir
		}
		if abs == d {
			return proj, true
		}
		rel, err := filepath.Rel(d, abs)
		if err == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
			return proj, true
		}
	}
	return "", false
}

// ComposeSource discovers Dapr sidecars running in compose-managed containers.
// A nil runner (no docker/podman) degrades to an empty, error-free scan.
type ComposeSource struct {
	run   containerruntime.Runner
	clock func() time.Time // injectable for cache tests

	mu      sync.Mutex
	last    time.Time
	results []ScanResult
	env     ComposeEnv
	lastErr error
}

func NewComposeSource(run containerruntime.Runner) *ComposeSource {
	return &ComposeSource{run: run, clock: time.Now}
}

// Scanner returns the compose scan as a discovery.Scanner.
func (s *ComposeSource) Scanner() Scanner { return s.scan }

// Env returns the compose endpoint/mount context from the last successful scan.
func (s *ComposeSource) Env() ComposeEnv {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.env
}

func (s *ComposeSource) scan() ([]ScanResult, error) {
	if s.run == nil {
		return nil, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.last.IsZero() && s.clock().Sub(s.last) < composeCacheTTL {
		return s.results, s.lastErr
	}
	results, env, err := s.scanOnce()
	s.last = s.clock()
	s.results, s.lastErr = results, err
	if err == nil {
		s.env = env
	}
	return results, err
}

func (s *ComposeSource) scanOnce() ([]ScanResult, ComposeEnv, error) {
	ctx, cancel := context.WithTimeout(context.Background(), composeScanTimeout)
	defer cancel()
	env := ComposeEnv{Projects: map[string]ComposeProject{}, PathProject: map[string]string{}}

	out, err := s.run.Run(ctx, "ps", "-q", "--filter", "label="+labelComposeProject)
	if err != nil {
		return nil, env, fmt.Errorf("compose ps: %w", err)
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil, env, nil
	}
	raw, err := s.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil, env, fmt.Errorf("compose inspect: %w", err)
	}
	containers, err := parseComposeContainers(raw)
	if err != nil {
		return nil, env, fmt.Errorf("compose inspect parse: %w", err)
	}

	// Index every container's published ports; index by project/service for
	// app pairing.
	byProjSvc := map[string]composeContainer{}
	for _, c := range containers {
		byProjSvc[c.Project+"/"+c.Service] = c
		proj, ok := env.Projects[c.Project]
		if !ok {
			proj = ComposeProject{ServicePorts: map[string]map[int]int{}, Mounts: map[string]string{}}
		}
		if len(c.Ports) > 0 {
			proj.ServicePorts[c.Service] = c.Ports
		}
		env.Projects[c.Project] = proj
	}

	var results []ScanResult
	for _, c := range containers {
		if !c.Running {
			continue
		}
		args, ok := parseDaprdArgs(c.Argv)
		if !ok || args.AppID == "" {
			continue
		}
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
		}
		r.SidecarReachable = r.HTTPPort != 0
		if args.ResourcesPath != "" {
			if host, ok := TranslateMountPath(c.Mounts, args.ResourcesPath); ok {
				r.ResourcePaths = []string{host}
				env.PathProject[host] = c.Project
			}
		}
		if args.ConfigPath != "" {
			if host, ok := TranslateMountPath(c.Mounts, args.ConfigPath); ok {
				r.ConfigPath = host
				env.PathProject[filepath.Dir(host)] = c.Project
			}
		}
		// Merge the sidecar's bind mounts into the project mount table.
		proj := env.Projects[c.Project]
		for dest, src := range c.Mounts {
			if _, exists := proj.Mounts[dest]; !exists {
				proj.Mounts[dest] = src
			}
		}
		env.Projects[c.Project] = proj
		// Pair the app container: same project, service named by
		// -app-channel-address (fallback: the app id).
		appSvc := args.AppChannelAddress
		if appSvc == "" {
			appSvc = args.AppID
		}
		if app, ok := byProjSvc[c.Project+"/"+appSvc]; ok {
			r.AppContainerID = app.ID
			r.AppContainerName = app.Name
			r.AppImage = app.Image
		}
		results = append(results, r)
	}
	return results, env, nil
}
```

Note the fake in the test responds to `"inspect aaa111"` — the key is the first two args, so the batched `inspect aaa111 bbb222 ccc333` still keys as `"inspect aaa111"`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -count=1`
Expected: PASS (new tests plus all existing discovery tests — golden tests may need `Source`/`SidecarReachable` added to expected JSON; update goldens per the instructions in `pkg/discovery/golden_test.go` if it has a `-update` flag, otherwise edit the expected files).

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery
git commit -m "feat(discovery): compose container scanner with endpoint map"
```

---

### Task 5: `Merge` scanner + serve wiring

**Files:**
- Create: `pkg/discovery/merge.go`
- Create: `pkg/discovery/merge_test.go`
- Modify: `cmd/root.go` (wire Merge + ComposeSource)
- Modify: `cmd/serve.go` (serveDeps fields, threaded to later tasks)

**Interfaces:**
- Consumes: `Scanner`, `ComposeSource` (Task 4), `containerruntime.Detect` (Task 1).
- Produces: `discovery.Merge(scanners ...Scanner) Scanner` — concatenates results; partial failure is logged and tolerated; error only when ALL scanners fail. `serveDeps` gains `ComposeEnv func() discovery.ComposeEnv` and `ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)` (both nil-safe; consumed by Tasks 7 and 8).

- [ ] **Step 1: Write the failing test**

Create `pkg/discovery/merge_test.go`:

```go
//go:build unit

package discovery

import (
	"errors"
	"testing"
)

func TestMergeConcatenates(t *testing.T) {
	a := func() ([]ScanResult, error) { return []ScanResult{{AppID: "a"}}, nil }
	b := func() ([]ScanResult, error) { return []ScanResult{{AppID: "b"}, {AppID: "c"}}, nil }
	got, err := Merge(a, b)()
	if err != nil || len(got) != 3 {
		t.Fatalf("got %v, %v", got, err)
	}
}

func TestMergeToleratesPartialFailure(t *testing.T) {
	ok := func() ([]ScanResult, error) { return []ScanResult{{AppID: "a"}}, nil }
	bad := func() ([]ScanResult, error) { return nil, errors.New("docker down") }
	got, err := Merge(ok, bad)()
	if err != nil {
		t.Fatalf("one healthy scanner must win: %v", err)
	}
	if len(got) != 1 || got[0].AppID != "a" {
		t.Fatalf("got %v", got)
	}
}

func TestMergeAllFail(t *testing.T) {
	bad := func() ([]ScanResult, error) { return nil, errors.New("boom") }
	if _, err := Merge(bad, bad)(); err == nil {
		t.Fatal("all scanners failing must return an error")
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestMerge -v`
Expected: FAIL — `undefined: Merge`.

- [ ] **Step 3: Implement `pkg/discovery/merge.go`**

```go
package discovery

import "errors"

// Merge combines scanners into one. A failing scanner is logged and skipped so
// one source (e.g. docker being absent) never hides the others; the merged
// scan errors only when every scanner fails.
func Merge(scanners ...Scanner) Scanner {
	return func() ([]ScanResult, error) {
		var out []ScanResult
		var errs []error
		for _, scan := range scanners {
			res, err := scan()
			if err != nil {
				errs = append(errs, err)
				continue
			}
			out = append(out, res...)
		}
		if len(scanners) > 0 && len(errs) == len(scanners) {
			return nil, errors.Join(errs...)
		}
		for _, err := range errs {
			logger().Warn("app scan source failed", "err", err)
		}
		return out, nil
	}
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestMerge -v`
Expected: PASS.

- [ ] **Step 5: Wire into serve**

In `cmd/root.go` `runServe`, replace the `Apps:` line and add the two new deps (import `github.com/diagridio/dev-dashboard/pkg/containerruntime`):

```go
	_, crtRunner := containerruntime.Detect()
	composeSrc := discovery.NewComposeSource(crtRunner)
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:       basePath,
		StateStorePath: stateStore,
		Namespace:      namespace,
		Apps: discovery.New(
			discovery.Merge(discovery.StandaloneScanner(), composeSrc.Scanner()),
			&http.Client{Timeout: 2 * time.Second}),
		HomeDir:       home,
		HTTPClient:    &http.Client{Timeout: 10 * time.Second},
		ComposeEnv:    composeSrc.Env,
		ContainerLogs: containerLogStream(crtRunner),
	}, dist)
```

In `cmd/serve.go`, extend `serveDeps` and add the helper:

```go
type serveDeps struct {
	BasePath       string
	StateStorePath string
	Namespace      string
	Apps           discovery.Service
	HomeDir        string
	HTTPClient     *http.Client
	// ComposeEnv returns the compose endpoint/mount context from the last
	// compose scan; nil when compose discovery is disabled (tests, no runtime).
	ComposeEnv func() discovery.ComposeEnv
	// ContainerLogs streams `docker logs -f` for a container id; nil when no
	// container runtime is available.
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
}

// containerLogStream adapts a runtime Runner into the log-stream dependency.
// Returns nil (feature disabled) when run is nil.
func containerLogStream(run containerruntime.Runner) func(context.Context, string) (<-chan string, error) {
	if run == nil {
		return nil
	}
	return func(ctx context.Context, id string) (<-chan string, error) {
		return run.Stream(ctx, "logs", "-f", "--tail", "200", id)
	}
}
```

(`containerLogStream` lives in `cmd/serve.go`; `ComposeEnv`/`ContainerLogs` are consumed in Tasks 7–8 — until then they are carried but unused, which compiles fine for struct fields.)

- [ ] **Step 6: Build + full unit gate**

Run: `go build ./... && go test -tags unit -race ./... -count=1`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add pkg/discovery/merge.go pkg/discovery/merge_test.go cmd/root.go cmd/serve.go
git commit -m "feat(discovery): merge standalone and compose scanners into serve wiring"
```

---

### Task 6: Enrichment for compose instances

**Files:**
- Modify: `pkg/discovery/service.go` (`enrich`)
- Modify: `pkg/discovery/infer.go` (+ `InferRuntimeFromImage`)
- Modify: `pkg/discovery/infer_test.go`
- Modify: `pkg/discovery/service_test.go`

**Interfaces:**
- Consumes: ScanResult fields from Task 4.
- Produces: enriched compose `Instance`s — unreachable sidecars skip all HTTP calls; compose instances never run `lsof`/DCP/`appRuntime` logic; `InferRuntimeFromImage(image string) string`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/discovery/service_test.go` (reuse the file's existing test-server helpers for metadata/health endpoints — read them first and follow the same pattern):

```go
func TestEnrichComposeUnreachableSkipsHTTP(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
	}))
	defer srv.Close()
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "x", Source: SourceCompose, SidecarReachable: false, HTTPPort: 0}}, nil
	}
	svc := New(scan, srv.Client())
	apps, err := svc.List(context.Background())
	if err != nil || len(apps) != 1 {
		t.Fatalf("%v %v", apps, err)
	}
	in := apps[0]
	if calls != 0 {
		t.Fatalf("unreachable sidecar must not be probed, got %d calls", calls)
	}
	if in.Health != HealthUnknown || in.MetadataOK || in.SidecarReachable {
		t.Fatalf("degraded fields: %+v", in)
	}
	if in.Source != SourceCompose {
		t.Fatalf("source: %+v", in)
	}
}

func TestEnrichComposeCarriesContainerFields(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{
			AppID: "primes-go", Source: SourceCompose, SidecarReachable: false,
			ComposeProject: "saga", ComposeService: "primes-go-dapr",
			DaprdContainerID: "aaa", DaprdContainerName: "saga-primes-go-dapr-1",
			AppContainerID: "bbb", AppContainerName: "saga-primes-go-1",
			AppImage: "python:3.12-slim",
		}}, nil
	}
	svc := New(scan, http.DefaultClient)
	apps, _ := svc.List(context.Background())
	in := apps[0]
	if in.ComposeProject != "saga" || in.DaprdContainerID != "aaa" || in.AppContainerName != "saga-primes-go-1" {
		t.Fatalf("container fields lost: %+v", in)
	}
	if in.Runtime != "python" {
		t.Fatalf("runtime from image: %q", in.Runtime)
	}
	if in.IsAspire {
		t.Fatalf("compose app must never be Aspire: %+v", in)
	}
}
```

Add to `pkg/discovery/infer_test.go`:

```go
func TestInferRuntimeFromImage(t *testing.T) {
	tests := map[string]string{
		"golang:1.24":          "go",
		"python:3.12-slim":     "python",
		"node:22-alpine":       "node",
		"mcr.microsoft.com/dotnet/aspnet:9.0": "dotnet",
		"eclipse-temurin:21":   "java",
		"openjdk:21":           "java",
		"saga-primes-go":       "unknown",
		"":                     "unknown",
	}
	for image, want := range tests {
		if got := InferRuntimeFromImage(image); got != want {
			t.Fatalf("InferRuntimeFromImage(%q) = %q, want %q", image, got, want)
		}
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/ -run 'TestEnrichCompose|TestInferRuntimeFromImage' -v`
Expected: FAIL.

- [ ] **Step 3: Implement**

Add to `pkg/discovery/infer.go`:

```go
// InferRuntimeFromImage guesses the app's language from its container image
// name (best-effort; conservative — a bespoke image name yields "unknown").
func InferRuntimeFromImage(image string) string {
	c := strings.ToLower(image)
	switch {
	case c == "":
		return "unknown"
	case strings.Contains(c, "golang"):
		return "go"
	case strings.Contains(c, "python"):
		return "python"
	case strings.Contains(c, "node"):
		return "node"
	case strings.Contains(c, "dotnet"), strings.Contains(c, "aspnet"):
		return "dotnet"
	case strings.Contains(c, "openjdk"), strings.Contains(c, "temurin"),
		strings.Contains(c, "java"), strings.Contains(c, "jre"), strings.Contains(c, "jdk"):
		return "java"
	default:
		return "unknown"
	}
}
```

Modify `enrich` in `pkg/discovery/service.go`:

```go
func (s *service) enrich(ctx context.Context, r ScanResult) Instance {
	in := Instance{
		AppID: r.AppID, HTTPPort: r.HTTPPort, GRPCPort: r.GRPCPort, AppPort: r.AppPort,
		DaprdPID: r.DaprdPID, CLIPID: r.CLIPID, RunTemplate: r.RunTemplate,
		ResourcePaths: r.ResourcePaths, ConfigPath: r.ConfigPath, Command: r.Command,
		Created: r.Created.Local().Format("15:04:05"), Age: humanAge(r.Created),
		Runtime: InferRuntime(r.Command), Health: HealthUnknown,
		Source: r.Source, ComposeProject: r.ComposeProject, ComposeService: r.ComposeService,
		DaprdContainerID: r.DaprdContainerID, DaprdContainerName: r.DaprdContainerName,
		AppContainerID: r.AppContainerID, AppContainerName: r.AppContainerName,
		SidecarReachable: r.SidecarReachable,
	}
	if in.Source == "" { // scanners predating the field (and bare test fixtures)
		in.Source = SourceStandalone
		in.SidecarReachable = true
	}
	if in.Source == SourceCompose && in.Runtime == "unknown" {
		in.Runtime = InferRuntimeFromImage(r.AppImage)
	}
	// An unreachable sidecar (compose, HTTP port unpublished) cannot answer
	// health or metadata — skip both probes instead of burning their timeouts.
	if !in.SidecarReachable {
		return in
	}
	in.Health = CheckHealth(ctx, s.client, r.HTTPPort)
	md, err := FetchMetadata(ctx, s.client, r.HTTPPort)
	if err != nil {
		in.MetadataOK = false
		logger().Warn("app metadata unavailable", "appID", r.AppID, "httpPort", r.HTTPPort, "err", err)
		return in
	}
	in.MetadataOK = true
	in.RuntimeVersion = md.RuntimeVersion
	in.AppPID = md.AppPID
	in.Actors = md.Actors
	in.Subscriptions = md.Subscriptions
	in.Components = md.Components
	in.EnabledFeatures = md.EnabledFeatures
	in.Placement = md.Placement
	if in.Source == SourceCompose {
		// Container apps: metadata Extended fields (PIDs, commands, log paths)
		// describe the container's own view; process probing and file log
		// sources don't apply. Logs stream from the container runtime instead.
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
	if md.CLIPID != 0 {
		in.CLIPID = md.CLIPID
	}
	if md.AppCommand != "" {
		in.Command = md.AppCommand
	}
	in.Runtime, in.IsAspire = appRuntime(in.Command, in.AppPort, s.appProc)
	if md.AppLogPath != "" {
		in.AppLogPath, in.AppLogFormat = md.AppLogPath, logFormatPlain
	}
	if md.DaprdLogPath != "" {
		in.DaprdLogPath, in.DaprdLogFormat = md.DaprdLogPath, logFormatPlain
	}
	s.resolveLogSources(&in)
	if md.RunTemplate != "" {
		in.RunTemplate = md.RunTemplate
	}
	return in
}
```

Note the compose-with-metadata branch keeps `in.AppPID = md.AppPID` (container-namespace PID — harmless and honest) but skips `appRuntime`/`resolveLogSources`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -count=1`
Expected: PASS (existing enrich tests must stay green — the standalone path is unchanged apart from the `Source` default guard).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery
git commit -m "feat(discovery): compose-aware enrichment with degrade-and-hint"
```

---

### Task 7: Container log streaming via `/api/apps/{appId}/logs`

**Files:**
- Modify: `pkg/server/logs.go`
- Modify: `pkg/server/logs_test.go`
- Modify: `pkg/server/api.go` (thread the new dependency)
- Modify: `pkg/server/server.go` (`Options.ContainerLogs`, pass to apiRouter)
- Modify: `cmd/serve.go` (`server.Options{... ContainerLogs: deps.ContainerLogs}`)

**Interfaces:**
- Consumes: `Instance.Source` / container-ID fields (Task 4), `deps.ContainerLogs` (Task 5).
- Produces: `server.Options.ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)`; `logsHandler(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error)) http.HandlerFunc`. Same SSE framing as today.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/server/logs_test.go` (mirror the file's existing fake `discovery.Service` + SSE assertions — read it first):

```go
func TestLogsComposeStreamsFromContainer(t *testing.T) {
	app := discovery.Instance{
		AppID: "primes-go", Source: discovery.SourceCompose,
		DaprdContainerID: "aaa", AppContainerID: "bbb",
	}
	var gotID string
	containerLogs := func(_ context.Context, id string) (<-chan string, error) {
		gotID = id
		ch := make(chan string, 2)
		ch <- "hello from container"
		close(ch)
		return ch, nil
	}
	h := logsHandler(fakeApps{app}, containerLogs)
	req := httptest.NewRequest("GET", "/api/apps/primes-go/logs?source=app", nil)
	req = withChiParam(req, "appId", "primes-go") // reuse the file's existing chi-param helper
	rec := httptest.NewRecorder()
	h(rec, req)
	if gotID != "bbb" {
		t.Fatalf("source=app must stream the app container, got %q", gotID)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "text/event-stream" {
		t.Fatalf("content type: %q", ct)
	}
	if !strings.Contains(rec.Body.String(), "data: hello from container\n\n") {
		t.Fatalf("body: %q", rec.Body.String())
	}
}

func TestLogsComposeDaprdDefault(t *testing.T) {
	// same as above but no ?source param: expects gotID == "aaa" (daprd container)
}

func TestLogsComposeNoRuntime404(t *testing.T) {
	app := discovery.Instance{AppID: "x", Source: discovery.SourceCompose, DaprdContainerID: "aaa"}
	h := logsHandler(fakeApps{app}, nil) // no container runtime wired
	req := httptest.NewRequest("GET", "/api/apps/x/logs", nil)
	req = withChiParam(req, "appId", "x")
	rec := httptest.NewRecorder()
	h(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("want 404 when no container runtime, got %d", rec.Code)
	}
}
```

Write `TestLogsComposeDaprdDefault` in full (copy the first test, drop the query param, assert `gotID == "aaa"`). Adapt `fakeApps`/`withChiParam` to whatever helpers the file actually uses.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/server/ -run TestLogsCompose -v`
Expected: FAIL — `logsHandler` has the wrong arity.

- [ ] **Step 3: Implement**

In `pkg/server/logs.go`, change the signature and add the compose branch; extract the shared SSE copy loop:

```go
func logsHandler(svc discovery.Service, containerLogs func(context.Context, string) (<-chan string, error)) http.HandlerFunc {
	log := slog.Default().With("component", "server")
	return func(w http.ResponseWriter, req *http.Request) {
		appID := chi.URLParam(req, "appId")
		in, err := svc.Get(req.Context(), appID)
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		source := "daprd"
		if req.URL.Query().Get("source") == "app" {
			source = "app"
		}

		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}

		var ch <-chan string
		format := ""
		if in.Source == discovery.SourceCompose {
			id := in.DaprdContainerID
			if source == "app" {
				id = in.AppContainerID
			}
			if id == "" || containerLogs == nil {
				log.Warn("container log source unavailable", "app", appID, "source", source)
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "no container logs for this app/source"})
				return
			}
			ch, err = containerLogs(req.Context(), id)
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		} else {
			path := in.DaprdLogPath
			format = in.DaprdLogFormat
			if source == "app" {
				path, format = in.AppLogPath, in.AppLogFormat
			}
			if path == "" {
				log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path)
				writeJSON(w, http.StatusNotFound, map[string]string{"error": "no log file for this app/source"})
				return
			}
			ch, err = logs.Tail(req.Context(), path, 200, 500*time.Millisecond)
			if err != nil {
				log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path, "err", err)
				writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
				return
			}
		}

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
		log.Info("log stream opened", "app", appID, "source", source)
		defer log.Info("log stream closed", "app", appID)
		for {
			select {
			case line, open := <-ch:
				if !open {
					return
				}
				_, _ = fmt.Fprintf(w, "data: %s\n\n", normalizeLine(line, format))
				flusher.Flush()
			case <-req.Context().Done():
				return
			}
		}
	}
}
```

In `pkg/server/server.go`, add to `Options`:

```go
	// ContainerLogs streams container logs for compose-discovered apps.
	// nil disables container log streaming (404 for those apps).
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
```

Thread it: `apiRouter(...)` in `pkg/server/api.go` gains a `containerLogs func(context.Context, string) (<-chan string, error)` parameter passed to `logsHandler(apps, containerLogs)`; `server.go` passes `opts.ContainerLogs`. Fix the existing `logsHandler(apps)` call sites in `api.go` and any test constructing the router.

In `cmd/serve.go` `assembleOptions`, add `ContainerLogs: deps.ContainerLogs` to the returned `server.Options`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/server/ ./cmd/... -count=1`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/server cmd/serve.go
git commit -m "feat(server): stream compose app logs from the container runtime"
```

---

### Task 8: State-store address translation

**Files:**
- Create: `pkg/statestore/translate.go`
- Create: `pkg/statestore/translate_test.go`
- Modify: `cmd/reconciler.go` (translate at connect points)
- Modify: `cmd/serve.go` (pass `deps.ComposeEnv` to `newReconciler`)
- Modify: `cmd/reconciler_test.go` (new translation test)

**Interfaces:**
- Consumes: `ComposeEnv.ProjectForPath` / `ComposeProject` / `TranslateMountPath` (Tasks 3–4).
- Produces: `statestore.HostLookup func(host string, port int) (string, bool)`, `statestore.PathLookup func(containerPath string) (string, bool)`, `statestore.Translate(c Component, hosts HostLookup, paths PathLookup) Component` (copy-on-write; never mutates c). `newReconciler` gains a trailing `composeEnv func() discovery.ComposeEnv` parameter; translation is applied in `componentForEntry` (covers `Stores` display + `ServiceFor`) and the reconcile pre-warm.

- [ ] **Step 1: Write the failing translation tests**

Create `pkg/statestore/translate_test.go`:

```go
//go:build unit

package statestore

import "testing"

func sagaHosts(host string, port int) (string, bool) {
	if host == "redis" && port == 6379 {
		return "localhost:16379", true
	}
	if host == "postgres-db" && port == 5432 {
		return "localhost:15432", true
	}
	return "", false
}

func TestTranslateRedis(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "redis:6379", "redisPassword": "x"}}
	got := Translate(c, sagaHosts, nil)
	if got.Metadata["redisHost"] != "localhost:16379" {
		t.Fatalf("redisHost: %q", got.Metadata["redisHost"])
	}
	if got.Metadata["redisPassword"] != "x" {
		t.Fatal("other metadata must survive")
	}
	if c.Metadata["redisHost"] != "redis:6379" {
		t.Fatal("input must not be mutated")
	}
}

func TestTranslateRedisUnknownHostUntouched(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "prod.example.com:6379"}}
	if got := Translate(c, sagaHosts, nil); got.Metadata["redisHost"] != "prod.example.com:6379" {
		t.Fatalf("foreign host must be untouched: %q", got.Metadata["redisHost"])
	}
}

func TestTranslatePostgresURL(t *testing.T) {
	c := Component{Type: "state.postgresql", Metadata: map[string]string{
		"connectionString": "postgres://postgres:pw@postgres-db:5432/dapr?sslmode=disable"}}
	got := Translate(c, sagaHosts, nil)
	want := "postgres://postgres:pw@localhost:15432/dapr?sslmode=disable"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslatePostgresDSN(t *testing.T) {
	c := Component{Type: "state.postgres", Metadata: map[string]string{
		"connectionString": "host=postgres-db user=postgres password=pw port=5432 dbname=dapr"}}
	got := Translate(c, sagaHosts, nil)
	want := "host=localhost user=postgres password=pw port=15432 dbname=dapr"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslatePostgresDSNDefaultPort(t *testing.T) {
	c := Component{Type: "state.postgresql", Metadata: map[string]string{
		"connectionString": "host=postgres-db user=postgres dbname=dapr"}}
	got := Translate(c, sagaHosts, nil)
	want := "host=localhost user=postgres dbname=dapr port=15432"
	if got.Metadata["connectionString"] != want {
		t.Fatalf("got %q, want %q", got.Metadata["connectionString"], want)
	}
}

func TestTranslateSQLitePath(t *testing.T) {
	paths := func(p string) (string, bool) {
		if p == "/data/state.db" {
			return "/host/data/state.db", true
		}
		return "", false
	}
	c := Component{Type: "state.sqlite", Metadata: map[string]string{"connectionString": "/data/state.db?mode=rw"}}
	got := Translate(c, nil, paths)
	if got.Metadata["connectionString"] != "/host/data/state.db?mode=rw" {
		t.Fatalf("got %q", got.Metadata["connectionString"])
	}
}

func TestTranslateNilLookupsNoop(t *testing.T) {
	c := Component{Type: "state.redis", Metadata: map[string]string{"redisHost": "redis:6379"}}
	if got := Translate(c, nil, nil); got.Metadata["redisHost"] != "redis:6379" {
		t.Fatal("nil lookups must be a no-op")
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/statestore/ -run TestTranslate -v`
Expected: FAIL — `undefined: Translate`.

- [ ] **Step 3: Implement `pkg/statestore/translate.go`**

```go
package statestore

import (
	"net/url"
	"strconv"
	"strings"
)

// HostLookup resolves a compose-network hostname + port to a host-reachable
// "host:port". ok=false leaves the original address untouched.
type HostLookup func(host string, port int) (string, bool)

// PathLookup resolves a container-internal file path to a host path.
type PathLookup func(containerPath string) (string, bool)

// Translate rewrites c's connection metadata for access from the host:
// state.redis redisHost, state.postgresql/postgres connection strings (URL or
// key=value DSN), and state.sqlite file paths. Only exact lookup hits are
// rewritten — foreign hostnames pass through so a connection failure stays
// honest. Copy-on-write: c is never mutated; the returned Component carries a
// fresh Metadata map only when something changed.
func Translate(c Component, hosts HostLookup, paths PathLookup) Component {
	if c.Metadata == nil {
		return c
	}
	set := func(k, v string) {
		md := make(map[string]string, len(c.Metadata))
		for kk, vv := range c.Metadata {
			md[kk] = vv
		}
		md[k] = v
		c.Metadata = md
	}
	switch c.Type {
	case "state.redis":
		if hosts == nil {
			return c
		}
		host, portStr, ok := strings.Cut(c.Metadata["redisHost"], ":")
		if !ok {
			return c
		}
		port, err := strconv.Atoi(portStr)
		if err != nil {
			return c
		}
		if translated, ok := hosts(host, port); ok {
			set("redisHost", translated)
		}
	case "state.postgresql", "state.postgres":
		if hosts == nil {
			return c
		}
		if cs, ok := translatePGConnString(c.Metadata["connectionString"], hosts); ok {
			set("connectionString", cs)
		}
	case "state.sqlite":
		if paths == nil {
			return c
		}
		file, query, hasQuery := strings.Cut(c.Metadata["connectionString"], "?")
		if hostPath, ok := paths(file); ok {
			if hasQuery {
				hostPath += "?" + query
			}
			set("connectionString", hostPath)
		}
	}
	return c
}

// translatePGConnString rewrites host/port in a PostgreSQL URL
// (postgres://...) or key=value DSN. ok=false means nothing was rewritten.
func translatePGConnString(cs string, hosts HostLookup) (string, bool) {
	if cs == "" {
		return "", false
	}
	if strings.HasPrefix(cs, "postgres://") || strings.HasPrefix(cs, "postgresql://") {
		u, err := url.Parse(cs)
		if err != nil {
			return "", false
		}
		port := 5432
		if p := u.Port(); p != "" {
			n, err := strconv.Atoi(p)
			if err != nil {
				return "", false
			}
			port = n
		}
		translated, ok := hosts(u.Hostname(), port)
		if !ok {
			return "", false
		}
		u.Host = translated
		return u.String(), true
	}
	// key=value DSN (libpq style, space separated)
	fields := strings.Fields(cs)
	hostIdx, portIdx := -1, -1
	host, port := "", 5432
	for i, f := range fields {
		k, v, ok := strings.Cut(f, "=")
		if !ok {
			continue
		}
		switch k {
		case "host":
			hostIdx, host = i, v
		case "port":
			if n, err := strconv.Atoi(v); err == nil {
				portIdx, port = i, n
			}
		}
	}
	if hostIdx == -1 {
		return "", false
	}
	translated, ok := hosts(host, port)
	if !ok {
		return "", false
	}
	th, tp, ok := strings.Cut(translated, ":")
	if !ok {
		return "", false
	}
	fields[hostIdx] = "host=" + th
	if portIdx >= 0 {
		fields[portIdx] = "port=" + tp
	} else {
		fields = append(fields, "port="+tp)
	}
	return strings.Join(fields, " "), true
}
```

- [ ] **Step 4: Run translation tests**

Run: `go test -tags unit ./pkg/statestore/ -run TestTranslate -v`
Expected: PASS.

- [ ] **Step 5: Write the failing reconciler test**

Add to `cmd/reconciler_test.go` (follow the file's existing reconciler construction helpers):

```go
func TestReconcilerTranslatesComposeStore(t *testing.T) {
	dir := t.TempDir()
	yaml := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: redis:6379`
	if err := os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}
	composeEnv := func() discovery.ComposeEnv {
		return discovery.ComposeEnv{
			Projects: map[string]discovery.ComposeProject{
				"saga": {ServicePorts: map[string]map[int]int{"redis": {6379: 16379}}},
			},
			PathProject: map[string]string{dir: "saga"},
		}
	}
	rc := newReconciler(context.Background(), nil, "default", "", "", nil, nil, nil, composeEnv)
	c := statestore.Component{
		Name: "statestore", Type: "state.redis", Path: filepath.Join(dir, "statestore.yaml"),
		Metadata: map[string]string{"redisHost": "redis:6379"},
	}
	got := rc.translate(c)
	if got.Metadata["redisHost"] != "localhost:16379" {
		t.Fatalf("redisHost: %q", got.Metadata["redisHost"])
	}
	// A store outside any compose project is untouched.
	foreign := statestore.Component{Name: "s", Type: "state.redis",
		Path: "/elsewhere/s.yaml", Metadata: map[string]string{"redisHost": "redis:6379"}}
	if rc.translate(foreign).Metadata["redisHost"] != "redis:6379" {
		t.Fatal("foreign store must be untouched")
	}
}
```

Run: `go test -tags unit ./cmd/ -run TestReconcilerTranslatesComposeStore -v`
Expected: FAIL — `newReconciler` arity / `rc.translate` undefined.

- [ ] **Step 6: Integrate into the reconciler**

In `cmd/reconciler.go`:

1. Add fields + parameter:

```go
	// composeEnv returns the compose endpoint/mount context (nil = no compose).
	composeEnv func() discovery.ComposeEnv
```

`newReconciler(ctx, apps, namespace, homeDir, stateStorePath, client, registry, pool, composeEnv)` — set `composeEnv: composeEnv`. Update ALL existing `newReconciler` call sites (`cmd/serve.go` passes `deps.ComposeEnv`; tests pass `nil`).

2. Add the translate helper:

```go
// translate rewrites a compose-project store's connection metadata to
// host-reachable addresses. Non-compose stores (or no compose context) pass
// through unchanged. Applied at connect/display time only — never persisted.
func (rc *reconciler) translate(c statestore.Component) statestore.Component {
	if rc.composeEnv == nil || c.Path == "" {
		return c
	}
	env := rc.composeEnv()
	projName, ok := env.ProjectForPath(c.Path)
	if !ok {
		return c
	}
	proj := env.Projects[projName]
	hosts := func(host string, port int) (string, bool) {
		hp, ok := proj.ServicePorts[host][port]
		if !ok {
			return "", false
		}
		return "localhost:" + strconv.Itoa(hp), true
	}
	paths := func(p string) (string, bool) {
		return discovery.TranslateMountPath(proj.Mounts, p)
	}
	return statestore.Translate(c, hosts, paths)
}
```

3. Apply it at the three connect/display points:
   - `componentForEntry`: change both success returns — `return rc.translate(statestore.Component{...})` for manual entries and `return rc.translate(c)` after secret resolution for auto entries. (This covers `Stores()` display, `ServiceFor`, and eviction identity consistently.)
   - `reconcile`: change the pre-warm to `rc.pool.openOrGet(octx, rc.translate(*active))`.

Note on identity consistency: `identity()` hashes name+type+ConnInfo. All pool interactions (`openOrGet` in pre-warm and `ServiceFor` via `componentForEntry`, `evict` via `componentFor`) now see the *translated* component, so identities stay consistent. `Stores()` computes `activeID` from `rc.activeComponent()` which is *untranslated* — fix that too: in `Stores()`, change `activeID := identity(rc.activeComponent())` to:

```go
	var activeID string
	if active := rc.activeComponent(); active != nil {
		activeID = identity(ptr(rc.translate(*active)))
	}
```

with a tiny helper `func ptr(c statestore.Component) *statestore.Component { return &c }` (or restructure `identity` calls accordingly).

- [ ] **Step 7: Run the full cmd + statestore suites**

Run: `go test -tags unit -race ./cmd/... ./pkg/statestore/ -count=1`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add pkg/statestore cmd
git commit -m "feat(statestore): translate compose-network store addresses at connect time"
```

---

### Task 9: Compose control-plane services

**Files:**
- Modify: `pkg/controlplane/types.go` (Service.ComposeProject)
- Modify: `pkg/controlplane/parse.go` (extend rawInspect; compose parse)
- Modify: `pkg/controlplane/service.go` (compose scan, dynamic allowlist, memory names)
- Modify: `pkg/controlplane/service_test.go` / `parse_test.go`
- Create: `pkg/controlplane/testdata/compose_cp_inspect.json`

**Interfaces:**
- Consumes: `containerruntime.Runner` (Task 1).
- Produces: `Service.ComposeProject string` (`json:"composeProject,omitempty"`); compose placement/scheduler containers appear in `List()` with `Actionable: true`; `Do`/`LogStream` accept compose names discovered by the most recent `List` (never arbitrary names). Task 12 consumes the JSON.

- [ ] **Step 1: Create the fixture**

`pkg/controlplane/testdata/compose_cp_inspect.json` — placement + one scheduler + a non-CP container that must be ignored:

```json
[
  {
    "Id": "p1",
    "Name": "/saga-placement-1",
    "State": { "Status": "running", "Health": { "Status": "" } },
    "Config": {
      "Labels": { "com.docker.compose.project": "saga", "com.docker.compose.service": "placement" },
      "Entrypoint": null,
      "Cmd": ["./placement", "-port", "50005", "-log-level", "warn"]
    },
    "NetworkSettings": { "Ports": { "50005/tcp": [ { "HostPort": "50005" } ] } },
    "LogPath": "/var/lib/docker/containers/p1/p1-json.log"
  },
  {
    "Id": "s0",
    "Name": "/saga-scheduler-0-1",
    "State": { "Status": "running", "Health": { "Status": "" } },
    "Config": {
      "Labels": { "com.docker.compose.project": "saga", "com.docker.compose.service": "scheduler-0" },
      "Entrypoint": null,
      "Cmd": ["./scheduler", "--etcd-data-dir", "/var/run/dapr/scheduler"]
    },
    "NetworkSettings": { "Ports": {} },
    "LogPath": ""
  },
  {
    "Id": "x1",
    "Name": "/saga-postgres-db-1",
    "State": { "Status": "running", "Health": { "Status": "healthy" } },
    "Config": {
      "Labels": { "com.docker.compose.project": "saga", "com.docker.compose.service": "postgres-db" },
      "Entrypoint": ["docker-entrypoint.sh"],
      "Cmd": ["postgres"]
    },
    "NetworkSettings": { "Ports": { "5432/tcp": [ { "HostPort": "5432" } ] } },
    "LogPath": ""
  }
]
```

- [ ] **Step 2: Write the failing tests**

Add to `pkg/controlplane/service_test.go` (extend the existing `fakeRunner`; its command key convention is `args[0]+" "+args[1]`):

```go
func TestListIncludesComposeControlPlane(t *testing.T) {
	inspect, err := os.ReadFile("testdata/compose_cp_inspect.json")
	if err != nil {
		t.Fatal(err)
	}
	fr := newFakeRunner() // reuse/extend the file's existing constructor + fixed-name responses
	fr.responses["ps -aq"] = []byte("p1\ns0\nx1\n")
	fr.responses["inspect p1"] = inspect
	m := newManager(RuntimeDocker, fr)
	res, err := m.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	var compose []Service
	for _, s := range res.Services {
		if s.ComposeProject != "" {
			compose = append(compose, s)
		}
	}
	if len(compose) != 2 {
		t.Fatalf("want placement + scheduler, got %+v", compose)
	}
	if compose[0].Name != "saga-placement-1" || !compose[0].Actionable || compose[0].ComposeProject != "saga" {
		t.Fatalf("placement: %+v", compose[0])
	}
	if compose[1].Name != "saga-scheduler-0-1" {
		t.Fatalf("scheduler: %+v", compose[1])
	}
	// postgres-db must NOT be listed (not a control-plane command).
}

func TestDoAllowsDiscoveredComposeNames(t *testing.T) {
	// build the same manager, call List first to populate the allowlist
	// then: m.Do(ctx, "restart", "saga-placement-1") => nil error
	// and:  m.Do(ctx, "restart", "saga-postgres-db-1") => ErrUnknownService
	// and:  m.Do(ctx, "restart", "dapr_placement") => nil (fixed names still work)
}

func TestDoRejectsComposeNamesBeforeList(t *testing.T) {
	// fresh manager, NO List call:
	// m.Do(ctx, "restart", "saga-placement-1") => ErrUnknownService
}
```

Write the two sketched tests in full following the first one's construction pattern.

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/controlplane/ -run 'TestListIncludesCompose|TestDoAllows|TestDoRejects' -v`
Expected: FAIL.

- [ ] **Step 4: Implement**

`pkg/controlplane/types.go` — add to `Service`:

```go
	ComposeProject string `json:"composeProject,omitempty"`
```

`pkg/controlplane/parse.go` — extend `rawInspect` with the compose fields and add a batch parser + CP classifier:

```go
type rawInspect struct {
	ID    string `json:"Id"`
	Name  string `json:"Name"`
	State struct {
		Status string `json:"Status"`
		Health struct {
			Status string `json:"Status"`
		} `json:"Health"`
	} `json:"State"`
	Config struct {
		Labels     map[string]string `json:"Labels"`
		Entrypoint []string          `json:"Entrypoint"`
		Cmd        []string          `json:"Cmd"`
	} `json:"Config"`
	NetworkSettings struct {
		Ports map[string]any `json:"Ports"`
	} `json:"NetworkSettings"`
	LogPath string `json:"LogPath"`
}

// parseComposeControlPlane extracts compose-managed placement/scheduler
// containers from a batched inspect payload.
func parseComposeControlPlane(data []byte) ([]Service, error) {
	var arr []rawInspect
	if err := json.Unmarshal(data, &arr); err != nil {
		return nil, err
	}
	var out []Service
	for _, c := range arr {
		project := c.Config.Labels["com.docker.compose.project"]
		if project == "" || !isControlPlaneCommand(c.Config.Entrypoint, c.Config.Cmd) {
			continue
		}
		svc := Service{
			Name:           strings.TrimPrefix(c.Name, "/"),
			ComposeProject: project,
			Actionable:     true,
			LogPath:        c.LogPath,
		}
		running := c.State.Status == "running"
		if running {
			svc.Status = StatusRunning
		} else {
			svc.Status = StatusStopped
		}
		h := c.State.Health.Status
		svc.Healthy = running && (h == "" || h == "healthy")
		for p := range c.NetworkSettings.Ports {
			svc.Ports = append(svc.Ports, p)
		}
		sort.Strings(svc.Ports)
		if svc.Ports == nil {
			svc.Ports = []string{}
		}
		out = append(out, svc)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// isControlPlaneCommand reports whether argv (entrypoint+cmd) launches the
// Dapr placement or scheduler binary.
func isControlPlaneCommand(entrypoint, cmd []string) bool {
	argv := append(append([]string{}, entrypoint...), cmd...)
	if len(argv) == 0 {
		return false
	}
	switch path.Base(argv[0]) {
	case "placement", "scheduler":
		return true
	default:
		return false
	}
}
```

(The existing `parseInspect` keeps working — the added struct fields are ignored by its single-container path.)

`pkg/controlplane/service.go`:

```go
type manager struct {
	runtime RuntimeKind
	run     containerruntime.Runner

	mu           sync.Mutex
	composeNames map[string]bool // compose CP containers found by the last List
}
```

In `List`, after the daemon probe and before the fixed-name loop, discover compose CP services and include their names in the single stats call:

```go
	composeSvcs := m.composeControlPlane(ctx)
	statNames := append(append([]string{}, LiveServiceNames...), serviceNames(composeSvcs)...)
	mem := m.memory(ctx, statNames)
```

(change `memory`'s signature to `memory(ctx context.Context, names []string)` and use `names` instead of `LiveServiceNames`). After the k8s-only loop, append the compose services and refresh the allowlist:

```go
	for i := range composeSvcs {
		if ms, ok := mem[composeSvcs[i].Name]; ok {
			composeSvcs[i].MemoryBytes = ms.Bytes
			composeSvcs[i].MemoryHuman = ms.Human
		}
		if composeSvcs[i].Status == StatusRunning {
			present = true
		}
		services = append(services, composeSvcs[i])
	}
	m.setComposeNames(serviceNames(composeSvcs))
```

Helpers:

```go
// composeControlPlane finds compose-run placement/scheduler containers.
// Failures degrade to none (the fixed dapr_* services still render).
func (m *manager) composeControlPlane(ctx context.Context) []Service {
	out, err := m.run.Run(ctx, "ps", "-aq", "--filter", "label=com.docker.compose.project")
	if err != nil {
		return nil
	}
	ids := strings.Fields(string(out))
	if len(ids) == 0 {
		return nil
	}
	raw, err := m.run.Run(ctx, append([]string{"inspect"}, ids...)...)
	if err != nil {
		return nil
	}
	svcs, err := parseComposeControlPlane(raw)
	if err != nil {
		return nil
	}
	return svcs
}

func serviceNames(svcs []Service) []string {
	out := make([]string, len(svcs))
	for i, s := range svcs {
		out[i] = s.Name
	}
	return out
}

func (m *manager) setComposeNames(names []string) {
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	m.mu.Lock()
	m.composeNames = set
	m.mu.Unlock()
}

func (m *manager) isComposeName(name string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.composeNames[name]
}
```

In `Do` and `LogStream`, replace `if !IsLiveName(name)` with:

```go
	if !IsLiveName(name) && !m.isComposeName(name) {
		return ErrUnknownService // (nil, ErrUnknownService) in LogStream
	}
```

Note `ps -aq` (not `-q`): a *stopped* compose placement container must still list and accept `start`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/controlplane/ -count=1`
Expected: PASS (existing fixed-name tests too — the fakeRunner returns an error for unknown `"ps -aq"` keys in old tests; make `composeControlPlane` tolerate that, which it does by returning nil on error).

- [ ] **Step 6: Commit**

```bash
git add pkg/controlplane
git commit -m "feat(controlplane): discover compose-run placement/scheduler with lifecycle actions"
```

---

### Task 10: Frontend — types + Applications badge & hint

**Files:**
- Modify: `web/src/types/api.ts`
- Modify: `web/src/pages/Applications.tsx`
- Modify: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: the Instance JSON from Task 4/6 (`source`, `composeProject`, `sidecarReachable`, container ids/names).
- Produces: `AppSummary`/`AppDetail` TS fields used by Tasks 11–12.

- [ ] **Step 1: Extend the types**

In `web/src/types/api.ts`:

```ts
export interface AppSummary {
  appId: string
  health: HealthStatus
  runtime: string
  /** true when the app is .NET Aspire-managed (started by the Aspire host, not a run template) */
  isAspire?: boolean
  /** discovery source: process table vs docker compose containers */
  source?: 'standalone' | 'compose'
  /** compose project name (source === 'compose' only) */
  composeProject?: string
  /** false when a compose sidecar's HTTP port is not published to the host */
  sidecarReachable?: boolean
  httpPort: number
  grpcPort: number
  appPort: number
  daprdPid: number
  appPid: number
  cliPid: number
  age: string
  created: string
  runTemplate: string
  components?: { name: string; type: string; version?: string }[]
}

export interface AppDetail extends AppSummary {
  resourcePaths: string[]
  configPath: string
  appLogPath: string
  daprdLogPath: string
  command: string
  runtimeVersion: string
  metadataOk: boolean
  composeService?: string
  daprdContainerId?: string
  daprdContainerName?: string
  appContainerId?: string
  appContainerName?: string
  enabledFeatures?: string[]
  actors?: { type: string; count: number }[]
  subscriptions?: { pubsubName: string; topic: string; [key: string]: unknown }[]
  placement?: string
}
```

- [ ] **Step 2: Write the failing tests**

Add to `web/src/pages/Applications.test.tsx` (follow the file's existing render/mocking pattern):

```tsx
it('labels compose-discovered apps and shows the publish-port hint when unreachable', async () => {
  mockApps([
    {
      ...baseApp, // reuse the file's fixture helper
      appId: 'primes-go',
      source: 'compose',
      composeProject: 'saga',
      sidecarReachable: false,
      health: 'unknown',
      runTemplate: '',
    },
  ])
  render(<Applications />, { wrapper })
  expect(await screen.findByText('Compose')).toBeInTheDocument()
  const hint = screen.getByTitle(/publish the daprd HTTP port/i)
  expect(hint).toBeInTheDocument()
})

it('does not show the hint for reachable compose apps', async () => {
  mockApps([
    { ...baseApp, appId: 'primes-go', source: 'compose', composeProject: 'saga', sidecarReachable: true },
  ])
  render(<Applications />, { wrapper })
  expect(await screen.findByText('Compose')).toBeInTheDocument()
  expect(screen.queryByTitle(/publish the daprd HTTP port/i)).not.toBeInTheDocument()
})
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `web/src/pages/Applications.tsx`:

1. Run-template stat: extend the fallback chain:

```tsx
const runTemplate =
  apps.find((a) => a.runTemplate)?.runTemplate ||
  (apps.some((a) => a.isAspire) ? 'Aspire' : apps.some((a) => a.source === 'compose') ? 'Compose' : '—')
```

2. In `AppRow`, replace the run-template cell and the health cell:

```tsx
const sourceLabel = app.runTemplate || (app.isAspire ? 'Aspire' : app.source === 'compose' ? 'Compose' : '—')
const unreachable = app.source === 'compose' && app.sidecarReachable === false
```

```tsx
      <td>
        <span
          className="health"
          title={unreachable ? 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata' : undefined}
        >
          <span className={`led ${ledClass(app.health)}`} /> {app.health}
          {unreachable && ' ⓘ'}
        </span>
      </td>
```

```tsx
      <td className="mono muted" title={app.composeProject ? `compose project: ${app.composeProject}` : undefined}>
        {sourceLabel}
      </td>
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx src/test/styleguide.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/api.ts web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): compose source badge and publish-port hint on Applications"
```

---

### Task 11: Frontend — AppDetail compose fields

**Files:**
- Modify: `web/src/pages/AppDetail.tsx`
- Modify: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: `AppDetail` TS fields from Task 10.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/AppDetail.test.tsx` (follow existing fixture/render pattern):

```tsx
it('shows container identities instead of PIDs for compose apps', async () => {
  mockApp({
    ...baseDetail,
    appId: 'primes-go',
    source: 'compose',
    composeProject: 'saga',
    composeService: 'primes-go-dapr',
    sidecarReachable: true,
    daprdContainerId: 'aaa111bbb222',
    daprdContainerName: 'saga-primes-go-dapr-1',
    appContainerId: 'ccc333ddd444',
    appContainerName: 'saga-primes-go-1',
  })
  render(<AppDetail />, { wrapper })
  expect(await screen.findByText('saga-primes-go-1')).toBeInTheDocument()
  expect(screen.getByText('saga-primes-go-dapr-1')).toBeInTheDocument()
  expect(screen.getByText(/compose project/i)).toBeInTheDocument()
  expect(screen.getByText('saga')).toBeInTheDocument()
  expect(screen.queryByText('App PID')).not.toBeInTheDocument()
  expect(screen.queryByText('daprd PID')).not.toBeInTheDocument()
})

it('shows the publish-port hint for unreachable compose apps', async () => {
  mockApp({ ...baseDetail, appId: 'x', source: 'compose', sidecarReachable: false, metadataOk: false })
  render(<AppDetail />, { wrapper })
  expect(await screen.findByText(/publish the daprd HTTP port/i)).toBeInTheDocument()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

In `web/src/pages/AppDetail.tsx`, inside `AppDetailContent`:

```tsx
const isCompose = app.source === 'compose'
const unreachable = isCompose && app.sidecarReachable === false
```

1. Metadata-unavailable note — replace the existing block:

```tsx
{unreachable ? (
  <div className="hint">
    sidecar unreachable — publish the daprd HTTP port (e.g. <span className="mono">3500:3500</span>) in
    your compose file to enable health &amp; metadata
  </div>
) : (
  !app.metadataOk && <div className="hint">metadata unavailable — showing process-scan data only</div>
)}
```

2. Application panel — swap the PID rows for container rows when compose:

```tsx
{isCompose ? (
  <>
    <div className="kk">Container</div>
    <div className="vv mono">{app.appContainerName || <span className="faint">—</span>}</div>

    <div className="kk">Container ID</div>
    <div className="vv mono">{app.appContainerId ? app.appContainerId.slice(0, 12) : <span className="faint">—</span>}</div>

    <div className="kk">Compose project</div>
    <div className="vv mono">{app.composeProject || <span className="faint">—</span>}</div>
  </>
) : (
  <>
    <div className="kk">App PID</div>
    <div className="vv mono">{appPidDisplay}</div>

    <div className="kk">CLI PID</div>
    <div className="vv mono">{app.cliPid || <span className="faint">—</span>}</div>
  </>
)}
```

3. Dapr sidecar panel — same treatment for the daprd PID row:

```tsx
{isCompose ? (
  <>
    <div className="kk">Container</div>
    <div className="vv mono">{app.daprdContainerName || <span className="faint">—</span>}</div>
  </>
) : (
  <>
    <div className="kk">daprd PID</div>
    <div className="vv mono">{app.daprdPid || <span className="faint">—</span>}</div>
  </>
)}
```

(The Paths panel needs no change: compose apps have host resource/config paths and empty log paths, which already render as `—`. The logs page works via the same `/api/apps/{id}/logs` SSE endpoint.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx src/test/styleguide.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): container identity panel for compose apps in AppDetail"
```

---

### Task 12: Frontend — ControlPlane compose group

**Files:**
- Modify: `web/src/types/controlplane.ts`
- Modify: `web/src/pages/ControlPlane.tsx`
- Modify: `web/src/pages/ControlPlane.test.tsx`

**Interfaces:**
- Consumes: `Service.composeProject` JSON (Task 9).

- [ ] **Step 1: Extend the type**

In `web/src/types/controlplane.ts` add to `ControlPlaneService`:

```ts
  /** compose project name when this service is compose-managed */
  composeProject?: string
```

- [ ] **Step 2: Write the failing test**

Add to `web/src/pages/ControlPlane.test.tsx` (follow the existing mocking pattern):

```tsx
it('groups compose-run control-plane services under their project', async () => {
  mockControlPlane({
    runtime: 'docker',
    available: true,
    reachable: true,
    controlPlanePresent: true,
    services: [
      { name: 'dapr_placement', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true },
      { name: 'saga-placement-1', status: 'running', healthy: true, ports: ['50005/tcp'], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
      { name: 'saga-scheduler-0-1', status: 'running', healthy: true, ports: [], memoryBytes: 0, memoryHuman: '', logPath: '', actionable: true, composeProject: 'saga' },
    ],
  })
  render(<ControlPlane />, { wrapper })
  expect(await screen.findByText('saga-placement-1')).toBeInTheDocument()
  expect(screen.getByText(/compose · saga/i)).toBeInTheDocument()
  expect(screen.getByText('dapr_placement')).toBeInTheDocument()
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/ControlPlane.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement**

In `web/src/pages/ControlPlane.tsx`, replace the single cards block with grouped sections:

```tsx
  const initServices = data.services.filter((s) => !s.composeProject)
  const composeProjects = [...new Set(data.services.filter((s) => s.composeProject).map((s) => s.composeProject!))]

  return (
    <div className="page">
      {header}
      <div className="cards">
        {initServices.map((svc) => (
          <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
        ))}
      </div>
      {composeProjects.map((project) => (
        <div key={project}>
          <div className="sec-title">
            compose · {project}{' '}
            <span className="faint" style={{ textTransform: 'none', letterSpacing: 0 }}>
              — docker compose managed
            </span>
          </div>
          <div className="cards">
            {data.services
              .filter((s) => s.composeProject === project)
              .map((svc) => (
                <ServiceCard key={svc.name} svc={svc} onAction={runAction} />
              ))}
          </div>
        </div>
      ))}
    </div>
  )
```

(`ServiceCard` is unchanged — compose services carry `actionable: true` and real names, so status/ports/memory/logs/actions all work as-is. Note the empty-state guard `!data.controlPlanePresent` also fires only when neither `dapr init` nor compose control-plane containers exist, because Task 9 sets `ControlPlanePresent` for compose services too.)

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/ControlPlane.test.tsx src/test/styleguide.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/controlplane.ts web/src/pages/ControlPlane.tsx web/src/pages/ControlPlane.test.tsx
git commit -m "feat(web): compose project group on the Control Plane page"
```

---

### Task 13: Integration test + documentation

**Files:**
- Create: `cmd/compose_discovery_integration_test.go`
- Modify: `ARCHITECTURE.md`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the integration test**

Create `cmd/compose_discovery_integration_test.go` (`//go:build integration`). It exercises the full chain: fake compose runner → merged discovery → reconciler election → **translated** connection against miniredis. Follow the construction patterns in `cmd/store_election_integration_test.go` (read it first for the miniredis + registry setup helpers):

```go
//go:build integration

package cmd

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// fakeComposeRunner serves canned ps/inspect payloads.
type fakeComposeRunner struct{ ps, inspect []byte }

func (f *fakeComposeRunner) Run(_ context.Context, args ...string) ([]byte, error) {
	if args[0] == "ps" {
		return f.ps, nil
	}
	return f.inspect, nil
}
func (f *fakeComposeRunner) Stream(context.Context, ...string) (<-chan string, error) {
	ch := make(chan string, 1)
	ch <- "container log line"
	close(ch)
	return ch, nil
}

func TestComposeStoreElectionWithTranslation(t *testing.T) {
	mr := miniredis.RunT(t)
	hostPort := mr.Port() // string

	dir := t.TempDir()
	yaml := `apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: redis:6379`
	if err := os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(yaml), 0o600); err != nil {
		t.Fatal(err)
	}

	// Compose inspect payload: one daprd sidecar mounting dir as /components,
	// plus a redis service whose 6379 is "published" at miniredis's port.
	inspect := composeInspectJSON(t, dir, hostPort) // helper below
	src := discovery.NewComposeSource(&fakeComposeRunner{
		ps:      []byte("sc1\nrd1\n"),
		inspect: inspect,
	})
	apps := discovery.New(src.Scanner(), httpClientNoDial(t)) // enrichment fails fast; scan data suffices

	pool := newConnPool("default", nil, apps, nil)
	registry := LoadRegistry(t.TempDir())
	rc := newReconciler(context.Background(), apps, "default", "", "", nil, registry, pool, src.Env)
	defer rc.Close()

	got, err := apps.List(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	rc.reconcile(got, appsFingerprint(got))

	active := rc.activeComponent()
	if active == nil || active.Name != "statestore" {
		t.Fatalf("active store: %+v", active)
	}
	translated := rc.translate(*active)
	if !strings.HasSuffix(translated.Metadata["redisHost"], hostPort) {
		t.Fatalf("expected translation to miniredis port %s, got %q", hostPort, translated.Metadata["redisHost"])
	}
	// The pre-warm in reconcile already connected through the pool; a working
	// ServiceFor("") proves the translated address actually dials.
	svc, _, _, ok := rc.ServiceFor("")
	if !ok || svc == nil {
		t.Fatal("ServiceFor must resolve the elected store")
	}
}
```

Write `composeInspectJSON` (builds the two-container inspect array with `fmt.Sprintf`, the sidecar mounting `dir` at `/components` with `-resources-path /components`, and the redis service publishing container port 6379 at miniredis's host port) and `httpClientNoDial` (an `http.Client` whose transport returns an immediate error, so enrichment degrades instantly) as small helpers in the same file — mirror how the existing integration tests build fixtures.

- [ ] **Step 2: Run the integration suite**

Run: `go test -tags integration -race ./cmd/ -run TestComposeStoreElection -v`
Expected: PASS.

- [ ] **Step 3: Update ARCHITECTURE.md**

- §2 repo layout: add `containerruntime/  docker/podman resolution + exec runner (shared by controlplane & discovery)` to the `pkg/` listing, and note `discovery/` now also scans compose containers.
- §6 Discovery: after the StandaloneScanner paragraph, add:

> A second scanner, `ComposeSource` (`scan_compose.go`), discovers Dapr apps running under **docker compose**: it lists compose-labelled containers (`ps -q --filter label=com.docker.compose.project`), batch-inspects them, and treats any container whose argv invokes `daprd` as a sidecar — app id and ports come from the daprd flags, host-reachable ports from the published port bindings, and resource/config paths from the bind-mount table (host side). The paired app container is matched by compose service name (`-app-channel-address`, falling back to the app id). Sidecars without a published HTTP port are listed but marked `sidecarReachable=false` and skip health/metadata probes (the UI shows a publish-port hint). Both scanners are combined with `Merge` (one failing source never hides the other) and the compose scan is cached for ~2s behind a ~3s exec timeout. The scanner also exposes a per-project **endpoint map** (`ComposeEnv`) — compose service → published host ports, plus mount tables — which the reconciler uses to **translate** detected state-store addresses (e.g. `postgres-db:5432` → `localhost:5432`) at connect time via `statestore.Translate`; translation is in-memory only, never persisted. Compose app logs stream from `docker logs -f` (`Options.ContainerLogs`) instead of file tailing.

- §6 Control plane: note that `List()` additionally detects compose containers whose command is `placement`/`scheduler`, surfaces them with a `composeProject`, and that `Do`/`LogStream` accept the compose names discovered by the most recent `List` (still never arbitrary names).
- §9 extension table: add row `Support a new discovery source | implement a discovery.Scanner + add it to Merge in cmd/root.go`.

- [ ] **Step 4: Full gate**

Run: `make test && go build ./...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/compose_discovery_integration_test.go ARCHITECTURE.md
git commit -m "test(cmd): compose discovery integration coverage + architecture docs"
```

---

## Deferred (explicitly out of scope)

- e2e test with a real docker compose stack (needs docker locally; follow-up).
- Compose YAML parsing, declared-but-stopped services, Docker Engine API/events, helper-container network access — spec non-goals.
