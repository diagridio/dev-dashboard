# Compose-Embedded Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the dashboard run as a service inside a user's own Docker Compose file, discovering only the Dapr apps that file declares, over sidecar HTTP/gRPC with no Docker socket.

**Architecture:** Generalize the existing "container posture" from Aspire-only to contract-driven, so `DEVDASHBOARD_MODE=compose` plus the `DEVDASHBOARD_APP_*` env contract selects a compose container posture. The contract scanner gains a source parameter and a gRPC address (derived from the HTTP base URL), and the workflow sidecar endpoint resolver stops hardcoding `127.0.0.1`. Capabilities gate off logs, lifecycle, and the control plane at the route level.

**Tech Stack:** Go 1.26 (stdlib + cobra + chi + testify), React 19 + TypeScript + Vitest for the SPA.

## Global Constraints

- Go tests carry the `//go:build unit` build tag and run via `go test -tags unit -race ./...` (or `make test-go`). A test file without the tag is invisible to CI.
- Web tests run via `cd web && npm test` (Vitest).
- `gofmt` must be clean; `make lint-go` runs `gofmt -l .` and `go vet -tags unit ./...`.
- **Zero regression to host posture.** Every existing mode must behave bit-for-bit as today. Where a shared helper is changed, an existing-behavior test must prove the host path is unchanged.
- Sidecar workflow inspection requires **Dapr 1.17+**; older runtimes surface the existing `workflow.ErrSidecarUnsupported`.
- `DEVDASHBOARD_APP_COUNT` stays bounded by `maxAspireAppCount` (1024).
- Default daprd gRPC port for derivation is `50001`.
- Contract validation is **fail-fast at startup** and every error names the exact environment variable.
- Do not change the `DEVDASHBOARD_MODE=aspire` default baked into `Dockerfile` / `Dockerfile.goreleaser` — it would break the existing Aspire hosting integration.
- Do not run `git push` or open a PR; commit locally only.

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `pkg/discovery/scan_aspire.go` → `pkg/discovery/scan_contract.go` | Parse the `DEVDASHBOARD_APP_*` contract into `ScanResult`s | Rename; add `source` param + `_DAPR_GRPC` |
| `pkg/discovery/types.go` | `Instance` struct | Add `DaprGRPCAddr` |
| `pkg/discovery/health.go` | Endpoint resolution (`BaseURL`) | Add `GRPCAddr()` |
| `pkg/discovery/service.go` | Enrichment; `ScanResult` | Add `DaprGRPCAddr` passthrough |
| `cmd/mode.go` | Mode parsing + posture + serve settings | Generalize `containerPosture` |
| `cmd/root.go` | Wiring in `runServe` | Mode-derived source, capabilities |
| `cmd/reconciler.go` | Sidecar endpoint resolution + eligibility | Use `GRPCAddr()`, add posture clause |
| `pkg/server/server.go` | `Capabilities` | Add `ContainerPosture` |
| `web/src/lib/capabilities.ts` | SPA capability flags | Add `containerPosture` |
| `web/src/pages/AppDetail.tsx`, `web/src/pages/Applications.tsx` | Unreachable-sidecar hint copy | Posture-aware copy |
| `README.md`, `ARCHITECTURE.md` | Docs | Compose container posture |

---

### Task 1: `Instance.GRPCAddr()` — resolve the sidecar gRPC endpoint

Today `cmd/reconciler.go:468` builds the sidecar gRPC address as `"127.0.0.1:" + strconv.Itoa(in.GRPCPort)`, which is a host-posture assumption. This task adds a resolver alongside the existing `BaseURL()` so a contract-supplied address can win, exactly as `DaprHTTPBaseURL` wins in `sidecarBaseURL`.

**Files:**
- Modify: `pkg/discovery/types.go` (add one field to `Instance`, after `DaprHTTPBaseURL` at line 39)
- Modify: `pkg/discovery/health.go` (add `GRPCAddr()` after `BaseURL()` at line 23)
- Test: `pkg/discovery/health_test.go` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `discovery.Instance.DaprGRPCAddr string` — JSON `daprGrpcAddr,omitempty`
  - `func (in Instance) GRPCAddr() string` — returns `DaprGRPCAddr` if non-empty, else `"127.0.0.1:<GRPCPort>"`, else `""` when `GRPCPort == 0`.

- [ ] **Step 1: Write the failing test**

Append to `pkg/discovery/health_test.go`:

```go
func TestInstanceGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		in   Instance
		want string
	}{
		{
			name: "contract address wins over port",
			in:   Instance{DaprGRPCAddr: "order-dapr:50001", GRPCPort: 9999},
			want: "order-dapr:50001",
		},
		{
			name: "no contract address falls back to loopback port",
			in:   Instance{GRPCPort: 58445},
			want: "127.0.0.1:58445",
		},
		{
			name: "neither available yields empty",
			in:   Instance{},
			want: "",
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.in.GRPCAddr(); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestInstanceGRPCAddr -v`
Expected: FAIL — compile error, `in.GRPCAddr undefined` and `unknown field DaprGRPCAddr`.

- [ ] **Step 3: Add the field**

In `pkg/discovery/types.go`, immediately after the `DaprHTTPBaseURL` field (line 39):

```go
	// DaprGRPCAddr is the daprd gRPC endpoint as host:port for
	// contract-declared apps ("" otherwise; consumers fall back to
	// 127.0.0.1:grpcPort).
	DaprGRPCAddr string `json:"daprGrpcAddr,omitempty"`
```

- [ ] **Step 4: Add the resolver**

In `pkg/discovery/health.go`, after `BaseURL()`. Note `strconv` must be added to the import block:

```go
// GRPCAddr resolves this instance's daprd gRPC endpoint as host:port (a
// contract-supplied address wins, else the loopback-port form). Empty means
// no gRPC endpoint is known.
func (in Instance) GRPCAddr() string {
	if in.DaprGRPCAddr != "" {
		return in.DaprGRPCAddr
	}
	if in.GRPCPort == 0 {
		return ""
	}
	return "127.0.0.1:" + strconv.Itoa(in.GRPCPort)
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestInstanceGRPCAddr -v`
Expected: PASS, all three subtests.

- [ ] **Step 6: Verify no regression and formatting**

Run: `gofmt -l pkg/discovery/ && go test -tags unit ./pkg/discovery/`
Expected: no gofmt output, all discovery tests PASS.

- [ ] **Step 7: Commit**

