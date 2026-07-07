# Datadog RUM Instrumentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Datadog RUM to the dev-dashboard front-end to track application startup, top-menu clicks, resource-panel clicks, and errors, with a working `DEVDASHBOARD_TELEMETRY_OPTOUT` env var opt-out.

**Architecture:** A front-end-only telemetry module (`web/src/lib/telemetry.ts`) wraps `@datadog/browser-rum`, dynamically imported only when enabled. The only backend change is the Go CLI reading `DEVDASHBOARD_TELEMETRY_OPTOUT` once at startup and injecting one boolean (`window.__DASH_TELEMETRY_ENABLED__`) into the served `index.html`. Route views use fixed per-route labels, never resolved URLs, so local identifiers (app ids, workflow instance ids) never reach Datadog.

**Tech Stack:** Go (chi router, cobra CLI), React + TypeScript + Vite, `@datadog/browser-rum` (npm), Vitest + Testing Library + MSW, `go test` with `//go:build unit` tags.

## Global Constraints

- Front-end only instrumentation. The only Go/backend change is reading the opt-out env var and threading one boolean to the browser — no Datadog APM/backend code.
- Opt-out env var: `DEVDASHBOARD_TELEMETRY_OPTOUT`. Read once at Go process start (restart required to change). Exact value `"true"` (case-insensitive) disables telemetry; anything else (including unset) leaves it enabled.
- When telemetry is disabled, `@datadog/browser-rum` must not be imported at all (not just left uninitialized).
- Datadog init config: `applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a'`, `clientToken: 'pub566ae9a25b52873b96a28f4075cf6825'`, `site: 'datadoghq.com'`, `service: 'dev-dashboard'`, `env: 'prod'`, `sessionSampleRate: 100`, `sessionReplaySampleRate: 0`, `trackUserInteractions: true`, `trackResources: true`, `trackLongTasks: true`, `defaultPrivacyLevel: 'mask'`, `trackViewsManually: true`.
- Route/view names come from a fixed `handle.rumView` label per route — never the resolved pathname or param values.
- Go unit tests are gated by `//go:build unit`; run with `go test -tags unit ./...`.
- Web tests run with `npm test` (`vitest run`) from `web/`.

---

### Task 1: Go — telemetry opt-out env var + startup console message

**Files:**
- Modify: `cmd/root.go`
- Test: `cmd/root_test.go`

**Interfaces:**
- Produces: `telemetryEnabled(getenv func(string) string) bool` — pure function, used by Task 2.

- [ ] **Step 1: Write the failing test**

Add to `cmd/root_test.go` (needs no new imports — `require` and `testing` are already imported):

```go
func TestTelemetryEnabled(t *testing.T) {
	cases := []struct {
		name string
		env  string
		want bool
	}{
		{"unset", "", true},
		{"true lowercase", "true", false},
		{"true uppercase", "TRUE", false},
		{"true mixed case", "True", false},
		{"false value", "false", true},
		{"other truthy-looking value", "1", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := telemetryEnabled(func(string) string { return tc.env })
			require.Equal(t, tc.want, got)
		})
	}
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd/... -run TestTelemetryEnabled -v`
Expected: FAIL with `undefined: telemetryEnabled`

- [ ] **Step 3: Write minimal implementation**

In `cmd/root.go`, add `"strings"` to the import block (alphabetical order among the standard-library imports):

```go
import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/containerruntime"
	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logging"
	"github.com/diagridio/dev-dashboard/pkg/metadata"
	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/web"
	"github.com/spf13/cobra"
)
```

Add this function near the bottom of `cmd/root.go` (e.g. right after `runServe`, before `trimSlash`):

```go
// telemetryEnabled reports whether RUM telemetry should run, based on the
// DEVDASHBOARD_TELEMETRY_OPTOUT env var. Read once at process start (via
// getenv) — restart the dashboard for a changed value to take effect.
func telemetryEnabled(getenv func(string) string) bool {
	return !strings.EqualFold(getenv("DEVDASHBOARD_TELEMETRY_OPTOUT"), "true")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./cmd/... -run TestTelemetryEnabled -v`
Expected: PASS (all 6 subtests)

- [ ] **Step 5: Wire the console message into `runServe`**

In `cmd/root.go`, inside `runServe`, compute the flag right before building `opts` (before the `assembleOptions` call), and print the message right after the existing `fmt.Printf("dev-dashboard %s → %s\n", ...)` line:

