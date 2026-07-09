# Compose App Runtime Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compose Dapr apps show a real runtime (go/dotnet/node/…) on the App overview and detail pages instead of "unknown", detected from signals the discovery scan already has plus a local build-context fallback.

**Architecture:** A short-circuiting chain computed at scan time in `ComposeSource` — app-container argv → base-image env markers → image name → marker files in the service's local compose `build.context` — stored as `ScanResult.AppRuntime` and consumed by `enrich` only when runtime is otherwise unknown. All signals except the last come from the batched `docker inspect` discovery already performs.

**Tech Stack:** Go (testify, `-tags unit -race`), `sigs.k8s.io/yaml` (existing direct dependency). No frontend changes.

**Spec:** `docs/superpowers/specs/2026-07-09-compose-runtime-detection-design.md`

## Global Constraints

- Zero extra container-runtime calls: only reuse fields from the existing batched `docker inspect`.
- Chain order (stop at first non-"unknown"): argv → env → image → build-context marker files. File I/O only when 1–3 all fail.
- Best-effort and silent: every failure path (missing/foreign compose file, YAML error, no `build:` section, unreadable dir) returns `"unknown"` — no error returns, no log noise on the 2s scan cadence.
- Env markers: `DOTNET_VERSION`/`ASPNET_VERSION` → dotnet; `NODE_VERSION` → node; `PYTHON_VERSION` → python; `JAVA_VERSION`/`JAVA_HOME` → java; `GOLANG_VERSION` → go; `RUST_VERSION`/`CARGO_HOME` → rust.
- Marker files (top level of context dir only): `go.mod` → go; `*.csproj`/`*.fsproj`/`*.sln`/`global.json` → dotnet; `Cargo.toml` → rust; `pom.xml`/`build.gradle`/`build.gradle.kts` → java; `pyproject.toml`/`requirements.txt`/`setup.py` → python; `package.json` → node (checked in that fixed priority order, not directory order).
- `enrich` treats `AppRuntime` of `""` OR `"unknown"` as absent and falls back to the existing `InferRuntimeFromImage(r.AppImage)` — keeps `TestEnrichComposeCarriesContainerFields` green.
- Standalone/Aspire paths untouched. No new Go dependencies. No frontend changes.
- Go tests: `go test -tags unit -race ./pkg/discovery/`. Commit after every green task.
- Work happens on branch `worktree-compose-container-identity` (PR #50) in `/Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/compose-container-identity`.

---

### Task 1: `InferRuntimeFromEnv`

**Files:**
- Modify: `pkg/discovery/infer.go` (append)
- Test: `pkg/discovery/infer_test.go` (append)

**Interfaces:**
- Consumes: nothing new.
- Produces: `func InferRuntimeFromEnv(env []string) string` — returns a runtime name or `"unknown"`. Task 3's chain calls it with `composeContainer.Env`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/discovery/infer_test.go`:

```go
func TestInferRuntimeFromEnv(t *testing.T) {
	tests := []struct {
		name string
		env  []string
		want string
	}{
		{"dotnet version", []string{"PATH=/usr/bin", "DOTNET_VERSION=10.0.9"}, "dotnet"},
		{"aspnet version", []string{"ASPNET_VERSION=10.0.9"}, "dotnet"},
		{"node", []string{"NODE_VERSION=22.1.0"}, "node"},
		{"python", []string{"PYTHON_VERSION=3.12.4"}, "python"},
		{"java version", []string{"JAVA_VERSION=21"}, "java"},
		{"java home", []string{"JAVA_HOME=/opt/java"}, "java"},
		{"golang", []string{"GOLANG_VERSION=1.23.4"}, "go"},
		{"rust", []string{"RUST_VERSION=1.79"}, "rust"},
		{"cargo home", []string{"CARGO_HOME=/usr/local/cargo"}, "rust"},
		{"no markers", []string{"PATH=/usr/bin", "HOME=/root"}, "unknown"},
		{"empty", nil, "unknown"},
		{"value not name", []string{"FOO=NODE_VERSION"}, "unknown"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) { require.Equal(t, tc.want, InferRuntimeFromEnv(tc.env)) })
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestInferRuntimeFromEnv -v`
Expected: FAIL to compile — `undefined: InferRuntimeFromEnv`.

- [ ] **Step 3: Implement**

Append to `pkg/discovery/infer.go`:

```go
// InferRuntimeFromEnv guesses the app's language from environment variables
// inherited from official base images (best-effort, conservative — only
// well-known variable names count, never values).
func InferRuntimeFromEnv(env []string) string {
	for _, kv := range env {
		name, _, _ := strings.Cut(kv, "=")
		switch name {
		case "DOTNET_VERSION", "ASPNET_VERSION":
			return "dotnet"
		case "NODE_VERSION":
			return "node"
		case "PYTHON_VERSION":
			return "python"
		case "JAVA_VERSION", "JAVA_HOME":
			return "java"
		case "GOLANG_VERSION":
			return "go"
		case "RUST_VERSION", "CARGO_HOME":
			return "rust"
		}
	}
	return "unknown"
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestInferRuntime -v`
Expected: PASS (new test plus the pre-existing `TestInferRuntime`/`TestInferRuntimeFromImage`).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/infer.go pkg/discovery/infer_test.go
git commit -m "feat(discovery): infer runtime from base-image env markers"
```

---

### Task 2: Build-context marker resolver

**Files:**
- Create: `pkg/discovery/compose_runtime.go`
- Test: `pkg/discovery/compose_runtime_test.go` (new)

**Interfaces:**
- Consumes: `InferRuntime`, `InferRuntimeFromEnv`, `InferRuntimeFromImage` (all in `pkg/discovery/infer.go`); `composeContainer` (Task 3 adds `Env`/`ConfigFiles`/`WorkingDir` fields — this task does NOT touch it yet).
- Produces:
  - `func runtimeFromBuildContext(configFiles, workingDir, service string) string`
  - `func runtimeFromMarkerFiles(dir string) string` (internal helper, tested directly)
  Task 3's chain calls `runtimeFromBuildContext`.

- [ ] **Step 1: Write the failing tests**

Create `pkg/discovery/compose_runtime_test.go`:

```go
//go:build unit

package discovery

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

// writeFile creates path (and parents) with content.
func writeFile(t *testing.T, path, content string) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0o755))
	require.NoError(t, os.WriteFile(path, []byte(content), 0o644))
}