```bash
git add pkg/discovery/types.go pkg/discovery/health.go pkg/discovery/health_test.go
git commit -m "feat(discovery): add Instance.GRPCAddr for contract-supplied sidecar endpoints"
```

---

### Task 2: Contract scanner — source parameter and `_DAPR_GRPC`

`pkg/discovery/scan_aspire.go` hardcodes `Source: SourceAspire`, so compose-posture apps would be flagged `IsAspire` (`service.go:224`). This task renames the file to reflect that the contract is no longer Aspire-specific, parameterizes the source, and adds the gRPC address with derivation from `_DAPR_HTTP`.

Derivation rule: take the **host** of `_DAPR_HTTP` (host without port, or host:port with the port replaced) and append `:50001`. `http://order-dapr:3500` → `order-dapr:50001`. This is correct in all three compose network shapes because it inherits whichever host already reaches the sidecar.

**Files:**
- Rename: `pkg/discovery/scan_aspire.go` → `pkg/discovery/scan_contract.go`
- Rename: `pkg/discovery/scan_aspire_test.go` → `pkg/discovery/scan_contract_test.go`
- Modify: `pkg/discovery/service.go` (add `DaprGRPCAddr` to `ScanResult` and its enrichment passthrough)
- Modify: `cmd/root.go:141,169` and `cmd/sources_test.go` if they reference the old names

**Interfaces:**
- Consumes: `Instance.DaprGRPCAddr` (Task 1).
- Produces:
  - `func ContractPresent(getenv func(string) string) bool` — replaces `AspireContractPresent`, same behavior (anchor `DEVDASHBOARD_APP_COUNT`).
  - `func NewContractScanner(getenv func(string) string, source string) (Scanner, error)` — replaces `NewAspireScanner`; `source` is `SourceAspire` or `SourceCompose`.
  - `ScanResult.DaprGRPCAddr string`.

- [ ] **Step 1: Rename the files (no content change yet)**

```bash
git mv pkg/discovery/scan_aspire.go pkg/discovery/scan_contract.go
git mv pkg/discovery/scan_aspire_test.go pkg/discovery/scan_contract_test.go
```

- [ ] **Step 2: Write the failing tests**

Append to `pkg/discovery/scan_contract_test.go`:

```go
// envMap returns a getenv func over a fixed map.
func envMap(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

// baseContract is a single valid app, for tests that vary one thing.
func baseContract() map[string]string {
	return map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order-processor",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://order-dapr:3500",
	}
}

func TestContractScannerSourceParameter(t *testing.T) {
	for _, source := range []string{SourceAspire, SourceCompose} {
		t.Run(source, func(t *testing.T) {
			scan, err := NewContractScanner(envMap(baseContract()), source)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got, err := scan()
			if err != nil {
				t.Fatalf("unexpected scan error: %v", err)
			}
			if len(got) != 1 {
				t.Fatalf("got %d results, want 1", len(got))
			}
			if got[0].Source != source {
				t.Fatalf("got source %q want %q", got[0].Source, source)
			}
		})
	}
}

func TestContractScannerDerivesGRPCAddr(t *testing.T) {
	tests := []struct {
		name     string
		daprHTTP string
		want     string
	}{
		// The three compose network shapes from the design doc.
		{name: "separate sidecar service", daprHTTP: "http://order-dapr:3500", want: "order-dapr:50001"},
		{name: "app joins sidecar namespace", daprHTTP: "http://daprd:3500", want: "daprd:50001"},
		{name: "sidecar joins app namespace", daprHTTP: "http://order-processor:3500", want: "order-processor:50001"},
		// No explicit port in the URL.
		{name: "host without port", daprHTTP: "http://order-dapr", want: "order-dapr:50001"},
		// Host posture / Aspire values still derive sanely.
		{name: "loopback with port", daprHTTP: "http://127.0.0.1:3500", want: "127.0.0.1:50001"},
		{name: "https base url", daprHTTP: "https://order-dapr:3500", want: "order-dapr:50001"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := baseContract()
			env["DEVDASHBOARD_APP_0_DAPR_HTTP"] = tc.daprHTTP
			scan, err := NewContractScanner(envMap(env), SourceCompose)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			got, _ := scan()
			if got[0].DaprGRPCAddr != tc.want {
				t.Fatalf("got %q want %q", got[0].DaprGRPCAddr, tc.want)
			}
		})
	}
}

func TestContractScannerExplicitGRPCAddrWins(t *testing.T) {
	env := baseContract()
	env["DEVDASHBOARD_APP_0_DAPR_GRPC"] = "sidecar-alias:60001"
	scan, err := NewContractScanner(envMap(env), SourceCompose)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, _ := scan()
	if got[0].DaprGRPCAddr != "sidecar-alias:60001" {
		t.Fatalf("got %q want %q", got[0].DaprGRPCAddr, "sidecar-alias:60001")
	}
}

func TestContractScannerRejectsMalformedGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		val  string
	}{
		{name: "no port", val: "order-dapr"},
		{name: "non-numeric port", val: "order-dapr:grpc"},
		{name: "port out of range", val: "order-dapr:70000"},
		{name: "url not host:port", val: "http://order-dapr:50001"},
		{name: "empty host", val: ":50001"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			env := baseContract()
			env["DEVDASHBOARD_APP_0_DAPR_GRPC"] = tc.val
			_, err := NewContractScanner(envMap(env), SourceCompose)
			if err == nil {
				t.Fatal("want error, got nil")
			}
			// Fail-fast errors must name the exact variable.
			if !strings.Contains(err.Error(), "DEVDASHBOARD_APP_0_DAPR_GRPC") {
				t.Fatalf("error must name the variable, got: %v", err)
			}
		})
	}
}
```

If `scan_contract_test.go` does not already import `strings`, add it.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/ -run TestContractScanner -v`
Expected: FAIL — `undefined: NewContractScanner`.

- [ ] **Step 4: Add `DaprGRPCAddr` to `ScanResult` and enrichment**

In `pkg/discovery/service.go`, add to the `ScanResult` struct next to the other endpoint fields:

```go
	// DaprGRPCAddr is the contract-supplied daprd gRPC endpoint (host:port).
	DaprGRPCAddr string
```

Then in the enrichment function, alongside where `DaprHTTPBaseURL` is carried onto the `Instance` (near `service.go:224`), add:

```go
	in.DaprGRPCAddr = r.DaprGRPCAddr
