# slog `--verbose` Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add opt-in diagnostic logging to the dashboard via `log/slog`, gated behind a `--verbose` flag, covering server lifecycle, UI/SSE, Dapr app discovery, state-store connection, and purge/force-delete.

**Architecture:** A new `pkg/logging` package builds an `*slog.Logger` — a text handler to stderr at INFO when verbose, or an `io.Discard` handler (no output) otherwise. `runServe` builds it from the flag and calls `slog.SetDefault`. Every emitting package logs through `slog.Default().With("component", "<name>")`; no constructor signatures change. All existing `fmt.Print*` lines stay (logging is purely additive).

**Tech Stack:** Go, `log/slog` (stdlib), cobra (existing CLI), chi (existing router).

## Global Constraints

- No new third-party dependencies — `log/slog` only.
- Without `--verbose`, the dashboard emits **no** slog output at all.
- All existing `fmt.Print*` / `fmt.Fprintln` output is preserved unchanged (additive).
- Output format: slog **text** handler to **`os.Stderr`**, level **`slog.LevelInfo`** when verbose.
- Every log line carries a `component=<name>` attribute via `slog.Default().With(...)`.

---

### Task 1: `pkg/logging` package

**Files:**
- Create: `pkg/logging/logging.go`
- Test: `pkg/logging/logging_test.go`

**Interfaces:**
- Consumes: nothing.
- Produces: `func New(verbose bool) *slog.Logger` — returns a logger writing text to stderr at INFO when `verbose` is true, or a logger that discards all output when false.

- [ ] **Step 1: Write the failing test**

```go
package logging

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"
)

func TestNew_VerboseWritesInfoAndAbove(t *testing.T) {
	// New(true) must produce a logger that emits INFO/WARN/ERROR.
	// We can't capture os.Stderr easily here, so assert the handler is enabled
	// at the expected levels.
	l := New(true)
	if !l.Handler().Enabled(nil, slog.LevelInfo) {
		t.Fatal("verbose logger should be enabled at INFO")
	}
	if !l.Handler().Enabled(nil, slog.LevelError) {
		t.Fatal("verbose logger should be enabled at ERROR")
	}
}

func TestNew_NotVerboseDiscardsEverything(t *testing.T) {
	l := New(false)
	if l.Handler().Enabled(nil, slog.LevelError) {
		t.Fatal("non-verbose logger must not be enabled at any level")
	}
}

func TestNew_VerboseDisabledBelowInfo(t *testing.T) {
	l := New(true)
	if l.Handler().Enabled(nil, slog.LevelDebug) {
		t.Fatal("verbose logger should not be enabled at DEBUG")
	}
}

// captureWriter test: a logger built over a buffer behaves the same as New(true).
func TestNew_OutputContainsMessage(t *testing.T) {
	var buf bytes.Buffer
	l := slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo}))
	l.Info("hello", "k", "v")
	out := buf.String()
	if !strings.Contains(out, "hello") || !strings.Contains(out, "k=v") {
		t.Fatalf("expected message and attr in output, got %q", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/logging/ -run TestNew -v`
Expected: FAIL — `undefined: New`.

- [ ] **Step 3: Write minimal implementation**

