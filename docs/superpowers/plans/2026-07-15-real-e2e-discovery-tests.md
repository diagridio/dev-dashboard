# Real E2E Discovery Tests Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one real end-to-end test per discovery mode (docker compose, TestContainers, Aspire) that stands up the actual runtime and verifies the dashboard discovers apps, workflows, and components through its real HTTP API.

**Architecture:** Each test boots the real built dashboard binary as a subprocess in the correct `--mode` against a live runtime, waits for discovery to converge, and asserts over `/api/apps/`, `/api/workflows/`, and `/api/resources/`. A shared `harness.go` provides the boot/poll/HTTP helpers. Fixtures live under `test/e2e/fixtures/`. A new `workflow_dispatch` GitHub Actions workflow runs them manually with the heavy toolchains installed.

**Tech Stack:** Go (`//go:build e2e`, testify), Docker + docker compose, testcontainers-go, .NET 8 + Aspire workload (`CommunityToolkit.Aspire.Hosting.Dapr`), Redis, Dapr (`daprd`).

## Global Constraints

- All new Go test files use the build tag `//go:build e2e` (first line, blank line, then `package e2e_test`).
- Tests must **skip**, not fail, when their toolchain is absent (Docker / dotnet / daprd) via the `require*` guards.
- Assertions poll with `waitFor` (generous deadlines) — never fixed `time.Sleep` for convergence.
- Dashboard CLI surface (verified): root command is the server; flags `--port` (default 9090), `--bind` (default 127.0.0.1), `--mode` (`dapr-run|compose|test-containers|aspire`), `--statestore`, `--no-open`. Health endpoint: `GET /api/health` → 200.
- Env contract (verified): `DEVDASHBOARD_APP_COUNT`, `DEVDASHBOARD_APP_<n>_ID`, `DEVDASHBOARD_APP_<n>_DAPR_HTTP`, `DEVDASHBOARD_RESOURCES_PATH`, `DEVDASHBOARD_STATESTORE_FILE`, `DEVDASHBOARD_PORT`, `DEVDASHBOARD_BIND`, `DEVDASHBOARD_ALLOWED_HOSTS`.
- The Go `wfapp` at `test/e2e/wfapp/` is a separate module; reuse it as the app for compose and testcontainers. Do not modify it.
- Discovery source strings (verified): `compose`, `testcontainers`, `aspire`.
- Run everything from repo root with `go test -tags e2e ./test/e2e/...`.

---

## Task 1: Shared harness + smoke test

**Files:**
- Create: `test/e2e/harness.go`
- Create: `test/e2e/harness_e2e_test.go`

**Interfaces:**
- Produces:
  - `dashboardBinary(t *testing.T) string` — abs path to `bin/diagrid-dev-dashboard`; skips if missing.
  - `freePort(t *testing.T) int` — an available TCP port.
  - `bootDashboard(t *testing.T, mode string, extraEnv []string, args ...string) string` — starts the binary, waits for `/api/health`, returns base URL.
  - `getJSON(t *testing.T, baseURL, path string) (string, int)` — GET, returns raw body + status.
  - `waitFor(t *testing.T, d time.Duration, cond func() bool)` — polls until true or fails.
  - `requireDocker(t *testing.T)`, `requireDotnet(t *testing.T)`, `requireDapr(t *testing.T)` — skip guards.

- [ ] **Step 1: Write the harness**

Create `test/e2e/harness.go`:

