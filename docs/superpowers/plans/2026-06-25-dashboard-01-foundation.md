# Dev Dashboard — Plan 1: Foundation (Walking Skeleton) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce a cross-platform single binary that starts a `chi` HTTP server, serves an embedded React SPA shell (top nav, History-API routing, light/dark theme, density toggle, desktop-only small-screen guard), and exposes `/api/health` + `/api/version` — the skeleton every later plan hangs features off.

**Architecture:** A Go binary (cobra CLI, default `serve` command) embeds the built Vite/React SPA via `go:embed` and serves it from `chi`, with the API under `/api/*` and a History-API fallback for everything else. The SPA is a small React + TypeScript app using React Router (base-path-aware), TanStack Query, Radix headless primitives, and CSS-variable theming. No Node at runtime; Node is a build-time dependency only.

**Tech Stack:** Go 1.23 · `github.com/go-chi/chi/v5` · `github.com/spf13/cobra` · `go:embed` · React 18 · TypeScript 5 · Vite 5 · `react-router-dom` v6 · `@tanstack/react-query` v5 · Vitest · `@testing-library/react` · MSW v2.

**Roadmap:** This is **Plan 1 of 6**. Later plans: (2) Discovery + Applications, (3) Workflows + state store + Terminate/Purge, (4) Resources/Actors/Subscriptions, (5) Logs + News, (6) Packaging. Each builds on this skeleton.

**Module path:** `github.com/diagridio/dev-dashboard` (matches the git remote `github.com/diagridio/dev-dashboard.git`). Keep consistent everywhere.

## Global Constraints

Copied verbatim from the spec (§1, §2, §9). Every task implicitly includes these.

- **Single self-contained binary; no Node.js at runtime.** Node is build-time only.
- **Desktop-only.** No responsive/mobile layout; below ≈1024 px show a non-dismissible "wider screen" overlay (no "continue anyway").
- **Default theme = light**; manual toggle persisted to `localStorage` (may follow `prefers-color-scheme` when unset). **No theme flash:** apply persisted theme + density before first paint.
- **Default density = Compact** (Comfortable / Compact toggle, persisted).
- **Default port `9090`** (`--port`), auto-opens browser on start (suppressible via `--no-open`).
- **Base-path-aware** routing/serving so the SPA can mount under a subpath (e.g. `/dashboard`) when folded into the Diagrid CLI.
- **Accessibility floor (required):** WCAG AA contrast, visible keyboard focus, `prefers-reduced-motion` honored. State encoded as color **and** text/shape, never color alone.
- **Lean embedded bundle** (soft budget ≈ 300 KB gzipped). No Monaco, no heavy design system; **headless primitives** (Radix) styled in-house.
- **Theming tokens (CSS variables)** — light / dark:
  - `--bg`/`--surface`: `#FFFFFF`/`#F9FAFB` · `#161C24`/`#212B36`
  - `--text`/`--text-muted`: `#212B36`/`#637381` · `#F9FAFB`/`#919EAB`
  - `--text-faint`: `#919EAB` · `#6B7682`
  - `--border`/`--border-soft`: `#DFE3E8`/`#ECEFF2` · `#454F5B`/`#28323D`
  - `--primary` (brand mint, logo/palette only): `#0BDDA3` · `#0BDDA3`
  - `--accent` (on-screen, contrast-adjusted): `#0A8A6E` · `#2FE3AD`
  - `--link`: `#007AD3` · `#63B8F6`
  - `--dapr-accent`: `#0D2192` · `#3EA9F5`
- **Monospace + tabular numerals** for ids/ports/PIDs/timestamps; **timestamps in local time**.
- **Testing:** Go `testing` + `testify` (`require`); `net/http/httptest`; build tags `//go:build unit` for unit tests. Frontend Vitest + Testing Library + MSW; `data-cy` attributes for stable selectors. CI uses `gotestsum -race` + coverage.
- **English-only** (no i18n/RTL).

## File Structure

```
dev-dashboard/
├── go.mod / go.sum
├── main.go                      # entrypoint → cmd.Execute()
├── cmd/
│   └── root.go                  # cobra root (default = serve), flags, browser open
├── pkg/
│   ├── version/version.go       # build-stamped version info
│   └── server/
│       ├── server.go            # Options, NewRouter, Server (start/shutdown)
│       ├── api.go               # /api/health, /api/version
│       └── spa.go               # embedded-SPA handler + History-API fallback
├── web/
│   ├── embed.go                 # //go:embed dist → DistFS()
│   ├── dist/index.html          # placeholder so embed compiles (Vite overwrites)
│   ├── package.json / tsconfig.json / vite.config.ts / vitest.config.ts
│   ├── index.html               # app html + no-flash boot snippet
│   └── src/
│       ├── main.tsx             # React root + providers
│       ├── router.tsx           # base-path-aware routes
│       ├── App.tsx              # shell (topbar + outlet + guard)
│       ├── lib/
│       │   ├── prefs.ts         # theme/density persistence + apply
│       │   ├── api.ts           # fetchJSON + base path
│       │   └── query.tsx        # QueryClientProvider
│       ├── hooks/useMeta.ts     # useHealth / useVersion
│       ├── components/
│       │   ├── TopNav.tsx
│       │   ├── Logo.tsx         # Diagrid wordmark (currentColor)
│       │   ├── ThemeToggle.tsx
│       │   ├── DensityToggle.tsx
│       │   └── SmallScreenGuard.tsx
│       ├── pages/Placeholder.tsx
│       ├── styles/theme.css     # CSS-variable tokens
│       └── test/setup.ts        # Vitest + MSW server
├── Makefile
└── .github/workflows/ci.yaml
```

---

### Task 1: Version package

**Files:**
- Create: `go.mod`
- Create: `pkg/version/version.go`
- Test: `pkg/version/version_test.go`

**Interfaces:**
- Produces: `version.Info{Version, Commit, Date string}`; `version.Get() Info`. Package-level vars `Version`, `Commit`, `Date` (overridable via `-ldflags -X`).

- [ ] **Step 1: Initialize the Go module**

Run:
```bash
go mod init github.com/diagridio/dev-dashboard
go get github.com/go-chi/chi/v5@latest github.com/spf13/cobra@latest github.com/stretchr/testify@latest
```