```go
	telemetry := telemetryEnabled(os.Getenv)
	opts, closers := assembleOptions(ctx, serveDeps{
		BasePath:       basePath,
		StateStorePath: stateStore,
		Namespace:      namespace,
		Apps: discovery.New(
			discovery.Merge(discovery.StandaloneScanner(), composeSrc.Scanner()),
			&http.Client{Timeout: 2 * time.Second}),
		HomeDir:          home,
		HTTPClient:       &http.Client{Timeout: 10 * time.Second},
		ComposeEnv:       composeSrc.Env,
		ContainerLogs:    containerLogStream(crtRunner),
		TelemetryEnabled: telemetry,
	}, dist)
	for _, close := range closers {
		close := close
		defer func() { _ = close() }()
	}

	srv := server.New(addr, opts)

	fmt.Printf("dev-dashboard %s → %s\n", version.Get().Version, url)
	if telemetry {
		fmt.Println("Anonymous usage telemetry is enabled. Set DEVDASHBOARD_TELEMETRY_OPTOUT=true to disable (restart required).")
	} else {
		fmt.Println("Anonymous usage telemetry is disabled (DEVDASHBOARD_TELEMETRY_OPTOUT=true).")
	}
```

This references `serveDeps.TelemetryEnabled` and `server.Options` implicitly via `assembleOptions` — both are added in Task 2, so this step is completed together with Task 2's Step 3 (the code won't compile until then). Leave this edit in place; proceed straight to Task 2.

- [ ] **Step 6: Commit** (after Task 2 makes this compile — see Task 2's final commit step, which includes this file)

---

### Task 2: Go — thread `TelemetryEnabled` through `serveDeps` and `server.Options`

**Files:**
- Modify: `cmd/serve.go`
- Modify: `pkg/server/server.go`
- Test: `cmd/serve_test.go`

**Interfaces:**
- Consumes: `telemetryEnabled` (Task 1, already computed as `telemetry` in `runServe`).
- Produces: `serveDeps.TelemetryEnabled bool`, `server.Options.TelemetryEnabled bool` — consumed by Task 3.

- [ ] **Step 1: Write the failing test**

Add to `cmd/serve_test.go`:

```go
func TestAssembleOptions_TelemetryEnabledPassedThrough(t *testing.T) {
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Namespace:        "default",
		Apps:             emptyApps{},
		HomeDir:          "",
		HTTPClient:       &http.Client{Timeout: time.Second},
		TelemetryEnabled: true,
	}, fstest.MapFS{})
	t.Cleanup(func() {
		for _, c := range closers {
			_ = c()
		}
	})

	require.True(t, opts.TelemetryEnabled)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./cmd/... -run TestAssembleOptions_TelemetryEnabledPassedThrough -v`
Expected: FAIL with `unknown field TelemetryEnabled in struct literal of type serveDeps`

- [ ] **Step 3: Write minimal implementation**

In `cmd/serve.go`, add the field to `serveDeps`:

```go
type serveDeps struct {
	BasePath       string
	StateStorePath string // explicit component YAML; "" means auto-detect
	Namespace      string
	Apps           discovery.Service
	HomeDir        string
	HTTPClient     *http.Client // workflow HTTP client (remover/purge)
	// ComposeEnv returns the compose endpoint/mount context from the last
	// compose scan; nil when compose discovery is disabled (tests, no runtime).
	ComposeEnv func() discovery.ComposeEnv
	// ContainerLogs streams `docker logs -f` for a container id; nil when no
	// container runtime is available.
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
	// TelemetryEnabled reflects DEVDASHBOARD_TELEMETRY_OPTOUT, read once at
	// process start in runServe.
	TelemetryEnabled bool
}
```

And thread it into the returned `server.Options` in `assembleOptions`:

```go
	return server.Options{
		BasePath:         deps.BasePath,
		DistFS:           dist,
		Version:          version.Get(),
		Apps:             decorated,
		ContainerLogs:    deps.ContainerLogs,
		Backend:          rc,
		Stores:           rc,
		Resources:        resources.New(rc.Paths),
		News:             newsSvc,
		ControlPlane:     controlplane.New(),
		TelemetryEnabled: deps.TelemetryEnabled,
	}, []func() error{rc.Close}
```

In `pkg/server/server.go`, add the field to `Options`:

```go
type Options struct {
	BasePath string // "" or e.g. "/dashboard"
	DistFS   fs.FS  // embedded SPA assets (contains index.html)
	Version  version.Info
	Apps     discovery.Service
	// ContainerLogs streams container logs for compose-discovered apps.
	// nil disables container log streaming (404 for those apps).
	ContainerLogs func(ctx context.Context, containerID string) (<-chan string, error)
	Backend       WorkflowBackend
	Stores        StoreRegistry
	Resources     resources.Service
	News          news.Service
	ControlPlane  controlplane.Manager
	// TelemetryEnabled controls whether the served SPA loads Datadog RUM.
	TelemetryEnabled bool
}
```

(Leave `NewRouter`'s use of `SPAHandler(opts.DistFS, opts.BasePath)` untouched for now — Task 3 changes `SPAHandler`'s signature and updates this call site together.)

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./cmd/... -run TestAssembleOptions_TelemetryEnabledPassedThrough -v`
Expected: PASS

- [ ] **Step 5: Run the full cmd package unit suite**

Run: `go test -tags unit ./cmd/... -v`
Expected: PASS (including `TestTelemetryEnabled` from Task 1, now compiling)

- [ ] **Step 6: Commit**

```bash
git add cmd/root.go cmd/root_test.go cmd/serve.go cmd/serve_test.go pkg/server/server.go
git commit -s -m "feat: add DEVDASHBOARD_TELEMETRY_OPTOUT env var and thread it to server options"
```

---

### Task 3: Go — inject the telemetry flag into the served `index.html`

**Files:**
- Modify: `pkg/server/spa.go`
- Modify: `pkg/server/server.go`
- Test: `pkg/server/spa_test.go`
- Test: `pkg/server/server_test.go`

**Interfaces:**
- Consumes: `Options.TelemetryEnabled` (Task 2).
- Produces: `SPAHandler(fsys fs.FS, basePath string, telemetryEnabled bool) http.Handler` — signature change; injects `window.__DASH_TELEMETRY_ENABLED__` into `index.html`, consumed by the front-end in Task 4.

- [ ] **Step 1: Update the shared test fixture and existing call sites**

`pkg/server/spa_test.go`'s `testFS()` currently returns an `index.html` with no `<head>` tag, so there's nothing for the injection to target. Update it to include one (keeping the "shell" text existing tests already assert on):

```go
func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":    {Data: []byte("<!doctype html><head><title>shell</title></head>")},
		"assets/app.js": {Data: []byte("console.log(1)")},
	}
}
```

Update every existing `SPAHandler(testFS(), ...)` call in this file to pass a third `bool` argument (use `true`, since none of these tests care about the flag's value):

```go
func TestSPAServesExistingFile(t *testing.T) {
	h := SPAHandler(testFS(), "", true)
	res, body := get(t, h, "/assets/app.js")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "console.log")
}