```go
// Package logging builds the dashboard's diagnostic logger.
//
// Logging is opt-in: New(false) returns a logger that discards everything,
// New(true) returns a text logger writing to stderr at INFO level.
package logging

import (
	"context"
	"log/slog"
	"os"
)

// New returns the dashboard logger. When verbose is false the logger discards
// all output (no diagnostics are emitted). When true it writes text to stderr
// at INFO level (INFO/WARN/ERROR).
func New(verbose bool) *slog.Logger {
	if !verbose {
		return slog.New(discardHandler{})
	}
	return slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
		Level: slog.LevelInfo,
	}))
}

// discardHandler is a slog.Handler that drops every record and reports disabled
// at all levels, so call sites become cheap no-ops when --verbose is off.
type discardHandler struct{}

func (discardHandler) Enabled(context.Context, slog.Level) bool  { return false }
func (discardHandler) Handle(context.Context, slog.Record) error { return nil }
func (d discardHandler) WithAttrs([]slog.Attr) slog.Handler      { return d }
func (d discardHandler) WithGroup(string) slog.Handler           { return d }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test ./pkg/logging/ -v`
Expected: PASS (all four tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/logging/logging.go pkg/logging/logging_test.go
git commit -m "feat(logging): add slog logger with verbose/discard gating"
```

---

### Task 2: `--verbose` flag + server lifecycle logs (`cmd/root.go`)

**Files:**
- Modify: `cmd/root.go`
- Test: `cmd/root_test.go`

**Interfaces:**
- Consumes: `logging.New(verbose bool) *slog.Logger` (Task 1).
- Produces: a `--verbose` persistent bool flag on the root command; `slog.SetDefault` is called with the built logger inside `runServe`.

- [ ] **Step 1: Write the failing test**

```go
package cmd

import "testing"

func TestRootCmd_HasVerboseFlag(t *testing.T) {
	c := NewRootCmd()
	f := c.Flags().Lookup("verbose")
	if f == nil {
		t.Fatal("expected --verbose flag to be registered")
	}
	if f.DefValue != "false" {
		t.Fatalf("expected --verbose default false, got %q", f.DefValue)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestRootCmd_HasVerboseFlag -v`
Expected: FAIL — flag not registered (nil).

- [ ] **Step 3: Add the flag and wire the logger**

In `cmd/root.go`, add the import:

```go
	"log/slog"

	"github.com/diagridio/dev-dashboard/pkg/logging"
```

Add the `verbose` var to the `var (...)` block in `NewRootCmd`:

```go
	var (
		port       int
		basePath   string
		noOpen     bool
		stateStore string
		namespace  string
		verbose    bool
	)
```

Register the flag (next to the other `c.Flags()` calls):

```go
	c.Flags().BoolVar(&verbose, "verbose", false, "enable diagnostic logging to stderr")
```

Pass it into `runServe`:

```go
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen, stateStore, namespace, verbose)
		},
```

- [ ] **Step 4: Add lifecycle logging in `runServe`**

Change the signature and build the logger at the top:

```go
func runServe(ctx context.Context, port int, basePath string, noOpen bool, stateStore, namespace string, verbose bool) error {
	logger := logging.New(verbose)
	slog.SetDefault(logger)

	dist, err := web.DistFS()
	if err != nil {
		logger.Error("embedded UI failed to load", "err", err)
		return fmt.Errorf("load embedded UI: %w", err)
	}
```

Log "server listening" just before starting the serve goroutine (replace the existing block around the `errCh`):

```go
	fmt.Printf("dev-dashboard %s → %s\n", version.Get().Version, url)
	if !noOpen {
		go func() { time.Sleep(400 * time.Millisecond); _ = openBrowser(url) }()
	}

	logger.Info("server listening", "addr", addr, "basePath", basePath, "version", version.Get().Version)

	errCh := make(chan error, 1)
	go func() { errCh <- srv.Start() }()

	select {
	case err := <-errCh:
		logger.Error("server failed to start", "addr", addr, "err", err)
		return err
	case <-ctx.Done():
		logger.Info("shutdown signal received")
		fmt.Println("shutting down…")
		shutCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutCtx); err != nil {
			logger.Warn("graceful shutdown failed", "err", err)
			return err
		}
		return nil
	}
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./cmd/ -v`
Expected: PASS (existing cmd tests + `TestRootCmd_HasVerboseFlag`).

- [ ] **Step 6: Build to confirm wiring compiles**

Run: `go build ./...`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add cmd/root.go cmd/root_test.go
git commit -m "feat(cmd): add --verbose flag and server lifecycle logging"
```

---

### Task 3: State-store connection logs (`cmd/workflow.go`)

**Files:**
- Modify: `cmd/workflow.go` (`newStoreBackend`)
- Test: `cmd/workflow_test.go`

**Interfaces:**
- Consumes: `slog.Default()` (default logger set in Task 2).
- Produces: no new exported symbols; adds INFO/WARN logs inside `newStoreBackend`.

- [ ] **Step 1: Write the failing test**

```go
package cmd

import (
	"bytes"
	"context"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

// withCapturedLogs swaps the default logger for one writing to buf, returns a restore func.
func withCapturedLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestNewStoreBackend_LogsNoStoreDetected(t *testing.T) {
	buf := withCapturedLogs(t)
	appIDs := func(context.Context) ([]string, error) { return nil, nil }
	_, closers := newStoreBackend(context.Background(), nil, "default", &http.Client{}, nil, appIDs)
	for _, c := range closers {
		_ = c()
	}
	if !strings.Contains(buf.String(), "no state store detected") {
		t.Fatalf("expected 'no state store detected' WARN, got %q", buf.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./cmd/ -run TestNewStoreBackend_LogsNoStoreDetected -v`
Expected: FAIL — message not present.

- [ ] **Step 3: Add logging in `newStoreBackend`**

Add `"log/slog"` to the imports in `cmd/workflow.go`. At the top of `newStoreBackend`, after `var closers []func() error`:

```go
	log := slog.Default().With("component", "statestore")
	log.Info("detected state-store components", "count", len(comps))
	if len(comps) == 0 {
		log.Warn("no state store detected")
	}
```

In the component loop, augment the existing failure branch and add a success log (keep the existing `fmt.Printf` — additive):

```go
	for _, comp := range comps {
		st, err := statestore.New(ctx, comp)
		if err != nil {
			fmt.Printf("warning: state store %q init failed: %v (skipping)\n", comp.Name, err)
			log.Warn("state store init failed, skipping", "name", comp.Name, "err", err)
			continue
		}
		closers = append(closers, st.Close)

		svc := workflow.New(st, namespace, appIDs)
		rem := workflow.NewRemover(client, st, namespace)
		res := newTargetResolver(apps, svc)
		b.services[comp.Name] = storeEntry{svc: svc, rem: rem, targets: res}
		log.Info("state store connected", "name", comp.Name, "type", comp.Type)
	}
```

After `activeName` is resolved (in the `if active := registry.active(); ...` block), log the active store:

```go
	if active := registry.active(); active != nil {
		if _, ok := b.services[active.Name]; ok {
			b.activeName = active.Name
			log.Info("active state store selected", "name", active.Name)
		}
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./cmd/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/workflow.go cmd/workflow_test.go
git commit -m "feat(cmd): log state-store detection and connection"
```

---

### Task 4: Dapr app discovery logs (`pkg/discovery/service.go`)

**Files:**
- Modify: `pkg/discovery/service.go` (`List`, `Get`, `enrich`)
- Test: `pkg/discovery/service_test.go`

**Interfaces:**
- Consumes: `slog.Default()`.
- Produces: no new exported symbols; adds INFO/WARN/ERROR logs in discovery.

- [ ] **Step 1: Write the failing test**

```go
package discovery

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"testing"
)

func captureLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestList_LogsScanFailure(t *testing.T) {
	buf := captureLogs(t)
	svc := New(func() ([]ScanResult, error) { return nil, errors.New("boom") }, &http.Client{})
	_, err := svc.List(context.Background())
	if err == nil {
		t.Fatal("expected error from List")
	}
	if !strings.Contains(buf.String(), "app scan failed") {
		t.Fatalf("expected 'app scan failed' ERROR, got %q", buf.String())
	}
}

func TestList_LogsDiscoveredCount(t *testing.T) {
	buf := captureLogs(t)
	svc := New(func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "a", HTTPPort: 0}}, nil
	}, &http.Client{Timeout: 1})
	_, _ = svc.List(context.Background())
	if !strings.Contains(buf.String(), "discovered Dapr apps") {
		t.Fatalf("expected 'discovered Dapr apps' INFO, got %q", buf.String())
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/discovery/ -run TestList_Logs -v`
Expected: FAIL — messages not present.

- [ ] **Step 3: Add logging**

Add `"log/slog"` to the imports in `pkg/discovery/service.go`. Add a package-level helper at the top (below the imports):

```go
func logger() *slog.Logger { return slog.Default().With("component", "discovery") }
```

In `List`, log scan failure and discovered count:

```go
func (s *service) List(ctx context.Context) ([]Instance, error) {
	results, err := s.scan()
	if err != nil {
		logger().Error("app scan failed", "err", err)
		return nil, err
	}
	// ... existing enrich fan-out unchanged ...
	wg.Wait()
	sort.SliceStable(out, func(a, b int) bool { return out[a].AppID < out[b].AppID })
	logger().Info("discovered Dapr apps", "count", len(out))
	return out, nil
}
```

In `Get`, log scan failure:

```go
func (s *service) Get(ctx context.Context, appID string) (Instance, error) {
	results, err := s.scan()
	if err != nil {
		logger().Error("app scan failed", "err", err)
		return Instance{}, err
	}
	// ... unchanged ...
}
```

In `enrich`, log missing metadata (WARN):

```go
	md, err := FetchMetadata(ctx, s.client, r.HTTPPort)
	if err != nil {
		in.MetadataOK = false
		logger().Warn("app metadata unavailable", "appID", r.AppID, "httpPort", r.HTTPPort, "err", err)
		return in
	}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/discovery/ -v`
Expected: PASS (existing tests + new ones).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): log app scan, discovered count, missing metadata"
```

---

### Task 5: UI serving + SSE log-stream logs (`pkg/server`)

**Files:**
- Modify: `pkg/server/server.go` (`NewRouter`), `pkg/server/logs.go` (`logsHandler`)
- Test: `pkg/server/logs_test.go`

**Interfaces:**
- Consumes: `slog.Default()`.
- Produces: no new exported symbols; adds INFO/WARN logs for UI serving and SSE lifecycle.

- [ ] **Step 1: Write the failing test**

Add to `pkg/server/logs_test.go` (reuse existing test helpers/fakes in that file for building a `discovery.Service`; the assertion is on the captured log buffer):

```go
func TestLogsHandler_LogsSourceUnavailable(t *testing.T) {
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })

	// Use the existing fake discovery service in this test file that returns an
	// instance with empty DaprdLogPath/AppLogPath, so the handler hits the
	// "no log file" branch. (Mirror the setup already used by other tests here.)
	h := logsHandler(fakeAppsNoLogPath{})
	req := httptest.NewRequest(http.MethodGet, "/apps/demo/logs", nil)
	req = withURLParam(req, "appId", "demo") // helper already used in this package's tests
	rec := httptest.NewRecorder()
	h(rec, req)

	if !strings.Contains(buf.String(), "log stream source unavailable") {
		t.Fatalf("expected 'log stream source unavailable' WARN, got %q", buf.String())
	}
}
```

If the test file does not already have a `fakeAppsNoLogPath` and `withURLParam`, model them on the existing fakes/helpers in `logs_test.go` / `apps_test.go` (a `discovery.Service` whose `Get` returns `discovery.Instance{AppID: "demo"}` with empty log paths, and chi route-context injection). Add the imports `bytes`, `log/slog`, `strings`, `net/http/httptest` as needed.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/server/ -run TestLogsHandler_LogsSourceUnavailable -v`
Expected: FAIL — message not present.