func TestRuntimeFromMarkerFiles(t *testing.T) {
	cases := []struct {
		name    string
		files   []string
		want    string
	}{
		{"go", []string{"go.mod"}, "go"},
		{"dotnet sln and global.json (dapr-mq layout)", []string{"DaprMQ.sln", "global.json", "NuGet.config"}, "dotnet"},
		{"dotnet csproj", []string{"App.csproj"}, "dotnet"},
		{"node", []string{"package.json"}, "node"},
		{"python", []string{"requirements.txt"}, "python"},
		{"java", []string{"pom.xml"}, "java"},
		{"rust", []string{"Cargo.toml"}, "rust"},
		{"priority: go.mod beats package.json", []string{"package.json", "go.mod"}, "go"},
		{"no markers", []string{"README.md"}, "unknown"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			for _, f := range tc.files {
				writeFile(t, filepath.Join(dir, f), "x")
			}
			require.Equal(t, tc.want, runtimeFromMarkerFiles(dir))
		})
	}
	t.Run("nonexistent dir", func(t *testing.T) {
		require.Equal(t, "unknown", runtimeFromMarkerFiles(filepath.Join(t.TempDir(), "nope")))
	})
	t.Run("markers in subdirs do not count", func(t *testing.T) {
		dir := t.TempDir()
		writeFile(t, filepath.Join(dir, "src", "go.mod"), "x")
		require.Equal(t, "unknown", runtimeFromMarkerFiles(dir))
	})
}