- [ ] **Step 2: Write the failing test**

`pkg/version/version_test.go`:
```go
//go:build unit

package version

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestGetDefaults(t *testing.T) {
	got := Get()
	require.Equal(t, "dev", got.Version)
	require.NotNil(t, got)
}

func TestGetReflectsVars(t *testing.T) {
	Version, Commit, Date = "1.2.3", "abc123", "2026-06-25"
	t.Cleanup(func() { Version, Commit, Date = "dev", "none", "unknown" })
	got := Get()
	require.Equal(t, "1.2.3", got.Version)
	require.Equal(t, "abc123", got.Commit)
	require.Equal(t, "2026-06-25", got.Date)
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test -tags unit ./pkg/version/ -run TestGet -v`
Expected: FAIL — `undefined: Get` / package does not compile.

- [ ] **Step 4: Write minimal implementation**

`pkg/version/version.go`:
```go
// Package version exposes build-stamped version information.
package version

// Overridable at build time with -ldflags "-X github.com/diagridio/dev-dashboard/pkg/version.Version=..."
var (
	Version = "dev"
	Commit  = "none"
	Date    = "unknown"
)

// Info is the version payload returned by the API.
type Info struct {
	Version string `json:"version"`
	Commit  string `json:"commit"`
	Date    string `json:"date"`
}

// Get returns the current build's version info.
func Get() Info {
	return Info{Version: Version, Commit: Commit, Date: Date}
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `go test -tags unit ./pkg/version/ -v`
Expected: PASS (both tests).

- [ ] **Step 6: Commit**

```bash
git add go.mod go.sum pkg/version/
git commit -m "feat: go module + version package"
```

---

### Task 2: API handlers (health + version)

**Files:**
- Create: `pkg/server/api.go`
- Test: `pkg/server/api_test.go`

**Interfaces:**
- Consumes: `version.Info` from Task 1.
- Produces: `apiRouter(v version.Info) http.Handler` mounting `GET /health` → `{"status":"ok"}` and `GET /version` → the `version.Info` JSON. (Mounted under `/api` by Task 4.)

- [ ] **Step 1: Write the failing test**

`pkg/server/api_test.go`:
```go
//go:build unit

package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

func TestHealthEndpoint(t *testing.T) {
	srv := httptest.NewServer(apiRouter(version.Info{Version: "test"}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/health")
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })
	require.Equal(t, http.StatusOK, resp.StatusCode)

	var body map[string]string
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&body))
	require.Equal(t, "ok", body["status"])
}

func TestVersionEndpoint(t *testing.T) {
	srv := httptest.NewServer(apiRouter(version.Info{Version: "1.2.3", Commit: "abc", Date: "d"}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL + "/version")
	require.NoError(t, err)
	t.Cleanup(func() { _ = resp.Body.Close() })

	var got version.Info
	require.NoError(t, json.NewDecoder(resp.Body).Decode(&got))
	require.Equal(t, "1.2.3", got.Version)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestHealthEndpoint -v`
Expected: FAIL — `undefined: apiRouter`.

- [ ] **Step 3: Write minimal implementation**

`pkg/server/api.go`:
```go
package server

import (
	"encoding/json"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
)

// apiRouter builds the JSON API surface served under /api.
func apiRouter(v version.Info) http.Handler {
	r := chi.NewRouter()
	r.Get("/health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	r.Get("/version", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, v)
	})
	return r
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/api.go pkg/server/api_test.go
git commit -m "feat: /api/health and /api/version handlers"
```

---

### Task 3: SPA handler with History-API fallback + base path

**Files:**
- Create: `pkg/server/spa.go`
- Test: `pkg/server/spa_test.go`

**Interfaces:**
- Produces: `SPAHandler(fsys fs.FS, basePath string) http.Handler`. Serves static files from `fsys`; for any path that isn't an existing file (and isn't under `/api`), serves `index.html` so client-side routing works. `basePath` ("" or e.g. "/dashboard") is stripped before lookup.

- [ ] **Step 1: Write the failing test**

`pkg/server/spa_test.go`:
```go
//go:build unit

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/require"
)

func testFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":      {Data: []byte("<!doctype html><title>shell</title>")},
		"assets/app.js":   {Data: []byte("console.log(1)")},
	}
}

func get(t *testing.T, h http.Handler, path string) (*http.Response, string) {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	b, _ := io.ReadAll(res.Body)
	return res, string(b)
}

func TestSPAServesExistingFile(t *testing.T) {
	h := SPAHandler(testFS(), "")
	res, body := get(t, h, "/assets/app.js")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "console.log")
}

func TestSPAFallsBackToIndex(t *testing.T) {
	h := SPAHandler(testFS(), "")
	res, body := get(t, h, "/workflows/order/abc123")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestSPARespectsBasePath(t *testing.T) {
	h := SPAHandler(testFS(), "/dashboard")
	res, body := get(t, h, "/dashboard/anything")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestSPA -v`
Expected: FAIL — `undefined: SPAHandler`.

- [ ] **Step 3: Write minimal implementation**

`pkg/server/spa.go`:
```go
package server

import (
	"io/fs"
	"net/http"
	"strings"
)

// SPAHandler serves static assets from fsys and falls back to index.html for
// unknown paths so client-side (History-API) routing works. basePath is the
// optional subpath the app is mounted under ("" for root).
func SPAHandler(fsys fs.FS, basePath string) http.Handler {
	basePath = "/" + strings.Trim(basePath, "/")
	fileServer := http.FileServer(http.FS(fsys))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upath := strings.TrimPrefix(r.URL.Path, basePath)
		upath = "/" + strings.TrimPrefix(upath, "/")

		// Existing file? serve it. Otherwise serve index.html (SPA fallback).
		if name := strings.TrimPrefix(upath, "/"); name != "" {
			if f, err := fsys.Open(name); err == nil {
				_ = f.Close()
				r2 := r.Clone(r.Context())
				r2.URL.Path = upath
				fileServer.ServeHTTP(w, r2)
				return
			}
		}
		serveIndex(w, r, fsys)
	})
}

