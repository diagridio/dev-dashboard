# Version-update Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tell dashboard users when a newer release exists — a first-line CLI startup notice and a clickable "Update available" indicator in the web Resources panel (expanded and collapsed).

**Architecture:** One shared backend service (`pkg/updatecheck`) resolves the latest GitHub release (reusing `selfupdate`'s resolver) and compares it to the running version with semver. The CLI calls it once at startup (with a spinner) and prints a notice; the HTTP server reuses the same instance to answer `GET /api/update-check`, which the SPA polls to drive the indicator.

**Tech Stack:** Go (cobra CLI, chi HTTP), `golang.org/x/mod/semver`, `github.com/briandowns/spinner`, `github.com/mattn/go-isatty` (all already in the module graph). React + TypeScript + Vite + TanStack Query; Vitest + MSW for web tests.

## Global Constraints

- **Go ≥ 1.26**, Node.js 20 — matching the repo.
- **Repo constant:** `diagridio/dev-dashboard`. **GitHub API base:** `https://api.github.com`. **Release URL:** `https://github.com/diagridio/dev-dashboard/releases/tag/<tag>`.
- **Notice copy (verbatim):**
  ```
  A new version of the Dapr Dev Dashboard is available: <current> → <latest>
  Run `dev-dashboard update` to upgrade.
  ```
- **Startup check timeout:** 2s. **Service cache TTL:** 1h positive, negative-cache capped at 5m.
- **`dev`/invalid-semver builds:** no spinner, no network call, no notice, no badge.
- **Fail silent:** offline / rate-limited / errored checks yield `UpdateAvailable: false`; never surfaced as an error.
- **No opt-out** (no env var, no flag).
- **Go build tags:** unit tests need `//go:build unit`; run with `go test -tags unit ./...`. Integration tests need `//go:build integration`.
- **Commits:** every commit uses `git commit -s` (DCO) and ends its message with the trailer `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Do not run any git command unless the user has explicitly authorized it in the session** (per the user's global instructions); if a Commit step is reached without that authorization, pause and ask.
- **Windows dev:** run Go tests with `go test -tags unit -race ./...`; web tests with `cd web; npm test`.

## File Structure

**Backend (new):**
- `pkg/updatecheck/updatecheck.go` — `Result`, `IsReleaseVersion`, `evaluate` (pure compare), `withV`.
- `pkg/updatecheck/service.go` — `Service` interface, caching `New`/`Check`.
- `pkg/updatecheck/updatecheck_test.go`, `pkg/updatecheck/service_test.go` — unit tests.
- `pkg/server/updatecheck.go` — `updateCheckRouter`.
- `pkg/server/updatecheck_test.go` — `fakeUpdateCheck` + endpoint test.

**Backend (modified):**
- `pkg/selfupdate/resolve.go`, `selfupdate.go`, `fetch_test.go` — export `ResolveLatest`.
- `pkg/server/server.go` — `Options.UpdateCheck` field; pass to `apiRouter`.
- `pkg/server/api.go` — `apiRouter` gains `updatecheck.Service` param; mounts `/update-check`.
- `pkg/server/api_test.go`, `statestores_test.go`, `workflows_test.go` — update `apiRouter(...)` call sites.
- `cmd/root.go` — build the service, announce at startup (spinner + notice), pass into deps.
- `cmd/serve.go` — `serveDeps.UpdateCheck`; wire into `assembleOptions`.
- `cmd/update_notice.go` (new) — `formatUpdateNotice`, `printUpdateNotice`, `maybeAnnounceUpdate`.
- `cmd/update_notice_test.go` (new), `cmd/serve_test.go` (add propagation test).

**Frontend (modified):**
- `web/src/hooks/useMeta.ts` — `UpdateInfo` + `useUpdateCheck`.
- `web/src/hooks/useMeta.test.tsx` — hook test.
- `web/src/components/ResourcesSidebar.tsx` — badge + collapsed indicator + `onUpdateAvailableChange` prop.
- `web/src/components/ResourcesSidebar.test.tsx` — badge/indicator tests + default mock.
- `web/src/App.tsx` — `update-available` class from a new state.
- `web/src/App.test.tsx` — default `/api/update-check` mock.
- `web/src/styles/theme.css` — badge + dot styling + collapsed rule.

**Docs (modified):** `README.md`, `ARCHITECTURE.md`.

---

## Task 1: Export `selfupdate.ResolveLatest`

Pure rename so `pkg/updatecheck` can reuse the GitHub latest-release resolver. No behavior change.

**Files:**
- Modify: `pkg/selfupdate/resolve.go:29-48`
- Modify: `pkg/selfupdate/selfupdate.go:68`
- Modify: `pkg/selfupdate/fetch_test.go:42,90`

**Interfaces:**
- Produces: `func ResolveLatest(ctx context.Context, client *http.Client, apiBase, repo string) (string, error)` — returns the latest release tag normalized with a leading `v` (e.g. `v1.3.0`).

- [ ] **Step 1: Rename the function and update its doc comment**

In `pkg/selfupdate/resolve.go`, change the comment and signature:

```go
// ResolveLatest queries the GitHub releases API for repo's latest tag_name and
// returns it normalized (with a leading "v"). The /releases/latest endpoint
// excludes prereleases by design, so this always resolves to the latest stable release.
func ResolveLatest(ctx context.Context, client *http.Client, apiBase, repo string) (string, error) {
```

(Leave the body unchanged.)

- [ ] **Step 2: Update the caller in `selfupdate.go`**

At `pkg/selfupdate/selfupdate.go:68`, change:

```go
		v, err := ResolveLatest(ctx, u.HTTP, u.APIBase, u.Repo)
```

- [ ] **Step 3: Update the test references**

In `pkg/selfupdate/fetch_test.go`, at both call sites (lines 42 and 90) change `resolveLatest(` to `ResolveLatest(`.

- [ ] **Step 4: Run the selfupdate tests to verify they pass**

Run: `go test -tags unit ./pkg/selfupdate/...`
Expected: PASS (all existing tests green).

- [ ] **Step 5: Commit**

```bash
git add pkg/selfupdate
git commit -s -m "refactor(selfupdate): export ResolveLatest for reuse"
```

---

## Task 2: `pkg/updatecheck` pure comparison logic

The version comparison and release-URL construction, with no network — fully unit-testable.

**Files:**
- Create: `pkg/updatecheck/updatecheck.go`
- Test: `pkg/updatecheck/updatecheck_test.go`

**Interfaces:**
- Produces:
  - `type Result struct { Current, Latest string; UpdateAvailable bool; ReleaseURL string }` (JSON tags `current`, `latest`, `updateAvailable`, `releaseUrl`).
  - `func IsReleaseVersion(v string) bool` — true when `v` is a valid semver (after adding a leading `v`); false for `dev`/empty/garbage.
  - `func evaluate(current, latest, repo string) Result` — pure comparison used by the service.

- [ ] **Step 1: Write the failing test**

Create `pkg/updatecheck/updatecheck_test.go`:

```go
//go:build unit

package updatecheck

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestIsReleaseVersion(t *testing.T) {
	require.True(t, IsReleaseVersion("1.2.0"))
	require.True(t, IsReleaseVersion("v1.2.0"))
	require.False(t, IsReleaseVersion("dev"))
	require.False(t, IsReleaseVersion(""))
	require.False(t, IsReleaseVersion("garbage"))
}

func TestEvaluate(t *testing.T) {
	const repo = "diagridio/dev-dashboard"

	t.Run("newer available", func(t *testing.T) {
		r := evaluate("1.2.0", "v1.3.0", repo)
		require.True(t, r.UpdateAvailable)
		require.Equal(t, "v1.2.0", r.Current)
		require.Equal(t, "v1.3.0", r.Latest)
		require.Equal(t, "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0", r.ReleaseURL)
	})

	t.Run("equal", func(t *testing.T) {
		r := evaluate("v1.3.0", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
		require.Empty(t, r.ReleaseURL)
	})

	t.Run("current newer than latest", func(t *testing.T) {
		r := evaluate("v1.4.0", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
	})

	t.Run("dev current is never an update", func(t *testing.T) {
		r := evaluate("dev", "v1.3.0", repo)
		require.False(t, r.UpdateAvailable)
		require.Empty(t, r.ReleaseURL)
	})
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/updatecheck/...`
Expected: FAIL — package/functions undefined (build error).

- [ ] **Step 3: Write the implementation**

Create `pkg/updatecheck/updatecheck.go`:

```go
// Package updatecheck reports whether a newer dev-dashboard release exists.
package updatecheck

import (
	"strings"

	"golang.org/x/mod/semver"
)

// Result is the update-availability payload shared by the CLI notice and the
// GET /api/update-check endpoint. When UpdateAvailable is true, Current and
// Latest are normalized with a leading "v" and ReleaseURL points at the release.
type Result struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"updateAvailable"`
	ReleaseURL      string `json:"releaseUrl"`
}

// IsReleaseVersion reports whether v is a real released version (valid semver
// once a leading "v" is ensured). A source/dev build ("dev") is not.
func IsReleaseVersion(v string) bool {
	return semver.IsValid(withV(v))
}

// evaluate compares current against latest and builds the Result. An update is
// available only when both are valid semver and latest is strictly greater.
func evaluate(current, latest, repo string) Result {
	cur := withV(current)
	lat := withV(latest)
	if semver.IsValid(cur) && semver.IsValid(lat) && semver.Compare(lat, cur) > 0 {
		return Result{
			Current:         cur,
			Latest:          lat,
			UpdateAvailable: true,
			ReleaseURL:      "https://github.com/" + repo + "/releases/tag/" + lat,
		}
	}
	return Result{Current: current, Latest: latest}
}

// withV normalizes a version to a single leading "v" (trimming space). Empty
// stays empty. "1.2.0" -> "v1.2.0"; "v1.2.0" -> "v1.2.0".
func withV(v string) string {
	v = strings.TrimSpace(v)
	if v == "" {
		return ""
	}
	return "v" + strings.TrimPrefix(v, "v")
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/updatecheck/...`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add pkg/updatecheck/updatecheck.go pkg/updatecheck/updatecheck_test.go
git commit -s -m "feat(updatecheck): add semver comparison and Result type"
```

---

## Task 3: `pkg/updatecheck` caching service

The `Service` that resolves the latest release (via `selfupdate.ResolveLatest`) and caches it, so the web endpoint reuses the startup check.

**Files:**
- Create: `pkg/updatecheck/service.go`
- Test: `pkg/updatecheck/service_test.go`

**Interfaces:**
- Consumes: `selfupdate.ResolveLatest` (Task 1); `evaluate` (Task 2).
- Produces:
  - `type Service interface { Check(ctx context.Context) Result }`
  - `func New(client *http.Client, apiBase, repo, current string, ttl time.Duration) Service`

- [ ] **Step 1: Write the failing test**

Create `pkg/updatecheck/service_test.go`:

```go
//go:build unit

package updatecheck

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// latestServer serves the GitHub /releases/latest shape and counts hits.
func latestServer(t *testing.T, tag string, hits *int32) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		require.Equal(t, "/repos/diagridio/dev-dashboard/releases/latest", r.URL.Path)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"tag_name":"` + tag + `"}`))
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestServiceCheckReportsUpdate(t *testing.T) {
	var hits int32
	srv := latestServer(t, "v1.3.0", &hits)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	r := svc.Check(context.Background())
	require.True(t, r.UpdateAvailable)
	require.Equal(t, "v1.3.0", r.Latest)
	require.Equal(t, "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0", r.ReleaseURL)
}

func TestServiceCachesWithinTTL(t *testing.T) {
	var hits int32
	srv := latestServer(t, "v1.3.0", &hits)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	_ = svc.Check(context.Background())
	_ = svc.Check(context.Background())
	require.Equal(t, int32(1), atomic.LoadInt32(&hits), "second Check should hit cache")
}

func TestServiceNegativeCacheOnError(t *testing.T) {
	var hits int32
	// Server that always 500s.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&hits, 1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	t.Cleanup(srv.Close)
	svc := New(srv.Client(), srv.URL, "diagridio/dev-dashboard", "1.2.0", time.Hour)

	r1 := svc.Check(context.Background())
	require.False(t, r1.UpdateAvailable)
	r2 := svc.Check(context.Background())
	require.False(t, r2.UpdateAvailable)
	require.Equal(t, int32(1), atomic.LoadInt32(&hits), "failed fetch should be negative-cached, not re-probed")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/updatecheck/... -run TestService`
Expected: FAIL — `New` undefined.

- [ ] **Step 3: Write the implementation**

Create `pkg/updatecheck/service.go`:

```go
package updatecheck

import (
	"context"
	"net/http"
	"sync"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/selfupdate"
)

// maxNegativeTTL caps how long a failed resolve suppresses retries.
const maxNegativeTTL = 5 * time.Minute

// Service reports whether a newer release exists, caching the result.
type Service interface {
	Check(ctx context.Context) Result
}

type service struct {
	client  *http.Client
	apiBase string
	repo    string
	current string
	ttl     time.Duration
	negTTL  time.Duration

	mu        sync.Mutex
	cached    Result
	fetchedAt time.Time
	failedAt  time.Time
	hasResult bool
}

// New builds a caching update-check service. ttl is the positive cache lifetime;
// failed resolves are negatively cached for half the ttl, capped at 5m.
func New(client *http.Client, apiBase, repo, current string, ttl time.Duration) Service {
	negTTL := ttl / 2
	if negTTL > maxNegativeTTL {
		negTTL = maxNegativeTTL
	}
	return &service{
		client:  client,
		apiBase: apiBase,
		repo:    repo,
		current: current,
		ttl:     ttl,
		negTTL:  negTTL,
	}
}

// Check returns update availability, serving from cache when fresh. On a resolve
// error the last-good result is preserved (zero Result if none) and the failure
// is negatively cached so the endpoint is not re-probed on every request.
func (s *service) Check(ctx context.Context) Result {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	if s.hasResult && now.Sub(s.fetchedAt) < s.ttl {
		return s.cached
	}
	if !s.failedAt.IsZero() && now.Sub(s.failedAt) < s.negTTL {
		return s.cached
	}

	latest, err := selfupdate.ResolveLatest(ctx, s.client, s.apiBase, s.repo)
	if err != nil {
		s.failedAt = time.Now()
		return s.cached
	}
	s.cached = evaluate(s.current, latest, s.repo)
	s.fetchedAt = time.Now()
	s.failedAt = time.Time{}
	s.hasResult = true
	return s.cached
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./pkg/updatecheck/...`
Expected: PASS (all updatecheck tests).

- [ ] **Step 5: Commit**

```bash
git add pkg/updatecheck/service.go pkg/updatecheck/service_test.go
git commit -s -m "feat(updatecheck): add caching service backed by GitHub releases"
```

---

## Task 4: Server endpoint `GET /api/update-check`

Expose the service over HTTP, mirroring the `/news` pattern.

**Files:**
- Create: `pkg/server/updatecheck.go`
- Create: `pkg/server/updatecheck_test.go`
- Modify: `pkg/server/server.go:20-36` (Options), `:48` (apiRouter call)
- Modify: `pkg/server/api.go:21` (signature), `:97-98` (mount)
- Modify: `pkg/server/api_test.go:16,30`, `pkg/server/statestores_test.go:60`, `pkg/server/workflows_test.go:243,254`

**Interfaces:**
- Consumes: `updatecheck.Service`, `updatecheck.Result` (Task 3).
- Produces: `func updateCheckRouter(svc updatecheck.Service) http.Handler` (GET `/` → `Result` JSON); `Options.UpdateCheck updatecheck.Service`.

- [ ] **Step 1: Write the failing test**

Create `pkg/server/updatecheck_test.go`:

```go
//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/stretchr/testify/require"
)

type fakeUpdateCheck struct{ r updatecheck.Result }

func (f fakeUpdateCheck) Check(context.Context) updatecheck.Result { return f.r }

func TestUpdateCheckEndpoint(t *testing.T) {
	h := updateCheckRouter(fakeUpdateCheck{r: updatecheck.Result{
		Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true,
		ReleaseURL: "https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0",
	}})
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"updateAvailable":true`)
	require.Contains(t, body, `"latest":"v1.3.0"`)
	require.Contains(t, body, `"releaseUrl":"https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0"`)
}
```

(The `get(t, handler, path)` helper is the same one used by `news_test.go` in this package.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./pkg/server/... -run TestUpdateCheckEndpoint`
Expected: FAIL — `updateCheckRouter` undefined.

- [ ] **Step 3: Create the router**

Create `pkg/server/updatecheck.go`:

```go
package server

import (
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/go-chi/chi/v5"
)

// updateCheckRouter returns an http.Handler for the /update-check sub-tree.
// GET / returns whether a newer release is available as JSON.
func updateCheckRouter(svc updatecheck.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		writeJSON(w, http.StatusOK, svc.Check(req.Context()))
	})
	return r
}
```

- [ ] **Step 4: Add the Options field and wire the router**

In `pkg/server/server.go`, add to the `Options` struct (after `News news.Service`):

```go
	UpdateCheck  updatecheck.Service
```

Add the import `"github.com/diagridio/dev-dashboard/pkg/updatecheck"` to `server.go`. Then update the `apiRouter(...)` call at line 48 to pass it (append the last arg):

```go
		router.Mount("/api", apiRouter(opts.Version, opts.Apps, opts.ContainerLogs, opts.Backend, opts.Stores, opts.Resources, opts.News, opts.ControlPlane, opts.UpdateCheck))
```

In `pkg/server/api.go`, add the import `"github.com/diagridio/dev-dashboard/pkg/updatecheck"`, extend the signature, and mount the route:

```go
func apiRouter(v version.Info, apps discovery.Service, containerLogs func(context.Context, string) (<-chan string, error), backend WorkflowBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service, cp controlplane.Manager, uc updatecheck.Service) http.Handler {
```

After the `/news` mount (line 97), add:

```go
	r.Mount("/update-check", updateCheckRouter(uc))
```

- [ ] **Step 5: Update the other `apiRouter` call sites in tests**

Append `, fakeUpdateCheck{}` as the final argument at each:
- `pkg/server/api_test.go:16` and `:30`
- `pkg/server/statestores_test.go:60`
- `pkg/server/workflows_test.go:243` and `:254`

Example for `api_test.go:16`:

```go
	srv := httptest.NewServer(apiRouter(version.Info{Version: "test"}, newFakeApps(), nil, newFakeBackend(fakeWF{}), nil, fakeResources{}, fakeNews{}, nil, fakeUpdateCheck{}))
```

- [ ] **Step 6: Run the server tests to verify they pass**

Run: `go test -tags unit ./pkg/server/...`
Expected: PASS (new endpoint test + all existing).

- [ ] **Step 7: Commit**

```bash
git add pkg/server
git commit -s -m "feat(server): add GET /api/update-check endpoint"
```

---

## Task 5: CLI notice formatting

Pure, testable notice functions (no spinner, no network).

**Files:**
- Create: `cmd/update_notice.go`
- Test: `cmd/update_notice_test.go`

**Interfaces:**
- Consumes: `updatecheck.Result` (Task 3).
- Produces:
  - `func formatUpdateNotice(current, latest string) string` — the two-line notice, with a trailing newline.
  - `func printUpdateNotice(w io.Writer, r updatecheck.Result)` — writes the notice iff `r.UpdateAvailable`.

- [ ] **Step 1: Write the failing test**

Create `cmd/update_notice_test.go`:

```go
//go:build unit

package cmd

import (
	"bytes"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
	"github.com/stretchr/testify/require"
)

func TestFormatUpdateNotice(t *testing.T) {
	got := formatUpdateNotice("v1.2.0", "v1.3.0")
	require.Equal(t,
		"A new version of the Dapr Dev Dashboard is available: v1.2.0 → v1.3.0\n"+
			"Run `dev-dashboard update` to upgrade.\n",
		got)
}

func TestPrintUpdateNoticeWhenAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{Current: "v1.2.0", Latest: "v1.3.0", UpdateAvailable: true})
	require.Contains(t, buf.String(), "v1.2.0 → v1.3.0")
	require.Contains(t, buf.String(), "dev-dashboard update")
}

func TestPrintUpdateNoticeSuppressedWhenNotAvailable(t *testing.T) {
	var buf bytes.Buffer
	printUpdateNotice(&buf, updatecheck.Result{Current: "v1.3.0", Latest: "v1.3.0", UpdateAvailable: false})
	require.Empty(t, buf.String())
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/... -run "UpdateNotice"`
Expected: FAIL — `formatUpdateNotice` undefined.

- [ ] **Step 3: Write the implementation**

Create `cmd/update_notice.go`:

```go
package cmd

import (
	"fmt"
	"io"

	"github.com/diagridio/dev-dashboard/pkg/updatecheck"
)

// formatUpdateNotice renders the two-line "new version available" notice.
func formatUpdateNotice(current, latest string) string {
	return fmt.Sprintf(
		"A new version of the Dapr Dev Dashboard is available: %s → %s\n"+
			"Run `dev-dashboard update` to upgrade.\n",
		current, latest)
}

// printUpdateNotice writes the notice to w when an update is available; it writes
// nothing otherwise.
func printUpdateNotice(w io.Writer, r updatecheck.Result) {
	if !r.UpdateAvailable {
		return
	}
	fmt.Fprint(w, formatUpdateNotice(r.Current, r.Latest))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `go test -tags unit ./cmd/... -run "UpdateNotice"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add cmd/update_notice.go cmd/update_notice_test.go
git commit -s -m "feat(cmd): add update-notice formatting"
```

---

## Task 6: Wire the startup check into `runServe`

Build the shared service, announce at startup with a spinner, and pass the same instance to the server.

**Files:**
- Modify: `cmd/update_notice.go` (add `maybeAnnounceUpdate`)
- Modify: `cmd/root.go` (imports; build service; announce; pass into deps)
- Modify: `cmd/serve.go:22-38` (`serveDeps.UpdateCheck`), `:89-101` (`assembleOptions`)
- Modify: `cmd/serve_test.go` (propagation test)
- Modify: `go.mod` / `go.sum` (promote `briandowns/spinner`, `mattn/go-isatty` to direct via `go mod tidy`)

**Interfaces:**
- Consumes: `updatecheck.New`, `updatecheck.Service`, `updatecheck.IsReleaseVersion` (Tasks 2-3); `printUpdateNotice` (Task 5).
- Produces: `func maybeAnnounceUpdate(ctx context.Context, uc updatecheck.Service, current string)`; `serveDeps.UpdateCheck updatecheck.Service`.

- [ ] **Step 1: Write the failing test (deps propagation)**

Add to `cmd/serve_test.go` (it already has `//go:build unit` and is `package cmd`):

```go
func TestAssembleOptionsPropagatesUpdateCheck(t *testing.T) {
	uc := updatecheck.New(nil, "https://api.github.com", "diagridio/dev-dashboard", "1.2.0", time.Hour)
	opts, closers := assembleOptions(context.Background(), serveDeps{
		Apps:        newStaticApps(nil),
		UpdateCheck: uc,
	}, nil)
	for _, c := range closers {
		defer func(c func() error) { _ = c() }(c)
	}
	require.Same(t, uc, opts.UpdateCheck)
}
```

Add imports as needed to `serve_test.go`: `"context"`, `"time"`, `"github.com/diagridio/dev-dashboard/pkg/updatecheck"`, and `"github.com/stretchr/testify/require"` if not already present. Use the package's existing apps test double for `Apps`; if the helper is named differently than `newStaticApps`, substitute the existing one (grep `serve_test.go` for how other tests construct `serveDeps.Apps`) — a nil-tolerant fake is required because `assembleOptions` calls `Apps.List`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test -tags unit ./cmd/... -run TestAssembleOptionsPropagatesUpdateCheck`
Expected: FAIL — `serveDeps.UpdateCheck` / `Options.UpdateCheck` undefined.

- [ ] **Step 3: Add `UpdateCheck` to `serveDeps` and `assembleOptions`**

In `cmd/serve.go`, add the import `"github.com/diagridio/dev-dashboard/pkg/updatecheck"`, add a field to `serveDeps` (after `TelemetryEnabled bool`):

```go
	// UpdateCheck is the shared latest-release checker; also used by runServe to
	// print the startup notice, so the server reuses its warmed cache.
	UpdateCheck updatecheck.Service
```

In the returned `server.Options` literal (after `TelemetryEnabled: deps.TelemetryEnabled,`), add:

```go
		UpdateCheck:      deps.UpdateCheck,
```

- [ ] **Step 4: Run the propagation test to verify it passes**

Run: `go test -tags unit ./cmd/... -run TestAssembleOptionsPropagatesUpdateCheck`
Expected: PASS.

- [ ] **Step 5: Add `maybeAnnounceUpdate`**

Append to `cmd/update_notice.go` (add imports `"context"`, `"os"`, `"time"`, `"github.com/briandowns/spinner"`, `"github.com/mattn/go-isatty"`):

```go
// maybeAnnounceUpdate runs the startup version check and prints the notice to
// stdout as the first output. For dev/source builds it does nothing (no spinner,
// no network call). On a TTY it shows a spinner while the (2s-bounded) check runs.
func maybeAnnounceUpdate(ctx context.Context, uc updatecheck.Service, current string) {
	if uc == nil || !updatecheck.IsReleaseVersion(current) {
		return
	}
	cctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()

	var sp *spinner.Spinner
	if isatty.IsTerminal(os.Stdout.Fd()) {
		sp = spinner.New(spinner.CharSets[14], 100*time.Millisecond, spinner.WithWriter(os.Stdout))
		sp.Suffix = " Checking for new versions…"
		sp.Start()
	}
	r := uc.Check(cctx)
	if sp != nil {
		sp.Stop()
	}
	printUpdateNotice(os.Stdout, r)
}
```

- [ ] **Step 6: Build the service and announce in `runServe`**

In `cmd/root.go`, add the import `"github.com/diagridio/dev-dashboard/pkg/updatecheck"`. In `runServe`, after the `telemetry := telemetryEnabled(os.Getenv)` line (root.go:95) build the service:

```go
	updateCheck := updatecheck.New(&http.Client{Timeout: 5 * time.Second}, "https://api.github.com", "diagridio/dev-dashboard", version.Get().Version, time.Hour)
```

Add `UpdateCheck: updateCheck,` to the `serveDeps{...}` literal passed to `assembleOptions` (alongside `TelemetryEnabled: telemetry,`).

Then, immediately before the existing `fmt.Printf("Diagrid Dev Dashboard is running → %s\n", url)` line (root.go:116), add:

```go
	maybeAnnounceUpdate(ctx, updateCheck, version.Get().Version)
```

- [ ] **Step 7: Tidy modules to promote the new direct dependencies**

Run: `go mod tidy`
Expected: `github.com/briandowns/spinner` and `github.com/mattn/go-isatty` move to the direct `require` block; no unrelated churn.

- [ ] **Step 8: Build and run the full Go unit suite**

Run: `go build ./... && go test -tags unit -race ./cmd/... ./pkg/updatecheck/... ./pkg/server/... ./pkg/selfupdate/...`
Expected: build succeeds; all PASS.

- [ ] **Step 9: Manually sanity-check the notice (optional but recommended)**

Run: `go build -o bin/dev-dashboard.exe . ; ./bin/dev-dashboard.exe --no-open`
Expected on a `dev` build: no spinner, no notice (dev is skipped), then the normal "running →" line. (A real notice only appears from a released, older binary.)

- [ ] **Step 10: Commit**

```bash
git add cmd go.mod go.sum
git commit -s -m "feat(cmd): announce available updates on startup"
```

---

## Task 7: Web `useUpdateCheck` hook

**Files:**
- Modify: `web/src/hooks/useMeta.ts`
- Test: `web/src/hooks/useMeta.test.tsx`

**Interfaces:**
- Produces:
  - `interface UpdateInfo { current: string; latest: string; updateAvailable: boolean; releaseUrl: string }`
  - `function useUpdateCheck(): UseQueryResult<UpdateInfo>` — polls `/update-check` every 5 min.

- [ ] **Step 1: Write the failing test**

Add to `web/src/hooks/useMeta.test.tsx` (import `useUpdateCheck` alongside `useVersion`):

```ts
describe('useUpdateCheck', () => {
  beforeEach(() => {
    server.use(
      http.get('/api/update-check', () =>
        HttpResponse.json({
          current: 'v1.2.0',
          latest: 'v1.3.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
        }),
      ),
    )
  })

  it('returns update info from /api/update-check', async () => {
    const { result } = renderHook(() => useUpdateCheck(), { wrapper: makeWrapper() })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data).toEqual({
      current: 'v1.2.0',
      latest: 'v1.3.0',
      updateAvailable: true,
      releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web; npx vitest run src/hooks/useMeta.test.tsx`
Expected: FAIL — `useUpdateCheck` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `web/src/hooks/useMeta.ts`:

```ts
/** Shape returned by GET /api/update-check */
export interface UpdateInfo {
  current: string
  latest: string
  updateAvailable: boolean
  releaseUrl: string
}

/** Fetch update availability from /api/update-check. Refreshes every 5 min. */
export function useUpdateCheck() {
  return useQuery<UpdateInfo>({
    queryKey: ['update-check'],
    queryFn: () => fetchJSON<UpdateInfo>('/update-check'),
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web; npx vitest run src/hooks/useMeta.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks/useMeta.ts web/src/hooks/useMeta.test.tsx
git commit -s -m "feat(web): add useUpdateCheck hook"
```

---

## Task 8: Web UI indicator (expanded badge + collapsed dot)

Render the indicator in both sidebar states, and apply the `update-available` class on `.app`.

**Files:**
- Modify: `web/src/components/ResourcesSidebar.tsx`
- Modify: `web/src/components/ResourcesSidebar.test.tsx`
- Modify: `web/src/App.tsx`
- Modify: `web/src/App.test.tsx`
- Modify: `web/src/styles/theme.css`

**Interfaces:**
- Consumes: `useUpdateCheck`, `UpdateInfo` (Task 7).
- Produces: `ResourcesSidebarProps` gains `onUpdateAvailableChange: (v: boolean) => void` (mirrors `onHasNewChange`).

- [ ] **Step 1: Write the failing tests**

First, add a default `/api/update-check` mock so existing tests don't error (recall `onUnhandledRequest: 'error'`). In `web/src/components/ResourcesSidebar.test.tsx`, extend the `beforeEach` (line 45-49) to add:

```ts
  server.use(
    http.get('/api/update-check', () =>
      HttpResponse.json({ current: 'v1.2.3', latest: 'v1.2.3', updateAvailable: false, releaseUrl: '' }),
    ),
  )
```

Update `SidebarWrapper` (line 21-34) to own an `updateAvailable` state and apply the class, and pass the new prop:

```tsx
function SidebarWrapper({ initialCollapsed = false }: { initialCollapsed?: boolean }) {
  const [collapsed, setCollapsed] = useState(initialCollapsed)
  const [hasNew, setHasNew] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  return (
    <div
      className={['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : '', updateAvailable ? 'update-available' : '']
        .filter(Boolean)
        .join(' ')}
      data-theme="light"
    >
      <ResourcesSidebar
        collapsed={collapsed}
        onCollapsedChange={setCollapsed}
        onHasNewChange={setHasNew}
        onUpdateAvailableChange={setUpdateAvailable}
      />
    </div>
  )
}
```

Also add `onUpdateAvailableChange={() => undefined}` to the `renderWithSpy` wrapper (line 351-364).

Then add a new describe block:

```tsx
describe('ResourcesSidebar update indicator', () => {
  const withUpdate = () =>
    server.use(
      http.get('/api/update-check', () =>
        HttpResponse.json({
          current: 'v1.2.0',
          latest: 'v1.3.0',
          updateAvailable: true,
          releaseUrl: 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0',
        }),
      ),
    )

  it('shows an Update available link in the footer when an update exists', async () => {
    withUpdate()
    renderSidebar()
    const link = await screen.findByRole('link', { name: /Update available/i })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
  })

  it('shows no update link when up to date', async () => {
    // default beforeEach mock has updateAvailable:false
    renderSidebar()
    await screen.findByRole('link', { name: 'Diagrid' })
    expect(screen.queryByRole('link', { name: /Update available/i })).not.toBeInTheDocument()
  })

  it('renders the collapsed update indicator linking to the release', async () => {
    withUpdate()
    renderSidebar({ initialCollapsed: true })
    const link = await screen.findByRole('link', { name: /version .* is available/i })
    expect(link).toHaveAttribute('href', 'https://github.com/diagridio/dev-dashboard/releases/tag/v1.3.0')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd web; npx vitest run src/components/ResourcesSidebar.test.tsx`
Expected: FAIL — the new prop / links don't exist yet.

- [ ] **Step 3: Implement the sidebar changes**

In `web/src/components/ResourcesSidebar.tsx`:

Add `useUpdateCheck` to the existing import from `../hooks/useMeta`:

```tsx
import { useVersion, useUpdateCheck } from '../hooks/useMeta'
```

Extend the props interface:

```tsx
interface ResourcesSidebarProps {
  collapsed: boolean
  onCollapsedChange: (v: boolean) => void
  onHasNewChange: (v: boolean) => void
  onUpdateAvailableChange: (v: boolean) => void
}
```

Update the function signature and add the hook + bubble-up (near the `useNews`/`useVersion` calls, ~line 159-168):

```tsx
export function ResourcesSidebar({ collapsed, onCollapsedChange, onHasNewChange, onUpdateAvailableChange }: ResourcesSidebarProps) {
  const [seen, setSeen] = useState<Set<string>>(() => getSeen())
  const { data: news } = useNews()
  const { data: versionData } = useVersion()
  const { data: update } = useUpdateCheck()

  const updateAvailable = update?.updateAvailable ?? false
  useEffect(() => {
    onUpdateAvailableChange(updateAvailable)
  }, [updateAvailable, onUpdateAvailableChange])
```

In the collapsed vertical panel (`.sbvert`, ~line 229-248), add the indicator as the first child inside the div, before the bell button:

```tsx
      <div className="sbvert" data-testid="sidebar-collapsed-label">
        {updateAvailable && update && (
          <a
            className="updot"
            id="update-v"
            href={update.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Version ${update.latest} is available — update`}
            title={`${update.latest} is available — update`}
            onClick={() => trackAction('update_click', { placement: 'collapsed', latest: update.latest })}
          />
        )}
```

In the footer (`.sbfoot`, ~line 250-261), add the badge inside the "Powered by" `.pw` span, after the version text:

```tsx
          {' · '}v{version}
          {updateAvailable && update && (
            <>
              {'  '}
              <a
                className="upbadge"
                href={update.releaseUrl}
                target="_blank"
                rel="noopener noreferrer"
                title={`${update.latest} is available`}
                onClick={() => trackAction('update_click', { placement: 'footer', latest: update.latest })}
              >
                <span className="updot" aria-hidden="true" /> Update available <span className="ext">↗</span>
              </a>
            </>
          )}
```

- [ ] **Step 4: Wire `App.tsx`**

In `web/src/App.tsx`, add state and class, and pass the prop:

```tsx
  const [hasNew, setHasNew] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
```

```tsx
  const appClass = ['app', collapsed ? 'collapsed' : '', hasNew ? 'has-new' : '', updateAvailable ? 'update-available' : '']
    .filter(Boolean)
    .join(' ')
```

```tsx
        <ResourcesSidebar
          collapsed={collapsed}
          onCollapsedChange={setCollapsed}
          onHasNewChange={setHasNew}
          onUpdateAvailableChange={setUpdateAvailable}
        />
```

- [ ] **Step 5: Add the default `/api/update-check` mock to `App.test.tsx`**

In `web/src/App.test.tsx`, add to the `beforeEach` `server.use(...)` block (line 31-40):

```ts
    http.get('/api/update-check', () =>
      HttpResponse.json({ current: '9.9.9', latest: '9.9.9', updateAvailable: false, releaseUrl: '' }),
    ),
```

- [ ] **Step 6: Add the CSS**

In `web/src/styles/theme.css`, after the bell rules (~line 109), add:

```css
/* Update-available indicator (footer badge + collapsed dot) */
.upbadge { color: var(--primary); text-decoration: none; white-space: nowrap; display: inline-flex; align-items: center; gap: 4px; }
.upbadge:hover { text-decoration: underline; }
.updot { width: 7px; height: 7px; border-radius: 50%; background: var(--primary); display: inline-block; }
.sbvert #update-v { display: none; }
.app.update-available.collapsed #update-v { display: inline-block; margin-bottom: 8px; }
```

- [ ] **Step 7: Run the web tests to verify they pass**

Run: `cd web; npx vitest run src/components/ResourcesSidebar.test.tsx src/App.test.tsx`
Expected: PASS.

- [ ] **Step 8: Run the full web suite + lint**

Run: `cd web; npm test; npm run lint`
Expected: all PASS (no unhandled-request errors, no lint errors). If any other suite errors on an unhandled `/api/update-check` request, add the same `updateAvailable:false` default mock to that suite's `beforeEach`.

- [ ] **Step 9: Commit**

```bash
git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx web/src/App.tsx web/src/App.test.tsx web/src/styles/theme.css
git commit -s -m "feat(web): show update-available indicator in Resources panel"
```

---

## Task 9: Documentation

Document the startup notice and the indicator.

**Files:**
- Modify: `README.md` (the "Updating the dashboard" section)
- Modify: `ARCHITECTURE.md` (data-sources list — near the News entry)

- [ ] **Step 1: Update README**

In `README.md`, at the start of the "Updating the dashboard" section (after line 91's heading), add:

```markdown
On startup the dashboard checks GitHub for a newer release. If one exists, it prints
a notice as the first line of output and the web UI shows an **Update available**
indicator next to the version number in the Resources panel. The check is best-effort:
it is skipped for source/dev builds and fails silently when offline.
```

- [ ] **Step 2: Update ARCHITECTURE**

In `ARCHITECTURE.md`, find the bullet describing the News endpoint (search for "News" / "product feed") and add a sibling bullet:

```markdown
- **Update check** (`pkg/updatecheck`) — resolves the latest GitHub release (reusing
  `pkg/selfupdate`'s resolver), compares it to the running version with semver, and
  caches the result. Consumed by the CLI startup notice and by `GET /api/update-check`
  for the web indicator. Fails silent; skipped for `dev`/source builds.
```

(If `ARCHITECTURE.md` has a component/endpoint table rather than a bullet list, add a matching row instead, following the surrounding format.)

- [ ] **Step 3: Commit**

```bash
git add README.md ARCHITECTURE.md
git commit -s -m "docs: document version-update awareness"
```

---

## Self-Review

**1. Spec coverage:**
- Startup notice as first line, with version + update command → Tasks 5, 6 (notice copy verbatim in Global Constraints).
- Spinner "Checking for new versions…" + TTY handling + 2s timeout → Task 6 (`maybeAnnounceUpdate`).
- Skip for dev/invalid → Task 2 (`IsReleaseVersion`), Task 6 guard.
- Shared backend service, reuse `selfupdate` resolver → Tasks 1, 3, 6 (one instance built in `runServe`, passed to server).
- Separate `/api/update-check` endpoint → Task 4.
- Web hook (5-min poll) → Task 7.
- Expanded footer badge + collapsed indicator, `update-available` class → Task 8.
- No opt-out, fail-silent, prerelease-excluded, normalization → Global Constraints + Tasks 2, 3 (`/releases/latest` via `ResolveLatest`, `withV`).
- Tests across Go unit, server, cmd, web → Tasks 2-8.
- Docs → Task 9.

**2. Placeholder scan:** No TBD/TODO; every code step contains complete code. The one conditional instruction (Task 6 Step 1 apps double, Task 8 Step 8 extra mocks) gives an explicit grep/action, not a vague "handle it".

**3. Type consistency:** `Result{Current, Latest, UpdateAvailable, ReleaseURL}` with JSON `current/latest/updateAvailable/releaseUrl` is used identically in Go (Tasks 2-6) and TS `UpdateInfo` (Task 7) and the web mocks (Tasks 7-8). `Service.Check(ctx) Result`, `updateCheckRouter(svc)`, `Options.UpdateCheck`, `apiRouter(..., uc)`, `serveDeps.UpdateCheck`, `maybeAnnounceUpdate(ctx, uc, current)`, `formatUpdateNotice(current, latest)`, `printUpdateNotice(w, r)`, `useUpdateCheck()`, and the `onUpdateAvailableChange` prop are consistent across their defining and consuming tasks.