func TestSPAFallsBackToIndex(t *testing.T) {
	h := SPAHandler(testFS(), "", true)
	res, body := get(t, h, "/workflows/order/abc123")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
	require.Equal(t, "no-store", res.Header.Get("Cache-Control"))
}

func TestSPARespectsBasePath(t *testing.T) {
	h := SPAHandler(testFS(), "/dashboard", true)
	res, body := get(t, h, "/dashboard/anything")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestSPADirectoryRequestDoesNotListContents(t *testing.T) {
	h := SPAHandler(testFS(), "", true)

	// An embedded directory must not produce an http.FileServer auto-index
	// (or a redirect toward one); it is a client-route miss → SPA shell.
	for _, p := range []string{"/assets", "/assets/"} {
		res, body := get(t, h, p)
		require.Equal(t, http.StatusOK, res.StatusCode, "path %s", p)
		require.Contains(t, body, "shell", "path %s", p)
		require.NotContains(t, body, "app.js", "path %s must not list directory contents", p)
	}
}

func TestSPAMissingAssetReturns404(t *testing.T) {
	h := SPAHandler(testFS(), "", true)
	res, body := get(t, h, "/assets/missing.js")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.NotContains(t, body, "shell")
}
```

- [ ] **Step 2: Write the new failing test**

Append to `pkg/server/spa_test.go`:

```go
func TestSPAInjectsTelemetryEnabledTrue(t *testing.T) {
	h := SPAHandler(testFS(), "", true)
	_, body := get(t, h, "/")
	require.Contains(t, body, "<script>window.__DASH_TELEMETRY_ENABLED__=true;</script>")
}

func TestSPAInjectsTelemetryEnabledFalse(t *testing.T) {
	h := SPAHandler(testFS(), "", false)
	_, body := get(t, h, "/")
	require.Contains(t, body, "<script>window.__DASH_TELEMETRY_ENABLED__=false;</script>")
}
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/server/... -run TestSPA -v`
Expected: build failure — `SPAHandler(testFS(), "")` missing an argument (existing calls) and `SPAHandler(testFS(), "", true)` too many arguments (new calls use the not-yet-updated 2-arg signature)

- [ ] **Step 4: Write minimal implementation**

In `pkg/server/spa.go`, add `"bytes"` to the imports and update `SPAHandler` / `serveIndex`:

```go
package server

import (
	"bytes"
	"io/fs"
	"net/http"
	"path"
	"strings"
)

// SPAHandler serves static assets from fsys and falls back to index.html for
// unknown paths so client-side (History-API) routing works. basePath is the
// optional subpath the app is mounted under ("" for root). telemetryEnabled
// is injected into the served index.html as window.__DASH_TELEMETRY_ENABLED__
// so the front-end knows whether to load Datadog RUM.
func SPAHandler(fsys fs.FS, basePath string, telemetryEnabled bool) http.Handler {
	basePath = "/" + strings.Trim(basePath, "/")
	fileServer := http.FileServer(http.FS(fsys))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(r.URL.Path, basePath)
		upath = "/" + strings.TrimPrefix(upath, "/")

		if name := strings.TrimPrefix(upath, "/"); name != "" {
			if f, err := fsys.Open(name); err == nil {
				info, statErr := f.Stat()
				_ = f.Close()
				// Serve regular files only: directories would get an
				// http.FileServer auto-index of embedded assets, so treat
				// them as a miss and use the SPA/404 fallback below.
				if statErr == nil && !info.IsDir() {
					r2 := r.Clone(r.Context())
					r2.URL.Path = upath
					fileServer.ServeHTTP(w, r2)
					return
				}
			}
		}
		// Missing path: only fall back to the SPA shell for client routes
		// (no file extension). Missing static assets must 404, not return HTML.
		if path.Ext(upath) != "" {
			http.NotFound(w, r)
			return
		}
		serveIndex(w, r, fsys, telemetryEnabled)
	})
}