```go
//go:build e2e

package e2e_test

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// repoRoot returns the absolute path to the repository root (two levels up
// from test/e2e).
func repoRoot(t *testing.T) string {
	t.Helper()
	root, err := filepath.Abs(filepath.Join("..", ".."))
	require.NoError(t, err)
	return root
}

// dashboardBinary returns the path to the built dashboard binary, skipping the
// test if it is absent (build it with `make build`).
func dashboardBinary(t *testing.T) string {
	t.Helper()
	bin := filepath.Join(repoRoot(t), "bin", "diagrid-dev-dashboard")
	if _, err := os.Stat(bin); err != nil {
		t.Skipf("dashboard binary not built at %s; run `make build`", bin)
	}
	return bin
}

// freePort asks the kernel for a free TCP port and returns it.
func freePort(t *testing.T) int {
	t.Helper()
	l, err := net.Listen("tcp", "127.0.0.1:0")
	require.NoError(t, err)
	defer func() { _ = l.Close() }()
	return l.Addr().(*net.TCPAddr).Port
}

// bootDashboard starts the dashboard binary in the given mode, waits for
// /api/health to return 200, and returns the base URL. The process is killed
// on test cleanup.
func bootDashboard(t *testing.T, mode string, extraEnv []string, args ...string) string {
	t.Helper()
	bin := dashboardBinary(t)
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	full := append([]string{
		"--mode", mode,
		"--port", fmt.Sprint(port),
		"--no-open",
	}, args...)

	ctx, cancel := context.WithCancel(context.Background())
	cmd := exec.CommandContext(ctx, bin, full...)
	cmd.Env = append(os.Environ(), extraEnv...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	require.NoError(t, cmd.Start())
	t.Cleanup(func() {
		cancel()
		_ = cmd.Wait()
	})

	waitFor(t, 30*time.Second, func() bool {
		res, err := http.Get(base + "/api/health")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})
	return base
}

// getJSON performs a GET and returns the raw body and status code.
func getJSON(t *testing.T, baseURL, path string) (string, int) {
	t.Helper()
	res, err := http.Get(baseURL + path)
	require.NoError(t, err)
	defer func() { _ = res.Body.Close() }()
	b, err := io.ReadAll(res.Body)
	require.NoError(t, err)
	return string(b), res.StatusCode
}

// waitFor polls cond every 500ms until it returns true or the deadline elapses,
// failing the test on timeout.
func waitFor(t *testing.T, d time.Duration, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(d)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("condition not met within %s", d)
}

// requireDocker skips the test if the docker CLI is not on PATH.
func requireDocker(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("docker"); err != nil {
		t.Skip("docker not on PATH; skipping e2e")
	}
}

// requireDotnet skips the test if the dotnet CLI is not on PATH.
func requireDotnet(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("dotnet"); err != nil {
		t.Skip("dotnet not on PATH; skipping e2e")
	}
}

// requireDapr skips the test if daprd is not available on PATH or in ~/.dapr/bin.
func requireDapr(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("daprd"); err == nil {
		return
	}
	home, _ := os.UserHomeDir()
	if home != "" {
		if _, err := os.Stat(filepath.Join(home, ".dapr", "bin", "daprd")); err == nil {
			return
		}
	}
	t.Skip("daprd not found on PATH or in ~/.dapr/bin; skipping e2e")
}
```

- [ ] **Step 2: Write the smoke test**

Create `test/e2e/harness_e2e_test.go`:

```go
//go:build e2e

package e2e_test

import (
	"net/http"
	"testing"

	"github.com/stretchr/testify/require"
)

// TestHarnessBootsDashboard proves the harness can build/locate the binary,
// boot it, and reach its HTTP surface — no external runtime required. It boots
// in dapr-run mode with no apps present; discovery simply returns an empty list.
func TestHarnessBootsDashboard(t *testing.T) {
	base := bootDashboard(t, "dapr-run", nil)

	_, status := getJSON(t, base, "/api/health")
	require.Equal(t, http.StatusOK, status)

	body, status := getJSON(t, base, "/api/version")
	require.Equal(t, http.StatusOK, status)
	require.Contains(t, body, "version")

	// Apps endpoint responds with valid JSON (an array), even when empty.
	body, status = getJSON(t, base, "/api/apps/")
	require.Equal(t, http.StatusOK, status)
	require.True(t, body == "[]" || body[0] == '[', "expected JSON array, got %q", body)
}
```

- [ ] **Step 3: Build the binary and run the smoke test to verify it passes**

Run:
```bash
make build
go test -tags e2e -run TestHarnessBootsDashboard ./test/e2e/... -v
```
Expected: PASS. (If `make build` is skipped, the test SKIPs with "dashboard binary not built".)

- [ ] **Step 4: Commit**

```bash
git add test/e2e/harness.go test/e2e/harness_e2e_test.go
git commit -m "test(e2e): add shared harness for real discovery e2e tests"
```