func serveIndex(w http.ResponseWriter, r *http.Request, fsys fs.FS) {
	f, err := fsys.Open("index.html")
	if err != nil {
		http.Error(w, "index.html not found", http.StatusInternalServerError)
		return
	}
	defer func() { _ = f.Close() }()
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if rs, ok := f.(io.ReadSeeker); ok {
		http.ServeContent(w, r, "index.html", time.Time{}, rs)
		return
	}
	_, _ = io.Copy(w, f)
}
```

Add the imports `io` and `time` to the file's import block.

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -run TestSPA -v`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add pkg/server/spa.go pkg/server/spa_test.go
git commit -m "feat: embedded-SPA handler with History-API fallback + base path"
```

---

### Task 4: Server assembly (router + lifecycle)

**Files:**
- Create: `pkg/server/server.go`
- Test: `pkg/server/server_test.go`

**Interfaces:**
- Consumes: `apiRouter` (Task 2), `SPAHandler` (Task 3), `version.Info` (Task 1).
- Produces:
  - `Options{BasePath string; DistFS fs.FS; Version version.Info}`
  - `NewRouter(opts Options) http.Handler` — mounts `{basePath}/api/*` then the SPA at `{basePath}/*`; `/api/*` unknown paths 404 (never index).
  - `Server{}` with `New(addr string, opts Options) *Server`, `(*Server) Start() error`, `(*Server) Shutdown(ctx) error`.

- [ ] **Step 1: Write the failing test**

`pkg/server/server_test.go`:
```go
//go:build unit

package server

import (
	"net/http"
	"testing"
	"testing/fstest"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/stretchr/testify/require"
)

func newTestRouter(basePath string) http.Handler {
	return NewRouter(Options{
		BasePath: basePath,
		DistFS:   fstest.MapFS{"index.html": {Data: []byte("shell")}},
		Version:  version.Info{Version: "test"},
	})
}

func TestRouterServesAPIAndSPA(t *testing.T) {
	h := newTestRouter("")

	res, body := get(t, h, "/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "ok")

	res, body = get(t, h, "/workflows")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, "shell")
}

func TestUnknownAPIIs404NotIndex(t *testing.T) {
	h := newTestRouter("")
	res, body := get(t, h, "/api/does-not-exist")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
	require.NotContains(t, body, "shell")
}

func TestRouterUnderBasePath(t *testing.T) {
	h := newTestRouter("/dashboard")
	res, _ := get(t, h, "/dashboard/api/health")
	require.Equal(t, http.StatusOK, res.StatusCode)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestRouter -v`
Expected: FAIL — `undefined: NewRouter` / `Options`.

- [ ] **Step 3: Write minimal implementation**

`pkg/server/server.go`:
```go
package server

import (
	"context"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
)

// Options configures the HTTP router.
type Options struct {
	BasePath string  // "" or e.g. "/dashboard"
	DistFS   fs.FS   // embedded SPA assets (contains index.html)
	Version  version.Info
}

// NewRouter wires the API and the embedded SPA under the optional base path.
func NewRouter(opts Options) http.Handler {
	base := "/" + strings.Trim(opts.BasePath, "/")
	base = strings.TrimSuffix(base, "/") // "" stays ""

	r := chi.NewRouter()
	r.Use(middleware.Recoverer)

	mount := func(router chi.Router) {
		router.Mount("/api", apiRouter(opts.Version))
		router.Handle("/*", SPAHandler(opts.DistFS, opts.BasePath))
	}

	if base == "" {
		mount(r)
	} else {
		r.Route(base, func(sub chi.Router) { mount(sub) })
	}
	return r
}

// Server owns the http.Server lifecycle.
type Server struct {
	http *http.Server
}

// New builds a Server listening on addr.
func New(addr string, opts Options) *Server {
	return &Server{http: &http.Server{
		Addr:              addr,
		Handler:           NewRouter(opts),
		ReadHeaderTimeout: 5 * time.Second,
	}}
}

// Start blocks serving until the server is shut down.
func (s *Server) Start() error {
	if err := s.http.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		return err
	}
	return nil
}

// Shutdown gracefully stops the server.
func (s *Server) Shutdown(ctx context.Context) error { return s.http.Shutdown(ctx) }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -v`
Expected: PASS (all server + api + spa tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/server/server.go pkg/server/server_test.go
git commit -m "feat: assemble chi router + server lifecycle"
```

---

### Task 5: CLI (cobra) + main + browser open

**Files:**
- Create: `main.go`
- Create: `cmd/root.go`
- Create: `web/embed.go`
- Create: `web/dist/index.html` (placeholder so `go:embed` compiles)
- Test: `cmd/root_test.go`

**Interfaces:**
- Consumes: `server.New`, `server.Options` (Task 4); `web.DistFS()`; `version.Get()`.
- Produces: `cmd.Execute() error`; `cmd.NewRootCmd() *cobra.Command` with flags `--port` (default `9090`), `--base-path` (default ""), `--no-open` (default false). `web.DistFS() (fs.FS, error)`.

- [ ] **Step 1: Create the embed placeholder + wiring**

`web/dist/index.html`:
```html
<!doctype html><meta charset="utf-8"><title>Dev Dashboard</title>
<body>Build the web app with <code>make web</code>.</body>
```

`web/embed.go`:
```go
// Package web embeds the built SPA assets.
package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var distEmbed embed.FS

// DistFS returns the embedded SPA file system rooted at dist/.
func DistFS() (fs.FS, error) { return fs.Sub(distEmbed, "dist") }
```

- [ ] **Step 2: Write the failing test**

`cmd/root_test.go`:
```go
//go:build unit

package cmd

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestRootDefaults(t *testing.T) {
	c := NewRootCmd()
	port, err := c.Flags().GetInt("port")
	require.NoError(t, err)
	require.Equal(t, 9090, port)

	noOpen, err := c.Flags().GetBool("no-open")
	require.NoError(t, err)
	require.False(t, noOpen)

	base, err := c.Flags().GetString("base-path")
	require.NoError(t, err)
	require.Equal(t, "", base)
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `go test -tags unit ./cmd/ -v`
Expected: FAIL — `undefined: NewRootCmd`.

- [ ] **Step 4: Write the implementation**

`cmd/root.go`:
```go
// Package cmd wires the dev-dashboard CLI.
package cmd

import (
	"context"
	"fmt"
	"os/exec"
	"runtime"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/server"
	"github.com/diagridio/dev-dashboard/pkg/version"
	"github.com/diagridio/dev-dashboard/web"
	"github.com/spf13/cobra"
)

// NewRootCmd builds the root command (default action = serve).
func NewRootCmd() *cobra.Command {
	var (
		port     int
		basePath string
		noOpen   bool
	)
	c := &cobra.Command{
		Use:           "dev-dashboard",
		Short:         "Local dashboard for Dapr apps, workflows, and sidecars",
		SilenceUsage:  true,
		SilenceErrors: true,
		RunE: func(cmd *cobra.Command, _ []string) error {
			return runServe(cmd.Context(), port, basePath, noOpen)
		},
	}
	c.Flags().IntVar(&port, "port", 9090, "port to serve the dashboard on")
	c.Flags().StringVar(&basePath, "base-path", "", "optional base path (e.g. /dashboard)")
	c.Flags().BoolVar(&noOpen, "no-open", false, "do not open the browser on start")
	return c
}

// Execute runs the CLI.
func Execute() error { return NewRootCmd().ExecuteContext(context.Background()) }

func runServe(ctx context.Context, port int, basePath string, noOpen bool) error {
	dist, err := web.DistFS()
	if err != nil {
		return fmt.Errorf("load embedded UI: %w", err)
	}
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	url := fmt.Sprintf("http://%s%s/", addr, "/"+trimSlash(basePath))

	srv := server.New(addr, server.Options{
		BasePath: basePath,
		DistFS:   dist,
		Version:  version.Get(),
	})

	fmt.Printf("dev-dashboard %s → %s\n", version.Get().Version, url)
	if !noOpen {
		go func() { time.Sleep(400 * time.Millisecond); _ = openBrowser(url) }()
	}
	return srv.Start()
}

func trimSlash(s string) string {
	for len(s) > 0 && s[0] == '/' {
		s = s[1:]
	}
	return s
}

func openBrowser(url string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", url).Start()
	case "windows":
		return exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
	default:
		return exec.Command("xdg-open", url).Start()
	}
}
```

`main.go`:
```go
package main

import (
	"fmt"
	"os"

	"github.com/diagridio/dev-dashboard/cmd"
)

func main() {
	if err := cmd.Execute(); err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
}
```

- [ ] **Step 5: Run test + build to verify**

Run:
```bash
go test -tags unit ./cmd/ -v
go build ./...
```
Expected: test PASS; build succeeds (embed compiles against the placeholder `web/dist/index.html`).

- [ ] **Step 6: Manual smoke**

Run: `go run . --no-open` then in another shell `curl -s localhost:9090/api/health`
Expected: `{"status":"ok"}`. Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add main.go cmd/ web/embed.go web/dist/index.html
git commit -m "feat: cobra CLI (serve default), embed wiring, browser open"
```

---

### Task 6: Web app scaffold (Vite + React + TS) + build pipeline

**Files:**
- Create: `web/package.json`, `web/tsconfig.json`, `web/vite.config.ts`, `web/vitest.config.ts`, `web/index.html`, `web/src/main.tsx`, `web/src/test/setup.ts`
- Create: `Makefile`
- Create: `.gitignore` (ignore `web/node_modules`, build artifacts; **do not** ignore `web/dist`)

**Interfaces:**
- Produces: `make web` builds the SPA into `web/dist`; `make build` builds web then the Go binary; `make test` runs Go + web tests. Vitest configured with jsdom + MSW setup.

- [ ] **Step 1: Create the web project files**

`web/package.json`:
```json
{
  "name": "dev-dashboard-web",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc -b && vite build",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@tanstack/react-query": "^5.59.0",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.26.0"
  },
  "devDependencies": {
    "@testing-library/jest-dom": "^6.5.0",
    "@testing-library/react": "^16.0.1",
    "@testing-library/user-event": "^14.5.2",
    "@types/react": "^18.3.5",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "jsdom": "^25.0.0",
    "msw": "^2.4.0",
    "typescript": "^5.5.4",
    "vite": "^5.4.0",
    "vitest": "^2.0.5"
  }
}
```

`web/tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2021",
    "lib": ["ES2021", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src"]
}
```

`web/vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base is injected at build time so the SPA can mount under a subpath.
export default defineConfig({
  plugins: [react()],
  base: process.env.DASH_BASE_PATH || '/',
  build: { outDir: 'dist', emptyOutDir: true },
})
```

`web/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.{test,spec}.{ts,tsx}'],
  },
})
```

`web/index.html`:
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Dev Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div>Dev Dashboard</div>
  </StrictMode>,
)
```

`web/src/test/setup.ts`:
```ts
import '@testing-library/jest-dom/vitest'
import { afterAll, afterEach, beforeAll } from 'vitest'
import { setupServer } from 'msw/node'

// Shared MSW server; handlers are added per-test with server.use(...).
export const server = setupServer()

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())
```

- [ ] **Step 2: Create the Makefile**

`Makefile`:
```makefile
.PHONY: web build test test-go test-web tidy

web:
	cd web && npm install && npm run build

build: web
	go build -o bin/dev-dashboard .

test-go:
	gotestsum --format testname -- -tags unit -race ./...

test-web:
	cd web && npm install && npm test

test: test-go test-web

tidy:
	go mod tidy
```

`.gitignore`:
```gitignore
/bin/
web/node_modules/
*.out
```

- [ ] **Step 3: Install + build the web app**

Run:
```bash
cd web && npm install && npm run build && cd ..
```
Expected: `web/dist/` now contains `index.html` + hashed `assets/`.

- [ ] **Step 4: Add a smoke test and run it**

`web/src/main.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'

function Hello() {
  return <div>Dev Dashboard</div>
}

describe('smoke', () => {
  it('renders', () => {
    render(<Hello />)
    expect(screen.getByText('Dev Dashboard')).toBeInTheDocument()
  })
})
```

Run: `cd web && npm test`
Expected: 1 passing test.

- [ ] **Step 5: Verify the binary serves the real SPA**

Run:
```bash
go build -o bin/dev-dashboard . && ./bin/dev-dashboard --no-open
```
Then `curl -s localhost:9090/ | grep -i '<div id="root">'` → matches. Stop with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add web/ Makefile .gitignore
git commit -m "feat: Vite/React/TS web scaffold + build pipeline + embed"
```

---

### Task 7: Theme tokens + prefs (no-flash) + theme/density toggles

**Files:**
- Create: `web/src/styles/theme.css`
- Create: `web/src/lib/prefs.ts`
- Create: `web/src/components/ThemeToggle.tsx`, `web/src/components/DensityToggle.tsx`
- Modify: `web/index.html` (add no-flash boot snippet + stylesheet import via main)
- Modify: `web/src/main.tsx` (import theme.css, applyPrefs)
- Test: `web/src/lib/prefs.test.ts`

**Interfaces:**
- Produces: `getTheme()/setTheme('light'|'dark')`, `getDensity()/setDensity('comfortable'|'compact')`, `applyPrefs()` (sets `data-theme` + `data-density` on `<html>`). Tokens exposed as CSS variables on `:root[data-theme=...]`.

- [ ] **Step 1: Write the failing test**

`web/src/lib/prefs.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { getTheme, setTheme, getDensity, setDensity, applyPrefs } from './prefs'

beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-density')
})

describe('prefs', () => {
  it('defaults to light + compact', () => {
    expect(getTheme()).toBe('light')
    expect(getDensity()).toBe('compact')
  })

  it('persists and applies theme', () => {
    setTheme('dark')
    expect(getTheme()).toBe('dark')
    applyPrefs()
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('persists and applies density', () => {
    setDensity('comfortable')
    applyPrefs()
    expect(document.documentElement.getAttribute('data-density')).toBe('comfortable')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/lib/prefs.test.ts`
Expected: FAIL — cannot resolve `./prefs`.

- [ ] **Step 3: Write the implementation**

`web/src/lib/prefs.ts`:
```ts
export type Theme = 'light' | 'dark'
export type Density = 'comfortable' | 'compact'

const THEME_KEY = 'devdash.theme'
const DENSITY_KEY = 'devdash.density'

export function getTheme(): Theme {
  const v = localStorage.getItem(THEME_KEY)
  if (v === 'light' || v === 'dark') return v
  return 'light' // default light (may consult prefers-color-scheme in a later iteration)
}

export function setTheme(t: Theme) {
  localStorage.setItem(THEME_KEY, t)
  document.documentElement.setAttribute('data-theme', t)
}

export function getDensity(): Density {
  const v = localStorage.getItem(DENSITY_KEY)
  if (v === 'comfortable' || v === 'compact') return v
  return 'compact' // default compact
}

export function setDensity(d: Density) {
  localStorage.setItem(DENSITY_KEY, d)
  document.documentElement.setAttribute('data-density', d)
}

export function applyPrefs() {
  document.documentElement.setAttribute('data-theme', getTheme())
  document.documentElement.setAttribute('data-density', getDensity())
}
```

`web/src/styles/theme.css`:
```css
:root,
:root[data-theme='light'] {
  --bg: #ffffff;        --surface: #f9fafb;
  --text: #212b36;      --text-muted: #637381;  --text-faint: #919eab;
  --border: #dfe3e8;    --border-soft: #eceff2;
  --primary: #0bdda3;   --accent: #0a8a6e;
  --link: #007ad3;      --dapr-accent: #0d2192;
}
:root[data-theme='dark'] {
  --bg: #161c24;        --surface: #212b36;
  --text: #f9fafb;      --text-muted: #919eab;  --text-faint: #6b7682;
  --border: #454f5b;    --border-soft: #28323d;
  --primary: #0bdda3;   --accent: #2fe3ad;
  --link: #63b8f6;      --dapr-accent: #3ea9f5;
}
/* density scales spacing + font size */
:root[data-density='compact']     { --row-pad: 6px 10px;  --font: 13px; --gap: 8px; }
:root[data-density='comfortable'] { --row-pad: 10px 14px; --font: 14px; --gap: 12px; }