```

- [ ] **Step 5: Rename the exported functions and add gRPC parsing**

In `pkg/discovery/scan_contract.go`:

1. Rename `AspireContractPresent` → `ContractPresent` (keep the body and the doc comment's anchor-variable note; drop "aspire" from the wording).
2. Change the signature to `func NewContractScanner(getenv func(string) string, source string) (Scanner, error)`.
3. Replace `Source: SourceAspire` with `Source: source`.
4. Inside the per-app loop, after `label` is resolved and before `results = append(...)`, add:

```go
		grpcKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_DAPR_GRPC", i)
		grpcAddr := strings.TrimSpace(getenv(grpcKey))
		if grpcAddr == "" {
			grpcAddr = deriveGRPCAddr(u)
		} else if err := validateHostPort(grpcAddr); err != nil {
			errs = append(errs, fmt.Errorf("%s: %w", grpcKey, err))
			continue
		}
```

5. Add `DaprGRPCAddr: grpcAddr,` to the `ScanResult` literal.
6. Add these helpers at the end of the file:

```go
// defaultDaprGRPCPort is daprd's default gRPC port, used when the contract
// declares only an HTTP base URL.
const defaultDaprGRPCPort = "50001"

// deriveGRPCAddr builds the sidecar gRPC endpoint from the validated HTTP
// base URL: the same host, with daprd's default gRPC port. Correct in every
// compose network shape because it inherits whichever host already reaches
// the sidecar.
func deriveGRPCAddr(u *url.URL) string {
	return net.JoinHostPort(u.Hostname(), defaultDaprGRPCPort)
}

// validateHostPort rejects anything that is not a bare host:port with a
// numeric in-range port (a URL, a bare host, an empty host).
func validateHostPort(addr string) error {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return fmt.Errorf("expected a host:port address, got %q", addr)
	}
	if host == "" {
		return fmt.Errorf("expected a host:port address with a non-empty host, got %q", addr)
	}
	if strings.Contains(host, "/") {
		return fmt.Errorf("expected a host:port address, not a URL, got %q", addr)
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return fmt.Errorf("expected a port number in 1-65535, got %q", addr)
	}
	return nil
}
```

Add `net` to the import block (`net/url`, `strconv`, `strings`, `fmt` are already imported).

Note on the `url not host:port` case: `net.SplitHostPort("http://order-dapr:50001")` splits into host `http://order-dapr` and port `50001`, which is why the explicit `/` check is needed.

- [ ] **Step 6: Update the call sites**

In `cmd/root.go`, the two `discovery.NewAspireScanner(os.Getenv)` calls (lines 141 and 169) become `discovery.NewContractScanner(os.Getenv, discovery.SourceAspire)` for now — Task 4 makes line 141's source mode-derived. Every `discovery.AspireContractPresent` reference (`cmd/mode.go:58`, `cmd/root.go:149`) becomes `discovery.ContractPresent`.

Find any remaining references:

```bash
grep -rn "AspireContractPresent\|NewAspireScanner" --include=*.go .
```