---

## Task 2: Compose discovery e2e

**Files:**
- Create: `test/e2e/fixtures/compose/docker-compose.yaml`
- Create: `test/e2e/fixtures/compose/Dockerfile.wfapp`
- Create: `test/e2e/fixtures/compose/components/statestore.yaml`
- Create: `test/e2e/compose_e2e_test.go`

**Interfaces:**
- Consumes: `requireDocker`, `bootDashboard`, `getJSON`, `waitFor` (Task 1).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Write the component fixture**

Create `test/e2e/fixtures/compose/components/statestore.yaml`:

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: redis:6379
  - name: redisPassword
    value: ""
  - name: actorStateStore
    value: "true"
```

- [ ] **Step 2: Write the wfapp image**

Create `test/e2e/fixtures/compose/Dockerfile.wfapp` (build context is `test/e2e`, so `wfapp/` is visible):

```dockerfile
FROM golang:1.24 AS build
WORKDIR /src
COPY wfapp/go.mod wfapp/go.sum ./
RUN go mod download
COPY wfapp/ ./
RUN CGO_ENABLED=0 go build -o /wfapp .

FROM gcr.io/distroless/static-debian12
COPY --from=build /wfapp /wfapp
ENTRYPOINT ["/wfapp"]
```

- [ ] **Step 3: Write the compose project**

Create `test/e2e/fixtures/compose/docker-compose.yaml`. The daprd sidecar shares the wfapp network namespace so the go-sdk client reaches it on localhost; daprd mounts the components dir at `/components`.

```yaml
services:
  redis:
    image: redis:7
    ports:
      - "6379"

  wfapp:
    build:
      context: ../..
      dockerfile: fixtures/compose/Dockerfile.wfapp
    depends_on:
      - redis
    environment:
      DAPR_GRPC_ENDPOINT: "127.0.0.1:50001"
      DAPR_HTTP_ENDPOINT: "http://127.0.0.1:3500"

  daprd:
    image: "daprio/daprd:1.15.0"
    command:
      - "./daprd"
      - "-app-id"
      - "wfapp"
      - "-app-channel-address"
      - "127.0.0.1"
      - "-app-port"
      - "8080"
      - "-dapr-http-port"
      - "3500"
      - "-dapr-grpc-port"
      - "50001"
      - "-resources-path"
      - "/components"
      - "-placement-host-address"
      - "placement:50005"
    depends_on:
      - wfapp
      - placement
    network_mode: "service:wfapp"
    ports:
      - "3500"
      - "50001"
    volumes:
      - "./components:/components"

  placement:
    image: "daprio/placement:1.15.0"
    command: ["./placement", "-port", "50005"]
    ports:
      - "50005"
```

- [ ] **Step 4: Write the failing e2e test**

Create `test/e2e/compose_e2e_test.go`:

```go
//go:build e2e