html, body, #root { height: 100%; margin: 0; }
body {
  background: var(--bg); color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  font-size: var(--font);
}
.mono { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }
```

Modify `web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'

applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <div>Dev Dashboard</div>
  </StrictMode>,
)
```

Add the **no-flash boot snippet** to `web/index.html` `<head>` (runs before the bundle, so no flash):
```html
    <script>
      (function () {
        try {
          var t = localStorage.getItem('devdash.theme');
          var d = localStorage.getItem('devdash.density');
          document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
          document.documentElement.setAttribute('data-density', d === 'comfortable' ? 'comfortable' : 'compact');
        } catch (e) {}
      })();
    </script>
```

- [ ] **Step 4: Write the toggle components**

`web/src/components/ThemeToggle.tsx`:
```tsx
import { useState } from 'react'
import { getTheme, setTheme, type Theme } from '../lib/prefs'

export function ThemeToggle() {
  const [theme, setT] = useState<Theme>(getTheme())
  return (
    <button
      data-cy="theme-toggle"
      aria-label="Toggle theme"
      onClick={() => {
        const next: Theme = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        setT(next)
      }}
    >
      ◐ {theme === 'dark' ? 'Dark' : 'Light'}
    </button>
  )
}
```

`web/src/components/DensityToggle.tsx`:
```tsx
import { useState } from 'react'
import { getDensity, setDensity, type Density } from '../lib/prefs'