Expected after the edit: no matches.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/discovery/ -run TestContractScanner -v`
Expected: PASS — all subtests including the six derivation shapes and five malformed cases.

- [ ] **Step 8: Verify no regression across the whole suite**

Run: `gofmt -l . && go test -tags unit -race ./...`
Expected: no gofmt output; all packages PASS. The pre-existing renamed aspire tests must still pass unchanged apart from the function name.

> **Windows note:** `TestDerivePaths_AutoDetect` and `TestRegistry_SaveLoadRoundTrip_WindowsPath` fail on Windows on every branch (path separator and file mode). Ignore those two when judging regressions.

- [ ] **Step 9: Commit**

```bash
git add pkg/discovery/scan_contract.go pkg/discovery/scan_contract_test.go pkg/discovery/service.go cmd/root.go cmd/mode.go
git commit -m "feat(discovery): parameterize contract scanner source and add gRPC address"
```

---

### Task 3: Compose container posture

`containerPosture` (`cmd/mode.go:57`) returns true only for Aspire. This task admits `ModeCompose`. Everything downstream in `resolveServeSettings` already keys off the boolean, so port 8080, bind `0.0.0.0`, `AllowNonLoopback`, and `QuietRegistry` follow automatically — the test proves that rather than adding code.

**Files:**
- Modify: `cmd/mode.go:53-59`
- Test: `cmd/mode_test.go` (append)

**Interfaces:**
- Consumes: `discovery.ContractPresent` (Task 2).
- Produces: `containerPosture(mode Mode, getenv func(string) string) bool` — true for `ModeAspire` or `ModeCompose` when the contract is present.

- [ ] **Step 1: Write the failing test**

Append to `cmd/mode_test.go`. It reuses the local `env` helper pattern already in that file:

```go
func TestContainerPostureMatrix(t *testing.T) {
	withContract := map[string]string{"DEVDASHBOARD_APP_COUNT": "1"}
	tests := []struct {
		name string
		mode Mode
		env  map[string]string
		want bool
	}{
		{name: "compose with contract is container posture", mode: ModeCompose, env: withContract, want: true},
		{name: "compose without contract stays host posture", mode: ModeCompose, env: nil, want: false},
		{name: "aspire with contract is container posture", mode: ModeAspire, env: withContract, want: true},
		{name: "aspire without contract stays host posture", mode: ModeAspire, env: nil, want: false},
		{name: "dapr-run with contract is never container posture", mode: ModeDaprRun, env: withContract, want: false},
		{name: "test-containers with contract is never container posture", mode: ModeTestcontainers, env: withContract, want: false},
		{name: "mode unset with contract is never container posture", mode: ModeDefault, env: withContract, want: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			if got := containerPosture(tc.mode, getenv); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

// Compose container posture must inherit the same serving defaults as aspire
// container posture — this is behavior that falls out of resolveServeSettings
// keying off the posture bool, and this test pins it.
func TestComposeContainerPostureServeDefaults(t *testing.T) {
	getenv := func(string) string { return "" }
	unchanged := func(string) bool { return false }

	got, err := resolveServeSettings(true, unchanged, 9090, "127.0.0.1", "", "default", getenv)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Port != 8080 {
		t.Fatalf("port: got %d want 8080", got.Port)
	}
	if got.Bind != "0.0.0.0" {
		t.Fatalf("bind: got %q want 0.0.0.0", got.Bind)
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/ -run "TestContainerPostureMatrix|TestComposeContainerPostureServeDefaults" -v`
Expected: FAIL on `compose with contract is container posture` — got false, want true. `TestComposeContainerPostureServeDefaults` should already PASS (it pins existing behavior).

- [ ] **Step 3: Widen the posture check**

Replace `containerPosture` in `cmd/mode.go`:

```go
// containerPosture reports whether the dashboard serves as a container inside
// the orchestrator it is inspecting: aspire or compose mode with the
// DEVDASHBOARD_APP_* env contract present. Either mode without the contract is
// a host-run dashboard filtered to that source and keeps host serving defaults.
func containerPosture(mode Mode, getenv func(string) string) bool {
	switch mode {
	case ModeAspire, ModeCompose:
		return discovery.ContractPresent(getenv)
	}
	return false
}
```

Also update the `Mode` doc comment block above (lines 13-28) so `ModeCompose` records both postures, matching how `ModeAspire` is already documented:

```go
//   - ModeCompose: Docker Compose only. With the DEVDASHBOARD_APP_* env
//     contract present the dashboard is a service inside the user's compose
//     project (container posture, discovery restricted to the contract);
//     without it the dashboard runs on the host and scans compose containers
//     via the container runtime.
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run "TestContainerPostureMatrix|TestComposeContainerPostureServeDefaults" -v`
Expected: PASS, all seven matrix subtests plus the defaults test.

- [ ] **Step 5: Update the `--bind` and `--mode` flag help**

In `cmd/root.go:69-70` the help text says "aspire container posture". Widen it:

```go
	c.Flags().StringVar(&bind, "bind", "127.0.0.1", "address to bind (container posture defaults to 0.0.0.0); binding a non-loopback address outside container posture leaves the loopback Host guard in place, which rejects remote clients")
	c.Flags().StringVar(&modeFlag, "mode", "", `discovery filter: "dapr-run", "compose", "test-containers", or "aspire" show only that source's resources ("aspire" and "compose" also switch to container posture when the DEVDASHBOARD_APP_* contract is present); unset scans every source`)
```

Also update the non-loopback warning at `cmd/root.go:103`, which currently tells the user to set `--mode aspire`:

```go
		logger.Warn("binding a non-loopback address without container posture; the loopback Host guard will reject remote clients (set --mode aspire or --mode compose with the DEVDASHBOARD_APP_* contract for container serving posture)", "bind", settings.Bind)
```

- [ ] **Step 6: Verify no regression**

Run: `gofmt -l . && go test -tags unit -race ./cmd/ ./pkg/...`
Expected: no gofmt output; PASS (except the two known Windows failures).

- [ ] **Step 7: Commit**

```bash
git add cmd/mode.go cmd/mode_test.go cmd/root.go
git commit -m "feat(cmd): admit compose mode into container posture"
```

---

### Task 4: Wire the compose container posture in `runServe`

The `case containerPosture:` branch (`cmd/root.go:140`) hardcodes the Aspire source and gates `Workflows` on a state-store file. This task derives the source from the mode and enables `Workflows` when any app has a gRPC address, since sidecar-gRPC inspection needs no store.

**Files:**
- Modify: `cmd/root.go:139-147`
- Modify: `pkg/server/server.go:62-76` (`Capabilities`)
- Test: `cmd/root_capabilities_test.go` (create)

**Interfaces:**
- Consumes: `discovery.NewContractScanner` (Task 2), `containerPosture` (Task 3).
- Produces:
  - `server.Capabilities.ContainerPosture bool` — JSON `containerPosture`.
  - `func contractSource(mode Mode) string` in `cmd/mode.go` — `discovery.SourceCompose` for `ModeCompose`, else `discovery.SourceAspire`.
  - `func anyGRPCAddr(scan discovery.Scanner) bool` in `cmd/root.go`.

- [ ] **Step 1: Write the failing test**

Create `cmd/root_capabilities_test.go`:

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

func TestContractSource(t *testing.T) {
	tests := []struct {
		mode Mode
		want string
	}{
		{mode: ModeCompose, want: discovery.SourceCompose},
		{mode: ModeAspire, want: discovery.SourceAspire},
	}
	for _, tc := range tests {
		t.Run(string(tc.mode), func(t *testing.T) {
			if got := contractSource(tc.mode); got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}

func TestAnyGRPCAddr(t *testing.T) {
	tests := []struct {
		name string
		env  map[string]string
		want bool
	}{
		{
			name: "one declared app derives an address",
			env: map[string]string{
				"DEVDASHBOARD_APP_COUNT":       "1",
				"DEVDASHBOARD_APP_0_ID":        "order",
				"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://order-dapr:3500",
			},
			want: true,
		},
		{
			name: "zero apps has no address",
			env:  map[string]string{"DEVDASHBOARD_APP_COUNT": "0"},
			want: false,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			scan, err := discovery.NewContractScanner(getenv, discovery.SourceCompose)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got := anyGRPCAddr(scan); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/ -run "TestContractSource|TestAnyGRPCAddr" -v`
Expected: FAIL — `undefined: contractSource`, `undefined: anyGRPCAddr`.

- [ ] **Step 3: Add `ContainerPosture` to `Capabilities`**

In `pkg/server/server.go`, add to the `Capabilities` struct after `Mode`:

```go
	// ContainerPosture is true when the dashboard runs as a container inside
	// the orchestrator it inspects. Mode alone cannot express this: Mode is
	// "compose" both for a host-run compose scan and for a dashboard running
	// as a compose service, and Instance.Source is "compose" in both. The SPA
	// needs the distinction for posture-specific copy.
	ContainerPosture bool `json:"containerPosture"`
```

`FullCapabilities()` leaves it false, which is correct for every host mode.

- [ ] **Step 4: Add the two helpers**

In `cmd/mode.go`, after `containerPosture`:

```go
// contractSource maps a container-posture mode to the discovery Source the
// contract scanner stamps on its results.
func contractSource(mode Mode) string {
	if mode == ModeCompose {
		return discovery.SourceCompose
	}
	return discovery.SourceAspire
}
```

In `cmd/root.go`, near the other file-local helpers:

```go
// anyGRPCAddr reports whether the contract declared at least one app with a
// resolvable sidecar gRPC endpoint. Because the address is derived from the
// required _DAPR_HTTP value, this is true whenever any app is declared — the
// zero-app case (a store-only dashboard) is the one that returns false.
func anyGRPCAddr(scan discovery.Scanner) bool {
	results, err := scan()
	if err != nil {
		return false
	}
	for _, r := range results {
		if r.DaprGRPCAddr != "" {
			return true
		}
	}
	return false
}
```

- [ ] **Step 5: Rewrite the container-posture branch**

Replace `cmd/root.go:140-147` with:

```go
	case containerPosture:
		scan, err := discovery.NewContractScanner(os.Getenv, contractSource(mode))
		if err != nil {
			return err
		}
		appNS = contractNamespaces(scan)
		appsSvc = discovery.New(scan, client)
		caps = &server.Capabilities{
			// Sidecar-gRPC inspection needs no store, so a declared app is
			// enough to enable the workflow routes.
			Workflows:        settings.StateStore != "" || anyGRPCAddr(scan),
			Mode:             string(mode),
			ContainerPosture: true,
		}
```

Note `Mode` changes from the hardcoded `string(ModeAspire)` to `string(mode)`. For Aspire that is the same value, so nothing changes there.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test -tags unit ./cmd/ -run "TestContractSource|TestAnyGRPCAddr" -v`
Expected: PASS.

- [ ] **Step 7: Verify no regression**

Run: `gofmt -l . && go test -tags unit -race ./cmd/ ./pkg/server/`
Expected: no gofmt output; PASS. If a `pkg/server` golden or snapshot test asserts the capabilities JSON, update it to include `"containerPosture":false` for host modes.

- [ ] **Step 8: Commit**

```bash
git add cmd/root.go cmd/mode.go cmd/root_capabilities_test.go pkg/server/server.go
git commit -m "feat(cmd): wire compose container posture with store-free workflow capability"
```

---

### Task 5: Sidecar endpoints and eligibility in the reconciler

`sidecarEndpoints` (`cmd/reconciler.go:445`) filters on `in.GRPCPort == 0` and builds a loopback address, so contract-declared apps are invisible to the sidecar workflow source. This task switches to `GRPCAddr()` and makes contract-declared compose apps unconditionally eligible.

**Files:**
- Modify: `cmd/reconciler.go:445-473`
- Test: `cmd/reconciler_sidecar_test.go` (create)

**Interfaces:**
- Consumes: `Instance.GRPCAddr()` (Task 1), `discovery.SourceCompose`.
- Produces: unchanged signature `func (rc *reconciler) sidecarEndpoints(includeAll bool) workflow.EndpointsFunc`.

- [ ] **Step 1: Write the failing test**

Create `cmd/reconciler_sidecar_test.go`. It reuses `staticApps`, the existing `discovery.Service`
double already defined in `cmd/reconciler_test.go:200` (same package, both `//go:build unit`) —
do **not** declare a second double, it will collide.

```go
//go:build unit

package cmd

import (
	"context"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
)

// workflowEndpoint keeps the table below readable.
type workflowEndpoint = workflow.SidecarEndpoint

func TestSidecarEndpointsAddressResolution(t *testing.T) {
	tests := []struct {
		name       string
		instances  []discovery.Instance
		includeAll bool
		want       []workflowEndpoint
	}{
		{
			name: "host posture still uses loopback",
			instances: []discovery.Instance{
				{AppID: "tc-app", Source: discovery.SourceTestcontainers, GRPCPort: 58445},
			},
			want: []workflowEndpoint{{AppID: "tc-app", Addr: "127.0.0.1:58445"}},
		},
		{
			name: "contract compose app uses its in-network address",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: true},
			},
			want: []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001"}},
		},
		{
			name: "contract compose app is eligible even when includeAll is false",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, DaprGRPCAddr: "order-dapr:50001", SidecarReachable: true},
			},
			includeAll: false,
			want:       []workflowEndpoint{{AppID: "order", Addr: "order-dapr:50001"}},
		},
		{
			name: "host compose app without a gRPC port is skipped",
			instances: []discovery.Instance{
				{AppID: "order", Source: discovery.SourceCompose, SidecarReachable: true},
			},
			includeAll: true,
			want:       nil,
		},
		{
			name: "aspire apps stay excluded",
			instances: []discovery.Instance{
				{AppID: "aspire-app", Source: discovery.SourceAspire, GRPCPort: 50001, SidecarReachable: true},
			},
			includeAll: true,
			want:       nil,
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			rc := &reconciler{apps: staticApps{instances: tc.instances}}
			got := rc.sidecarEndpoints(tc.includeAll)(context.Background())
			if len(got) != len(tc.want) {
				t.Fatalf("got %d endpoints %v, want %d", len(got), got, len(tc.want))
			}
			for i := range tc.want {
				if got[i].AppID != tc.want[i].AppID || got[i].Addr != tc.want[i].Addr {
					t.Fatalf("endpoint %d: got %+v want %+v", i, got[i], tc.want[i])
				}
			}
		})
	}
}
```

`staticApps` is a value type (not a pointer) and already implements both methods of
`discovery.Service` (`List` and `Get`, per `pkg/discovery/service.go:101`), so no new double
is needed.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/ -run TestSidecarEndpointsAddressResolution -v`
Expected: FAIL on `contract compose app uses its in-network address` — got 0 endpoints (the `GRPCPort == 0` filter drops it).

- [ ] **Step 3: Rewrite the endpoint resolver**

Replace the body of `sidecarEndpoints` (`cmd/reconciler.go:446-472`):

```go
	return func(ctx context.Context) []workflow.SidecarEndpoint {
		if rc.apps == nil {
			return nil
		}
		apps, err := rc.apps.List(ctx)
		if err != nil {
			return nil
		}
		var eps []workflow.SidecarEndpoint
		seen := map[string]bool{}
		for _, in := range apps {
			addr := in.GRPCAddr()
			if addr == "" || seen[in.AppID] {
				continue
			}
			// Aspire apps are never sidecar-sourced. This is checked first and
			// unconditionally: the contract scanner sets DaprGRPCAddr for aspire
			// posture too, so folding it into the includeAll clause below would
			// silently admit them.
			if in.Source == discovery.SourceAspire {
				continue
			}
			// A contract-declared app carries its own gRPC address and is
			// always sidecar-sourced: there may be no readable store at all,
			// exactly as for Testcontainers apps.
			include := in.Source == discovery.SourceTestcontainers ||
				in.DaprGRPCAddr != "" ||
				(includeAll && in.SidecarReachable)
			if !include {
				continue
			}
			seen[in.AppID] = true
			eps = append(eps, workflow.SidecarEndpoint{AppID: in.AppID, Addr: addr})
		}
		return eps
	}
```

This is the complete final state of the loop body — the aspire check is outermost and the
`includeAll` clause no longer repeats it.

`strconv` may now be unused in `cmd/reconciler.go` — remove it from the imports if `go vet` says so.

Update the doc comment above the function to record the new clause:

```go
// sidecarEndpoints returns the sidecar-sourced app endpoints under the current
// selection rule. Testcontainers apps are always eligible (their store lives
// inside the container and is never host-readable), as are contract-declared
// apps (they carry an explicit in-network gRPC address and may have no
// readable store). When includeAll is true (no openable active store), every
// reachable non-aspire sidecar with a gRPC endpoint becomes eligible. The list
// is computed per query from live discovery so re-published random ports apply
// immediately.
```

The reason the aspire check moved outermost: `DaprGRPCAddr != ""` is now an inclusion trigger,
and the contract scanner sets that field in **aspire** posture too (Task 4 passes
`SourceAspire` there). Leaving the exclusion inside the `includeAll` clause would therefore
give aspire container posture a sidecar workflow source it does not have today — a silent
behavior change. The `aspire apps stay excluded` subtest in Step 1 is the guard.

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./cmd/ -run TestSidecarEndpointsAddressResolution -v`
Expected: PASS, all five subtests — including `aspire apps stay excluded`.

- [ ] **Step 5: Verify no regression in workflow routing**

Run: `gofmt -l . && go test -tags unit -race ./cmd/ ./pkg/workflow/`
Expected: no gofmt output; PASS.

- [ ] **Step 6: Commit**

```bash
git add cmd/reconciler.go cmd/reconciler_sidecar_test.go
git commit -m "feat(cmd): resolve sidecar gRPC endpoints via GRPCAddr and admit contract apps"
```

---

### Task 6: Pin the translation no-op

`rc.translate` (`cmd/reconciler.go:94`) rewrites compose state-store addresses to `localhost:<published>`, which would be actively wrong in container posture — inside the network `postgres:5432` resolves directly. Correctness rests on `composeEnv` being nil, which container posture achieves by never constructing a `ComposeSource`. That is a nil check in a different file from the code that depends on it, so it gets a regression test.

**Files:**
- Test: `cmd/reconciler_translate_test.go` (create)

**Interfaces:**
- Consumes: `reconciler.translate`, `statestore.Component`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

Create `cmd/reconciler_translate_test.go`. `statestore.Component` is defined at
`pkg/statestore/store.go:41` with fields `Name`, `Type`, `Version`, `Metadata`, `SecretRefs`,
`SecretStore`, `Path` — the literal below matches it:

```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

// In compose container posture the dashboard shares the compose network, so
// an in-network store address must reach the pool untouched. Host posture
// rewrites it to localhost:<published>, which would be wrong here. The guard
// is composeEnv == nil, which container posture gets by never constructing a
// ComposeSource — this test pins that behavior against a future refactor.
func TestTranslateIsNoOpWithoutComposeEnv(t *testing.T) {
	rc := &reconciler{composeEnv: nil}
	in := statestore.Component{
		Name: "statestore",
		Path: "/components/statestore.yaml",
		Metadata: map[string]string{
			"redisHost": "redis:6379",
		},
	}

	got := rc.translate(in)

	if got.Metadata["redisHost"] != "redis:6379" {
		t.Fatalf("in-network address was rewritten: got %q want %q",
			got.Metadata["redisHost"], "redis:6379")
	}
}
```

- [ ] **Step 2: Run the test**

Run: `go test -tags unit ./cmd/ -run TestTranslateIsNoOpWithoutComposeEnv -v`
Expected: PASS immediately — this pins existing behavior rather than driving a change. If it FAILS, `translate` has a path that ignores the nil check, which is a real bug to fix before continuing.

- [ ] **Step 3: Commit**

```bash
git add cmd/reconciler_translate_test.go
git commit -m "test(cmd): pin state-store address translation as a no-op in container posture"
```

---

### Task 7: Posture-aware unreachable-sidecar copy in the SPA

Both hints tell the user to publish the daprd HTTP port to the host, keyed on `app.source === 'compose'`. In container posture that advice is wrong — the fix is a shared network, not a published port.

**Files:**
- Modify: `web/src/lib/capabilities.ts`
- Modify: `web/src/pages/AppDetail.tsx:42,233`
- Modify: `web/src/pages/Applications.tsx:165,175`
- Test: `web/src/pages/AppDetail.test.tsx` (append; an existing test at line 218 covers the host case)

**Interfaces:**
- Consumes: `server.Capabilities.ContainerPosture` (Task 4).
- Produces: `Capabilities.containerPosture: boolean` in `web/src/lib/capabilities.ts`.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('AppDetail', ...)` block in `web/src/pages/AppDetail.test.tsx`,
directly after the test named `shows the publish-port hint for unreachable compose apps` (line 218).
The file already has `afterEach(() => { delete window.__DASH_CAPABILITIES__ })` at line 35, so the
stub cannot leak into the host-posture test — do not add another cleanup hook.

```tsx
  it('shows the shared-network hint, not the publish-port hint, in container posture', async () => {
    window.__DASH_CAPABILITIES__ = {
      lifecycle: false,
      controlPlane: false,
      logs: false,
      workflows: true,
      mode: 'compose',
      containerPosture: true,
    }
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'order',
          health: 'unhealthy',
          runtime: 'go',
          httpPort: 3500,
          metadataOk: false,
          source: 'compose',
          sidecarReachable: false,
        }),
      ),
    )
    renderDetail()
    expect(await screen.findByText(/same Docker network/i)).toBeInTheDocument()
    expect(screen.queryByText(/publish the daprd HTTP port/i)).not.toBeInTheDocument()
  })
```

The existing host-posture test at line 218 sets no capabilities stub, so `containerPosture` is
`undefined` there and it must keep asserting the publish-port copy. That pairing is the
regression guard — run both.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL — the publish-port hint renders, `same Docker network` is not found.

- [ ] **Step 3: Add the flag to the SPA capabilities**

In `web/src/lib/capabilities.ts`:

```ts
export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
  /** CLI --mode value ('' = complete scan); lets the UI adapt static fallbacks. */
  mode?: string
  /**
   * True when the dashboard runs as a container inside the orchestrator it
   * inspects. `mode` cannot express this: it is 'compose' both for a host-run
   * compose scan and for a dashboard running as a compose service.
   */
  containerPosture?: boolean
}
```

`FULL` stays as-is — an absent flag means host posture, matching the server default.

- [ ] **Step 4: Update the AppDetail hint**

In `web/src/pages/AppDetail.tsx`, near line 42 where `unreachable` is computed, add the posture read (the file already imports `getCapabilities` for other gating — verify and add the import if not):

```ts
  const containerPosture = getCapabilities().containerPosture === true