package e2e_test

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestComposeDiscovery brings up a real compose project (redis + wfapp + daprd
// sidecar + placement), then boots the dashboard in compose mode and asserts it
// discovers the app, its component, and the completed workflow instance through
// the real HTTP API. The workflow assertion proves host->container Redis
// address translation.
func TestComposeDiscovery(t *testing.T) {
	requireDocker(t)

	dir := filepath.Join("fixtures", "compose")
	compose := func(args ...string) *exec.Cmd {
		c := exec.Command("docker", append([]string{"compose"}, args...)...)
		c.Dir = dir
		return c
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	up := compose("up", "-d", "--build")
	out, err := up.CombinedOutput()
	require.NoErrorf(t, err, "compose up: %s", out)
	t.Cleanup(func() {
		down := compose("down", "-v")
		_, _ = down.CombinedOutput()
	})

	// Wait for wfapp to schedule and complete its workflow (marker line).
	waitFor(t, 90*time.Second, func() bool {
		logs := compose("logs", "wfapp")
		b, _ := logs.CombinedOutput()
		return strings.Contains(string(b), "WORKFLOW_DONE")
	})

	base := bootDashboard(t, "compose", nil)

	// Apps: wfapp discovered from the compose sidecar.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"appId":"wfapp"`) &&
			strings.Contains(body, `"source":"compose"`)
	})
	body, _ := getJSON(t, base, "/api/apps/")
	require.Contains(t, body, `"health":"healthy"`)

	// Components: statestore read from the mounted -resources-path.
	body, _ = getJSON(t, base, "/api/resources/")
	require.Contains(t, body, "statestore")

	// Workflows: the completed instance is visible — proves host->container
	// Redis translation (redis:6379 -> localhost:<publishedPort>).
	waitFor(t, 30*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})
}
```

- [ ] **Step 5: Run to verify it fails without fixtures wired, then passes**

Run:
```bash
make build
go test -tags e2e -run TestComposeDiscovery ./test/e2e/... -v
```
Expected first run while wiring: FAIL on a specific assertion (e.g. app not discovered, or workflow not found) — use the failure to correct daprd args / network wiring. Iterate on the compose file until: PASS.

If the app is not discovered, verify with `docker compose -f test/e2e/fixtures/compose/docker-compose.yaml ps` that daprd is running and inspect its labels; adjust `-app-id`/network as needed. If workflows is empty, confirm the published Redis port and that the sidecar reached placement.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/fixtures/compose test/e2e/compose_e2e_test.go
git commit -m "test(e2e): add real docker compose discovery test"
```

---

## Task 3: TestContainers discovery e2e

**Files:**
- Create: `test/e2e/fixtures/testcontainers/go.mod`
- Create: `test/e2e/fixtures/testcontainers/main.go`
- Create: `test/e2e/fixtures/testcontainers/components/statestore.yaml`
- Create: `test/e2e/testcontainers_e2e_test.go`

**Interfaces:**
- Consumes: `requireDocker`, `bootDashboard`, `getJSON`, `waitFor` (Task 1).
- Produces: nothing consumed by later tasks.

The fixture is a standalone Go program (its own module) that starts a
testcontainers-go session — redis + wfapp + daprd sidecar sharing a network,
with the component YAML **copied into** the daprd container (tar-extraction is
the discovery path under test). It schedules the workflow, prints a marker, then
blocks until signalled so the containers stay up for the dashboard to scan.

- [ ] **Step 1: Write the component fixture**

Create `test/e2e/fixtures/testcontainers/components/statestore.yaml` (identical body to the compose one — copied, not referenced, because it is baked into the container):

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: redis:6379
  - name: redisPassword
    value: ""
  - name: actorStateStore
    value: "true"
```

- [ ] **Step 2: Initialise the fixture module**

Run:
```bash
cd test/e2e/fixtures/testcontainers
go mod init tcfixture
go get github.com/testcontainers/testcontainers-go@latest
go get github.com/testcontainers/testcontainers-go/modules/redis@latest
cd -
```
Expected: `go.mod` and `go.sum` created.

- [ ] **Step 3: Write the fixture program**

Create `test/e2e/fixtures/testcontainers/main.go`:

```go
// Command tcfixture starts a TestContainers session (redis + wfapp + daprd
// sidecar) with the component YAML copied into the daprd container, schedules a
// workflow, prints markers, and blocks until signalled. Used only by the e2e
// test; the dashboard scans the running containers while this program is alive.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/testcontainers/testcontainers-go"
	"github.com/testcontainers/testcontainers-go/network"
	tcredis "github.com/testcontainers/testcontainers-go/modules/redis"
	"github.com/testcontainers/testcontainers-go/wait"
)