- [ ] **Step 3: Add logging in `logsHandler`**

Add `"log/slog"` to the imports in `pkg/server/logs.go`. At the top of the returned handler func, derive a logger and instrument the branches:

```go
func logsHandler(svc discovery.Service) http.HandlerFunc {
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
		path := in.DaprdLogPath
		if req.URL.Query().Get("source") == "app" {
			source = "app"
			path = in.AppLogPath
		}
		if path == "" {
			log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path)
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no log file for this app/source"})
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming unsupported"})
			return
		}
		ch, err := logs.Tail(req.Context(), path, 200, 500*time.Millisecond)
		if err != nil {
			log.Warn("log stream source unavailable", "app", appID, "source", source, "path", path, "err", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
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
				_, _ = fmt.Fprintf(w, "data: %s\n\n", line)
				flusher.Flush()
			case <-req.Context().Done():
				return
			}
		}
	}
}
```

- [ ] **Step 4: Add the one-time "serving embedded UI" log in `NewRouter`**

Add `"log/slog"` to the imports in `pkg/server/server.go`. At the end of `NewRouter`, before `return r`:

```go
	slog.Default().With("component", "server").Info("serving embedded UI", "basePath", opts.BasePath)
	return r
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test ./pkg/server/ -v`
Expected: PASS (existing tests + new one).