func TestRuntimeFromBuildContext(t *testing.T) {
	t.Run("string build shorthand", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "dotnet", "global.json"), "{}")
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./dotnet\n")
		require.Equal(t, "dotnet", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("object build with context", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "svc", "go.mod"), "module x")
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build:\n      context: ./svc\n      dockerfile: Dockerfile\n")
		require.Equal(t, "go", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("service without build section (pulled image)", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    image: nginx\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("unknown service", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: .\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "other"))
	})
	t.Run("comma-separated config files, second resolves", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "app", "Cargo.toml"), "[package]")
		cf1 := filepath.Join(proj, "missing.yml") // does not exist
		cf2 := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf2, "services:\n  web:\n    build: ./app\n")
		require.Equal(t, "rust", runtimeFromBuildContext(cf1+","+cf2, proj, "web"))
	})
	t.Run("dangling context path", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./gone\n")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("invalid yaml", func(t *testing.T) {
		proj := t.TempDir()
		cf := filepath.Join(proj, "docker-compose.yml")
		writeFile(t, cf, "services: [not: valid: yaml")
		require.Equal(t, "unknown", runtimeFromBuildContext(cf, proj, "web"))
	})
	t.Run("empty inputs", func(t *testing.T) {
		require.Equal(t, "unknown", runtimeFromBuildContext("", "", "web"))
		require.Equal(t, "unknown", runtimeFromBuildContext("x.yml", "", ""))
	})
	t.Run("relative context resolved against workingDir not cwd", func(t *testing.T) {
		proj := t.TempDir()
		writeFile(t, filepath.Join(proj, "js", "package.json"), "{}")
		// compose file lives elsewhere; workingDir is the project dir
		other := t.TempDir()
		cf := filepath.Join(other, "compose.yml")
		writeFile(t, cf, "services:\n  web:\n    build: ./js\n")
		require.Equal(t, "node", runtimeFromBuildContext(cf, proj, "web"))
	})
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/discovery/ -run 'TestRuntimeFrom' -v`
Expected: FAIL to compile — `undefined: runtimeFromMarkerFiles`, `undefined: runtimeFromBuildContext`.

- [ ] **Step 3: Implement**

Create `pkg/discovery/compose_runtime.go`:

```go
package discovery

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

// composeFileServices is the minimal compose-file subset we consume: only
// each service's build key, which compose allows as either a string
// (context shorthand) or an object. sigs.k8s.io/yaml converts YAML to JSON
// first, so json tags and json.RawMessage apply.
type composeFileServices struct {
	Services map[string]struct {
		Build json.RawMessage `json:"build,omitempty"`
	} `json:"services"`
}

// runtimeFromBuildContext infers the app language from marker files in the
// service's local build context, located via the compose project labels
// (com.docker.compose.project.config_files / .working_dir). configFiles is
// the raw label value — comma-separated when the project was started with
// multiple -f files; the first file that yields a runtime wins. Best-effort:
// any failure (missing/foreign compose file, YAML error, no build section,
// unreadable dir) yields "unknown". Display-only enrichment — discovery
// correctness never depends on it (see the design doc for why compose-file
// parsing is otherwise avoided).
func runtimeFromBuildContext(configFiles, workingDir, service string) string {
	if configFiles == "" || service == "" {
		return "unknown"
	}
	for _, cf := range strings.Split(configFiles, ",") {
		dir, ok := buildContextDir(strings.TrimSpace(cf), workingDir, service)
		if !ok {
			continue
		}
		if rt := runtimeFromMarkerFiles(dir); rt != "unknown" {
			return rt
		}
	}
	return "unknown"
}

// buildContextDir resolves the local build-context directory for service
// from one compose file, or ok=false when it cannot.
func buildContextDir(configFile, workingDir, service string) (string, bool) {
	data, err := os.ReadFile(configFile)
	if err != nil {
		return "", false
	}
	var doc composeFileServices
	if err := yaml.Unmarshal(data, &doc); err != nil {
		return "", false
	}
	svc, ok := doc.Services[service]
	if !ok || len(svc.Build) == 0 {
		return "", false
	}
	var ctx string
	if err := json.Unmarshal(svc.Build, &ctx); err != nil {
		var obj struct {
			Context string `json:"context"`
		}
		if err := json.Unmarshal(svc.Build, &obj); err != nil {
			return "", false
		}
		ctx = obj.Context
	}
	if ctx == "" {
		ctx = "."
	}
	if !filepath.IsAbs(ctx) {
		base := workingDir
		if base == "" {
			base = filepath.Dir(configFile)
		}
		ctx = filepath.Join(base, ctx)
	}
	return ctx, true
}