```

Replace the hint block at line 233:

```tsx
      {unreachable ? (
        containerPosture ? (
          <div className="hint">
            sidecar unreachable — make sure the dashboard and{' '}
            <span className="mono">{app.appId}</span>&apos;s sidecar are on the same Docker
            network, and that <span className="mono">DEVDASHBOARD_APP_*_DAPR_HTTP</span> uses
            the service name that owns the network namespace
          </div>
        ) : (
          <div className="hint">
            sidecar unreachable — publish the daprd HTTP port (e.g. <span className="mono">3500:3500</span>) in
            your compose file to enable health &amp; metadata
          </div>
        )
      ) : (
        !app.metadataOk && <div className="hint">metadata unavailable — showing process-scan data only</div>
      )}
```

- [ ] **Step 5: Update the Applications list tooltip**

In `web/src/pages/Applications.tsx`, add the posture read alongside the existing `unreachable` computation at line 165 and branch the `title` at line 175:

```ts
  const containerPosture = getCapabilities().containerPosture === true
  const unreachableHint = containerPosture
    ? 'sidecar unreachable — the dashboard and this app must share a Docker network'
    : 'publish the daprd HTTP port (e.g. 3500:3500) to enable health & metadata'
```

```tsx
          title={state.hint ?? (unreachable ? unreachableHint : undefined)}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx src/pages/Applications.test.tsx`
Expected: PASS — the new container-posture test and the existing host-posture test at line 218 both green.

- [ ] **Step 7: Run the full web suite and lint**

Run: `cd web && npm test && npm run lint`
Expected: PASS, no lint errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/lib/capabilities.ts web/src/pages/AppDetail.tsx web/src/pages/Applications.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): posture-aware unreachable-sidecar hint copy"
```