func main() {
	ctx := context.Background()

	net, err := network.New(ctx)
	must(err)

	// Redis on the shared network with alias "redis".
	_, err = tcredis.Run(ctx, "redis:7",
		network.WithNetwork([]string{"redis"}, net),
	)
	must(err)

	// wfapp container (built by the e2e test into image "tcfixture-wfapp").
	wfapp, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:    "tcfixture-wfapp",
			Networks: []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"wfapp"}},
			Env: map[string]string{
				"DAPR_GRPC_ENDPOINT": "daprd:50001",
				"DAPR_HTTP_ENDPOINT": "http://daprd:3500",
			},
		},
		Started: true,
	})
	must(err)
	_ = wfapp

	// daprd sidecar with the component YAML copied in at /components.
	comp, err := os.ReadFile("components/statestore.yaml")
	must(err)
	daprd, err := testcontainers.GenericContainer(ctx, testcontainers.GenericContainerRequest{
		ContainerRequest: testcontainers.ContainerRequest{
			Image:    "daprio/daprd:1.15.0",
			Networks: []string{net.Name},
			NetworkAliases: map[string][]string{net.Name: {"daprd"}},
			Cmd: []string{
				"./daprd",
				"-app-id", "wfapp",
				"-app-channel-address", "wfapp",
				"-app-port", "8080",
				"-dapr-http-port", "3500",
				"-dapr-grpc-port", "50001",
				"-resources-path", "/components",
			},
			Files: []testcontainers.ContainerFile{
				{
					Reader:            bytesReader(comp),
					ContainerFilePath: "/components/statestore.yaml",
					FileMode:          0o644,
				},
			},
			ExposedPorts: []string{"3500/tcp", "50001/tcp"},
			WaitingFor:   wait.ForListeningPort("3500/tcp").WithStartupTimeout(60 * time.Second),
		},
		Started: true,
	})
	must(err)
	_ = daprd

	fmt.Println("TCFIXTURE_READY")

	// Block until signalled; the e2e test scans the containers meanwhile.
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
	fmt.Println("TCFIXTURE_STOPPING")
}

func must(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, "fixture error:", err)
		os.Exit(1)
	}
}
```

Add the `bytesReader` helper at the bottom of `main.go`:

```go
import "bytes"

func bytesReader(b []byte) *bytes.Reader { return bytes.NewReader(b) }
```

(Consolidate the two `import` blocks into one when writing the file.)

- [ ] **Step 4: Write the failing e2e test**

Create `test/e2e/testcontainers_e2e_test.go`:

```go
//go:build e2e

package e2e_test

import (
	"bufio"
	"context"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestTestcontainersDiscovery builds the wfapp image, launches the
// testcontainers fixture session, then boots the dashboard in test-containers
// mode and asserts it discovers the sidecar, the tar-extracted component, and
// the workflow instance through the real HTTP API.
func TestTestcontainersDiscovery(t *testing.T) {
	requireDocker(t)

	// Build the wfapp image the fixture references (context = test/e2e).
	build := exec.Command("docker", "build",
		"-t", "tcfixture-wfapp",
		"-f", "fixtures/compose/Dockerfile.wfapp",
		".")
	out, err := build.CombinedOutput()
	require.NoErrorf(t, err, "docker build wfapp: %s", out)

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	fix := exec.CommandContext(ctx, "go", "run", ".")
	fix.Dir = "fixtures/testcontainers"
	stdout, err := fix.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, fix.Start())
	t.Cleanup(func() {
		_ = fix.Process.Signal(syscallSIGTERM)
		_ = fix.Wait()
	})

	// Wait for the fixture to report ready.
	ready := make(chan struct{})
	go func() {
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			if strings.Contains(sc.Text(), "TCFIXTURE_READY") {
				close(ready)
				return
			}
		}
	}()
	select {
	case <-ready:
	case <-time.After(2 * time.Minute):
		t.Fatal("fixture did not become ready")
	}

	base := bootDashboard(t, "test-containers", nil)

	// Apps: sidecar discovered with source=testcontainers.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"source":"testcontainers"`)
	})

	// Components: statestore tar-extracted from the running container.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/resources/")
		return strings.Contains(body, "statestore")
	})

	// Workflows: instance visible through the store read path.
	waitFor(t, 30*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})
}
```

Add the signal constant near the top of the file (kept separate so the import stays clean):

```go
import "syscall"

var syscallSIGTERM = syscall.SIGTERM
```

(Fold this `import` into the block above when writing the file.)

- [ ] **Step 5: Run to verify, iterating on container wiring**

Run:
```bash
make build
cd test/e2e/fixtures/testcontainers && go mod tidy && cd -
go test -tags e2e -run TestTestcontainersDiscovery ./test/e2e/... -v
```
Expected while wiring: FAIL on a specific assertion. Use `docker ps` during the run to confirm the daprd container is labelled by testcontainers and reachable; adjust `Cmd`/aliases until: PASS. If workflows is empty, the wfapp may need the workflow scheduled before the sidecar is scanned — confirm `TCFIXTURE_READY` prints after the sidecar is up and give the reconciler time via the existing `waitFor`.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/fixtures/testcontainers test/e2e/testcontainers_e2e_test.go
git commit -m "test(e2e): add real testcontainers discovery test"
```