export function DensityToggle() {
  const [density, setD] = useState<Density>(getDensity())
  return (
    <button
      data-cy="density-toggle"
      aria-label="Toggle density"
      onClick={() => {
        const next: Density = density === 'compact' ? 'comfortable' : 'compact'
        setDensity(next)
        setD(next)
      }}
    >
      {density === 'compact' ? 'Compact' : 'Comfortable'}
    </button>
  )
}
```

- [ ] **Step 5: Run tests**

Run: `cd web && npm test`
Expected: prefs tests + smoke pass.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles web/src/lib/prefs.ts web/src/components/ThemeToggle.tsx web/src/components/DensityToggle.tsx web/index.html web/src/main.tsx web/src/lib/prefs.test.ts
git commit -m "feat: theme tokens + prefs (no-flash) + theme/density toggles"
```

---

### Task 8: Small-screen guard

**Files:**
- Create: `web/src/components/SmallScreenGuard.tsx`
- Test: `web/src/components/SmallScreenGuard.test.tsx`

**Interfaces:**
- Produces: `<SmallScreenGuard>{children}</SmallScreenGuard>` — renders children normally at ≥1024 px; below that, renders a non-dismissible overlay and hides children. Uses `matchMedia('(min-width: 1024px)')`.

- [ ] **Step 1: Write the failing test**