---

### Task 8: Integration test — the four features over a fake sidecar

The spec's acceptance criteria are application data, workflow inspection, component review, and publishing. This task proves the first, third, and fourth end-to-end through the contract scanner against an `httptest` sidecar. Workflow inspection over gRPC is covered by the unit tests in Task 5 plus the existing `pkg/workflow` suite.

**Files:**
- Test: `cmd/compose_container_integration_test.go` (create)

**Interfaces:**
- Consumes: `discovery.NewContractScanner`, `discovery.New`.
- Produces: nothing.

- [ ] **Step 1: Write the test**

`cmd/compose_discovery_integration_test.go` carries `//go:build integration` because it needs a
real container runtime. This test needs none — it drives an in-process `httptest` sidecar — so it
uses the `unit` tag and runs in the normal suite.

```go
//go:build unit

package cmd

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
)

// fakeSidecar serves the daprd endpoints the dashboard probes in compose
// container posture: health, metadata, and publish.
func fakeSidecar(t *testing.T, published *string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1.0/healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1.0/metadata", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"id": "order-processor",
			"runtimeVersion": "1.18.1",
			"actorRuntime": {"placement": "placement: connected"},
			"components": [{"name": "statestore", "type": "state.redis", "version": "v1"}],
			"subscriptions": [{"pubsubname": "pubsub", "topic": "orders", "rules": [], "type": "DECLARATIVE"}]
		}`))
	})
	mux.HandleFunc("/v1.0/publish/", func(w http.ResponseWriter, r *http.Request) {
		*published = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv
}

func TestComposeContainerPostureDiscoversAppOverSidecarHTTP(t *testing.T) {
	var published string
	sidecar := fakeSidecar(t, &published)

	env := map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "order-processor",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": sidecar.URL,
		"DEVDASHBOARD_APP_0_LABEL":     "Order Processor",
	}
	scan, err := discovery.NewContractScanner(func(k string) string { return env[k] }, discovery.SourceCompose)
	if err != nil {
		t.Fatalf("contract scanner: %v", err)
	}

	svc := discovery.New(scan, &http.Client{Timeout: 2 * time.Second})
	apps, err := svc.List(context.Background())
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(apps) != 1 {
		t.Fatalf("got %d apps want 1", len(apps))
	}
	app := apps[0]

	// Application data: the source frames it as compose, not aspire.
	if app.Source != discovery.SourceCompose {
		t.Errorf("source: got %q want %q", app.Source, discovery.SourceCompose)
	}
	if app.IsAspire {
		t.Error("IsAspire must be false for compose-source apps")
	}
	if app.Health != discovery.HealthHealthy {
		t.Errorf("health: got %q want %q", app.Health, discovery.HealthHealthy)
	}
	if !app.MetadataOK {
		t.Error("metadata probe failed")
	}
	if app.RuntimeVersion != "1.18.1" {
		t.Errorf("runtimeVersion: got %q want 1.18.1", app.RuntimeVersion)
	}
	if app.Label != "Order Processor" {
		t.Errorf("label: got %q want %q", app.Label, "Order Processor")
	}

	// Placement connectivity arrives free via sidecar metadata (the spec's
	// stated substitute for the disabled Control Plane page).
	if app.Placement == "" {
		t.Error("placement status must be populated from sidecar metadata")
	}

	// Component review without any mounted file: names and types only.
	if len(app.Components) != 1 || app.Components[0].Type != "state.redis" {
		t.Errorf("components: got %+v want one state.redis", app.Components)
	}
	if len(app.Subscriptions) != 1 || app.Subscriptions[0].Topic != "orders" {
		t.Errorf("subscriptions: got %+v want one orders topic", app.Subscriptions)
	}

	// The gRPC address is derived from the HTTP base URL's host.
	u, _ := url.Parse(sidecar.URL)
	if want := u.Hostname() + ":50001"; app.GRPCAddr() != want {
		t.Errorf("grpc addr: got %q want %q", app.GRPCAddr(), want)
	}

	// Publish reaches the sidecar.
	req, _ := http.NewRequest(http.MethodPost, app.BaseURL()+"/v1.0/publish/pubsub/orders", strings.NewReader(`{"k":"v"}`))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("publish: %v", err)
	}
	_ = resp.Body.Close()
	if published != "/v1.0/publish/pubsub/orders" {
		t.Errorf("publish path: got %q", published)
	}
}
```

- [ ] **Step 2: Run the test**

Run: `go test -tags unit ./cmd/ -run TestComposeContainerPostureDiscoversAppOverSidecarHTTP -v`
Expected: PASS. If enrichment field names differ from the assertions (e.g. `Placement` is nested), read `pkg/discovery/service.go` enrichment and fix the assertions to match the real struct — do not weaken them to make the test pass.

- [ ] **Step 3: Commit**

```bash
git add cmd/compose_container_integration_test.go
git commit -m "test(cmd): integration coverage for compose container posture over sidecar HTTP"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md:117-190` (the "Run as a container (.NET Aspire)" section)
- Modify: `ARCHITECTURE.md:125,139,149,288,359`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Retitle and restructure the README container section**

Rename `## Run as a container (.NET Aspire)` to `## Run as a container` with two subsections, `### Inside a .NET Aspire AppHost` (the existing content, unchanged apart from the heading) and `### As a Docker Compose service` (new). Update the intro paragraph so it no longer says the image is "purpose-built for embedding inside a .NET Aspire AppHost" — it now serves both.