// runtimeFromMarkerFiles inspects the top level of dir for well-known
// project marker files. Markers are checked in a fixed priority order (not
// directory order) so polyglot contexts resolve deterministically —
// package.json last, since it shows up in many non-Node repos.
func runtimeFromMarkerFiles(dir string) string {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return "unknown"
	}
	names := map[string]bool{}
	dotnetProj := false
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		n := strings.ToLower(e.Name())
		names[n] = true
		if strings.HasSuffix(n, ".csproj") || strings.HasSuffix(n, ".fsproj") || strings.HasSuffix(n, ".sln") {
			dotnetProj = true
		}
	}
	switch {
	case names["go.mod"]:
		return "go"
	case dotnetProj, names["global.json"]:
		return "dotnet"
	case names["cargo.toml"]:
		return "rust"
	case names["pom.xml"], names["build.gradle"], names["build.gradle.kts"]:
		return "java"
	case names["pyproject.toml"], names["requirements.txt"], names["setup.py"]:
		return "python"
	case names["package.json"]:
		return "node"
	}
	return "unknown"
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -run 'TestRuntimeFrom' -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/compose_runtime.go pkg/discovery/compose_runtime_test.go
git commit -m "feat(discovery): infer runtime from compose build-context marker files"
```

---

### Task 3: Capture signals in the compose scan and wire the chain

**Files:**
- Modify: `pkg/discovery/compose_inspect.go` (labels ~line 11-14, `composeContainer` ~line 18-29, `rawComposeContainer.Config` ~line 39-44, `parseComposeContainers` ~line 70-80)
- Modify: `pkg/discovery/compose_runtime.go` (append the chain function)
- Modify: `pkg/discovery/scan_compose.go` (app pairing block ~line 193-197)
- Modify: `pkg/discovery/service.go` (`ScanResult` struct — add field after `AppImage`)
- Modify: `pkg/discovery/testdata/compose_inspect.json` (add `Env` to the app container)
- Test: `pkg/discovery/compose_runtime_test.go`, `pkg/discovery/scan_compose_test.go` (append)

**Interfaces:**
- Consumes: `runtimeFromBuildContext` (Task 2), `InferRuntimeFromEnv` (Task 1), existing `InferRuntime`/`InferRuntimeFromImage`.
- Produces:
  - `composeContainer` gains `Env []string`, `ConfigFiles string`, `WorkingDir string`
  - `func composeAppRuntime(app composeContainer) string` in `compose_runtime.go`
  - `ScanResult.AppRuntime string` — Task 4's `enrich` reads it.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/discovery/compose_runtime_test.go`:

```go
func TestComposeAppRuntimeChainPrecedence(t *testing.T) {
	// Build-context fixture that would say "go" if reached.
	proj := t.TempDir()
	writeFile(t, filepath.Join(proj, "svc", "go.mod"), "module x")
	cf := filepath.Join(proj, "docker-compose.yml")
	writeFile(t, cf, "services:\n  web:\n    build: ./svc\n")

	base := composeContainer{Service: "web", ConfigFiles: cf, WorkingDir: proj}

	t.Run("argv beats everything", func(t *testing.T) {
		app := base
		app.Argv = []string{"dotnet", "App.dll"}
		app.Env = []string{"NODE_VERSION=22"}
		app.Image = "python:3.12"
		require.Equal(t, "dotnet", composeAppRuntime(app))
	})
	t.Run("env beats image and files", func(t *testing.T) {
		app := base
		app.Argv = []string{"/entrypoint.sh"}
		app.Env = []string{"NODE_VERSION=22"}
		app.Image = "python:3.12"
		require.Equal(t, "node", composeAppRuntime(app))
	})
	t.Run("image beats files", func(t *testing.T) {
		app := base
		app.Argv = []string{"/app/server"}
		app.Image = "python:3.12"
		require.Equal(t, "python", composeAppRuntime(app))
	})
	t.Run("build context is the last resort", func(t *testing.T) {
		app := base
		app.Argv = []string{"/app/server"}
		app.Image = "custom-app"
		require.Equal(t, "go", composeAppRuntime(app))
	})
	t.Run("all unknown", func(t *testing.T) {
		app := composeContainer{Service: "web", Argv: []string{"/app/server"}, Image: "custom-app"}
		require.Equal(t, "unknown", composeAppRuntime(app))
	})
}
```