- [ ] **Step 6: Commit**

```bash
git add pkg/server/server.go pkg/server/logs.go pkg/server/logs_test.go
git commit -m "feat(server): log UI serving and SSE log-stream lifecycle"
```

---

### Task 6: Purge / terminate / force-delete logs (`pkg/workflow/remove.go`)

**Files:**
- Modify: `pkg/workflow/remove.go` (`Remove`, `RemoveMany`, `forceDelete`)
- Test: `pkg/workflow/remove_test.go`

**Interfaces:**
- Consumes: `slog.Default()`.
- Produces: no new exported symbols; adds INFO/WARN/ERROR logs around removal.

- [ ] **Step 1: Write the failing test**

```go
package workflow

import (
	"bytes"
	"context"
	"log/slog"
	"strings"
	"testing"
)

func captureWFLogs(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&buf, &slog.HandlerOptions{Level: slog.LevelInfo})))
	t.Cleanup(func() { slog.SetDefault(old) })
	return &buf
}

func TestRemove_LogsForceUnavailableWhenNoStore(t *testing.T) {
	buf := captureWFLogs(t)
	r := NewRemover(nil, nil, "default") // nil store -> force delete unavailable
	res := r.Remove(context.Background(), RemoveTarget{
		AppID: "app1", InstanceID: "inst1", HTTPPort: 0, Healthy: false,
	}, true) // force=true and unhealthy -> MechForce
	if res.OK {
		t.Fatal("expected force delete to fail with no store")
	}
	out := buf.String()
	if !strings.Contains(out, "workflow removal requested") {
		t.Fatalf("expected request INFO, got %q", out)
	}
	if !strings.Contains(out, "workflow removal failed") {
		t.Fatalf("expected failure ERROR, got %q", out)
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test ./pkg/workflow/ -run TestRemove_LogsForceUnavailable -v`
Expected: FAIL — messages not present.