---

## Task 4: Aspire discovery e2e

**Files:**
- Create: `test/e2e/fixtures/aspire/AppHost/AppHost.csproj`
- Create: `test/e2e/fixtures/aspire/AppHost/Program.cs`
- Create: `test/e2e/fixtures/aspire/OrderService/OrderService.csproj`
- Create: `test/e2e/fixtures/aspire/OrderService/Program.cs`
- Create: `test/e2e/aspire_e2e_test.go`

**Interfaces:**
- Consumes: `requireDotnet`, `requireDocker`, `bootDashboard` is **not** used here (Aspire launches the dashboard itself); uses `getJSON`, `waitFor`, `dashboardBinary`, `requireDocker`.
- Produces: nothing consumed by later tasks.

Aspire owns process launch: the AppHost starts Redis, the `OrderService` Dapr app, and the dashboard binary as an executable resource in `--mode aspire`, injecting the `DEVDASHBOARD_APP_*` env contract. The dashboard is pinned to a known port so the test can connect.

- [ ] **Step 1: Write the OrderService Dapr workflow app**

Create `test/e2e/fixtures/aspire/OrderService/OrderService.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Dapr.Workflow" Version="1.15.0" />
  </ItemGroup>
</Project>
```

Create `test/e2e/fixtures/aspire/OrderService/Program.cs` — registers one workflow, schedules a single instance on startup:

```csharp
using Dapr.Workflow;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddDaprWorkflow(options =>
{
    options.RegisterWorkflow<OrderWorkflow>();
    options.RegisterActivity<NotifyActivity>();
});

var app = builder.Build();

app.MapGet("/healthz", () => Results.Ok());

// Schedule one workflow instance once the sidecar is ready.
_ = Task.Run(async () =>
{
    using var scope = app.Services.CreateScope();
    var client = scope.ServiceProvider.GetRequiredService<DaprWorkflowClient>();
    for (var i = 0; i < 30; i++)
    {
        try
        {
            await client.ScheduleNewWorkflowAsync(
                name: nameof(OrderWorkflow),
                instanceId: "e2e-order-1",
                input: "order");
            break;
        }
        catch
        {
            await Task.Delay(TimeSpan.FromSeconds(2));
        }
    }
});

app.Run();

sealed class OrderWorkflow : Workflow<string, string>
{
    public override async Task<string> RunAsync(WorkflowContext context, string input)
        => await context.CallActivityAsync<string>(nameof(NotifyActivity), input);
}

sealed class NotifyActivity : WorkflowActivity<string, string>
{
    public override Task<string> RunAsync(WorkflowActivityContext context, string input)
        => Task.FromResult($"notified:{input}");
}
```

- [ ] **Step 2: Write the Aspire AppHost**

Create `test/e2e/fixtures/aspire/AppHost/AppHost.csproj`:

```xml
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsAspireHost>true</IsAspireHost>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Aspire.Hosting.AppHost" Version="8.2.0" />
    <PackageReference Include="Aspire.Hosting.Redis" Version="8.2.0" />
    <PackageReference Include="CommunityToolkit.Aspire.Hosting.Dapr" Version="9.0.0" />
  </ItemGroup>
</Project>
```

Create `test/e2e/fixtures/aspire/AppHost/Program.cs`. The dashboard binary path and port come from environment variables the e2e test sets (`DASH_BIN`, `DASH_PORT`):