Append to `pkg/discovery/scan_compose_test.go`, inside `TestComposeSourceScan` after the `r.AppImage` check (line ~83):

```go
	// App runtime: fixture app container has entrypoint /app/server (no
	// command signal), image saga-primes-go (no image signal), and
	// GOLANG_VERSION in env — the env marker resolves it.
	if r.AppRuntime != "go" {
		t.Fatalf("app runtime from env marker: %+v", r)
	}
```

- [ ] **Step 2: Update the fixture**

In `pkg/discovery/testdata/compose_inspect.json`, find the app container object (`"Name": "/saga-primes-go-1"`) and add an `Env` array to its `Config` (next to `"Entrypoint": ["/app/server"]`):

```json
"Env": ["PATH=/usr/local/bin:/usr/bin", "GOLANG_VERSION=1.23.4"],
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/discovery/ -run 'TestComposeAppRuntimeChainPrecedence|TestComposeSourceScan' -v`
Expected: FAIL to compile — `unknown field Env/ConfigFiles/WorkingDir in composeContainer`, `undefined: composeAppRuntime`, `r.AppRuntime undefined`.

- [ ] **Step 4: Implement**

`pkg/discovery/compose_inspect.go` — extend the label constants (line 11-14):

```go
const (
	labelComposeProject     = "com.docker.compose.project"
	labelComposeService     = "com.docker.compose.service"
	labelComposeConfigFiles = "com.docker.compose.project.config_files"
	labelComposeWorkingDir  = "com.docker.compose.project.working_dir"
)
```

Extend `composeContainer` (after `Argv`):

```go
	Env         []string // Config.Env — carries base-image markers like DOTNET_VERSION
	ConfigFiles string   // host path(s) of the compose file(s), comma-separated
	WorkingDir  string   // host project dir; base for relative build contexts
```

Extend `rawComposeContainer.Config` (after `Cmd`):

```go
		Env []string `json:"Env"`
```

Populate in `parseComposeContainers` (inside the `composeContainer{...}` literal, after `Argv`):

```go
			Env:         r.Config.Env,
			ConfigFiles: r.Config.Labels[labelComposeConfigFiles],
			WorkingDir:  r.Config.Labels[labelComposeWorkingDir],
```

`pkg/discovery/compose_runtime.go` — append the chain:

```go
// composeAppRuntime resolves the app's language from scan data, cheapest
// signal first: launch command, base-image env markers, image name, and
// finally marker files in the service's local build context (the only step
// that touches the filesystem).
func composeAppRuntime(app composeContainer) string {
	if rt := InferRuntime(strings.Join(app.Argv, " ")); rt != "unknown" {
		return rt
	}
	if rt := InferRuntimeFromEnv(app.Env); rt != "unknown" {
		return rt
	}
	if rt := InferRuntimeFromImage(app.Image); rt != "unknown" {
		return rt
	}
	return runtimeFromBuildContext(app.ConfigFiles, app.WorkingDir, app.Service)
}
```

`pkg/discovery/service.go` — add to `ScanResult` after `AppImage`:

```go
	// AppRuntime is the compose scanner's language inference for the app
	// container ("" for other sources; possibly "unknown").
	AppRuntime string
```

`pkg/discovery/scan_compose.go` — in the app-pairing block (line ~193-197), add one line:

```go
			if app, ok := byProjSvc[c.Project+"/"+appSvc]; ok {
				r.AppContainerID = app.ID
				r.AppContainerName = app.Name
				r.AppImage = app.Image
				r.AppRuntime = composeAppRuntime(app)
			}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -v`