- [ ] **Step 3: Add logging in `Remove`, `RemoveMany`, `forceDelete`**

Add `"log/slog"` to the imports in `pkg/workflow/remove.go`. Instrument `Remove`:

```go
func (r *Remover) Remove(ctx context.Context, t RemoveTarget, force bool) RemoveResult {
	log := slog.Default().With("component", "workflow")
	mech := SelectMechanism(t.Status, t.Healthy && t.HTTPPort > 0, force)
	res := RemoveResult{InstanceID: t.InstanceID, Mechanism: mech}
	log.Info("workflow removal requested", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech), "force", force)
	var err error
	switch mech {
	case MechPurge:
		err = r.purge(ctx, t)
	case MechTerminateThenPurge:
		if err = r.terminate(ctx, t); err == nil {
			err = r.purge(ctx, t)
		}
	case MechForce:
		err = r.forceDelete(ctx, t)
	}
	if err != nil {
		res.Error = err.Error()
		log.Error("workflow removal failed", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech), "err", err)
		return res
	}
	res.OK = true
	log.Info("workflow removed", "app", t.AppID, "instance", t.InstanceID, "mechanism", string(mech))
	return res
}
```

Instrument `RemoveMany` with a summary:

```go
func (r *Remover) RemoveMany(ctx context.Context, targets []RemoveTarget, force bool) []RemoveResult {
	out := make([]RemoveResult, 0, len(targets))
	ok := 0
	for _, t := range targets {
		res := r.Remove(ctx, t, force)
		if res.OK {
			ok++
		}
		out = append(out, res)
	}
	slog.Default().With("component", "workflow").Info("bulk removal complete",
		"total", len(targets), "ok", ok, "failed", len(targets)-ok)
	return out
}
```

Add the specific WARN in `forceDelete`'s no-store guard (in addition to returning the error, which `Remove` will log as ERROR):

```go
func (r *Remover) forceDelete(ctx context.Context, t RemoveTarget) error {
	if r.store == nil {
		slog.Default().With("component", "workflow").Warn("force delete unavailable", "app", t.AppID, "instance", t.InstanceID)
		return fmt.Errorf("force delete unavailable: no state store")
	}
	// ... unchanged ...
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test ./pkg/workflow/ -v`
Expected: PASS (existing tests + new one).

- [ ] **Step 5: Commit**

```bash
git add pkg/workflow/remove.go pkg/workflow/remove_test.go
git commit -m "feat(workflow): log removal requests, results, and force-delete guard"
```

---

### Task 7: Document `--verbose` and troubleshooting (`README.md`)

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the `--verbose` flag (Task 2).
- Produces: user-facing documentation only.

- [ ] **Step 1: Add a flag entry and a troubleshooting note**

In the flags/usage section of `README.md`, add a row/line for `--verbose`:

```markdown
| `--verbose` | Enable diagnostic logging to stderr (server startup, app discovery, state-store connection, log streams, and workflow purge/force-delete). Off by default. |
```

Add a short "Troubleshooting" subsection:

```markdown
## Troubleshooting

If the dashboard does not behave as expected, run it with `--verbose` to print
diagnostic logs to stderr:

    dev-dashboard --verbose

Logs are grouped by `component=` (server, discovery, statestore, workflow) and
use levels INFO (normal milestones), WARN (degraded but still working, e.g. a
state store that failed to initialise), and ERROR (an operation failed, e.g. the
server could not bind its port). Without `--verbose`, no diagnostic logs are
emitted.
```

(Match the exact table/section style already present in `README.md`; if the flags are documented as a bullet list rather than a table, add a bullet instead of a table row.)

- [ ] **Step 2: Verify the build and full test suite**

Run: `go build ./... && go test ./...`
Expected: build succeeds; all tests pass.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: document --verbose flag and troubleshooting"
```

---

## Final verification

- [ ] Run `go build ./...` — no errors.
- [ ] Run `go test ./...` — all pass.
- [ ] Manual smoke: `go run . --verbose` shows `component=server msg="server listening"` on stderr; `go run .` (no flag) shows none of the slog lines (only the existing `dev-dashboard … → url` stdout line).