```csharp
using CommunityToolkit.Aspire.Hosting.Dapr;

var builder = DistributedApplication.CreateBuilder(args);

var redis = builder.AddRedis("statestore");

var orders = builder.AddProject<Projects.OrderService>("orderservice")
    .WithReference(redis)
    .WithDaprSidecar(new DaprSidecarOptions
    {
        AppId = "orderservice",
        ResourcesPaths = new[] { "components" },
    });

var dashBin = Environment.GetEnvironmentVariable("DASH_BIN")
    ?? throw new InvalidOperationException("DASH_BIN not set");
var dashPort = Environment.GetEnvironmentVariable("DASH_PORT") ?? "9099";

builder.AddExecutable("dashboard", dashBin, workingDirectory: ".",
        "--mode", "aspire", "--port", dashPort, "--bind", "0.0.0.0", "--no-open")
    .WithReference(orders);

builder.Build().Run();
```

Create `test/e2e/fixtures/aspire/AppHost/components/statestore.yaml` (the sidecar's resources path):

```yaml
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
  - name: redisHost
    value: localhost:6379
  - name: actorStateStore
    value: "true"
```

- [ ] **Step 3: Verify the .NET fixture builds (confirms package API names)**

Run:
```bash
cd test/e2e/fixtures/aspire && dotnet build && cd -
```
Expected: build succeeds. If `WithDaprSidecar`/`DaprSidecarOptions` names differ in the installed `CommunityToolkit.Aspire.Hosting.Dapr` version, adjust to the version's API (check `dotnet build` errors) and re-run until green. This step exists specifically to pin the exact API before writing the Go test.

- [ ] **Step 4: Write the failing e2e test**

Create `test/e2e/aspire_e2e_test.go`:

```go
//go:build e2e

package e2e_test

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// TestAspireDiscovery runs a real .NET Aspire AppHost that launches Redis, a
// .NET Dapr workflow app, and the dashboard binary in aspire mode. It asserts
// the dashboard discovers the app (via the env contract), its component, and
// the workflow instance, and that gated routes are absent.
func TestAspireDiscovery(t *testing.T) {
	requireDotnet(t)
	requireDocker(t)

	bin := dashboardBinary(t)
	port := freePort(t)
	base := fmt.Sprintf("http://127.0.0.1:%d", port)

	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()

	apphost := exec.CommandContext(ctx, "dotnet", "run", "--project", "AppHost")
	apphost.Dir = "fixtures/aspire"
	apphost.Env = append(os.Environ(),
		"DASH_BIN="+bin,
		"DASH_PORT="+fmt.Sprint(port),
	)
	apphost.Stdout = os.Stdout
	apphost.Stderr = os.Stderr
	require.NoError(t, apphost.Start())
	t.Cleanup(func() {
		cancel()
		_ = apphost.Wait()
	})

	// Wait for the dashboard (launched by Aspire) to answer.
	waitFor(t, 3*time.Minute, func() bool {
		res, err := http.Get(base + "/api/health")
		if err != nil {
			return false
		}
		_ = res.Body.Close()
		return res.StatusCode == http.StatusOK
	})

	// Apps: orderservice discovered via the env contract, source=aspire.
	waitFor(t, 60*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/apps/")
		return strings.Contains(body, `"appId":"orderservice"`) &&
			strings.Contains(body, `"source":"aspire"`)
	})

	// Components: statestore from DEVDASHBOARD_RESOURCES_PATH.
	waitFor(t, 30*time.Second, func() bool {
		body, _ := getJSON(t, base, "/api/resources/")
		return strings.Contains(body, "statestore")
	})

	// Workflows: instance from the Aspire-managed Redis.
	waitFor(t, 60*time.Second, func() bool {
		body, status := getJSON(t, base, "/api/workflows/")
		return status == 200 && strings.Contains(body, "e2e-order-1")
	})

	// Negative: controlplane and per-app logs are gated off in aspire mode.
	_, status := getJSON(t, base, "/api/controlplane/")
	require.Equal(t, http.StatusNotFound, status)
	_, status = getJSON(t, base, "/api/apps/orderservice/logs")
	require.Equal(t, http.StatusNotFound, status)
}
```

- [ ] **Step 5: Run to verify, iterating on Aspire wiring**

Run:
```bash
make build
go test -tags e2e -run TestAspireDiscovery ./test/e2e/... -v
```
Expected while wiring: FAIL on a specific assertion. Confirm Aspire injects `DEVDASHBOARD_APP_*` into the dashboard resource (the `.WithReference(orders)` drives this); if apps are empty, check the AppHost logs for the env vars passed to the dashboard executable and adjust the reference/naming until: PASS.

- [ ] **Step 6: Commit**

```bash
git add test/e2e/fixtures/aspire test/e2e/aspire_e2e_test.go
git commit -m "test(e2e): add real aspire discovery test"
```

---

## Task 5: Manual CI workflow

**Files:**
- Create: `.github/workflows/e2e.yaml`

**Interfaces:**
- Consumes: the three test functions and `make build`.
- Produces: nothing.

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/e2e.yaml`:

```yaml
name: e2e

on:
  workflow_dispatch:
    inputs:
      mode:
        description: "Which mode(s) to run"
        type: choice
        default: all
        options: [all, compose, testcontainers, aspire]

jobs:
  e2e:
    runs-on: ubuntu-latest
    strategy:
      fail-fast: false
      matrix:
        mode: [compose, testcontainers, aspire]
    steps:
      - uses: actions/checkout@v4

      - name: Skip unselected modes
        id: gate
        run: |
          want='${{ github.event.inputs.mode }}'
          if [ "$want" = "all" ] || [ "$want" = "${{ matrix.mode }}" ]; then
            echo "run=true" >> "$GITHUB_OUTPUT"
          else
            echo "run=false" >> "$GITHUB_OUTPUT"
          fi

      - uses: actions/setup-go@v5
        if: steps.gate.outputs.run == 'true'
        with:
          go-version-file: go.mod

      - uses: actions/setup-node@v4
        if: steps.gate.outputs.run == 'true'
        with:
          node-version: 20

      - name: Setup .NET + Aspire workload
        if: steps.gate.outputs.run == 'true' && matrix.mode == 'aspire'
        uses: actions/setup-dotnet@v4
        with:
          dotnet-version: 8.0.x

      - name: Install Aspire workload
        if: steps.gate.outputs.run == 'true' && matrix.mode == 'aspire'
        run: dotnet workload install aspire

      - name: Install Dapr CLI + runtime
        if: steps.gate.outputs.run == 'true'
        run: |
          wget -q https://raw.githubusercontent.com/dapr/cli/master/install/install.sh -O - | /bin/bash
          dapr init --slim

      - name: Build dashboard
        if: steps.gate.outputs.run == 'true'
        run: make build

      - name: Run e2e (${{ matrix.mode }})
        if: steps.gate.outputs.run == 'true'
        run: |
          case "${{ matrix.mode }}" in
            compose)        run=TestComposeDiscovery ;;
            testcontainers) run=TestTestcontainersDiscovery ;;
            aspire)         run=TestAspireDiscovery ;;
          esac
          go test -tags e2e -run "$run" -timeout 15m -v ./test/e2e/...