Expected: PASS — including the pre-existing scan/cache tests.

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery/compose_inspect.go pkg/discovery/compose_runtime.go pkg/discovery/scan_compose.go pkg/discovery/service.go pkg/discovery/testdata/compose_inspect.json pkg/discovery/compose_runtime_test.go pkg/discovery/scan_compose_test.go
git commit -m "feat(discovery): compose scan computes app runtime via signal chain"
```

---

### Task 4: `enrich` consumes `AppRuntime`

**Files:**
- Modify: `pkg/discovery/service.go` (`enrich`, the compose runtime fallback — currently `if in.Source == SourceCompose && in.Runtime == "unknown" { in.Runtime = InferRuntimeFromImage(r.AppImage) }`)
- Test: `pkg/discovery/service_test.go` (append)

**Interfaces:**
- Consumes: `ScanResult.AppRuntime` (Task 3).
- Produces: `Instance.Runtime` populated for compose apps — no API shape change; the frontend already renders it.

- [ ] **Step 1: Write the failing test**

Append to `pkg/discovery/service_test.go`:

```go
func TestEnrichComposeUsesAppRuntime(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			// Scanner chain resolved: wins over image inference.
			{AppID: "a", Source: SourceCompose, SidecarReachable: false, AppRuntime: "dotnet", AppImage: "python:3.12"},
			// Chain exhausted ("unknown"): image fallback still applies.
			{AppID: "b", Source: SourceCompose, SidecarReachable: false, AppRuntime: "unknown", AppImage: "python:3.12"},
			// Field absent (older fixtures): image fallback still applies.
			{AppID: "c", Source: SourceCompose, SidecarReachable: false, AppImage: "node:22"},
		}, nil
	}
	svc := New(scan, http.DefaultClient)
	apps, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, apps, 3)
	require.Equal(t, "dotnet", apps[0].Runtime)
	require.Equal(t, "python", apps[1].Runtime)
	require.Equal(t, "node", apps[2].Runtime)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestEnrichComposeUsesAppRuntime -v`
Expected: FAIL — `apps[0].Runtime` is `"python"` (image inference ignores `AppRuntime` today).

- [ ] **Step 3: Implement**

In `pkg/discovery/service.go` `enrich`, replace:

```go
	if in.Source == SourceCompose && in.Runtime == "unknown" {
		in.Runtime = InferRuntimeFromImage(r.AppImage)
	}
```

with:

```go
	if in.Source == SourceCompose && in.Runtime == "unknown" {
		// Prefer the scanner's signal chain (argv → env → image → build
		// context); fall back to image inference for scan results that
		// predate AppRuntime (test fixtures).
		in.Runtime = r.AppRuntime
		if in.Runtime == "" || in.Runtime == "unknown" {
			in.Runtime = InferRuntimeFromImage(r.AppImage)
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -v`
Expected: PASS — including `TestEnrichComposeCarriesContainerFields` (its fixture has no `AppRuntime`, so the image fallback still yields `"python"`).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): enrich prefers scanner AppRuntime for compose apps"
```

---

### Task 5: Full verification — suites, build, live daprmq stack

**Files:**
- No source changes expected (fix anything the suites surface).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the complete matrix**

```bash
make lint && make test && make build
```

Expected: all green; `bin/dev-dashboard` produced.

- [ ] **Step 2: Live verification (dapr-mq stack, 4 dotnet services)**

The user's own dashboard runs on port 9090 — do NOT stop it or use its port. Run the new build on 9091 and kill only that process afterwards:

```bash
./bin/dev-dashboard --port 9091 > /tmp/dd-runtime-check.log 2>&1 &
sleep 3
curl -s http://localhost:9091/api/apps | python3 -c "import json,sys; [print(a['instanceKey'], a['runtime']) for a in json.load(sys.stdin)]"
```

Expected — env/argv signals resolve all four:

```
daprmq-gateway-1 dotnet
daprmq-host-1 dotnet
daprmq-host-2 dotnet
daprmq-host-3 dotnet
```

Then stop the test instance (only the PID you started):

```bash
kill %1
```

- [ ] **Step 3: Report**

Report suite results and the live runtime values. Commit only if fixes were needed.