func serveIndex(w http.ResponseWriter, _ *http.Request, fsys fs.FS, telemetryEnabled bool) {
	data, err := fs.ReadFile(fsys, "index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	flag := "false"
	if telemetryEnabled {
		flag = "true"
	}
	script := []byte("<script>window.__DASH_TELEMETRY_ENABLED__=" + flag + ";</script></head>")
	data = bytes.Replace(data, []byte("</head>"), script, 1)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
```

In `pkg/server/server.go`, update the `SPAHandler` call site inside `NewRouter`:

```go
	mount := func(router chi.Router) {
		router.Mount("/api", apiRouter(opts.Version, opts.Apps, opts.ContainerLogs, opts.Backend, opts.Stores, opts.Resources, opts.News, opts.ControlPlane))
		router.Handle("/*", SPAHandler(opts.DistFS, opts.BasePath, opts.TelemetryEnabled))
	}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/server/... -run TestSPA -v`
Expected: PASS (all `TestSPA*` tests, including the two new ones)

- [ ] **Step 6: Add a router-level test confirming the wiring end to end**

Append to `pkg/server/server_test.go`:

```go
func TestRouterInjectsTelemetryFlag(t *testing.T) {
	h := NewRouter(Options{
		DistFS:           fstest.MapFS{"index.html": {Data: []byte("<!doctype html><head></head>")}},
		Version:          version.Info{Version: "test"},
		Apps:             newFakeApps(),
		Backend:          newFakeBackend(fakeWF{}),
		TelemetryEnabled: true,
	})
	_, body := get(t, h, "/")
	require.Contains(t, body, "window.__DASH_TELEMETRY_ENABLED__=true;")
}
```

- [ ] **Step 7: Run the full server package unit suite**

Run: `go test -tags unit ./pkg/server/... -v`
Expected: PASS

- [ ] **Step 8: Run the full Go unit suite to catch any other call sites**

Run: `go test -tags unit ./... `
Expected: PASS (confirms `cmd/root.go`'s edit from Task 1 now compiles too)

- [ ] **Step 9: Commit**

```bash
git add pkg/server/spa.go pkg/server/spa_test.go pkg/server/server.go pkg/server/server_test.go
git commit -s -m "feat: inject telemetry-enabled flag into the served SPA shell"
```

---

### Task 4: Front-end — telemetry module

**Files:**
- Modify: `web/package.json`
- Create: `web/src/lib/telemetry.ts`
- Test: `web/src/lib/telemetry.test.tsx`

**Interfaces:**
- Consumes: `window.__DASH_TELEMETRY_ENABLED__` (Task 3).
- Produces: `initTelemetry(): Promise<void>`, `trackAction(name: string, context?: Record<string, unknown>): void`, `trackError(error: unknown, context?: Record<string, unknown>): void`, `trackView(name: string): void` — consumed by Tasks 5–8.

- [ ] **Step 1: Add the dependency**

In `web/package.json`, add to `dependencies` (keep alphabetical order):

```json
    "@datadog/browser-rum": "^7.5.0",
    "@tanstack/react-query": "^5.59.0",
```

Run: `cd web && npm install`
Expected: `package-lock.json` updates; `node_modules/@datadog/browser-rum` exists.

- [ ] **Step 2: Write the failing test**

Create `web/src/lib/telemetry.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest'

const initMock = vi.fn()
const addActionMock = vi.fn()
const addErrorMock = vi.fn()
const startViewMock = vi.fn()

vi.mock('@datadog/browser-rum', () => ({
  datadogRum: {
    init: initMock,
    addAction: addActionMock,
    addError: addErrorMock,
    startView: startViewMock,
  },
}))

beforeEach(() => {
  vi.resetModules()
  initMock.mockClear()
  addActionMock.mockClear()
  addErrorMock.mockClear()
  startViewMock.mockClear()
  delete (window as { __DASH_TELEMETRY_ENABLED__?: boolean }).__DASH_TELEMETRY_ENABLED__
})

describe('initTelemetry', () => {
  it('does not call datadogRum.init when the flag is unset', async () => {
    const { initTelemetry, trackAction } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).not.toHaveBeenCalled()
    trackAction('nav_click', { label: 'Applications' })
    expect(addActionMock).not.toHaveBeenCalled()
  })

  it('does not call datadogRum.init when the flag is false', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = false
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).not.toHaveBeenCalled()
  })

  it('calls datadogRum.init with the expected config when the flag is true', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry } = await import('./telemetry')
    await initTelemetry()
    expect(initMock).toHaveBeenCalledWith({
      applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a',
      clientToken: 'pub566ae9a25b52873b96a28f4075cf6825',
      site: 'datadoghq.com',
      service: 'dev-dashboard',
      env: 'prod',
      sessionSampleRate: 100,
      sessionReplaySampleRate: 0,
      trackUserInteractions: true,
      trackResources: true,
      trackLongTasks: true,
      defaultPrivacyLevel: 'mask',
      trackViewsManually: true,
    })
  })

  it('delegates trackAction/trackError/trackView to the RUM SDK once enabled', async () => {
    window.__DASH_TELEMETRY_ENABLED__ = true
    const { initTelemetry, trackAction, trackError, trackView } = await import('./telemetry')
    await initTelemetry()

    trackAction('nav_click', { label: 'Applications' })
    expect(addActionMock).toHaveBeenCalledWith('nav_click', { label: 'Applications' })

    trackError('boom')
    expect(addErrorMock).toHaveBeenCalledWith('boom', undefined)

    trackView('Applications')
    expect(startViewMock).toHaveBeenCalledWith('Applications')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/telemetry.test.tsx`
Expected: FAIL — `Failed to resolve import "./telemetry"`

- [ ] **Step 4: Write minimal implementation**

Create `web/src/lib/telemetry.ts`:

```ts
declare global {
  interface Window {
    __DASH_TELEMETRY_ENABLED__?: boolean
  }
}

type Rum = typeof import('@datadog/browser-rum').datadogRum

let rum: Rum | undefined

/** Loads and initializes Datadog RUM, but only when the server-injected flag
 * is exactly `true`. When disabled, the SDK is never imported. */
export async function initTelemetry(): Promise<void> {
  if (window.__DASH_TELEMETRY_ENABLED__ !== true) return
  const { datadogRum } = await import('@datadog/browser-rum')
  datadogRum.init({
    applicationId: '80d4832f-54ab-4091-bd92-0d816379b40a',
    clientToken: 'pub566ae9a25b52873b96a28f4075cf6825',
    site: 'datadoghq.com',
    service: 'dev-dashboard',
    env: 'prod',
    sessionSampleRate: 100,
    sessionReplaySampleRate: 0,
    trackUserInteractions: true,
    trackResources: true,
    trackLongTasks: true,
    defaultPrivacyLevel: 'mask',
    trackViewsManually: true,
  })
  rum = datadogRum
}

export function trackAction(name: string, context?: Record<string, unknown>): void {
  rum?.addAction(name, context)
}

export function trackError(error: unknown, context?: Record<string, unknown>): void {
  rum?.addError(error, context)
}

export function trackView(name: string): void {
  rum?.startView(name)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd web && npx vitest run src/lib/telemetry.test.tsx`
Expected: PASS (4 tests)

- [ ] **Step 6: Typecheck**

Run: `cd web && npx tsc -b`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add web/package.json web/package-lock.json web/src/lib/telemetry.ts web/src/lib/telemetry.test.tsx
git commit -s -m "feat: add front-end telemetry module wrapping Datadog RUM"
```

---

### Task 5: Front-end — startup + route-view tracking

**Files:**
- Modify: `web/src/main.tsx`
- Modify: `web/src/router.tsx`
- Modify: `web/src/App.tsx`
- Test: `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `initTelemetry`, `trackAction`, `trackView` from `web/src/lib/telemetry.ts` (Task 4).
- Produces: every route object gains `handle: { rumView: string }`, read by `App.tsx`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/App.test.tsx`, near the top (after the existing imports, before `beforeAll`):

```tsx
vi.mock('./lib/telemetry', () => ({ trackAction: vi.fn(), trackView: vi.fn() }))
```

Add `import { trackAction, trackView } from './lib/telemetry'` to the import block.

Add a new `describe` block at the end of the file:

```tsx
describe('RUM tracking', () => {
  it('tracks app_startup and the initial route view on mount', () => {
    renderApp()
    expect(trackAction).toHaveBeenCalledWith('app_startup')
    expect(trackView).toHaveBeenCalledWith('Applications')
  })

  it('tracks the matching view label when mounted on a different route', () => {
    const client = makeQueryClient()
    const router = createMemoryRouter(routes, { initialEntries: ['/workflows'], future: { v7_relativeSplatPath: true } })
    render(
      <QueryProvider client={client}>
        <RefreshProvider>
          <RouterProvider router={router} future={{ v7_startTransition: true }} />
        </RefreshProvider>
      </QueryProvider>,
    )
    expect(trackView).toHaveBeenCalledWith('Workflows')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/App.test.tsx -t "RUM tracking"`
Expected: FAIL — `trackAction`/`trackView` never called (routes have no `handle.rumView`, `App.tsx` doesn't call them yet)

- [ ] **Step 3: Add `handle.rumView` to every route**

In `web/src/router.tsx`, add a `handle` to each leaf route (the `children` array's inner list):

```tsx
        children: [
          { index: true, element: <Applications />, handle: { rumView: 'Applications' } },
          { path: 'apps/:appId', element: <AppDetail />, handle: { rumView: 'AppDetail' } },
          { path: 'workflows', element: <Workflows />, handle: { rumView: 'Workflows' } },
          { path: 'workflows/:appId/:instanceId', element: <WorkflowDetail />, handle: { rumView: 'WorkflowDetail' } },
          { path: 'actors', element: <Actors />, handle: { rumView: 'Actors' } },
          { path: 'subscriptions', element: <Subscriptions />, handle: { rumView: 'Subscriptions' } },
          { path: 'components/new', element: <ComponentBuilder />, handle: { rumView: 'ComponentBuilder' } },
          { path: 'components', element: <ResourceList kind="component" />, handle: { rumView: 'Components' } },
          { path: 'components/:name', element: <ResourceList kind="component" />, handle: { rumView: 'Components' } },
          { path: 'configurations', element: <ResourceList kind="configuration" />, handle: { rumView: 'Configurations' } },
          { path: 'configurations/:name', element: <ResourceList kind="configuration" />, handle: { rumView: 'Configurations' } },
          { path: 'resiliency', element: <Resiliency />, handle: { rumView: 'Resiliency' } },
          { path: 'resiliency/new', element: <ResiliencyBuilder />, handle: { rumView: 'ResiliencyBuilder' } },
          { path: 'control-plane', element: <ControlPlane />, handle: { rumView: 'ControlPlane' } },
          { path: 'logs', element: <Logs />, handle: { rumView: 'Logs' } },
        ],
```

- [ ] **Step 4: Wire tracking into `App.tsx`**

Replace the contents of `web/src/App.tsx`:

```tsx
import { useEffect, useState } from 'react'
import { Outlet, useMatches } from 'react-router-dom'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { TopNav } from './components/TopNav'
import { ResourcesSidebar } from './components/ResourcesSidebar'
import { getTheme, type Theme } from './lib/prefs'
import { safeGet } from './lib/safeStorage'
import { trackAction, trackView } from './lib/telemetry'

const SIDEBAR_COLLAPSED_KEY = 'devdash.sidebarCollapsed'

function getInitialCollapsed(): boolean {
  return safeGet(SIDEBAR_COLLAPSED_KEY) === 'true'
}

interface RouteHandle {
  rumView?: string
}

export function App() {
  const [theme, setTheme] = useState<Theme>(getTheme)
  const [collapsed, setCollapsed] = useState(getInitialCollapsed)
  const [hasNew, setHasNew] = useState(false)
  const matches = useMatches()

  const rumView = [...matches]
    .reverse()
    .map((m) => (m.handle as RouteHandle | undefined)?.rumView)
    .find((name) => name != null)

  useEffect(() => {
    trackAction('app_startup')
  }, [])

  useEffect(() => {
    if (rumView) trackView(rumView)
  }, [rumView])

  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : ''].filter(Boolean).join(' ')

  return (
    <SmallScreenGuard>
      <div className={appClass} data-theme={theme}>
        <TopNav theme={theme} onThemeChange={setTheme} />
        <ResourcesSidebar
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onHasNewChange={setHasNew}
        />
        <main className="body">
          <Outlet />
        </main>
      </div>
    </SmallScreenGuard>
  )
}
```

- [ ] **Step 5: Call `initTelemetry()` from `main.tsx`**

In `web/src/main.tsx`, add the import and call it before anything else runs:

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'
import { QueryProvider } from './lib/query'
import { RefreshProvider } from './lib/refresh'
import { initTelemetry } from './lib/telemetry'

void initTelemetry()
applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>
  </StrictMode>,
)
```

(`main.tsx` has no dedicated bootstrap test today — `main.test.tsx` is a standalone smoke test unrelated to this file's actual code — so this one-line addition isn't covered by a new test, consistent with the existing file.)

- [ ] **Step 6: Run test to verify it passes**

Run: `cd web && npx vitest run src/App.test.tsx`
Expected: PASS (all tests in the file, including the two new ones)

- [ ] **Step 7: Run the full web suite and typecheck**

Run: `cd web && npm test`
Expected: PASS

Run: `cd web && npx tsc -b`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add web/src/main.tsx web/src/router.tsx web/src/App.tsx web/src/App.test.tsx
git commit -s -m "feat: track application startup and route views via RUM"
```

---

### Task 6: Front-end — top-menu click tracking

**Files:**
- Modify: `web/src/components/TopNav.tsx`
- Test: `web/src/components/TopNav.test.tsx`

**Interfaces:**
- Consumes: `trackAction` from `web/src/lib/telemetry.ts` (Task 4).

- [ ] **Step 1: Write the failing test**

In `web/src/components/TopNav.test.tsx`, add `fireEvent` to the existing `@testing-library/react` import and add a mock + import right after the existing imports:

```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, afterEach } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { TopNav, NAV_ITEMS } from './TopNav'
import { RefreshProvider } from '../lib/refresh'
import { trackAction } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))
```

Add a new test inside the existing `describe('TopNav', ...)` block:

```tsx
  it('tracks nav_click with the item label when a nav link is clicked', () => {
    renderNav()
    fireEvent.click(screen.getByRole('link', { name: 'Workflows' }))
    expect(trackAction).toHaveBeenCalledWith('nav_click', { label: 'Workflows' })
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx -t "tracks nav_click"`
Expected: FAIL — `trackAction` not called

- [ ] **Step 3: Write minimal implementation**

In `web/src/components/TopNav.tsx`, add the import and the `onClick`:

```tsx
import { useEffect, useRef } from 'react'
import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { RefreshControl } from './RefreshControl'
import type { Theme } from '../lib/prefs'
import { trackAction } from '../lib/telemetry'
```

```tsx
      <nav className="nav" aria-label="Primary navigation">
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            className={({ isActive }) => (isActive ? 'active' : undefined)}
            onClick={() => trackAction('nav_click', { label: item.label })}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx
git commit -s -m "feat: track top-menu nav clicks via RUM"
```

---

### Task 7: Front-end — resource-panel click tracking

**Files:**
- Modify: `web/src/components/ResourcesSidebar.tsx`
- Test: `web/src/components/ResourcesSidebar.test.tsx`

**Interfaces:**
- Consumes: `trackAction` from `web/src/lib/telemetry.ts` (Task 4).

- [ ] **Step 1: Write the failing tests**

In `web/src/components/ResourcesSidebar.test.tsx`, add a mock + import after the existing imports:

```tsx
import { trackAction } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackAction: vi.fn() }))
```

Add a new `describe` block at the end of the file:

```tsx
describe('ResourcesSidebar telemetry', () => {
  it('tracks resource_click with section and label when a static link is clicked', () => {
    renderSidebar()
    fireEvent.click(screen.getByRole('link', { name: /Dapr Docs/ }))
    expect(trackAction).toHaveBeenCalledWith('resource_click', { section: 'Read', label: 'Dapr Docs' })
  })

  it('tracks resource_click for a news item, in addition to marking it seen', async () => {
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Blog A/ })
    fireEvent.click(link)
    expect(trackAction).toHaveBeenCalledWith('resource_click', { section: 'News', label: 'Blog A', kind: 'blog' })
    await waitFor(() => {
      expect(localStorage.getItem('devdash.newsSeen')).toBeTruthy()
    })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/ResourcesSidebar.test.tsx -t "telemetry"`
Expected: FAIL — `trackAction` not called

- [ ] **Step 3: Write minimal implementation**

In `web/src/components/ResourcesSidebar.tsx`, add the import:

```tsx
import { useCallback, useEffect, useState } from 'react'
import { useNews } from '../hooks/useNews'
import { newsUrls, getSeen, markSeen } from '../lib/newsSeen'
import { useVersion } from '../hooks/useMeta'
import type { NewsResponse, NewsItem } from '../types/logs'
import { trackAction } from '../lib/telemetry'
```

Update the `NewsSection` component's item link to also track the click:

```tsx
      {NEWS_SLOTS.map(({ key, label }) => {
        const item = news[key]
        if (!item) return null
        const subtitle = newsSubtitle(item, label)
        return (
          <a
            key={key}
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={() => {
              onMarkSeen()
              trackAction('resource_click', { section: 'News', label: item.title, kind: key })
            }}
            className="sblink"
          >
            <span className="col">
              <span className="txt">{item.title}</span>
              <span className="sub">{subtitle}</span>
            </span>
            <span className="ext">↗</span>
          </a>
        )
      })}
```

Update the static-section link rendering inside `ResourcesSidebar`:

```tsx
        {SECTIONS.map((section) => (
          <div key={section.heading} className="sbsection">
            <div className="sbtitle">{section.heading}</div>
            {section.links.map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="sblink"
                onClick={() => trackAction('resource_click', { section: section.heading, label: link.label })}
              >
                <span className="txt">{link.label}</span>
                <span className="ext">↗</span>
              </a>
            ))}
          </div>
        ))}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/components/ResourcesSidebar.test.tsx`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Commit**

```bash
git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx
git commit -s -m "feat: track resource-panel clicks via RUM"
```

---

### Task 8: Front-end — error tracking in the route error boundary

**Files:**
- Modify: `web/src/components/RouteError.tsx`
- Test: `web/src/components/RouteError.test.tsx`

**Interfaces:**
- Consumes: `trackError` from `web/src/lib/telemetry.ts` (Task 4).

- [ ] **Step 1: Write the failing test**

In `web/src/components/RouteError.test.tsx`, add a mock + import after the existing imports:

```tsx
import { trackError } from '../lib/telemetry'

vi.mock('../lib/telemetry', () => ({ trackError: vi.fn() }))
```

Add a new test inside the existing `describe('route error boundary', ...)` block:

```tsx
  it('reports the error to telemetry', () => {
    renderBombed()
    expect(trackError).toHaveBeenCalledWith(expect.any(Error))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/RouteError.test.tsx -t "reports the error"`
Expected: FAIL — `trackError` not called

- [ ] **Step 3: Write minimal implementation**

Replace the contents of `web/src/components/RouteError.tsx`:

```tsx
import { useEffect } from 'react'
import { Link, isRouteErrorResponse, useRouteError } from 'react-router-dom'
import { trackError } from '../lib/telemetry'

/**
 * Route-level error boundary. Rendered by react-router (via `errorElement`)
 * when a route element throws during render, so users get a recoverable page
 * instead of the raw "Unexpected Application Error" screen.
 */
export function RouteError() {
  const error = useRouteError()
  const message = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)

  useEffect(() => {
    trackError(error)
  }, [error])

  return (
    <div className="page">
      <div className="phead">
        <div>
          <h1>Something went wrong</h1>
          <div className="sub">The page hit an unexpected error while rendering</div>
        </div>
      </div>
      <div className="panel">
        <div className="ph">Error</div>
        <p className="err">{message}</p>
        <p className="muted">Reload the page, or go back to the applications list.</p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <Link className="btn ghost" to="/">
            Back to Applications
          </Link>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/RouteError.test.tsx`
Expected: PASS (all tests in the file)

- [ ] **Step 5: Run the full web suite and typecheck one more time**

Run: `cd web && npm test`
Expected: PASS

Run: `cd web && npx tsc -b`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add web/src/components/RouteError.tsx web/src/components/RouteError.test.tsx
git commit -s -m "feat: report route render errors to RUM"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`

**Interfaces:**
- None (documentation only).

- [ ] **Step 1: Add a Telemetry section**

In `README.md`, insert a new `## Telemetry` section right after the `## Troubleshooting` section (before `## Building from source`):

```markdown
## Telemetry

The dashboard sends anonymous usage telemetry (via Datadog RUM) to help us understand how
it's used: application startup, top navigation clicks, Resources-panel clicks, and front-end
errors. There is no session replay and no dashboard content is collected — page views are
tracked by a fixed page label (e.g. `Workflows`, `AppDetail`), never the resolved URL, so
local app/workflow identifiers never leave your machine.

To opt out, set `DEVDASHBOARD_TELEMETRY_OPTOUT=true` before starting the dashboard. This is
read once at startup, so restart the dashboard for the change to take effect:

```sh
DEVDASHBOARD_TELEMETRY_OPTOUT=true dev-dashboard
```
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -s -m "docs: document RUM telemetry and the opt-out env var"
```