- [ ] **Step 2: Write the compose subsection**

Include, in this order:

1. The reference compose file from the spec's section 7 verbatim, including the YAML anchor.
2. The namespace-owner addressing table (three shapes) from spec section 3.
3. The custom-networks requirement, stated as the first troubleshooting item.
4. The `_DAPR_GRPC` row added to the app-discovery env table, documenting the derivation default.
5. An explicit "what is off and why" list: lifecycle, control plane, logs, update-check, browser-open — with the note that placement connectivity is still visible on App Detail and Actors, and that logs are architecturally unavailable rather than unimplemented.
6. A note that `DEVDASHBOARD_MODE=compose` must be set explicitly because the image bakes in `aspire`.

- [ ] **Step 3: Update the mode/flag tables**

- `README.md:107` — the `--mode compose` bullet gains ", or a service inside your compose project when the `DEVDASHBOARD_APP_*` contract is set".
- `README.md:113` — the "requires a container runtime" sentence must except container posture, which requires no runtime.
- `README.md:123-124` — the `--port`/`--bind` rows say "aspire container posture"; widen to "container posture".

- [ ] **Step 4: Update ARCHITECTURE.md**

- Line 125 (`--mode` row): note that `compose` selects posture by contract presence.
- Line 139: the container-posture definition currently reads "aspire mode *with* the contract"; widen to aspire **or compose**.
- Line 149: `compose` is listed as failing hard without a container runtime — add the container-posture exception.
- Line 288 (capabilities tier 1): record that compose container posture gets `Workflows` from the sidecar-gRPC source without a store, and add `ContainerPosture` to the struct description.
- Line 359 (`sourcesFor`): note that container posture branches before `sourcesFor` is consulted.
- The scanner section describing `scan_aspire.go` must use the new filename and the source parameter.

