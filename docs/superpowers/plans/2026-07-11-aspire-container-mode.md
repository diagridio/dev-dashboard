# Aspire Container Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `aspire` mode to the dashboard (env-contract app discovery, container serving posture), plus a published GHCR container image, per the approved spec `docs/superpowers/specs/2026-07-11-aspire-container-mode-design.md`.

**Architecture:** A single-value mode (`--mode` flag / `DEVDASHBOARD_MODE` env; unset = today's full scan) gates behavior at existing seams: a new static `AspireScanner` reads `DEVDASHBOARD_APP_*` vars; a `DaprHTTPBaseURL` field threads through health/metadata/workflow-removal in place of hardcoded `127.0.0.1:<port>`; the server gains a same-origin guard variant and a `Capabilities` struct that gates route registration and is injected into the SPA. A multi-stage Dockerfile + goreleaser `dockers` block publish `ghcr.io/diagridio/dev-dashboard`.

**Tech Stack:** Go 1.26 (cobra, chi), React 19 + Vite + vitest, goreleaser, distroless.

## Global Constraints

- Env var prefix is `DEVDASHBOARD_` exactly (matches existing `DEVDASHBOARD_TELEMETRY_OPTOUT`).
- Precedence everywhere: **flag > env > mode default**.
- Aspire-mode defaults: port `8080`, bind `0.0.0.0`. Mode-unset defaults: port `9090`, bind `127.0.0.1`.
- Image name: `ghcr.io/diagridio/dev-dashboard`. Final base: `gcr.io/distroless/static:nonroot`. `ENV DEVDASHBOARD_MODE=aspire` baked in.
- Go tests run with `-tags unit` (`make test-go`); match the `//go:build` header of sibling `*_test.go` files in the same package when creating new test files.
- **vitest does not typecheck.** After ANY `.ts`/`.tsx` change (test files included) run `cd web && npm run build` (tsc -b) before claiming success.
- `gofmt -l .` must be clean and `go vet -tags unit ./...` must pass before every commit (`make lint-go`).
- Commit messages follow repo convention: `feat(scope): ...`, `fix(scope): ...`, `docs: ...`, `test(scope): ...`.
- Working directory: `/Users/marcduiker/dev/diagrid/dev-dashboard/.claude/worktrees/aspire-container-mode` (branch `worktree-aspire-container-mode`).
- Unknown `--mode`/`DEVDASHBOARD_MODE` values, and malformed `DEVDASHBOARD_APP_*` contracts (in aspire mode, or present-but-malformed in unset mode), exit non-zero at startup naming the exact variable.

---

### Task 1: Mode type and resolution

**Files:**
- Create: `cmd/mode.go`
- Test: `cmd/mode_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Mode string`, `const ModeDefault Mode = ""`, `const ModeAspire Mode = "aspire"`, `func resolveMode(flagValue string, getenv func(string) string) (Mode, error)`. Task 8 calls `resolveMode` in the cobra RunE.

- [ ] **Step 1: Write the failing test**

Check the build-tag header of `cmd/root_test.go` and copy it (e.g. `//go:build unit`) to the top of the new test file if present.

```go
package cmd

import "testing"

func TestResolveMode(t *testing.T) {
	env := func(vals map[string]string) func(string) string {
		return func(k string) string { return vals[k] }
	}
	tests := []struct {
		name    string
		flag    string
		env     map[string]string
		want    Mode
		wantErr bool
	}{
		{name: "unset everywhere is default", flag: "", env: nil, want: ModeDefault},
		{name: "flag aspire", flag: "aspire", env: nil, want: ModeAspire},
		{name: "env aspire", flag: "", env: map[string]string{"DEVDASHBOARD_MODE": "aspire"}, want: ModeAspire},
		{name: "flag wins over env", flag: "aspire", env: map[string]string{"DEVDASHBOARD_MODE": "bogus"}, want: ModeAspire},
		{name: "unknown flag value errors", flag: "compose", wantErr: true},
		{name: "unknown env value errors", env: map[string]string{"DEVDASHBOARD_MODE": "dapr"}, wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got, err := resolveMode(tc.flag, env(tc.env))
			if tc.wantErr {
				if err == nil {
					t.Fatalf("want error, got %q", got)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if got != tc.want {
				t.Fatalf("got %q want %q", got, tc.want)
			}
		})
	}
}
```

Note: `compose` and `dapr` are *reserved future* values per the spec — they must error today.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd/ -run TestResolveMode -v`
Expected: FAIL — `undefined: resolveMode` (compile error).

- [ ] **Step 3: Write minimal implementation**

```go
// cmd/mode.go
package cmd

import "fmt"

// Mode selects the dashboard's discovery and serving posture. ModeDefault
// (the zero value, mode unset) is the complete scan across all discovery
// sources with today's host behavior; ModeAspire restricts discovery to the
// DEVDASHBOARD_APP_* env contract and switches to container posture.
// "dapr" and "compose" are reserved for future single-source filter modes.
type Mode string

const (
	ModeDefault Mode = ""
	ModeAspire  Mode = "aspire"
)

// resolveMode picks the mode from the --mode flag value and the
// DEVDASHBOARD_MODE env var (flag wins; both empty means ModeDefault).
func resolveMode(flagValue string, getenv func(string) string) (Mode, error) {
	v := flagValue
	if v == "" {
		v = getenv("DEVDASHBOARD_MODE")
	}
	switch Mode(v) {
	case ModeDefault, ModeAspire:
		return Mode(v), nil
	}
	return ModeDefault, fmt.Errorf("unknown mode %q: supported values are \"aspire\", or unset for the complete scan", v)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./cmd/ -run TestResolveMode -v`
Expected: PASS (all subtests).

- [ ] **Step 5: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./...
git add cmd/mode.go cmd/mode_test.go
git commit -m "feat(cmd): mode type and DEVDASHBOARD_MODE resolution"
```

---

### Task 2: AspireScanner and new ScanResult fields

**Files:**
- Create: `pkg/discovery/scan_aspire.go`
- Modify: `pkg/discovery/service.go` (ScanResult struct, ~line 25-59; Source consts ~line 16-19)
- Test: `pkg/discovery/scan_aspire_test.go`

**Interfaces:**
- Consumes: `discovery.Scanner`, `discovery.ScanResult` (existing).
- Produces: `const SourceAspire = "aspire"`; `func AspireContractPresent(getenv func(string) string) bool`; `func NewAspireScanner(getenv func(string) string) (Scanner, error)`; new `ScanResult` fields `DaprHTTPBaseURL string`, `Namespace string`, `Label string`. Tasks 3 and 8 consume all of these.

- [ ] **Step 1: Add the ScanResult fields**

In `pkg/discovery/service.go`, add `SourceAspire` to the consts block:

```go
const (
	SourceStandalone = "standalone"
	SourceCompose    = "compose"
	// SourceAspire marks apps injected via the DEVDASHBOARD_APP_* env
	// contract (aspire mode, or mode-unset with the contract present).
	SourceAspire = "aspire"
)
```

And add to the `ScanResult` struct, after the `SidecarReachable` field:

```go
	// DaprHTTPBaseURL, when set (aspire source), replaces
	// http://127.0.0.1:<HTTPPort> as the daprd HTTP endpoint for health,
	// metadata, and workflow calls.
	DaprHTTPBaseURL string
	// Namespace and Label come from the Aspire env contract ("" for other
	// sources). Label is the orchestrator's display name for the app.
	Namespace string
	Label     string
```

- [ ] **Step 2: Write the failing test**

Match the build-tag header of `pkg/discovery/health_test.go`. Create `pkg/discovery/scan_aspire_test.go`:

```go
package discovery

import (
	"strings"
	"testing"
)

func envFunc(vals map[string]string) func(string) string {
	return func(k string) string { return vals[k] }
}

func TestAspireContractPresent(t *testing.T) {
	if AspireContractPresent(envFunc(nil)) {
		t.Fatal("empty env: want false")
	}
	if !AspireContractPresent(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"})) {
		t.Fatal("count set: want true")
	}
}

func TestNewAspireScannerHappyPath(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{
		"DEVDASHBOARD_APP_COUNT":       "2",
		"DEVDASHBOARD_APP_0_ID":        "orders",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://orders-dapr:3500/",
		"DEVDASHBOARD_APP_1_ID":        "payments",
		"DEVDASHBOARD_APP_1_DAPR_HTTP": "http://payments-dapr:3501",
		"DEVDASHBOARD_APP_1_NAMESPACE": "prod",
		"DEVDASHBOARD_APP_1_LABEL":     "Payments API",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := scan()
	if err != nil {
		t.Fatalf("scan: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d results, want 2", len(got))
	}
	r0, r1 := got[0], got[1]
	if r0.AppID != "orders" || r0.DaprHTTPBaseURL != "http://orders-dapr:3500" {
		t.Fatalf("r0: %+v (trailing slash must be trimmed)", r0)
	}
	if r0.Namespace != "default" || r0.Label != "orders" {
		t.Fatalf("r0 defaults: ns=%q label=%q", r0.Namespace, r0.Label)
	}
	if r0.Source != SourceAspire || !r0.SidecarReachable {
		t.Fatalf("r0 source/reachable: %+v", r0)
	}
	if r1.Namespace != "prod" || r1.Label != "Payments API" {
		t.Fatalf("r1 overrides: ns=%q label=%q", r1.Namespace, r1.Label)
	}
}

func TestNewAspireScannerNamespaceDefault(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{
		"DEVDASHBOARD_NAMESPACE":       "team-a",
		"DEVDASHBOARD_APP_COUNT":       "1",
		"DEVDASHBOARD_APP_0_ID":        "a",
		"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
	}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, _ := scan()
	if got[0].Namespace != "team-a" {
		t.Fatalf("namespace: got %q want team-a", got[0].Namespace)
	}
}

func TestNewAspireScannerCountZero(t *testing.T) {
	scan, err := NewAspireScanner(envFunc(map[string]string{"DEVDASHBOARD_APP_COUNT": "0"}))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	got, err := scan()
	if err != nil || len(got) != 0 {
		t.Fatalf("want empty scan, got %v / %v", got, err)
	}
}

func TestNewAspireScannerErrorsNameTheVariable(t *testing.T) {
	tests := []struct {
		name    string
		env     map[string]string
		wantVar string
	}{
		{"missing count", map[string]string{}, "DEVDASHBOARD_APP_COUNT"},
		{"non-numeric count", map[string]string{"DEVDASHBOARD_APP_COUNT": "two"}, "DEVDASHBOARD_APP_COUNT"},
		{"negative count", map[string]string{"DEVDASHBOARD_APP_COUNT": "-1"}, "DEVDASHBOARD_APP_COUNT"},
		{"missing id", map[string]string{
			"DEVDASHBOARD_APP_COUNT":       "1",
			"DEVDASHBOARD_APP_0_DAPR_HTTP": "http://a:3500",
		}, "DEVDASHBOARD_APP_0_ID"},
		{"missing url", map[string]string{
			"DEVDASHBOARD_APP_COUNT": "1",
			"DEVDASHBOARD_APP_0_ID":  "a",
		}, "DEVDASHBOARD_APP_0_DAPR_HTTP"},
		{"bad url scheme", map[string]string{
			"DEVDASHBOARD_APP_COUNT":       "1",
			"DEVDASHBOARD_APP_0_ID":        "a",
			"DEVDASHBOARD_APP_0_DAPR_HTTP": "ftp://a:3500",
		}, "DEVDASHBOARD_APP_0_DAPR_HTTP"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			_, err := NewAspireScanner(envFunc(tc.env))
			if err == nil {
				t.Fatal("want error")
			}
			if !strings.Contains(err.Error(), tc.wantVar) {
				t.Fatalf("error %q does not name %s", err, tc.wantVar)
			}
		})
	}
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run "TestAspire|TestNewAspire" -v`
Expected: FAIL — `undefined: AspireContractPresent`, `undefined: NewAspireScanner`.

- [ ] **Step 4: Write the implementation**

```go
// pkg/discovery/scan_aspire.go
package discovery

import (
	"fmt"
	"net/url"
	"strconv"
	"strings"
)

// AspireContractPresent reports whether the DEVDASHBOARD_APP_* env contract
// is set at all (anchor variable: DEVDASHBOARD_APP_COUNT). Used with mode
// unset to decide whether the aspire source joins the merge.
func AspireContractPresent(getenv func(string) string) bool {
	return strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT")) != ""
}

// NewAspireScanner parses the DEVDASHBOARD_APP_* env contract eagerly and
// returns a static Scanner over the parsed apps. Malformed contracts fail
// here — at startup — with an error naming the exact variable, never at scan
// time. The returned scanner is static: env is read once; liveness comes
// from the discovery service's per-poll health/metadata probes.
func NewAspireScanner(getenv func(string) string) (Scanner, error) {
	countRaw := strings.TrimSpace(getenv("DEVDASHBOARD_APP_COUNT"))
	count, err := strconv.Atoi(countRaw)
	if err != nil || count < 0 {
		return nil, fmt.Errorf("DEVDASHBOARD_APP_COUNT: expected a non-negative integer, got %q", countRaw)
	}
	defaultNS := strings.TrimSpace(getenv("DEVDASHBOARD_NAMESPACE"))
	if defaultNS == "" {
		defaultNS = "default"
	}
	results := make([]ScanResult, 0, count)
	for i := 0; i < count; i++ {
		idKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_ID", i)
		urlKey := fmt.Sprintf("DEVDASHBOARD_APP_%d_DAPR_HTTP", i)
		id := strings.TrimSpace(getenv(idKey))
		if id == "" {
			return nil, fmt.Errorf("%s: required but empty", idKey)
		}
		raw := strings.TrimSpace(getenv(urlKey))
		u, err := url.Parse(raw)
		if raw == "" || err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
			return nil, fmt.Errorf("%s: expected an http(s) base URL, got %q", urlKey, raw)
		}
		ns := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_NAMESPACE", i)))
		if ns == "" {
			ns = defaultNS
		}
		label := strings.TrimSpace(getenv(fmt.Sprintf("DEVDASHBOARD_APP_%d_LABEL", i)))
		if label == "" {
			label = id
		}
		results = append(results, ScanResult{
			AppID:            id,
			DaprHTTPBaseURL:  strings.TrimRight(raw, "/"),
			Namespace:        ns,
			Label:            label,
			Source:           SourceAspire,
			SidecarReachable: true,
		})
	}
	return func() ([]ScanResult, error) {
		out := make([]ScanResult, len(results))
		copy(out, results)
		return out, nil
	}, nil
}
```

- [ ] **Step 5: Run tests, lint, commit**

Run: `go test -tags unit ./pkg/discovery/ -v -run "Aspire"` → PASS. Then the full package: `go test -tags unit ./pkg/discovery/` → PASS (no regressions from the struct change).

```bash
gofmt -l . && go vet -tags unit ./...
git add pkg/discovery/scan_aspire.go pkg/discovery/scan_aspire_test.go pkg/discovery/service.go
git commit -m "feat(discovery): AspireScanner reads DEVDASHBOARD_APP_* env contract"
```

---

### Task 3: Base-URL threading through health, metadata, and enrich

**Files:**
- Modify: `pkg/discovery/health.go` (whole file), `pkg/discovery/metadata.go:88-91`, `pkg/discovery/service.go` (Instance passthrough + enrich, ~lines 170-294), `pkg/discovery/types.go` (Instance struct)
- Test: `pkg/discovery/health_test.go`, `pkg/discovery/metadata_test.go` (update signatures), `pkg/discovery/service_test.go` (add aspire enrich case)

**Interfaces:**
- Consumes: `ScanResult.DaprHTTPBaseURL` (Task 2).
- Produces: `func CheckHealth(ctx context.Context, client *http.Client, baseURL string) Health`; `func FetchMetadata(ctx context.Context, client *http.Client, baseURL string) (Metadata, error)`; `func sidecarBaseURL(base string, httpPort int) string`; new `Instance` fields `DaprHTTPBaseURL string` (json `daprHttpBaseUrl,omitempty`), `Namespace string` (json `namespace,omitempty`), `Label string` (json `label,omitempty`). Task 4 reads `Instance.DaprHTTPBaseURL`.

- [ ] **Step 1: Write the failing tests**

In `pkg/discovery/health_test.go` and `metadata_test.go`, the existing tests construct `httptest.Server`s and pass the port. Update them to pass `srv.URL` directly (the new signature), and add one URL-shape assertion:

```go
func TestSidecarBaseURL(t *testing.T) {
	if got := sidecarBaseURL("", 3500); got != "http://127.0.0.1:3500" {
		t.Fatalf("port fallback: %q", got)
	}
	if got := sidecarBaseURL("http://orders-dapr:3500", 0); got != "http://orders-dapr:3500" {
		t.Fatalf("base passthrough: %q", got)
	}
	if got := sidecarBaseURL("http://orders-dapr:3500/", 0); got != "http://orders-dapr:3500" {
		t.Fatalf("trailing slash: %q", got)
	}
}
```

In `service_test.go`, add a case: an aspire-source `ScanResult` with `DaprHTTPBaseURL` pointing at a stub daprd (`httptest.Server` responding 200 to `/v1.0/healthz` and valid JSON to `/v1.0/metadata`) enriches to `Health == HealthHealthy`, `MetadataOK == true`, `IsAspire == true`, and passes through `DaprHTTPBaseURL`/`Namespace`/`Label`. Follow the existing fixture style in that file (bare `service{scan: ..., client: srv.Client()}` structs).

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/discovery/`
Expected: FAIL — compile errors on `CheckHealth`/`FetchMetadata` argument types and `undefined: sidecarBaseURL`.

- [ ] **Step 3: Implement**

`pkg/discovery/health.go`:

```go
package discovery

import (
	"context"
	"fmt"
	"net/http"
	"strings"
)

// sidecarBaseURL resolves the daprd HTTP endpoint: an explicit base URL
// (aspire contract) wins; otherwise the historical loopback-port form.
func sidecarBaseURL(base string, httpPort int) string {
	if base != "" {
		return strings.TrimRight(base, "/")
	}
	return fmt.Sprintf("http://127.0.0.1:%d", httpPort)
}

// CheckHealth probes a sidecar's /v1.0/healthz endpoint at baseURL.
func CheckHealth(ctx context.Context, client *http.Client, baseURL string) Health {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1.0/healthz", nil)
	if err != nil {
		return HealthUnknown
	}
	resp, err := client.Do(req)
	if err != nil {
		return HealthUnhealthy
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode == http.StatusOK || resp.StatusCode == http.StatusNoContent {
		return HealthHealthy
	}
	return HealthUnhealthy
}
```

`pkg/discovery/metadata.go` — `FetchMetadata` head becomes:

```go
// FetchMetadata queries a sidecar's /v1.0/metadata endpoint at baseURL.
func FetchMetadata(ctx context.Context, client *http.Client, baseURL string) (Metadata, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, baseURL+"/v1.0/metadata", nil)
```

(rest of the function unchanged).

`pkg/discovery/types.go` — add to `Instance` after `SidecarReachable`:

```go
	// DaprHTTPBaseURL is the daprd HTTP endpoint for aspire-source apps
	// ("" otherwise; consumers fall back to 127.0.0.1:httpPort).
	DaprHTTPBaseURL string `json:"daprHttpBaseUrl,omitempty"`
	Namespace       string `json:"namespace,omitempty"`
	Label           string `json:"label,omitempty"`
```

`pkg/discovery/service.go` `enrich` — three changes:

1. In the `Instance` literal (~line 171), add: `DaprHTTPBaseURL: r.DaprHTTPBaseURL, Namespace: r.Namespace, Label: r.Label,`
2. After the `if in.Source == "" {...}` block (~line 197), add:

```go
	if in.Source == SourceAspire {
		in.IsAspire = true
	}
```

3. Replace the two probe call sites (~lines 222-223):

```go
	base := sidecarBaseURL(r.DaprHTTPBaseURL, r.HTTPPort)
	in.Health = CheckHealth(ctx, s.client, base)
	md, err := FetchMetadata(ctx, s.client, base)
```

4. Directly after the `if in.Source == SourceCompose { ... return in }` early-return block (~line 267), add a matching aspire early-return so host-process probing (PIDs, lsof, orphan detection) never runs for env-contract apps:

```go
	if in.Source == SourceAspire {
		// Env-contract apps are containers/executables managed by Aspire:
		// host PIDs, stdout files, and orphan semantics don't apply.
		if md.RunTemplate != "" {
			in.RunTemplate = md.RunTemplate
		}
		return in
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/discovery/` → PASS. Then `go build ./...` — expect a compile failure in `pkg/server` or `cmd` **only if** something else calls `CheckHealth`/`FetchMetadata`; run `grep -rn "CheckHealth(\|FetchMetadata(" --include="*.go" cmd pkg | grep -v _test | grep -v "pkg/discovery/"` — expected: no hits outside `pkg/discovery` (verified at plan time). If a hit appears, update that call site to pass `sidecarBaseURL(inst.DaprHTTPBaseURL, inst.HTTPPort)`.

- [ ] **Step 5: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./... && go test -tags unit ./...
git add pkg/discovery/
git commit -m "feat(discovery): thread daprd base URL through health/metadata enrichment"
```

---

### Task 4: Workflow remover base URL

**Files:**
- Modify: `pkg/workflow/remove.go` (RemoveTarget struct ~line 16, Remove ~line 44, terminate/purge/post ~lines 84-107), `cmd/workflow.go:162-185` (targetResolver.Resolve)
- Test: `pkg/workflow/remove_test.go` (or the file containing existing Remover tests — check `ls pkg/workflow/*_test.go`), `cmd/workflow_test.go`

**Interfaces:**
- Consumes: `Instance.DaprHTTPBaseURL` (Task 3).
- Produces: `RemoveTarget.DaprHTTPBaseURL string`. No signature changes to `Remover.Remove`/`RemoveMany`.

- [ ] **Step 1: Write the failing test**

Add to the workflow remover tests (match existing test style — they use `httptest.Server` for the daprd endpoints):

```go
func TestRemoverUsesBaseURL(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()

	r := NewRemover(srv.Client(), nil, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID:           "orders",
		InstanceID:      "wf-1",
		Status:          StatusCompleted, // terminal → MechPurge (single POST)
		DaprHTTPBaseURL: srv.URL,
		Healthy:         true,
	}, false)
	if !res.OK {
		t.Fatalf("remove failed: %+v", res)
	}
	if want := "/v1.0-beta1/workflows/dapr/wf-1/purge"; gotPath != want {
		t.Fatalf("path %q want %q", gotPath, want)
	}
}

func TestRemoverBaseURLCountsAsReachable(t *testing.T) {
	// HTTPPort 0 but a base URL present must still select the HTTP mechanism,
	// not force-delete.
	if got := SelectMechanism(StatusCompleted, true, false); got != MechPurge {
		t.Fatalf("sanity: %v", got)
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusAccepted)
	}))
	defer srv.Close()
	r := NewRemover(srv.Client(), nil, "default")
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "a", InstanceID: "i", Status: StatusCompleted,
		HTTPPort: 0, DaprHTTPBaseURL: srv.URL, Healthy: true,
	}, false)
	if !res.OK || res.Mechanism != MechPurge {
		t.Fatalf("want OK purge, got %+v", res)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/workflow/ -run TestRemover -v`
Expected: FAIL — `unknown field DaprHTTPBaseURL`.

- [ ] **Step 3: Implement**

`pkg/workflow/remove.go`:

```go
type RemoveTarget struct {
	AppID      string
	InstanceID string
	Status     Status
	HTTPPort   int
	// DaprHTTPBaseURL, when set (aspire-discovered apps), replaces
	// http://127.0.0.1:<HTTPPort> for the terminate/purge calls.
	DaprHTTPBaseURL string
	Healthy         bool
}
```

In `Remove`, replace the mechanism selection line:

```go
	reachable := t.Healthy && (t.HTTPPort > 0 || t.DaprHTTPBaseURL != "")
	mech := SelectMechanism(t.Status, reachable, force)
```

Replace `terminate`, `purge`, and `post`:

```go
func (r *Remover) terminate(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t, "terminate")
}

func (r *Remover) purge(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t, "purge")
}

func (r *Remover) post(ctx context.Context, t RemoveTarget, action string) error {
	base := t.DaprHTTPBaseURL
	if base == "" {
		base = fmt.Sprintf("http://127.0.0.1:%d", t.HTTPPort)
	}
	u := fmt.Sprintf("%s/v1.0-beta1/workflows/%s/%s/%s", base, WorkflowComponent, t.InstanceID, action)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u, nil)
	...
```

(the request/response handling below the URL line is unchanged).

`cmd/workflow.go` `targetResolver.Resolve` — capture and pass the base URL:

```go
	var httpPort int
	var daprBase string
	var healthy bool

	inst, err := r.apps.Get(ctx, appID)
	if err == nil {
		httpPort = inst.HTTPPort
		daprBase = inst.DaprHTTPBaseURL
		healthy = inst.Health == discovery.HealthHealthy
	}
	...
	return workflow.RemoveTarget{
		AppID:           appID,
		InstanceID:      instanceID,
		Status:          ex.Status,
		HTTPPort:        httpPort,
		DaprHTTPBaseURL: daprBase,
		Healthy:         healthy,
	}, nil
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/workflow/ ./cmd/` → PASS.

- [ ] **Step 5: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./...
git add pkg/workflow/ cmd/workflow.go
git commit -m "feat(workflow): terminate/purge via daprd base URL for aspire apps"
```

---

### Task 5: Same-origin request guard

**Files:**
- Modify: `pkg/server/middleware.go` (whole file), `pkg/server/server.go` (Options + NewRouter, lines 23-51)
- Test: `pkg/server/middleware_test.go`

**Interfaces:**
- Consumes: nothing new.
- Produces: `func requestGuard(allowAnyHost bool) func(http.Handler) http.Handler` (replaces `localhostGuard`); `Options.AllowNonLoopback bool`. Task 8 sets `AllowNonLoopback` in aspire mode.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/server/middleware_test.go` (keep all existing localhostGuard cases — they now exercise `requestGuard(false)`; rename references):

```go
func TestRequestGuardAllowAnyHost(t *testing.T) {
	ok := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	h := requestGuard(true)(ok)

	tests := []struct {
		name   string
		method string
		host   string
		origin string
		want   int
	}{
		{"non-loopback host allowed", http.MethodGet, "dashboard.example:8080", "", http.StatusOK},
		{"proxy host allowed", http.MethodGet, "diagrid-dashboard.localhost", "", http.StatusOK},
		{"mutating same-origin allowed", http.MethodPost, "dash.local:8080", "http://dash.local:8080", http.StatusOK},
		{"mutating no-origin allowed", http.MethodPost, "dash.local:8080", "", http.StatusOK},
		{"mutating cross-origin forbidden", http.MethodPost, "dash.local:8080", "http://evil.example", http.StatusForbidden},
		{"mutating origin port mismatch forbidden", http.MethodPost, "dash.local:8080", "http://dash.local:9999", http.StatusForbidden},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/health", nil)
			req.Host = tc.host
			if tc.origin != "" {
				req.Header.Set("Origin", tc.origin)
			}
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("got %d want %d", rec.Code, tc.want)
			}
		})
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/server/ -run TestRequestGuard -v`
Expected: FAIL — `undefined: requestGuard`.

- [ ] **Step 3: Implement**

Replace `localhostGuard` in `pkg/server/middleware.go`:

```go
// requestGuard hardens the server against browser-borne attacks. Two modes:
//
// allowAnyHost=false (loopback bind, the host-mode default):
//   - DNS rebinding: every request must carry a loopback Host header.
//   - CSRF: mutating requests with an Origin header must originate from a
//     loopback origin on any port (the Vite dev server has its own port).
//
// allowAnyHost=true (aspire/container mode, reached through a proxy on an
// arbitrary host): the Host allowlist is meaningless, so it is skipped, and
// CSRF tightens to same-origin — a present Origin must match the request
// Host exactly. Requests without an Origin (curl, CLI tools) pass in both
// modes.
func requestGuard(allowAnyHost bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if !allowAnyHost && !isLoopbackHostname(stripPort(r.Host)) {
				writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: non-local Host header"})
				return
			}
			switch r.Method {
			case http.MethodPost, http.MethodPut, http.MethodDelete, http.MethodPatch:
				origin := r.Header.Get("Origin")
				if origin != "" {
					crossOrigin := !isLoopbackOrigin(origin)
					if allowAnyHost {
						crossOrigin = !sameOrigin(origin, r.Host)
					}
					if crossOrigin {
						writeJSON(w, http.StatusForbidden, map[string]string{"error": "forbidden: cross-origin request"})
						return
					}
				}
			}
			next.ServeHTTP(w, r)
		})
	}
}

// sameOrigin reports whether an Origin header's host:port equals the
// request's Host header.
func sameOrigin(origin, host string) bool {
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	return u.Host == host
}
```

Keep `stripPort`, `isLoopbackHostname`, `isLoopbackOrigin` unchanged. In `pkg/server/server.go` add to `Options`:

```go
	// AllowNonLoopback switches the request guard from the loopback
	// allowlist to same-origin CSRF (aspire/container mode, where the
	// dashboard is reached through a proxy on an arbitrary host).
	AllowNonLoopback bool
```

and change the middleware registration in `NewRouter`:

```go
	r.Use(requestGuard(opts.AllowNonLoopback))
```

Update any existing test/code references to `localhostGuard` → `requestGuard(false)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/server/` → PASS (existing guard tests included).

- [ ] **Step 5: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./...
git add pkg/server/middleware.go pkg/server/middleware_test.go pkg/server/server.go
git commit -m "feat(server): same-origin request guard for non-loopback serving"
```

---

### Task 6: Capabilities — SPA injection and route gating

**Files:**
- Modify: `pkg/server/server.go` (Options + NewRouter), `pkg/server/api.go` (apiRouter signature + mounts), `pkg/server/apps.go:15-45` (appsRouter registration), `pkg/server/spa.go` (SPAHandler/serveIndex)
- Test: `pkg/server/spa_test.go`, `pkg/server/api_test.go` (or `server_test.go` — put route-presence tests wherever router-level tests already live)

**Interfaces:**
- Consumes: `Options.AllowNonLoopback` (Task 5).
- Produces: `type Capabilities struct { Lifecycle, ControlPlane, Logs, Workflows bool }` (json tags `lifecycle`, `controlPlane`, `logs`, `workflows`); `func FullCapabilities() Capabilities`; `Options.Capabilities *Capabilities` (nil ⇒ full). Task 7 reads the injected `window.__DASH_CAPABILITIES__`; Task 8 sets `Options.Capabilities`.

- [ ] **Step 1: Write the failing tests**

SPA injection test (in `spa_test.go`, follow the existing telemetry-injection test):

```go
func TestServeIndexInjectsCapabilities(t *testing.T) {
	fsys := fstest.MapFS{"index.html": {Data: []byte("<html><head></head><body></body></html>")}}
	h := SPAHandler(fsys, "", false, Capabilities{Workflows: true})
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/", nil)
	h.ServeHTTP(rec, req)
	body := rec.Body.String()
	want := `window.__DASH_CAPABILITIES__={"lifecycle":false,"controlPlane":false,"logs":false,"workflows":true}`
	if !strings.Contains(body, want) {
		t.Fatalf("body missing %q:\n%s", want, body)
	}
}
```

Route-presence test (router-level; build `Options` the way existing `NewRouter` tests do, with stub services):

```go
func TestRouterCapabilityGating(t *testing.T) {
	// buildTestOptions is whatever helper the existing router tests use to
	// construct a servable Options with stub Apps/Backend/etc. Reuse it.
	limited := Capabilities{Workflows: true} // aspire-with-store shape
	opts := buildTestOptions()
	opts.Capabilities = &limited
	srv := httptest.NewServer(NewRouter(opts))
	defer srv.Close()

	get := func(path string) int {
		resp, err := http.Get(srv.URL + path)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	if got := get("/api/controlplane/"); got != http.StatusNotFound {
		t.Fatalf("controlplane: got %d want 404", got)
	}
	if got := get("/api/apps/some-app/logs"); got != http.StatusNotFound {
		t.Fatalf("logs: got %d want 404", got)
	}
	resp, err := http.Post(srv.URL+"/api/apps/some-app/app/stop", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound && resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("lifecycle: got %d want 404/405", resp.StatusCode)
	}
	if got := get("/api/workflows/"); got == http.StatusNotFound {
		t.Fatal("workflows should be mounted")
	}
	// nil Capabilities keeps everything mounted (host default).
	opts2 := buildTestOptions()
	srv2 := httptest.NewServer(NewRouter(opts2))
	defer srv2.Close()
	resp2, _ := http.Get(srv2.URL + "/api/controlplane/")
	if resp2.StatusCode == http.StatusNotFound {
		t.Fatal("nil capabilities must keep controlplane mounted")
	}
	resp2.Body.Close()
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/server/ -run "TestServeIndexInjects|TestRouterCapability" -v`
Expected: FAIL — `undefined: Capabilities`, SPAHandler signature mismatch.

- [ ] **Step 3: Implement**

In `pkg/server/server.go`:

```go
// Capabilities gates optional feature surfaces per serving mode. The JSON
// form is injected into the SPA as window.__DASH_CAPABILITIES__; the same
// flags gate server-side route registration (the flags are advisory UX for
// the UI; absent routes are the real boundary).
type Capabilities struct {
	Lifecycle    bool `json:"lifecycle"`
	ControlPlane bool `json:"controlPlane"`
	Logs         bool `json:"logs"`
	Workflows    bool `json:"workflows"`
}

// FullCapabilities is the host-mode default: everything on.
func FullCapabilities() Capabilities {
	return Capabilities{Lifecycle: true, ControlPlane: true, Logs: true, Workflows: true}
}
```

Add to `Options`:

```go
	// Capabilities gates optional feature routes and the SPA's capability
	// flags; nil means FullCapabilities (host mode).
	Capabilities *Capabilities
```

In `NewRouter`, resolve once and thread through:

```go
	caps := FullCapabilities()
	if opts.Capabilities != nil {
		caps = *opts.Capabilities
	}
	...
	mount := func(router chi.Router) {
		router.Mount("/api", apiRouter(opts.Version, opts.Apps, opts.ContainerLogs, opts.Lifecycle, opts.Backend, opts.Stores, opts.Resources, opts.News, opts.ControlPlane, opts.UpdateCheck, caps))
		router.Handle("/*", SPAHandler(opts.DistFS, opts.BasePath, opts.TelemetryEnabled, caps))
	}
```

In `pkg/server/api.go`, `apiRouter` gains the trailing `caps Capabilities` parameter and gates the mounts:

```go
	r.Mount("/apps", appsRouter(apps, containerLogs, life, caps))
	r.Mount("/actors", actorsRouter(apps))
	r.Mount("/subscriptions", subscriptionsRouter(apps))
	if caps.Workflows {
		r.Mount("/workflows", workflowsRouter(backend, stores))
	}
	r.Mount("/resources", resourcesRouter(res, apps))
	r.Mount("/news", newsRouter(newsSvc))
	if caps.ControlPlane {
		r.Mount("/controlplane", controlPlaneRouter(cp))
	}
	if uc != nil {
		r.Mount("/update-check", updateCheckRouter(uc))
	}
```

In `pkg/server/apps.go`, `appsRouter` gains `caps Capabilities` and gates the two feature routes (GET list/detail stay unconditional):

```go
	if caps.Logs {
		r.Get("/{appId}/logs", logsHandler(svc, containerLogs))
	}
	if caps.Lifecycle {
		r.Post("/{appId}/{target}/{action}", func(w http.ResponseWriter, req *http.Request) {
			... // existing body unchanged (nil life still answers 503)
		})
	}
```

In `pkg/server/spa.go`, `SPAHandler(fsys fs.FS, basePath string, telemetryEnabled bool, caps Capabilities)` and `serveIndex(w, r, fsys, telemetryEnabled, caps)`:

```go
	capsJSON, err := json.Marshal(caps)
	if err != nil {
		capsJSON = []byte("{}")
	}
	script := []byte("<script>window.__DASH_TELEMETRY_ENABLED__=" + flag +
		";window.__DASH_CAPABILITIES__=" + string(capsJSON) + ";</script></head>")
```

Fix all existing callers/tests of `SPAHandler` to pass `FullCapabilities()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/server/` → PASS. Then `go build ./...` → clean (cmd's `assembleOptions` still compiles because `Capabilities` is a new optional field).

- [ ] **Step 5: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./...
git add pkg/server/
git commit -m "feat(server): capability gating for routes and SPA injection"
```

---

### Task 7: Web capability gating (nav, routes, lifecycle controls)

**Files:**
- Create: `web/src/lib/capabilities.ts`
- Modify: `web/src/components/TopNav.tsx` (NAV_ITEMS + render filter), `web/src/router.tsx` (route table), `web/src/pages/AppDetail.tsx` (lifecycle button groups)
- Test: `web/src/lib/capabilities.test.ts`, `web/src/components/TopNav.test.tsx` (extend existing)

**Interfaces:**
- Consumes: `window.__DASH_CAPABILITIES__` injected by Task 6 (shape `{lifecycle, controlPlane, logs, workflows}`).
- Produces: `getCapabilities(): Capabilities` accessor used by TopNav, router, AppDetail.

- [ ] **Step 1: Write the failing test**

`web/src/lib/capabilities.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { getCapabilities } from './capabilities'

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: import('./capabilities').Capabilities
  }
}

describe('getCapabilities', () => {
  afterEach(() => {
    delete window.__DASH_CAPABILITIES__
  })

  it('defaults to everything enabled when the flag is absent (dev server)', () => {
    expect(getCapabilities()).toEqual({
      lifecycle: true,
      controlPlane: true,
      logs: true,
      workflows: true,
    })
  })

  it('returns the injected flags verbatim', () => {
    window.__DASH_CAPABILITIES__ = {
      lifecycle: false,
      controlPlane: false,
      logs: false,
      workflows: true,
    }
    expect(getCapabilities().lifecycle).toBe(false)
    expect(getCapabilities().workflows).toBe(true)
  })
})
```

Extend `web/src/components/TopNav.test.tsx` with (follow the file's existing render helpers):

```ts
it('hides capability-gated entries when their capability is off', () => {
  window.__DASH_CAPABILITIES__ = {
    lifecycle: false,
    controlPlane: false,
    logs: false,
    workflows: true,
  }
  renderTopNav() // the file's existing render helper
  expect(screen.queryByText('Control Plane')).toBeNull()
  expect(screen.queryByText('Logs')).toBeNull()
  expect(screen.getByText('Workflows')).toBeInTheDocument()
  expect(screen.getByText('Applications')).toBeInTheDocument()
  delete window.__DASH_CAPABILITIES__
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/lib/capabilities.test.ts src/components/TopNav.test.tsx`
Expected: FAIL — cannot resolve `./capabilities`.

- [ ] **Step 3: Implement**

`web/src/lib/capabilities.ts`:

```ts
export interface Capabilities {
  lifecycle: boolean
  controlPlane: boolean
  logs: boolean
  workflows: boolean
}

declare global {
  interface Window {
    __DASH_CAPABILITIES__?: Capabilities
  }
}

const FULL: Capabilities = { lifecycle: true, controlPlane: true, logs: true, workflows: true }

// getCapabilities reads the server-injected capability flags. Absent flag
// (Vite dev server, tests) means everything on — matching the host-mode
// server default.
export function getCapabilities(): Capabilities {
  return window.__DASH_CAPABILITIES__ ?? FULL
}
```

`web/src/components/TopNav.tsx` — add the optional `cap` key and filter:

```ts
import { getCapabilities, type Capabilities } from '../lib/capabilities'

export interface NavItem {
  label: string
  to: string
  cap?: keyof Capabilities
}

export const NAV_ITEMS: NavItem[] = [
  { label: 'Applications', to: '/' },
  { label: 'Components', to: '/components' },
  { label: 'Workflows', to: '/workflows', cap: 'workflows' },
  { label: 'Actors', to: '/actors' },
  { label: 'Subscriptions', to: '/subscriptions' },
  { label: 'Resiliency', to: '/resiliency' },
  { label: 'Configurations', to: '/configurations' },
  { label: 'Control Plane', to: '/control-plane', cap: 'controlPlane' },
  { label: 'Logs', to: '/logs', cap: 'logs' },
]
```

and in the component body, before the return:

```ts
  const caps = getCapabilities()
  const items = NAV_ITEMS.filter((item) => !item.cap || caps[item.cap])
```

then map over `items` instead of `NAV_ITEMS` in the JSX.

`web/src/router.tsx` — gate the route entries (read the file first; the children array is at ~lines 29-43). Compute `const caps = getCapabilities()` at module top and filter:

```ts
const caps = getCapabilities()

const gatedChildren = [
  { index: true, element: <Applications />, handle: { rumView: 'Applications' } },
  { path: 'apps/:appId', element: <AppDetail />, handle: { rumView: 'AppDetail' } },
  ...(caps.workflows
    ? [
        { path: 'workflows', element: <Workflows />, handle: { rumView: 'Workflows' } },
        { path: 'workflows/:appId/:instanceId', element: <WorkflowDetail />, handle: { rumView: 'WorkflowDetail' } },
      ]
    : []),
  // ... keep the ungated entries verbatim ...
  ...(caps.controlPlane
    ? [{ path: 'control-plane', element: <ControlPlane />, handle: { rumView: 'ControlPlane' } }]
    : []),
  ...(caps.logs ? [{ path: 'logs', element: <Logs />, handle: { rumView: 'Logs' } }] : []),
]
```

(preserve whatever catch-all/error route follows them; a gated-off path then falls through to the existing 404/error handling).

`web/src/pages/AppDetail.tsx` — gate lifecycle controls. Read the file; add near the other hooks:

```ts
  const caps = getCapabilities()
```

Then in `panelActions` (~line 94), first line:

```ts
  const panelActions = (target: AppTarget, status: string | undefined, what: string) => {
    if (!caps.lifecycle) return null
    return (
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        ...existing body unchanged...
      </span>
    )
  }
```

Also find every other `runAction(`/`removeFromList` button group in the file (the page-header action block, ~lines 145-185) and wrap each group in `{caps.lifecycle && ( ... )}` the same way. Do not change button markup inside the wrappers.

- [ ] **Step 4: Run tests and typecheck**

Run: `cd web && npx vitest run` → all pass.
Run: `cd web && npm run build` → tsc clean. **Required — vitest alone does not typecheck.**

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/capabilities.ts web/src/lib/capabilities.test.ts web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx web/src/router.tsx web/src/pages/AppDetail.tsx
git commit -m "feat(web): hide lifecycle/control-plane/logs/workflows behind capability flags"
```

---

### Task 8: cmd wiring — flags, env fallbacks, aspire serve path

**Files:**
- Modify: `cmd/root.go` (NewRootCmd flags + runServe), `cmd/serve.go` (serveDeps + assembleOptions), `cmd/derive.go:21-53` (derivePaths extra paths), `cmd/reconciler.go:65,125` (thread extra paths)
- Test: `cmd/root_test.go`, `cmd/derive_test.go`, `cmd/mode_test.go` (extend)

**Interfaces:**
- Consumes: `resolveMode` (Task 1), `NewAspireScanner`/`AspireContractPresent` (Task 2), `server.Capabilities` (Task 6), `Options.AllowNonLoopback` (Task 5).
- Produces: `--mode` and `--bind` flags; env fallbacks `DEVDASHBOARD_PORT`, `DEVDASHBOARD_BIND`, `DEVDASHBOARD_STATESTORE_FILE`, `DEVDASHBOARD_NAMESPACE`, `DEVDASHBOARD_RESOURCES_PATH`; `func resolveServeSettings(mode Mode, flagChanged func(string) bool, port int, bind, stateStore, namespace string, getenv func(string) string) (serveSettings, error)`.

- [ ] **Step 1: Write the failing settings-resolution test**

Add to `cmd/mode_test.go`:

```go
func TestResolveServeSettings(t *testing.T) {
	noneChanged := func(string) bool { return false }
	tests := []struct {
		name    string
		mode    Mode
		changed func(string) bool
		port    int
		bind    string
		env     map[string]string
		want    serveSettings
	}{
		{
			name: "default mode keeps host defaults",
			mode: ModeDefault, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			want: serveSettings{Port: 9090, Bind: "127.0.0.1", Namespace: "default"},
		},
		{
			name: "aspire mode defaults to 8080 on 0.0.0.0",
			mode: ModeAspire, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			want: serveSettings{Port: 8080, Bind: "0.0.0.0", Namespace: "default"},
		},
		{
			name: "env overrides aspire defaults",
			mode: ModeAspire, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			env: map[string]string{
				"DEVDASHBOARD_PORT":            "9999",
				"DEVDASHBOARD_BIND":            "127.0.0.1",
				"DEVDASHBOARD_STATESTORE_FILE": "/app/components/state.yaml",
				"DEVDASHBOARD_NAMESPACE":       "team-a",
			},
			want: serveSettings{Port: 9999, Bind: "127.0.0.1", StateStore: "/app/components/state.yaml",
				Namespace: "team-a", ResourcesPaths: []string{"/app/components"}},
		},
		{
			name: "changed flag beats env",
			mode: ModeAspire, changed: func(f string) bool { return f == "port" }, port: 7000, bind: "127.0.0.1",
			env:  map[string]string{"DEVDASHBOARD_PORT": "9999"},
			want: serveSettings{Port: 7000, Bind: "0.0.0.0", Namespace: "default"},
		},
		{
			name: "explicit resources path splits on list separator",
			mode: ModeAspire, changed: noneChanged, port: 9090, bind: "127.0.0.1",
			env: map[string]string{
				"DEVDASHBOARD_RESOURCES_PATH": "/mnt/a" + string(os.PathListSeparator) + "/mnt/b",
			},
			want: serveSettings{Port: 8080, Bind: "0.0.0.0", Namespace: "default",
				ResourcesPaths: []string{"/mnt/a", "/mnt/b"}},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			getenv := func(k string) string { return tc.env[k] }
			got, err := resolveServeSettings(tc.mode, tc.changed, tc.port, tc.bind, "", "default", getenv)
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %+v want %+v", got, tc.want)
			}
		})
	}
	t.Run("bad DEVDASHBOARD_PORT errors", func(t *testing.T) {
		_, err := resolveServeSettings(ModeAspire, noneChanged, 9090, "127.0.0.1", "", "default",
			func(k string) string {
				if k == "DEVDASHBOARD_PORT" {
					return "not-a-port"
				}
				return ""
			})
		if err == nil || !strings.Contains(err.Error(), "DEVDASHBOARD_PORT") {
			t.Fatalf("want error naming DEVDASHBOARD_PORT, got %v", err)
		}
	})
}
```

Also extend `cmd/derive_test.go` with:

```go
func TestDerivePathsExtraResPaths(t *testing.T) {
	resPaths, scanPaths, _, _ := derivePaths(nil, "", "/app/components/state.yaml", []string{"/app/components"})
	found := false
	for _, p := range resPaths {
		if p == "/app/components" {
			found = true
		}
	}
	if !found {
		t.Fatalf("resPaths missing extra path: %v", resPaths)
	}
	if len(scanPaths) != 1 || scanPaths[0] != "/app/components/state.yaml" {
		t.Fatalf("explicit statestore must own scanPaths: %v", scanPaths)
	}
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./cmd/ -run "TestResolveServeSettings|TestDerivePathsExtra" -v`
Expected: FAIL — `undefined: serveSettings`, `undefined: resolveServeSettings`, derivePaths argument-count compile error.

- [ ] **Step 3: Implement settings resolution (append to `cmd/mode.go`)**

```go
import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// serveSettings is the fully resolved serve configuration: flag > env > mode
// default, per the spec's precedence rule.
type serveSettings struct {
	Port           int
	Bind           string
	StateStore     string
	Namespace      string
	ResourcesPaths []string
}

// resolveServeSettings applies the flag > env > mode-default precedence.
// flagChanged reports whether the named cobra flag was set explicitly; port,
// bind, stateStore, namespace carry the flag values (which hold cobra
// defaults when unchanged).
func resolveServeSettings(mode Mode, flagChanged func(string) bool, port int, bind, stateStore, namespace string, getenv func(string) string) (serveSettings, error) {
	s := serveSettings{Port: port, Bind: bind, StateStore: stateStore, Namespace: namespace}

	if !flagChanged("port") {
		if v := getenv("DEVDASHBOARD_PORT"); v != "" {
			p, err := strconv.Atoi(v)
			if err != nil || p < 1 || p > 65535 {
				return s, fmt.Errorf("DEVDASHBOARD_PORT: expected a port number, got %q", v)
			}
			s.Port = p
		} else if mode == ModeAspire {
			s.Port = 8080
		}
	}
	if !flagChanged("bind") {
		if v := getenv("DEVDASHBOARD_BIND"); v != "" {
			s.Bind = v
		} else if mode == ModeAspire {
			s.Bind = "0.0.0.0"
		}
	}
	if s.StateStore == "" {
		s.StateStore = getenv("DEVDASHBOARD_STATESTORE_FILE")
	}
	if !flagChanged("namespace") {
		if v := getenv("DEVDASHBOARD_NAMESPACE"); v != "" {
			s.Namespace = v
		}
	}
	if v := getenv("DEVDASHBOARD_RESOURCES_PATH"); v != "" {
		for _, p := range strings.Split(v, string(os.PathListSeparator)) {
			if p = strings.TrimSpace(p); p != "" {
				s.ResourcesPaths = append(s.ResourcesPaths, p)
			}
		}
	} else if mode == ModeAspire && s.StateStore != "" {
		s.ResourcesPaths = []string{filepath.Dir(s.StateStore)}
	}
	return s, nil
}
```

- [ ] **Step 4: Thread extra resource paths through derive/reconciler**

`cmd/derive.go` — signature gains a final param; append to `resPaths` only:

```go
func derivePaths(apps []discovery.Instance, homeDir, stateStorePath string, extraResPaths []string) (resPaths, scanPaths []string, loaded map[string]bool, appPaths []string) {
	...
	resPaths = append(resPaths, extraResPaths...)
	return resPaths, scanPaths, loaded, appPaths
}
```

(place the append just before the return). `cmd/reconciler.go`: add an `extraResPaths []string` field to the reconciler struct, a matching final parameter on `newReconciler(...)`, and pass `rc.extraResPaths` at the `derivePaths` call site (line ~125). Fix the existing `newReconciler`/`derivePaths` callers (compiler-guided: `go build ./...` lists them) by passing `nil` except where Step 5 supplies real values.

- [ ] **Step 5: Wire NewRootCmd and runServe (`cmd/root.go`)**

New flags in `NewRootCmd`:

```go
	var (
		port       int
		bind       string
		modeFlag   string
		basePath   string
		noOpen     bool
		stateStore string
		namespace  string
		verbose    bool
	)
	...
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&bind, "bind", "127.0.0.1", "address to bind (aspire mode defaults to 0.0.0.0)")
	c.Flags().StringVar(&modeFlag, "mode", "", `serving/discovery mode: "aspire", or unset for the complete scan`)
```

RunE resolves before calling runServe:

```go
		RunE: func(cmd *cobra.Command, _ []string) error {
			mode, err := resolveMode(modeFlag, os.Getenv)
			if err != nil {
				return err
			}
			settings, err := resolveServeSettings(mode, cmd.Flags().Changed, port, bind, stateStore, namespace, os.Getenv)
			if err != nil {
				return err
			}
			return runServe(cmd.Context(), mode, settings, basePath, noOpen, verbose)
		},
```

`runServe(ctx context.Context, mode Mode, settings serveSettings, basePath string, noOpen, verbose bool) error` — restructure the current body:

```go
	// ...logger/dist/metadata.Init unchanged...

	addr := fmt.Sprintf("%s:%d", settings.Bind, settings.Port)
	displayHost := settings.Bind
	if displayHost == "0.0.0.0" || displayHost == "::" {
		displayHost = "localhost"
	}
	url := fmt.Sprintf("http://%s:%d%s/", displayHost, settings.Port, urlPath)

	home := ""
	if mode != ModeAspire {
		home, err = os.UserHomeDir()
		if err != nil {
			logger.Warn("home directory unavailable; connection registry will not be persisted", "err", err)
			home = ""
		}
	}

	client := &http.Client{Timeout: 2 * time.Second}
	var (
		appsSvc       discovery.Service
		lifeMgr       lifecycle.Manager
		composeEnv    func() discovery.ComposeEnv
		containerLogs func(context.Context, string) (<-chan string, error)
		updateCheck   updatecheck.Service
		caps          *server.Capabilities
	)
	switch mode {
	case ModeAspire:
		scan, err := discovery.NewAspireScanner(os.Getenv)
		if err != nil {
			return err
		}
		appsSvc = discovery.New(scan, client)
		caps = &server.Capabilities{Workflows: settings.StateStore != ""}
	default:
		_, crtRunner := containerruntime.Detect()
		composeSrc := discovery.NewComposeSource(crtRunner)
		scanners := []discovery.Scanner{discovery.StandaloneScanner(), composeSrc.Scanner()}
		if discovery.AspireContractPresent(os.Getenv) {
			as, err := discovery.NewAspireScanner(os.Getenv)
			if err != nil {
				return err
			}
			scanners = append(scanners, as)
		}
		lifeReg := lifecycle.NewRegistry()
		lifeProc := lifecycle.NewProcController()
		appsSvc = lifecycle.Overlay(
			discovery.New(discovery.Merge(scanners...), client), lifeReg, lifeProc)
		lifeMgr = lifecycle.New(appsSvc, lifeReg, crtRunner, lifeProc, lifecycle.NewStarter())
		composeEnv = composeSrc.Env
		containerLogs = containerLogStream(crtRunner)
		updateCheck = updatecheck.New(&http.Client{Timeout: 5 * time.Second}, "https://api.github.com", "diagridio/dev-dashboard", version.Get().Version, time.Hour)
	}
```

Pass through `assembleOptions` via extended `serveDeps` (add fields `AllowNonLoopback bool`, `Capabilities *server.Capabilities`, `ResourcesPaths []string`, `QuietRegistry bool`):

```go
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:         basePath,
		StateStorePath:   settings.StateStore,
		Namespace:        settings.Namespace,
		Apps:             appsSvc,
		Lifecycle:        lifeMgr,
		HomeDir:          home,
		HTTPClient:       &http.Client{Timeout: 10 * time.Second},
		ComposeEnv:       composeEnv,
		ContainerLogs:    containerLogs,
		TelemetryEnabled: telemetry,
		UpdateCheck:      updateCheck,
		AllowNonLoopback: mode == ModeAspire,
		Capabilities:     caps,
		ResourcesPaths:   settings.ResourcesPaths,
		QuietRegistry:    mode == ModeAspire,
	}, dist)
```

Guard the update announcement and browser open:

```go
	if updateCheck != nil {
		check := maybeAnnounceUpdate(ctx, updateCheck, version.Get().Version)
		interactive := isatty.IsTerminal(os.Stdin.Fd()) && isatty.IsTerminal(os.Stdout.Fd())
		maybeOfferUpdate(ctx, check, os.Stdin, os.Stdout, interactive, selfUpdateAndRestart)
	}
	...
	if !noOpen && mode != ModeAspire {
		go func() { time.Sleep(400 * time.Millisecond); _ = openBrowser(url) }()
	}
```

`cmd/serve.go` `assembleOptions` changes:

```go
	if deps.HomeDir != "" {
		registry = LoadRegistry(deps.HomeDir)
	} else if !deps.QuietRegistry {
		slog.Default().With("component", "registry").Warn("no home directory; connection registry persistence disabled")
	}
	...
	rc := newReconciler(ctx, appsSvc, deps.Namespace, deps.HomeDir, deps.StateStorePath, deps.HTTPClient, registry, pool, deps.ComposeEnv, deps.ResourcesPaths)
	...
	return server.Options{
		...
		AllowNonLoopback: deps.AllowNonLoopback,
		Capabilities:     deps.Capabilities,
	}, []func() error{rc.Close}
```

- [ ] **Step 6: Run all tests**

Run: `go test -tags unit ./...` → PASS (fix any existing cmd tests that construct `serveDeps`/`newReconciler`/`derivePaths` — compiler-guided, pass zero values/nil for the new params).

- [ ] **Step 7: Manual smoke (mode-unset regression + aspire startup)**

```bash
go build -o bin/dev-dashboard . && ./bin/dev-dashboard --no-open --port 19091 &
sleep 1 && curl -s http://127.0.0.1:19091/api/health && kill %1
```
Expected: `{"status":"ok"}`.

```bash
DEVDASHBOARD_MODE=aspire ./bin/dev-dashboard 2>&1 | head -2
```
Expected: exits non-zero with an error containing `DEVDASHBOARD_APP_COUNT` (contract missing = fail fast).

```bash
DEVDASHBOARD_MODE=aspire DEVDASHBOARD_APP_COUNT=0 ./bin/dev-dashboard --no-open &
sleep 1 && curl -s -H "Host: whatever.example" http://127.0.0.1:8080/api/health && curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/api/controlplane/ && kill %1
```
Expected: `{"status":"ok"}` (foreign Host accepted) then `404` (control plane absent).

- [ ] **Step 8: Lint and commit**

```bash
gofmt -l . && go vet -tags unit ./... && make build
git add cmd/
git commit -m "feat(cmd): aspire mode wiring — flags, env fallbacks, scanner selection"
```

---

### Task 9: Aspire-mode integration test

**Files:**
- Create: `cmd/serve_aspire_integration_test.go` (build tag: copy the `//go:build integration` header from `cmd/serve_integration_test.go`)

**Interfaces:**
- Consumes: everything from Tasks 1-8. No new surface.

- [ ] **Step 1: Write the test**

Follow the structural conventions of `cmd/serve_integration_test.go` (how it builds deps and drives the router). The test:

```go
func TestAspireModeEndToEnd(t *testing.T) {
	// Stub daprd: healthz + minimal metadata.
	daprd := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(http.StatusNoContent)
		case "/v1.0/metadata":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"id":"orders","runtimeVersion":"1.16.0","extended":{}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer daprd.Close()

	t.Setenv("DEVDASHBOARD_APP_COUNT", "1")
	t.Setenv("DEVDASHBOARD_APP_0_ID", "orders")
	t.Setenv("DEVDASHBOARD_APP_0_DAPR_HTTP", daprd.URL)

	scan, err := discovery.NewAspireScanner(os.Getenv)
	if err != nil {
		t.Fatalf("scanner: %v", err)
	}
	appsSvc := discovery.New(scan, daprd.Client())
	caps := &server.Capabilities{Workflows: false}
	opts, closers := assembleOptions(t.Context(), serveDeps{
		Namespace: "default", Apps: appsSvc,
		HTTPClient:       &http.Client{Timeout: 5 * time.Second},
		AllowNonLoopback: true, Capabilities: caps, QuietRegistry: true,
	}, testDistFS(t)) // reuse/mirror however serve_integration_test.go supplies a dist FS
	for _, c := range closers {
		defer func() { _ = c() }()
	}
	srv := httptest.NewServer(server.NewRouter(opts))
	defer srv.Close()

	// Apps listed from env contract, enriched from the stub daprd.
	req, _ := http.NewRequest(http.MethodGet, srv.URL+"/api/apps/", nil)
	req.Host = "dashboard.internal:8080" // non-loopback Host must be accepted
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("apps: %d %s", resp.StatusCode, body)
	}
	if !strings.Contains(string(body), `"appId":"orders"`) || !strings.Contains(string(body), `"health":"healthy"`) {
		t.Fatalf("apps body: %s", body)
	}
	if !strings.Contains(string(body), `"source":"aspire"`) {
		t.Fatalf("apps body missing aspire source: %s", body)
	}

	// Gated surfaces are absent.
	for _, path := range []string{"/api/controlplane/", "/api/workflows/", "/api/apps/orders/logs"} {
		r2, _ := http.Get(srv.URL + path)
		r2.Body.Close()
		if r2.StatusCode != http.StatusNotFound {
			t.Fatalf("%s: got %d want 404", path, r2.StatusCode)
		}
	}
}
```

Adjust helper usage (`testDistFS`, deps construction) to exactly match what `serve_integration_test.go` already does — reuse its helpers rather than inventing new ones.

- [ ] **Step 2: Run it**

Run: `go test -tags integration ./cmd/ -run TestAspireModeEndToEnd -v`
Expected: PASS.

- [ ] **Step 3: Full suites and commit**

```bash
make test && make test-integration
git add cmd/serve_aspire_integration_test.go
git commit -m "test(cmd): aspire-mode end-to-end integration test"
```

---

### Task 10: Dockerfile, .dockerignore, CI image build

**Files:**
- Create: `Dockerfile`, `.dockerignore`
- Modify: `.github/workflows/ci.yaml` (add a build-only image job)

**Interfaces:**
- Consumes: the binary behavior from Task 8 (`ENV DEVDASHBOARD_MODE=aspire` default).
- Produces: a locally buildable image; Task 12 documents it. Task 11's `Dockerfile.goreleaser` is separate (prebuilt-binary context).

- [ ] **Step 1: Write `.dockerignore`**

```
.git
.claude
.superpowers
bin
docs
node_modules
web/node_modules
web/dist
test
*.md
```

(`web/dist` is excluded because the web stage rebuilds it; the go stage copies it from there.)

- [ ] **Step 2: Write `Dockerfile`**

Check `go.mod` for the exact Go version line (currently `go 1.26.x`) and match the builder tag major.minor:

```dockerfile
# syntax=docker/dockerfile:1

FROM node:22-alpine AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM golang:1.26-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
COPY --from=web /src/web/dist ./web/dist
ARG VERSION=dev
ARG COMMIT=unknown
ARG DATE=unknown
RUN CGO_ENABLED=0 go build \
    -ldflags "-s -w \
    -X github.com/diagridio/dev-dashboard/pkg/version.Version=${VERSION} \
    -X github.com/diagridio/dev-dashboard/pkg/version.Commit=${COMMIT} \
    -X github.com/diagridio/dev-dashboard/pkg/version.Date=${DATE}" \
    -o /out/dev-dashboard .

FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/dev-dashboard /dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
EXPOSE 8080
ENTRYPOINT ["/dev-dashboard"]
```

- [ ] **Step 3: Build and smoke-test the image**

```bash
docker build -t dev-dashboard:dev .
docker run --rm -e DEVDASHBOARD_APP_COUNT=0 -p 18080:8080 -d --name dd-smoke dev-dashboard:dev
sleep 2
curl -s http://127.0.0.1:18080/api/health
docker logs dd-smoke | head -3
docker rm -f dd-smoke
```
Expected: `{"status":"ok"}`; logs show the startup line with the 8080 URL and no telemetry/update prompts blocking.

Also verify fail-fast: `docker run --rm dev-dashboard:dev` (no env) must exit non-zero printing an error naming `DEVDASHBOARD_APP_COUNT`.

- [ ] **Step 4: Add the CI job**

Read `.github/workflows/ci.yaml` and append a job matching its indentation/checkout style:

```yaml
  docker:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build container image (no push)
        run: docker build -t dev-dashboard:ci .
```

- [ ] **Step 5: Commit**

```bash
git add Dockerfile .dockerignore .github/workflows/ci.yaml
git commit -m "feat(docker): multi-stage container image with aspire-mode default"
```

---

### Task 11: goreleaser image publishing

**Files:**
- Create: `Dockerfile.goreleaser`
- Modify: `.goreleaser.yaml`, `.github/workflows/release.yaml`

**Interfaces:**
- Consumes: the `dev-dashboard` build id in `.goreleaser.yaml`.
- Produces: `ghcr.io/diagridio/dev-dashboard:{version}` + `:latest` multi-arch manifests on tag release.

- [ ] **Step 1: Write `Dockerfile.goreleaser`**

goreleaser injects the prebuilt binary into the build context, so this stage is copy-only:

```dockerfile
FROM gcr.io/distroless/static:nonroot
COPY dev-dashboard /dev-dashboard
ENV DEVDASHBOARD_MODE=aspire
EXPOSE 8080
ENTRYPOINT ["/dev-dashboard"]
```

- [ ] **Step 2: Add dockers + manifests to `.goreleaser.yaml`**

Append after the `archives:` block:

```yaml
dockers:
  - id: linux-amd64
    ids: [dev-dashboard]
    goos: linux
    goarch: amd64
    dockerfile: Dockerfile.goreleaser
    use: buildx
    image_templates:
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-amd64"
    build_flag_templates:
      - "--platform=linux/amd64"
  - id: linux-arm64
    ids: [dev-dashboard]
    goos: linux
    goarch: arm64
    dockerfile: Dockerfile.goreleaser
    use: buildx
    image_templates:
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-arm64"
    build_flag_templates:
      - "--platform=linux/arm64"

docker_manifests:
  - name_template: "ghcr.io/diagridio/dev-dashboard:{{ .Version }}"
    image_templates:
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-amd64"
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-arm64"
  - name_template: "ghcr.io/diagridio/dev-dashboard:latest"
    image_templates:
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-amd64"
      - "ghcr.io/diagridio/dev-dashboard:{{ .Version }}-arm64"
```

- [ ] **Step 3: Update the release workflow**

Read `.github/workflows/release.yaml`. Ensure the release job has `permissions:` including `packages: write` (add alongside the existing `contents: write`), and add before the goreleaser step (match the file's action-version style):

```yaml
      - name: Log in to GHCR
        uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - name: Set up QEMU
        uses: docker/setup-qemu-action@v3
      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3
```

- [ ] **Step 4: Validate config and snapshot-build**

```bash
make release-check
goreleaser release --snapshot --clean --skip=publish
docker run --rm -e DEVDASHBOARD_APP_COUNT=0 -p 18081:8080 -d --name dd-gr ghcr.io/diagridio/dev-dashboard:$(ls dist/ | grep -oE '[0-9]+\.[0-9]+\.[0-9]+[^_]*' | head -1)-amd64 2>/dev/null || true
```
Expected: `release-check` passes; snapshot builds both arch images locally (on Apple Silicon the amd64 image may not run — verifying the arm64 tag with the same curl smoke as Task 10 is sufficient).

- [ ] **Step 5: Commit**

```bash
git add Dockerfile.goreleaser .goreleaser.yaml .github/workflows/release.yaml
git commit -m "feat(release): publish multi-arch image to ghcr.io/diagridio/dev-dashboard"
```

---

### Task 12: Documentation

**Files:**
- Modify: `README.md` (new "Run as a container (.NET Aspire)" section after the install section)

**Interfaces:** none — prose only, describing the contract exactly as specified.

- [ ] **Step 1: Write the README section**

Add a section documenting: the image name/tags; that `DEVDASHBOARD_MODE=aspire` is baked in; the full env contract table (`DEVDASHBOARD_APP_COUNT`, `DEVDASHBOARD_APP_<i>_ID`, `DEVDASHBOARD_APP_<i>_DAPR_HTTP`, `DEVDASHBOARD_APP_<i>_NAMESPACE`, `DEVDASHBOARD_APP_<i>_LABEL`, `DEVDASHBOARD_PORT`, `DEVDASHBOARD_BIND`, `DEVDASHBOARD_STATESTORE_FILE`, `DEVDASHBOARD_NAMESPACE`, `DEVDASHBOARD_RESOURCES_PATH`, `DEVDASHBOARD_MODE`) with the same required/default columns as the spec; what aspire mode disables (lifecycle, control plane, log tailing, self-update); a hand-run example:

```bash
docker run --rm -p 8080:8080 \
  -e DEVDASHBOARD_APP_COUNT=1 \
  -e DEVDASHBOARD_APP_0_ID=myapp \
  -e DEVDASHBOARD_APP_0_DAPR_HTTP=http://host.docker.internal:3500 \
  ghcr.io/diagridio/dev-dashboard:latest
```

and a pointer to the hosting-integration repo (`diagrid-labs/dashboard-aspire`) as the intended consumer. Also mention `--mode`/`DEVDASHBOARD_MODE` in the existing flags documentation, including that unset mode performs the complete scan and that `dapr`/`compose` values are reserved for future single-source modes.

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: container image and aspire-mode contract documentation"
```

---

## Final verification (after all tasks)

- [ ] `make lint && make test && make test-integration` — all green.
- [ ] `make build` — binary builds with fresh web assets.
- [ ] Task 8 Step 7 smoke commands re-run against the final binary.
- [ ] Invoke superpowers:requesting-code-review before merging.