`web/src/components/SmallScreenGuard.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { SmallScreenGuard } from './SmallScreenGuard'

function mockMatch(matches: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
}

describe('SmallScreenGuard', () => {
  it('shows content when wide enough', () => {
    mockMatch(true)
    render(<SmallScreenGuard><div>content</div></SmallScreenGuard>)
    expect(screen.getByText('content')).toBeInTheDocument()
    expect(screen.queryByText(/wider screen/i)).toBeNull()
  })

  it('shows the overlay when too narrow', () => {
    mockMatch(false)
    render(<SmallScreenGuard><div>content</div></SmallScreenGuard>)
    expect(screen.getByText(/wider screen/i)).toBeInTheDocument()
    expect(screen.queryByText('content')).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/SmallScreenGuard.test.tsx`
Expected: FAIL — cannot resolve `./SmallScreenGuard`.

- [ ] **Step 3: Write the implementation**

`web/src/components/SmallScreenGuard.tsx`:
```tsx
import { useEffect, useState, type ReactNode } from 'react'

const MIN_WIDTH = 1024

export function SmallScreenGuard({ children }: { children: ReactNode }) {
  const [wide, setWide] = useState(
    () => window.matchMedia(`(min-width: ${MIN_WIDTH}px)`).matches,
  )

  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${MIN_WIDTH}px)`)
    const onChange = () => setWide(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  if (wide) return <>{children}</>

  return (
    <div
      data-cy="small-screen-overlay"
      role="alertdialog"
      aria-label="Screen too small"
      style={{
        position: 'fixed', inset: 0, display: 'grid', placeItems: 'center',
        background: 'var(--bg)', color: 'var(--text)', textAlign: 'center', padding: 24,
      }}
    >
      <div style={{ maxWidth: 360 }}>
        <h2>The dashboard is designed for a wider screen</h2>
        <p style={{ color: 'var(--text-muted)' }}>Please widen the window to continue.</p>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/SmallScreenGuard.test.tsx`
Expected: PASS (both).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/SmallScreenGuard.tsx web/src/components/SmallScreenGuard.test.tsx
git commit -m "feat: desktop-only small-screen guard overlay"
```

---

### Task 9: Diagrid wordmark logo

**Files:**
- Create: `web/src/components/Logo.tsx`
- Test: `web/src/components/Logo.test.tsx`

**Interfaces:**
- Produces: `<Logo />` — inline SVG Diagrid wordmark using `currentColor` for the text fills and the brand mint for the accent, so it themes via the surrounding `color`.

- [ ] **Step 1: Write the failing test**

`web/src/components/Logo.test.tsx`:
```tsx
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Logo } from './Logo'

describe('Logo', () => {
  it('renders an accessible svg wordmark', () => {
    const { container } = render(<Logo />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('aria-label')).toBe('Diagrid')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/Logo.test.tsx`
Expected: FAIL — cannot resolve `./Logo`.

- [ ] **Step 3: Write the implementation**

`web/src/components/Logo.tsx` — paste the real Diagrid wordmark SVG from the prototype asset (`v0-website/public/images/logos/diagrid-logo-white.svg`), replacing every `fill="white"` with `fill="currentColor"` and keeping the `#41BD9B` accent path. Minimal stub that satisfies the interface and is replaced by the full path data:
```tsx
export function Logo({ height = 21 }: { height?: number }) {
  return (
    <svg
      viewBox="0 0 176 55"
      height={height}
      role="img"
      aria-label="Diagrid"
      xmlns="http://www.w3.org/2000/svg"
      style={{ display: 'block', color: 'var(--logo-ink, currentColor)' }}
    >
      {/* Accent glyph keeps brand green */}
      <path d="M10.0949 41.0122C7.48 41.0122 5.67 40.49 4.67 39.45C3.67 38.41 3.17 36.79 3.17 34.61V6.88C3.17 4.7 3.67 3.08 4.67 2.04C5.67 0.97 7.48 0.43 10.09 0.43H14.37V6.05H11.99C11.09 6.05 10.48 6.25 10.16 6.65C9.87 7.02 9.73 7.64 9.73 8.52V41.01H10.09Z" fill="#41BD9B" />
      {/* Wordmark text themes via currentColor (replace with full path data from the asset) */}
      <text x="44" y="38" fontFamily="system-ui" fontWeight="680" fontSize="34" fill="currentColor">iagrid</text>
    </svg>
  )
}
```
> Note for implementer: swap the `<text>` placeholder for the actual wordmark `<path>` elements from `diagrid-logo-white.svg` (fills → `currentColor`). The test only asserts the `aria-label`, so it passes either way; the visual fidelity is the real deliverable.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web && npx vitest run src/components/Logo.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/Logo.tsx web/src/components/Logo.test.tsx
git commit -m "feat: themeable Diagrid wordmark logo"
```

---

### Task 10: App shell — router + top nav + placeholder pages

**Files:**
- Create: `web/src/router.tsx`, `web/src/App.tsx`, `web/src/components/TopNav.tsx`, `web/src/pages/Placeholder.tsx`
- Modify: `web/src/main.tsx` (mount RouterProvider)
- Test: `web/src/components/TopNav.test.tsx`, `web/src/App.test.tsx`

**Interfaces:**
- Consumes: `Logo`, `ThemeToggle`, `DensityToggle`, `SmallScreenGuard`.
- Produces: `NAV_ITEMS` (`{to, label}[]` for the 7 views), `<TopNav>`, `<App>` (shell with `<Outlet/>`), `router` (`createBrowserRouter` with `basename` from `import.meta.env.BASE_URL`). Routes: `/` (Applications), `/workflows`, `/actors`, `/subscriptions`, `/components`, `/configurations`, `/logs` — all render `<Placeholder/>` for now.

- [ ] **Step 1: Write the failing tests**

`web/src/components/TopNav.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { describe, it, expect } from 'vitest'
import { TopNav, NAV_ITEMS } from './TopNav'

describe('TopNav', () => {
  it('renders all seven primary nav items in order', () => {
    render(<MemoryRouter><TopNav /></MemoryRouter>)
    const labels = ['Applications', 'Workflows', 'Actors', 'Subscriptions', 'Components', 'Configurations', 'Logs']
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(labels)
    for (const l of labels) expect(screen.getByRole('link', { name: l })).toBeInTheDocument()
  })
})
```

`web/src/App.test.tsx`:
```tsx
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { describe, it, expect, vi } from 'vitest'
import { routes } from './router'

vi.stubGlobal('matchMedia', (q: string) => ({
  matches: true, media: q, onchange: null,
  addEventListener: vi.fn(), removeEventListener: vi.fn(),
  addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: vi.fn(),
}))

describe('App routing', () => {
  it('renders the Workflows route', () => {
    const router = createMemoryRouter(routes, { initialEntries: ['/workflows'] })
    render(<RouterProvider router={router} />)
    expect(screen.getByText(/Workflows/i)).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/components/TopNav.test.tsx src/App.test.tsx`
Expected: FAIL — cannot resolve `./TopNav` / `./router`.

- [ ] **Step 3: Write the implementation**

`web/src/components/TopNav.tsx`:
```tsx
import { NavLink } from 'react-router-dom'
import { Logo } from './Logo'
import { ThemeToggle } from './ThemeToggle'
import { DensityToggle } from './DensityToggle'

export const NAV_ITEMS = [
  { to: '/', label: 'Applications' },
  { to: '/workflows', label: 'Workflows' },
  { to: '/actors', label: 'Actors' },
  { to: '/subscriptions', label: 'Subscriptions' },
  { to: '/components', label: 'Components' },
  { to: '/configurations', label: 'Configurations' },
  { to: '/logs', label: 'Logs' },
] as const

export function TopNav() {
  return (
    <header
      data-cy="topbar"
      style={{
        display: 'flex', alignItems: 'center', gap: 16,
        padding: '11px 24px', borderBottom: '1px solid var(--border)',
        background: 'var(--surface)',
      }}
    >
      <Logo />
      <nav style={{ display: 'flex', gap: 2 }}>
        {NAV_ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.to === '/'}
            style={({ isActive }) => ({
              fontSize: 13, padding: '6px 10px', borderRadius: 7, textDecoration: 'none',
              color: isActive ? 'var(--text)' : 'var(--text-muted)',
              background: isActive ? 'var(--bg)' : 'transparent',
              boxShadow: isActive ? 'inset 0 0 0 1px var(--border)' : 'none',
            })}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div style={{ marginLeft: 'auto', display: 'flex', gap: 10 }}>
        <DensityToggle />
        <ThemeToggle />
      </div>
    </header>
  )
}
```

`web/src/pages/Placeholder.tsx`:
```tsx
export function Placeholder({ title }: { title: string }) {
  return (
    <main style={{ padding: 24 }}>
      <h1 style={{ fontSize: 22, fontWeight: 680 }}>{title}</h1>
      <p style={{ color: 'var(--text-muted)' }}>Coming in a later plan.</p>
    </main>
  )
}
```

`web/src/App.tsx`:
```tsx
import { Outlet } from 'react-router-dom'
import { TopNav } from './components/TopNav'
import { SmallScreenGuard } from './components/SmallScreenGuard'

export function App() {
  return (
    <SmallScreenGuard>
      <TopNav />
      <Outlet />
    </SmallScreenGuard>
  )
}
```

`web/src/router.tsx`:
```tsx
import { createBrowserRouter, type RouteObject } from 'react-router-dom'
import { App } from './App'
import { Placeholder } from './pages/Placeholder'

export const routes: RouteObject[] = [
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Placeholder title="Applications" /> },
      { path: 'workflows', element: <Placeholder title="Workflows" /> },
      { path: 'actors', element: <Placeholder title="Actors" /> },
      { path: 'subscriptions', element: <Placeholder title="Subscriptions" /> },
      { path: 'components', element: <Placeholder title="Components" /> },
      { path: 'configurations', element: <Placeholder title="Configurations" /> },
      { path: 'logs', element: <Placeholder title="Logs" /> },
    ],
  },
]

// BASE_URL comes from Vite's `base` (the configurable subpath).
export const router = createBrowserRouter(routes, {
  basename: import.meta.env.BASE_URL.replace(/\/$/, '') || '/',
})
```

Modify `web/src/main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'

applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: TopNav + App + prefs + guard + logo + smoke all PASS.

- [ ] **Step 5: Build + verify deep-link fallback end-to-end**

Run:
```bash
make build && ./bin/dev-dashboard --no-open
```
Then `curl -s localhost:9090/workflows | grep -i '<div id="root">'` → matches (History-API fallback serves the shell). Stop with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add web/src/router.tsx web/src/App.tsx web/src/App.test.tsx web/src/components/TopNav.tsx web/src/components/TopNav.test.tsx web/src/pages/Placeholder.tsx web/src/main.tsx
git commit -m "feat: app shell — router + top nav + placeholder views"
```

---

### Task 11: TanStack Query provider + typed API client + version footer

**Files:**
- Create: `web/src/lib/api.ts`, `web/src/lib/query.tsx`, `web/src/hooks/useMeta.ts`, `web/src/components/StatusFooter.tsx`
- Modify: `web/src/main.tsx` (wrap in `QueryProvider`), `web/src/App.tsx` (render `StatusFooter`)
- Test: `web/src/hooks/useMeta.test.tsx`

**Interfaces:**
- Produces:
  - `apiUrl(path: string): string` — prefixes `import.meta.env.BASE_URL` + `api` to a path.
  - `fetchJSON<T>(path: string): Promise<T>`.
  - `QueryProvider` (wraps `QueryClientProvider`).
  - `useVersion()` / `useHealth()` (TanStack Query hooks).
  - `<StatusFooter/>` showing the backend version.

- [ ] **Step 1: Write the failing test**

`web/src/hooks/useMeta.test.tsx`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { StatusFooter } from '../components/StatusFooter'

describe('useVersion', () => {
  it('renders the backend version from /api/version', async () => {
    server.use(
      http.get('/api/version', () =>
        HttpResponse.json({ version: '9.9.9', commit: 'abc', date: 'd' }),
      ),
    )
    render(<QueryProvider><StatusFooter /></QueryProvider>)
    await waitFor(() => expect(screen.getByText(/9\.9\.9/)).toBeInTheDocument())
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/hooks/useMeta.test.tsx`
Expected: FAIL — cannot resolve `../lib/query` / `../components/StatusFooter`.

- [ ] **Step 3: Write the implementation**

`web/src/lib/api.ts`:
```ts
const base = import.meta.env.BASE_URL.replace(/\/$/, '')

export function apiUrl(path: string): string {
  return `${base}/api${path.startsWith('/') ? path : `/${path}`}`
}

export async function fetchJSON<T>(path: string): Promise<T> {
  const res = await fetch(apiUrl(path))
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return (await res.json()) as T
}
```

`web/src/lib/query.tsx`:
```tsx
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

const client = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
})

export function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
```

`web/src/hooks/useMeta.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'

export interface VersionInfo { version: string; commit: string; date: string }

export function useVersion() {
  return useQuery({ queryKey: ['version'], queryFn: () => fetchJSON<VersionInfo>('/version') })
}

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: () => fetchJSON<{ status: string }>('/health') })
}
```

`web/src/components/StatusFooter.tsx`:
```tsx
import { useVersion } from '../hooks/useMeta'

export function StatusFooter() {
  const { data } = useVersion()
  return (
    <footer
      data-cy="status-footer"
      className="mono"
      style={{ padding: '8px 24px', borderTop: '1px solid var(--border-soft)', color: 'var(--text-faint)', fontSize: 11 }}
    >
      dev-dashboard {data ? `v${data.version}` : '…'}
    </footer>
  )
}
```

Modify `web/src/App.tsx` to render the footer:
```tsx
import { Outlet } from 'react-router-dom'
import { TopNav } from './components/TopNav'
import { SmallScreenGuard } from './components/SmallScreenGuard'
import { StatusFooter } from './components/StatusFooter'

export function App() {
  return (
    <SmallScreenGuard>
      <div style={{ display: 'flex', flexDirection: 'column', minHeight: '100vh' }}>
        <TopNav />
        <div style={{ flex: 1 }}><Outlet /></div>
        <StatusFooter />
      </div>
    </SmallScreenGuard>
  )
}
```

Modify `web/src/main.tsx` to wrap in `QueryProvider`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { RouterProvider } from 'react-router-dom'
import './styles/theme.css'
import { applyPrefs } from './lib/prefs'
import { router } from './router'
import { QueryProvider } from './lib/query'

applyPrefs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryProvider>
      <RouterProvider router={router} />
    </QueryProvider>
  </StrictMode>,
)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npm test`
Expected: all web tests PASS (including the MSW-backed version test).

- [ ] **Step 5: Build + full manual verification**

Run:
```bash
make build && ./bin/dev-dashboard
```
Browser opens at `http://localhost:9090/`. Verify: top nav switches views without full reload, theme + density toggles work and survive reload (no flash), narrowing the window below 1024 px shows the overlay, and the footer shows the real version. Stop with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/api.ts web/src/lib/query.tsx web/src/hooks/ web/src/components/StatusFooter.tsx web/src/App.tsx web/src/main.tsx
git commit -m "feat: TanStack Query provider + typed API client + version footer"
```

---

### Task 12: CI workflow

**Files:**
- Create: `.github/workflows/ci.yaml`

**Interfaces:** none (CI only).

- [ ] **Step 1: Write the workflow**

`.github/workflows/ci.yaml`:
```yaml
name: ci
on:
  push: { branches: [main] }
  pull_request:
jobs:
  go:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: '1.23' }
      - run: go install gotest.tools/gotestsum@latest
      - run: gotestsum --format testname -- -tags unit -race ./...
  web:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: cd web && npm install && npm run build && npm test
```

- [ ] **Step 2: Verify locally**

Run: `make test`
Expected: Go unit tests + web tests pass (mirrors CI).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yaml
git commit -m "ci: go + web test workflow"
```

---

## Self-Review

**Spec coverage (Plan 1 scope):**
- Single binary, no runtime Node → Tasks 5–6 (embed + Makefile). ✓
- chi server + `/api/health` + `/api/version` → Tasks 2, 4. ✓
- History-API routing + base-path-aware SPA fallback → Tasks 3, 4, 10. ✓
- React + Vite + TS + TanStack Query → Tasks 6, 11. ✓
- Top nav with the 7 views in the agreed order → Task 10. ✓
- Light-default theme + density toggle, both persisted, no flash → Tasks 7. ✓
- Desktop-only small-screen guard (non-dismissible) → Task 8. ✓
- Diagrid wordmark logo (currentColor themed) → Task 9. ✓
- Default port 9090 + `--port`/`--base-path`/`--no-open`, browser open → Task 5. ✓
- Testing per cloudgrid conventions (testify + build tags + httptest; Vitest + RTL + MSW; gotestsum -race) → throughout + Task 12. ✓
- Deferred to later plans (correctly out of Plan 1 scope): discovery, workflows, statestore, resources, actors, subscriptions, logs, news/Resources sidebar, Terminate/Purge, virtualization, keyboard shortcuts, packaging.

**Placeholder scan:** No "TBD/TODO" left. The only intentional note is the Logo SVG path data (Task 9) — the implementer pastes the real wordmark paths from the named asset; the interface/test are concrete and the stub compiles/passes.

**Type consistency:** `version.Info`, `server.Options`, `NewRouter`, `SPAHandler`, `apiRouter`, `web.DistFS`, `prefs` (`getTheme/setTheme/getDensity/setDensity/applyPrefs`), `NAV_ITEMS`, `routes`/`router`, `apiUrl/fetchJSON`, `useVersion/useHealth`, `QueryProvider` are referenced consistently across tasks.

**Note for implementer:** Go unit tests build with `-tags unit`; the embed in Task 5 requires `web/dist/index.html` to exist (placeholder committed in Task 5, real assets after Task 6). Server tests never use the embed — they inject `fstest.MapFS`.