- [ ] **Step 5: Verify the docs match the code**

Run:

```bash
grep -rn "AspireContractPresent\|NewAspireScanner\|scan_aspire" README.md ARCHITECTURE.md docs/
```

Expected: no matches outside `docs/superpowers/specs/` and `docs/superpowers/plans/` (historical design docs keep their original text).

- [ ] **Step 6: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -m "docs: document the compose container posture"
```

---

### Task 10: Full verification

- [ ] **Step 1: Format and lint**

Run: `make lint-go`
Expected: no gofmt output, `go vet` clean.

- [ ] **Step 2: Full Go suite**

Run: `go test -tags unit -race ./...`
Expected: PASS, except the two known Windows-only failures (`TestDerivePaths_AutoDetect`, `TestRegistry_SaveLoadRoundTrip_WindowsPath`).

- [ ] **Step 3: Web suite and lint**

Run: `cd web && npm test && npm run lint`
Expected: PASS.

- [ ] **Step 4: Confirm the host-posture regression bar**

Run: `go test -tags unit ./cmd/ -run "TestResolveMode|TestSourcesFor|TestResolveServeSettings" -v`
Expected: PASS with no test modified in this plan — proof that host modes are untouched.

- [ ] **Step 5: Manual smoke test against the real fixture**

The repo ships a working compose Dapr app at `test/e2e/fixtures/compose/docker-compose.yaml` (daprd owns the network namespace via `network_mode: "service:daprd"`, app id `wfapp`, HTTP 3500, gRPC 50001).

1. Build the image: `docker build -t devdash:local .`
2. Add a dashboard service to a **copy** of that fixture (do not modify the fixture itself):

```yaml
  dev-dashboard:
    image: devdash:local
    ports:
      - "9090:8080"
    environment:
      DEVDASHBOARD_MODE: compose
      DEVDASHBOARD_APP_COUNT: "1"
      DEVDASHBOARD_APP_0_ID: wfapp
      DEVDASHBOARD_APP_0_DAPR_HTTP: http://daprd:3500
      DEVDASHBOARD_RESOURCES_PATH: /components
    volumes:
      - "./components:/components:ro"
```

3. `docker compose up -d`, open `http://localhost:9090`.
4. Confirm: the app is listed as source `compose` and healthy; App Detail shows placement connected; Resources lists the mounted components; the Workflows page loads and lists instances via the sidecar with **no** state store configured; the Logs and Control Plane nav entries are absent.
5. Confirm `curl -s localhost:9090/api/controlplane` returns 404 (route absent, not merely flagged off).
6. `docker compose down`.

- [ ] **Step 6: Report**

Summarize: which steps passed, any deviations from the plan and why, and anything left undone. Do not claim completion without the command output for steps 1-4.

---

## Self-Review

**Spec coverage:** section 1 posture → Task 3; section 2 contract → Task 2; section 3 network shape → Tasks 2 (derivation across all three shapes) + 9 (docs); section 4 workflows → Tasks 1, 4, 5; section 5 files and translation → Task 6; section 6 capabilities and copy → Tasks 4, 7; section 7 reference file → Tasks 9, 10; section 8 errors → Task 2 (malformed contract), Task 7 (unreachable copy); testing → every task plus Task 10; documentation → Task 9.

**Deliberately not implemented** (spec "Future work"): compose-file parsing, the health-only Control Plane, and per-app scheduler connectivity. No task should add them.

**Known open item for the implementer:** Task 5 Step 3 changes how the Aspire exclusion is expressed. The plan resolves it by making the aspire check outermost, which preserves today's behavior (aspire container posture has no sidecar workflow source). If a reviewer wants aspire container posture to gain sidecar workflows, that is a separate change with its own spec.