```

- [ ] **Step 2: Validate the workflow YAML**

Run:
```bash
python3 -c "import yaml,sys; yaml.safe_load(open('.github/workflows/e2e.yaml')); print('ok')"
```
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/e2e.yaml
git commit -m "ci: add manual e2e workflow for discovery tests"
```

---

## Self-Review notes

- **Spec coverage:** harness (Task 1); compose apps/workflows/components + translation (Task 2); testcontainers apps/workflows/components + tar-extraction (Task 3); aspire apps/workflows/components + env-contract + gated-route negatives (Task 4); manual `workflow_dispatch` CI with per-mode matrix and toolchain install (Task 5). All spec sections mapped.
- **Forward-compat note:** the Aspire fixture is reusable for the future gRPC `DashboardService` discovery path (spec §Mode 3) — no task needed now since that code is unbuilt.
- **Known iteration points (not placeholders):** exact daprd container/network args (Tasks 2–3) and the `CommunityToolkit.Aspire.Hosting.Dapr` API surface (Task 4) are pinned by explicit build/run-and-adjust steps, because they depend on installed image/package versions.
- **Type consistency:** helper names (`bootDashboard`, `getJSON`, `waitFor`, `require*`, `dashboardBinary`, `freePort`) are defined once in Task 1 and used verbatim in Tasks 2–4.
