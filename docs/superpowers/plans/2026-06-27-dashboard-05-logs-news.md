# Dev Dashboard — Plan 5: Logs (SSE) + News / Resources Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add live per-app **log tailing** over SSE (daprd + app logs, level coloring, keyword highlight, follow/jump-to-latest, bounded buffer) and a collapsible left **Resources/News sidebar** backed by a server-proxied, cached Diagrid product feed.

**Architecture:** A new `pkg/logs` polling tailer streams a log file's backfill + appended lines on a channel; the server exposes `GET /api/apps/{appId}/logs?source=daprd|app` as an SSE endpoint (resolves the file via discovery's `AppLogPath`/`DaprdLogPath`). A new `pkg/news` service fetches `https://www.diagrid.io/api/product-feed`, caches the last-good result (~1 h TTL), derives the four News "slots" (latest blog, latest report, next upcoming webinar, next upcoming event), and is served same-origin at `GET /api/news`. The SPA replaces the Logs placeholder with a streaming viewer (native `EventSource`, bounded client buffer — **no virtualization library**) and adds a themed, collapsible `ResourcesSidebar` with static link sections + the dynamic News slots and an unseen-items bell.

**Tech Stack:** (builds on Plans 1–4) Go + chi + `net/http` SSE (`http.Flusher`) · React + TanStack Query + React Router + native `EventSource`. **No new runtime dependencies** — the log list uses a bounded buffer (not TanStack Virtual), SSE uses native `EventSource`, and the tailer polls (no fsnotify).

**Builds on Plans 1–4 (all merged, `main` @ `c0d2d22`).** Real interfaces this plan consumes:
- Go: `discovery.Service{List,Get}`, `discovery.Instance{AppID, AppLogPath, DaprdLogPath, ...}`, `discovery.ErrNotFound`; `server.Options{BasePath, DistFS, Version, Apps, Backend, Stores, Resources}`, `server.NewRouter(opts)`, `apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry, res resources.Service) http.Handler`, `appsRouter(svc discovery.Service)` (in `pkg/server/apps.go`, currently `GET /` + `GET /{appId}`), `writeJSON`, the `get()` test helper (`pkg/server/spa_test.go`); `cmd/root.go runServe` (builds `appsSvc`, sets `Options`).
- Web: `apiUrl`/`fetchJSON<T>` (`web/src/lib/api.ts`), `QueryProvider`, `RefreshProvider`/`useRefreshInterval`/`refetchMs` (`web/src/lib/refresh.tsx`), `useApp(appId)` (`web/src/hooks/useApps.ts`, returns `AppDetail` incl. `appLogPath`/`daprdLogPath`), `routes`/`router` (`web/src/router.tsx`), `App.tsx` layout (TopNav + `<Outlet/>` + StatusFooter), the `Applications.tsx` dense-table + `Field`/section patterns, `useApps()` (app list for the selector), theme tokens (`--surface`, `--border`, `--bg`, `--text`, `--text-muted`, `--text-faint`, `--link`, `--ok/--warn/--bad`, `--space-1..6`, `.mono`), the `data-cy` + MSW conventions (`web/src/test/setup.ts`).

**Module path:** `github.com/diagridio/dev-dashboard`. **Go toolchain:** 1.26.x. **Node:** 20 (build-time only).

## Global Constraints

(Inherited verbatim from Plans 1–4 — single binary, desktop-only, light/Compact defaults, base-path-aware, WCAG-AA, **lean bundle (≈300 KB gzipped soft budget)**, theme tokens, monospace+tabular-nums, **local** timestamps, testify + `//go:build unit`, Vitest+RTL+MSW, `data-cy` selectors, never `git add web/dist/`, run `gofmt -w` before committing Go, **`cd web && npm run build` in every web task's verification** since Vitest doesn't typecheck, **test output must be PRISTINE** — no `[MSW] Error: intercepted a request without a matching` lines.) Plan-5-specific:

- **No new runtime dependencies.** The log tail uses a **bounded client buffer** (cap N lines, drop oldest) rendered directly — NOT TanStack Virtual or any virtualization lib. SSE uses the browser-native **`EventSource`** (no SSE client lib). The Go tailer **polls** appended bytes (no `fsnotify`). True list virtualization is an explicit deferred follow-up if the buffer cap proves too large.
- **Logs are SSE (spec §6.7).** `GET /api/apps/{appId}/logs?source=daprd|app` streams `text/event-stream`. The source maps to the instance's `DaprdLogPath` (`source=daprd`) or `AppLogPath` (`source=app`). **Ad-hoc `dapr run` (no `-f`) has no log file** → the path is empty → the server responds `404` (the SPA gates on the app's log paths from `useApp` and shows an explanatory empty state rather than opening the stream). The SSE handler flushes per line (`http.Flusher`) and **closes when the client disconnects** (`r.Context().Done()`); one `EventSource` per Logs view, closed on unmount/route change.
- **Log viewer behavior (spec §6.7):** bounded buffer; **follow toggle** auto-scrolls to newest while following; scrolling up **pauses** auto-scroll and shows a **"jump to latest"** affordance; **log-level coloring** (info/warn/error/debug parsed from the line) via theme tokens (`error`→`--bad`, `warn`→`--warn`, `info`→`--text`, `debug`→`--text-faint`); **keyword highlight** (a search box highlights matches). State encoded as color **and** text (never color alone — the level word stays visible).
- **News feed (spec §9.6):** the Go backend **proxies + caches** `GET https://www.diagrid.io/api/product-feed` behind same-origin `GET /api/news` (sidesteps CSP). Cache the **last-good** result, ~1 h TTL; on fetch failure serve the cached result (or empty). `/api/news` returns the **four derived slots**: latest blog post, latest report/ebook, next **upcoming** webinar, next **upcoming** event — "upcoming" derived server-side from `eventStartDate` vs now (past events excluded). Each slot may be absent (null) → the SPA shows a muted empty state for that slot. The rest of the dashboard works offline (News just shows empty slots / static links).
- **Resources sidebar (spec §9.6):** a **left** sidebar, **~240px**, themed (`--surface` bg, `--border`, themed text), uppercase section headers, rounded hover rows, **text-only** menu items, **all links open in a new tab** (`target="_blank" rel="noopener noreferrer"`). Sections + exact links (copy verbatim): **News** (dynamic), **Build** — Dapr Workflow Skills `https://docs.diagrid.io/develop/workflows/dapr-skills/` · Dapr Composer `https://workflows.diagrid.io/`; **Learn** — Dapr University `https://www.diagrid.io/university` · Diagrid Webinars `https://www.diagrid.io/webinars`; **Read** — Dapr Docs `https://docs.dapr.io` · Diagrid Docs `https://docs.diagrid.io`; **Run & Operate** — Diagrid Catalyst `https://www.diagrid.io/catalyst`. **Collapsible**, state remembered in `localStorage`; when collapsed the rail shows the word "Resources" rotated **-90°** and clicking it re-expands. A **bell** appears (expanded header + collapsed rail) when the feed has items the user hasn't seen; **seen state** = the set of item URLs in `localStorage`; clicking the bell or opening a News link marks current items seen and clears the bell; new items on a later poll re-raise it. `prefers-reduced-motion` honored for any collapse animation.

## File Structure

```
pkg/logs/
  tail.go            # Tail(ctx, path, backfillLines, pollInterval) (<-chan string, error)
  tail_test.go
pkg/news/
  news.go            # Feed/Item types, Service{Get}, New(client,url,ttl); fetch + cache + slot derivation
  news_test.go
pkg/server/
  logs.go            # logsHandler(svc discovery.Service) — SSE for /{appId}/logs
  logs_test.go
  apps.go            # MODIFY: mount GET /{appId}/logs in appsRouter
  apps_test.go       # MODIFY: assert logs route wired (404 on no-path)
  news.go            # newsRouter(svc news.Service) — GET /
  news_test.go
  api.go             # MODIFY: apiRouter(..., res, newsSvc) mounts /news
  server.go          # MODIFY: Options.News news.Service
  server_test.go     # MODIFY: pass fakes
cmd/root.go          # MODIFY: build news.New(...) ; set Options.News
web/src/
  lib/loglevel.ts          # parseLogLevel(line): LogLevel|undefined
  lib/loglevel.test.ts
  hooks/useLogStream.ts     # EventSource hook → bounded buffer of lines + status
  hooks/useLogStream.test.tsx
  hooks/useNews.ts          # useNews() (poll ~hourly) ; News types
  hooks/useNews.test.tsx
  types/logs.ts             # LogLine, LogLevel, NewsItem, NewsResponse TS types
  pages/Logs.tsx            # app+source selector, stream, buffer, follow, search, empty state
  pages/Logs.test.tsx
  components/ResourcesSidebar.tsx   # collapsible rail + sections + News slots + bell
  components/ResourcesSidebar.test.tsx
  lib/newsSeen.ts           # seen-URL localStorage helpers
  lib/newsSeen.test.ts
  App.tsx                   # MODIFY: render <ResourcesSidebar/> left of <Outlet/>
  router.tsx                # MODIFY: /logs → <Logs/>
  pages/AppDetail.tsx       # MODIFY: add a "View logs" link → /logs?app={id}&source=daprd
```

---

### Task 1: Log tailer (`pkg/logs`)

**Files:** Create `pkg/logs/tail.go`, `pkg/logs/tail_test.go`

**Interfaces — Produces:**
```go
// Tail streams a log file: first up to backfillLines of the existing tail, then
// each newly-appended line, on the returned channel. The channel is closed when
// ctx is cancelled or an unrecoverable read error occurs. Returns an error if the
// file cannot be opened. pollInterval controls how often appended bytes are polled.
func Tail(ctx context.Context, path string, backfillLines int, pollInterval time.Duration) (<-chan string, error)
```
Implementation: `os.Open(path)` (return err if missing). Read the whole file, keep the last `backfillLines` complete lines, emit them. Track the byte offset at EOF. Spawn a goroutine: on each `pollInterval` tick, read from the offset to new EOF; split on `\n`, buffering any trailing partial line until its newline arrives; emit each complete line; advance the offset; exit + close channel on `ctx.Done()`. Lines are emitted without the trailing `\n`.

- [ ] **Step 1: Write the failing test** (`tail_test.go`, `//go:build unit`):
```go
//go:build unit

package logs

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func TestTailBackfillAndAppend(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.log")
	require.NoError(t, os.WriteFile(path, []byte("line1\nline2\n"), 0o600))

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := Tail(ctx, path, 10, 20*time.Millisecond)
	require.NoError(t, err)

	require.Equal(t, "line1", recv(t, ch))
	require.Equal(t, "line2", recv(t, ch))

	f, err := os.OpenFile(path, os.O_APPEND|os.O_WRONLY, 0o600)
	require.NoError(t, err)
	_, _ = f.WriteString("line3\n")
	_ = f.Close()

	require.Equal(t, "line3", recv(t, ch))
}

func TestTailBackfillLimit(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "a.log")
	require.NoError(t, os.WriteFile(path, []byte("a\nb\nc\nd\n"), 0o600))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ch, err := Tail(ctx, path, 2, 20*time.Millisecond)
	require.NoError(t, err)
	require.Equal(t, "c", recv(t, ch)) // only last 2 backfilled
	require.Equal(t, "d", recv(t, ch))
}

func TestTailMissingFile(t *testing.T) {
	_, err := Tail(context.Background(), "/no/such/file.log", 1, time.Second)
	require.Error(t, err)
}

func recv(t *testing.T, ch <-chan string) string {
	t.Helper()
	select {
	case s, ok := <-ch:
		require.True(t, ok, "channel closed early")
		return s
	case <-time.After(2 * time.Second):
		t.Fatal("timeout waiting for line")
		return ""
	}
}
```
- [ ] **Step 2: Run → fail.** `go test -tags unit ./pkg/logs/ -v`
- [ ] **Step 3: Implement** `tail.go` per the interface above. Use a `bufio`-free approach: `os.ReadFile`-equivalent incremental reads via `f.Read` from the tracked offset; maintain a `[]byte` carry buffer for partial lines. Backfill: read the whole file, `strings.Split` on `\n`, drop the trailing empty element, keep the last `backfillLines`. Send on the channel with a `select { case ch <- line: case <-ctx.Done(): return }` so a slow/abandoned consumer can't block shutdown.
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/logs/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/logs && git add pkg/logs/ && git commit -m "feat(logs): polling file tailer (backfill + append)"`

---

### Task 2: API — SSE logs endpoint

**Files:** Create `pkg/server/logs.go`, `pkg/server/logs_test.go`; **modify** `pkg/server/apps.go`, `pkg/server/apps_test.go`.

**Interfaces — Produces:**
- `logsHandler(svc discovery.Service) http.HandlerFunc` — resolves the app via `svc.Get(appId)`; picks `DaprdLogPath` (`?source=daprd`, the default) or `AppLogPath` (`?source=app`); if the app is unknown → 404, if the chosen path is empty → 404 (`{"error":"no log file for this app/source"}`); otherwise streams SSE: sets `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`, then for each line from `logs.Tail(r.Context(), path, 200, 500ms)` writes `data: <line>\n\n` and flushes; returns when the tail channel closes or `r.Context()` is done.
- `appsRouter` mounts `r.Get("/{appId}/logs", logsHandler(svc))`.

- [ ] **Step 1: Write the failing test** (`logs_test.go`) — a fake `discovery.Service` whose instance has a real temp log file; assert the SSE response streams the backfilled lines, and a 404 when the path is empty. Use `httptest.NewServer` so streaming works, and read with a context timeout:
```go
//go:build unit

package server

import (
	"bufio"
	"context"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
	"github.com/stretchr/testify/require"
)

func TestLogsSSEStreamsLines(t *testing.T) {
	dir := t.TempDir()
	logPath := filepath.Join(dir, "daprd.log")
	require.NoError(t, os.WriteFile(logPath, []byte("hello\nworld\n"), 0o600))

	svc := fakeApps{instances: []discovery.Instance{{AppID: "order", DaprdLogPath: logPath}}}
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc))

	// Use httptest server for real streaming.
	ts := newStreamServer(t, r)
	defer ts.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, ts.URL+"/order/logs?source=daprd", nil)
	resp, err := http.DefaultClient.Do(req)
	require.NoError(t, err)
	defer func() { _ = resp.Body.Close() }()
	require.Equal(t, http.StatusOK, resp.StatusCode)
	require.Contains(t, resp.Header.Get("Content-Type"), "text/event-stream")

	got := readSSEData(t, resp.Body, 2)
	require.Equal(t, []string{"hello", "world"}, got)
}

func TestLogsNoFile404(t *testing.T) {
	svc := fakeApps{instances: []discovery.Instance{{AppID: "order"}}} // no DaprdLogPath
	r := chi.NewRouter()
	r.Get("/{appId}/logs", logsHandler(svc))
	res, _ := get(t, r, "/order/logs?source=daprd")
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

// helpers: newStreamServer wraps a handler in httptest.NewServer; readSSEData reads
// n `data:` payloads from an SSE stream (split on lines beginning with "data: ").
func readSSEData(t *testing.T, body interface{ Read([]byte) (int, error) }, n int) []string {
	t.Helper()
	sc := bufio.NewScanner(body.(interface {
		Read([]byte) (int, error)
	}).(interface{ Read([]byte) (int, error) }))
	_ = sc
	// Simpler: use bufio.NewReader; see implementation note.
	return nil
}
```
> The test helper sketch above is intentionally replaced in implementation: use `bufio.NewReader(resp.Body)` and read lines until you collect `n` lines beginning with `data: `, stripping that prefix. Define `newStreamServer(t, h)` as `httptest.NewServer(h)`. Keep `readSSEData` simple and correct (the sketch's reflection is a placeholder — write the straightforward `bufio.NewReader` loop with a deadline via the request context).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `logs.go`:
```go
package server

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/logs"
	"github.com/go-chi/chi/v5"
)

func logsHandler(svc discovery.Service) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		in, err := svc.Get(req.Context(), chi.URLParam(req, "appId"))
		if errors.Is(err, discovery.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "app not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		path := in.DaprdLogPath
		if req.URL.Query().Get("source") == "app" {
			path = in.AppLogPath
		}
		if path == "" {
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
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("Connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()
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
- [ ] **Step 4: Modify `apps.go`** — add `r.Get("/{appId}/logs", logsHandler(svc))` to `appsRouter` (keep `/` and `/{appId}`).
- [ ] **Step 5: Modify `apps_test.go`** — add the 404-no-path assertion through the full `appsRouter` (`get(t, appsRouter(fakeApps{...}), "/order/logs")` → 404 when the instance has no log path).
- [ ] **Step 6: Run → pass.** `go test -tags unit ./pkg/server/ -v`
- [ ] **Step 7: Commit.** `gofmt -w pkg/server && git add pkg/server/logs.go pkg/server/logs_test.go pkg/server/apps.go pkg/server/apps_test.go && git commit -m "feat(server): SSE log tail endpoint"`

---

### Task 3: News service (`pkg/news`) — fetch + cache + slots

**Files:** Create `pkg/news/news.go`, `pkg/news/news_test.go`

**Interfaces — Produces:**
```go
type Item struct {
  Title          string `json:"title"`
  URL            string `json:"url"`
  Excerpt        string `json:"excerpt,omitempty"`
  PublishedAt    string `json:"publishedAt,omitempty"`
  EventStartDate string `json:"eventStartDate,omitempty"`
  EventLocation  string `json:"eventLocation,omitempty"`
}
// Response is the four derived slots returned by /api/news (any may be nil).
type Response struct {
  Blog    *Item `json:"blog"`
  Report  *Item `json:"report"`
  Webinar *Item `json:"webinar"`
  Event   *Item `json:"event"`
}
type Service interface { Get(ctx context.Context) Response }
// New builds a caching service. url is the upstream product feed; ttl is the cache lifetime.
func New(client *http.Client, url string, ttl time.Duration) Service
```
The upstream feed JSON is `{ "latestBlogPosts": [Item], "latestReports": [Item], "upcomingWebinars": [Item], "upcomingEvents": [Item] }`. `Get`: if the cache is fresh (< ttl since last successful fetch) return the cached `Response`; otherwise fetch the upstream, derive slots, cache, and return; on fetch/parse failure return the last-good cached `Response` (zero-value `Response{}` if none). Slot derivation: `Blog` = first of `latestBlogPosts`; `Report` = first of `latestReports`; `Webinar` = first `upcomingWebinars` item whose `EventStartDate` parses to a time **after now**; `Event` = first such `upcomingEvents`. Guard all with a mutex.

- [ ] **Step 1: Write the failing test** (`news_test.go`) with an httptest upstream that counts calls; assert slot derivation, caching (second Get within ttl doesn't refetch), and last-good on failure:
```go
//go:build unit

package news

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

const feedJSON = `{
  "latestBlogPosts":[{"title":"Blog A","url":"https://x/blog-a"}],
  "latestReports":[{"title":"Report A","url":"https://x/report-a"}],
  "upcomingWebinars":[{"title":"Past WB","url":"https://x/wb-past","eventStartDate":"2020-01-01T00:00:00Z"},{"title":"Future WB","url":"https://x/wb-future","eventStartDate":"2099-01-01T00:00:00Z"}],
  "upcomingEvents":[{"title":"Future EV","url":"https://x/ev","eventStartDate":"2099-06-01T00:00:00Z","eventLocation":"Berlin"}]
}`

func TestNewsSlotsAndCache(t *testing.T) {
	var calls int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt32(&calls, 1)
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 2 * time.Second}, ts.URL, time.Hour)
	r := svc.Get(context.Background())
	require.NotNil(t, r.Blog)
	require.Equal(t, "Blog A", r.Blog.Title)
	require.NotNil(t, r.Report)
	require.NotNil(t, r.Webinar)
	require.Equal(t, "Future WB", r.Webinar.Title) // past one skipped
	require.NotNil(t, r.Event)
	require.Equal(t, "Berlin", r.Event.EventLocation)

	_ = svc.Get(context.Background()) // within ttl → cached
	require.Equal(t, int32(1), atomic.LoadInt32(&calls))
}

func TestNewsLastGoodOnFailure(t *testing.T) {
	var fail atomic.Bool
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if fail.Load() {
			w.WriteHeader(500)
			return
		}
		_, _ = w.Write([]byte(feedJSON))
	}))
	defer ts.Close()

	svc := New(&http.Client{Timeout: 2 * time.Second}, ts.URL, time.Nanosecond) // always stale
	r1 := svc.Get(context.Background())
	require.NotNil(t, r1.Blog)
	fail.Store(true)
	time.Sleep(time.Millisecond)
	r2 := svc.Get(context.Background()) // refetch fails → last-good
	require.NotNil(t, r2.Blog)
	require.Equal(t, "Blog A", r2.Blog.Title)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `news.go`. Parse `EventStartDate` with `time.Parse(time.RFC3339, ...)`; treat a parse error as "not upcoming" (skip). Use `time.Now()` for the upcoming comparison. Cache fields under a `sync.Mutex`: `cached Response`, `fetchedAt time.Time`, `hasGood bool`.
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/news/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/news && git add pkg/news/ && git commit -m "feat(news): cached product-feed service with slot derivation"`

---

### Task 4: API — `/api/news` + wiring

**Files:** Create `pkg/server/news.go`, `pkg/server/news_test.go`; **modify** `pkg/server/api.go`, `pkg/server/server.go`, `pkg/server/server_test.go`, `cmd/root.go`.

**Interfaces — Produces:**
- `newsRouter(svc news.Service) http.Handler` — `GET /` → `svc.Get(ctx)` as JSON.
- `Options` gains `News news.Service`; `apiRouter(v, apps, backend, stores, res, newsSvc)` mounts `/news`.
- `cmd` builds `news.New(&http.Client{Timeout: 5*time.Second}, "https://www.diagrid.io/api/product-feed", time.Hour)` → `Options.News`.

- [ ] **Step 1: Write the failing test** (`news_test.go`, package `server`) with a fake `news.Service`:
```go
//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/news"
	"github.com/stretchr/testify/require"
)

type fakeNews struct{ r news.Response }

func (f fakeNews) Get(context.Context) news.Response { return f.r }

func TestNewsEndpoint(t *testing.T) {
	h := newsRouter(fakeNews{r: news.Response{Blog: &news.Item{Title: "Hi", URL: "https://x"}}})
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"blog"`)
	require.Contains(t, body, `"title":"Hi"`)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `news.go` (`newsRouter` with `r.Get("/", ...)` → `writeJSON(w, 200, svc.Get(req.Context()))`).
- [ ] **Step 4: Modify `api.go`** — `apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry, res resources.Service, newsSvc news.Service) http.Handler` + `r.Mount("/news", newsRouter(newsSvc))`.
- [ ] **Step 5: Modify `server.go`** — add `News news.Service` to `Options`; pass `opts.News` in the `apiRouter(...)` call.
- [ ] **Step 6: Modify `server_test.go` + `api_test.go`** — update all `apiRouter(...)` call sites to pass a `fakeNews{}` (search for every call site so none is orphaned).
- [ ] **Step 7: Modify `cmd/root.go`** — build the news service and add `News: newsSvc` to `Options` (add the `news` import + `time`/`net/http` already present).
- [ ] **Step 8: Run → pass.** `go test -tags unit ./pkg/server/ ./cmd/ -v && go build ./...`
- [ ] **Step 9: Commit.** `gofmt -w pkg/server cmd && go mod tidy && git add pkg/server cmd go.mod go.sum && git commit -m "feat(server,cmd): /api/news proxy endpoint"`

---

### Task 5: Frontend — log types, level parser, log-stream hook

**Files:** Create `web/src/types/logs.ts`, `web/src/lib/loglevel.ts`, `web/src/lib/loglevel.test.ts`, `web/src/hooks/useLogStream.ts`, `web/src/hooks/useLogStream.test.tsx`.

**Interfaces — Produces:**
```ts
// types/logs.ts
export type LogLevel = 'error' | 'warn' | 'info' | 'debug'
export interface LogLine { seq: number; text: string; level?: LogLevel }
export interface NewsItem { title: string; url: string; excerpt?: string; publishedAt?: string; eventStartDate?: string; eventLocation?: string }
export interface NewsResponse { blog: NewsItem | null; report: NewsItem | null; webinar: NewsItem | null; event: NewsItem | null }
// loglevel.ts
export function parseLogLevel(line: string): LogLevel | undefined
// useLogStream.ts — opens an EventSource and accumulates a bounded buffer.
export function useLogStream(appId: string | undefined, source: 'daprd' | 'app', opts?: { max?: number }):
  { lines: LogLine[]; status: 'idle' | 'connecting' | 'open' | 'error'; clear: () => void }
```
`parseLogLevel`: case-insensitive match for `level=error|warn|warning|info|debug` (logfmt) OR standalone tokens `ERRO|ERROR|WARN|INFO|DEBU|DEBUG|FATA` → map to the 4 levels (`fata`/`error`→`error`, `warn`/`warning`→`warn`, `info`→`info`, `debu`/`debug`→`debug`); else `undefined`. `useLogStream`: when `appId` is set, opens `new EventSource(apiUrl('/apps/'+appId+'/logs?source='+source))`; on each `message` appends `{seq, text: e.data, level: parseLogLevel(e.data)}` to a buffer capped at `opts.max ?? 2000` (drop oldest); tracks status; closes the EventSource on `appId`/`source` change and on unmount; `clear()` empties the buffer. `seq` is a monotonic counter (stable React keys).

- [ ] **Step 1: Write the failing tests.** `loglevel.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { parseLogLevel } from './loglevel'

describe('parseLogLevel', () => {
  it('parses logfmt and bare tokens', () => {
    expect(parseLogLevel('time=2024 level=error msg=boom')).toBe('error')
    expect(parseLogLevel('level=warning something')).toBe('warn')
    expect(parseLogLevel('INFO starting up')).toBe('info')
    expect(parseLogLevel('2024 DEBU detail')).toBe('debug')
    expect(parseLogLevel('plain line')).toBeUndefined()
  })
})
```
`useLogStream.test.tsx`: stub `EventSource` (jsdom has none) with a minimal fake on `globalThis`, render a probe hook, dispatch a `message` event, assert a line is buffered and `level` parsed; assert `close()` is called on unmount.
```tsx
import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useLogStream } from './useLogStream'

class FakeES {
  static instances: FakeES[] = []
  url: string; onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null; onopen: (() => void) | null = null
  closed = false
  constructor(url: string) { this.url = url; FakeES.instances.push(this) }
  close() { this.closed = true }
}

beforeEach(() => { FakeES.instances = []; (globalThis as unknown as { EventSource: unknown }).EventSource = FakeES })

describe('useLogStream', () => {
  it('buffers messages with parsed level and closes on unmount', () => {
    const { result, unmount } = renderHook(() => useLogStream('order', 'daprd'))
    const es = FakeES.instances[0]
    expect(es.url).toContain('/api/apps/order/logs?source=daprd')
    act(() => { es.onmessage?.({ data: 'level=error boom' }) })
    expect(result.current.lines).toHaveLength(1)
    expect(result.current.lines[0].level).toBe('error')
    unmount()
    expect(es.closed).toBe(true)
  })
})
```
- [ ] **Step 2: Run → fail.** `cd web && npm test -- --run loglevel useLogStream`
- [ ] **Step 3: Implement** `types/logs.ts`, `loglevel.ts`, `useLogStream.ts` (use `apiUrl` from `lib/api.ts`; bounded buffer via `useState` + a ref counter; effect keyed on `[appId, source]` that creates/closes the EventSource; guard `if (!appId) return`).
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run loglevel useLogStream && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/types/logs.ts web/src/lib/loglevel.ts web/src/lib/loglevel.test.ts web/src/hooks/useLogStream.ts web/src/hooks/useLogStream.test.tsx && git commit -m "feat(web): log types, level parser, EventSource stream hook"`

---

### Task 6: Frontend — Logs page

**Files:** Create `web/src/pages/Logs.tsx`, `web/src/pages/Logs.test.tsx`; **modify** `web/src/router.tsx`, `web/src/pages/AppDetail.tsx`.

**Interfaces — Produces:** `<Logs/>` — reads `?app=` + `?source=` from the URL (`useSearchParams`, default source `daprd`). An **app selector** (dropdown from `useApps()`) and a **source toggle** (daprd / app), both writing to the URL. When `app` is set, reads `useApp(app)` to get `daprdLogPath`/`appLogPath`: if the selected source's path is empty → an **empty state** ("No log file — this app was started with `dapr run` without `-f`"). Otherwise streams via `useLogStream(app, source)`: a dense monospace log pane where each line is colored by `line.level` (`error`→`--bad`, `warn`→`--warn`, `info`→`--text`, `debug`→`--text-faint`, none→`--text`); a **search box** (`data-cy="log-search"`) highlights matching substrings (wrap matches in a `<mark>`-like span using `--accent`); a **follow toggle** (`data-cy="log-follow"`, default on) auto-scrolls to bottom on new lines; when the user scrolls up, follow pauses and a **"Jump to latest"** button (`data-cy="log-jump"`) appears that re-enables follow + scrolls to bottom. The buffer is bounded by `useLogStream`.

- [ ] **Step 1: Write the failing test** (`Logs.test.tsx`) — stub `EventSource` (as in Task 5), MSW for `/api/apps` (selector) + `/api/apps/order` (log paths); assert: (a) with an app whose `daprdLogPath` is set and a dispatched message, a log line renders with its text; (b) an app with no log path shows the empty-state copy. Wrap in `QueryProvider`+`RefreshProvider`+`createMemoryRouter` with `initialEntries: ['/logs?app=order&source=daprd']`.
```tsx
// Reuse the FakeES stub from Task 5's test. Mock /api/apps -> [{appId:'order',...}],
// /api/apps/order -> { appId:'order', daprdLogPath:'/l/daprd.log', metadataOk:true, ... }.
// Dispatch es.onmessage({data:'level=info hello'}); assert screen.getByText(/hello/) appears.
// Second test: /api/apps/order -> { appId:'order', daprdLogPath:'', appLogPath:'' };
// assert the "No log file" empty state renders and NO EventSource was opened.
```
(Write both `it` blocks fully, mirroring the Task-5 FakeES setup + the Plan-4 page-test structure.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Logs.tsx`; change `router.tsx`'s `{ path: 'logs', element: <Placeholder title="Logs" /> }` → `<Logs />`; and in `AppDetail.tsx` add a "View logs" `<Link to={'/logs?app='+app.appId+'&source=daprd'}>` in the header or Paths section (cross-nav). Follow/scroll: use a scroll-container ref; on new `lines` length change, if following, set `scrollTop = scrollHeight`; an `onScroll` handler sets following=false when the user is not near the bottom and following=true via the Jump button.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run Logs && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx web/src/router.tsx web/src/pages/AppDetail.tsx && git commit -m "feat(web): Logs page (live tail, follow, level coloring, search)"`

---

### Task 7: Frontend — news types + `useNews` + seen-state helper

**Files:** Create `web/src/hooks/useNews.ts`, `web/src/hooks/useNews.test.tsx`, `web/src/lib/newsSeen.ts`, `web/src/lib/newsSeen.test.ts`. (`NewsItem`/`NewsResponse` types already added in `web/src/types/logs.ts` in Task 5 — import from there, or move them to `web/src/types/news.ts`; keep one canonical location and import it.)

**Interfaces — Produces:**
- `useNews(): { data?: NewsResponse }` — TanStack Query against `/api/news`, `staleTime: 60*60*1000` (hourly), `refetchInterval: 60*60*1000`.
- `newsSeen.ts`: `newsUrls(n: NewsResponse): string[]` (the non-null slot URLs); `getSeen(): Set<string>` / `markSeen(urls: string[])` (localStorage key `devdash.newsSeen`); `hasUnseen(n: NewsResponse): boolean`.

- [ ] **Step 1: Write the failing tests.** `newsSeen.test.ts`:
```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { newsUrls, getSeen, markSeen, hasUnseen } from './newsSeen'
import type { NewsResponse } from '../types/logs'

const resp: NewsResponse = { blog: { title: 'B', url: 'u1' }, report: null, webinar: { title: 'W', url: 'u2' }, event: null }

beforeEach(() => localStorage.clear())

describe('newsSeen', () => {
  it('tracks unseen vs seen URLs', () => {
    expect(newsUrls(resp)).toEqual(['u1', 'u2'])
    expect(hasUnseen(resp)).toBe(true)
    markSeen(['u1', 'u2'])
    expect(getSeen().has('u1')).toBe(true)
    expect(hasUnseen(resp)).toBe(false)
  })
})
```
`useNews.test.tsx`: MSW `/api/news` returns a NewsResponse; assert `data.blog.title` renders via a probe.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `newsSeen.ts` and `useNews.ts`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run useNews newsSeen && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/hooks/useNews.ts web/src/hooks/useNews.test.tsx web/src/lib/newsSeen.ts web/src/lib/newsSeen.test.ts && git commit -m "feat(web): useNews hook + seen-state helpers"`

---

### Task 8: Frontend — Resources sidebar (static sections + collapse)

**Files:** Create `web/src/components/ResourcesSidebar.tsx`, `web/src/components/ResourcesSidebar.test.tsx`; **modify** `web/src/App.tsx`.

**Interfaces — Produces:** `<ResourcesSidebar/>` — a themed **left** rail (~240px expanded) rendered between `TopNav` and... no: in `App.tsx`, wrap the content row so the sidebar sits to the **left** of `<Outlet/>`. Sections **Build / Learn / Read / Run & Operate** with the exact links from Global Constraints (text-only, `target="_blank" rel="noopener noreferrer"`, rounded hover rows, uppercase section headers). A **collapse toggle** (`data-cy="sidebar-toggle"`); collapsed state persisted in `localStorage` (`devdash.sidebarCollapsed`); when collapsed the rail is narrow and shows the word "Resources" rotated `-90°` (clicking it expands). (News section added in Task 9 — leave a clearly marked placeholder slot at the top, e.g. a `{/* News slot — Task 9 */}` region, or render an empty News header now.) Honor `prefers-reduced-motion` (no width transition when set).

- [ ] **Step 1: Write the failing test** (`ResourcesSidebar.test.tsx`): asserts the static links render with correct hrefs + `target="_blank"` (e.g. Dapr Docs → `https://docs.dapr.io`), and that clicking `data-cy="sidebar-toggle"` toggles a collapsed state (e.g. the "Resources" vertical label appears / a section link hides). Mock `/api/news` via MSW (returns all-null) so the News section (Task 9) doesn't cause unhandled requests once added — for this task, if the component doesn't call `useNews` yet, no handler is needed; add it in Task 9.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `ResourcesSidebar.tsx` (static sections + collapse + localStorage) and modify `App.tsx`: change the content area to a flex row `<div style={{display:'flex',flex:1,overflow:'hidden'}}><ResourcesSidebar/><div style={{flex:1,overflow:'auto'}}><Outlet/></div></div>`. Keep `TopNav` above and `StatusFooter` below.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run ResourcesSidebar && npm test -- --run App && npm run build` (the existing `App.test.tsx` must still pass — if the layout change breaks an assertion, adapt minimally; add a `/api/news` MSW handler to `App.test.tsx` only once Task 9 wires `useNews`).
- [ ] **Step 5: Commit.** `git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx web/src/App.tsx && git commit -m "feat(web): collapsible Resources sidebar (static sections)"`

---

### Task 9: Frontend — News section + unseen bell

**Files:** Modify `web/src/components/ResourcesSidebar.tsx`, `web/src/components/ResourcesSidebar.test.tsx`; (add `/api/news` MSW handler to `web/src/App.test.tsx` if `App.test` renders the sidebar).

**Interfaces — Consumes:** `useNews`, `newsSeen` helpers (Task 7). **Produces:** a **News** section at the top of the sidebar showing the four slots (blog / report / webinar / event); each present slot is a link (new tab) with its title (+ a muted subtitle: excerpt or event date/location); each absent slot shows a **muted empty state** ("No upcoming events", etc.). A **bell** indicator (`data-cy="news-bell"`) renders in the expanded header AND the collapsed rail when `hasUnseen(news)` is true; clicking the bell, or any News link, calls `markSeen(newsUrls(news))` and clears the bell.

- [ ] **Step 1: Write the failing test** — extend `ResourcesSidebar.test.tsx`: MSW `/api/news` returns `{blog:{title:'Blog A',url:'u1'},report:null,webinar:{title:'WB',url:'u2'},event:null}`; assert the blog title link renders (new tab), the "report"/"event" empty states render, the `data-cy="news-bell"` appears (unseen), and clicking it hides the bell (seen persisted). `beforeEach(() => localStorage.clear())`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the News section in `ResourcesSidebar.tsx` (call `useNews()`; render the 4 slots; bell driven by `hasUnseen`; mark-seen on bell-click + news-link-click). If `App.test.tsx` now renders the sidebar (it does, via `App`), add a `/api/news` MSW handler to its `beforeEach` so output stays pristine.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run ResourcesSidebar && npm test -- --run App && npm test -- --run && npm run build` (full suite green + pristine).
- [ ] **Step 5: Build + manual verify.** `make build && ./bin/dev-dashboard --no-open` → the left sidebar shows News (or empty slots offline) + the static sections, collapses/expands (persisted), and the bell clears on click; the Logs view streams a running app's daprd/app logs with level colors, follow + jump-to-latest, and search highlight; an ad-hoc app shows the no-log empty state. Stop.
- [ ] **Step 6: Commit.** `git add web/src/components/ResourcesSidebar.tsx web/src/components/ResourcesSidebar.test.tsx web/src/App.test.tsx && git commit -m "feat(web): News section + unseen bell in Resources sidebar"`

---

## Self-Review

**Spec coverage (Plan 5 scope):**
- §6.7 Logs — live SSE tail (daprd + app), level coloring, keyword highlight, follow toggle, auto-scroll + pause + jump-to-latest, bounded buffer, close on unmount, ad-hoc empty state → Tasks 1, 2, 5, 6. ✓ (true list **virtualization** is replaced by a bounded buffer per Global Constraints — deferred follow-up.)
- §8 API `GET /api/apps/{appId}/logs?source=daprd|app` (SSE) + `GET /api/news` → Tasks 2, 4. ✓
- §9.6 Resources sidebar — left, ~240px, themed, collapsible (persisted), text-only links (new tab), exact Build/Learn/Read/Run links, collapsed "Resources" rotated -90° → Task 8. ✓
- §9.6 News — server-proxied + cached feed (`/api/news`), four derived slots, upcoming-vs-past from `eventStartDate`, last-good on failure, muted empty slots, **bell** for unseen items (localStorage seen-URLs, cleared on bell/link click, re-raised on new items) → Tasks 3, 4, 7, 9. ✓
- Cross-nav: App detail → Logs (`/logs?app=&source=`) → Task 6. ✓
- **Deferred to Plan 6:** packaging/GoReleaser/install scripts/README. Log list virtualization (TanStack Virtual) and SSE custom backoff are noted follow-ups (native `EventSource` already auto-reconnects).

**Placeholder scan:** The Task-2 test sketch's `readSSEData`/`newStreamServer` helpers are explicitly flagged as sketches to replace with a straightforward `bufio.NewReader` SSE-line loop + `httptest.NewServer` — called out in the step, not left as a hidden TODO. React-page tasks carry the test contract + precise prose (the proven Plan 3/4 approach); Go tasks carry full code. The EventSource jsdom gap is handled by the `FakeES` stub defined in Task 5 and reused in Task 6.

**Type consistency:** Go — `logs.Tail`; `news.{Item,Response,Service,New}`; `server.{logsHandler,newsRouter,Options.News,apiRouter(v,apps,backend,stores,res,newsSvc)}` — note `apiRouter` gains a 6th param `newsSvc` in Task 4 (Task 2 only adds a route inside `appsRouter`, no signature change); Task 4 updates ALL `apiRouter` call sites (`server.go`, `api_test.go`, `server_test.go`). Web — `LogLevel`/`LogLine`/`NewsItem`/`NewsResponse` (one canonical location), `parseLogLevel`, `useLogStream`, `useNews`, `newsUrls`/`getSeen`/`markSeen`/`hasUnseen`, `ResourcesSidebar`, `Logs` referenced consistently; all reuse Plan 1–4 `fetchJSON`/`apiUrl`/`QueryProvider`/`RefreshProvider`/`useApp`/`useApps`/`get()`/MSW/theme tokens. The `FakeES` EventSource stub is the one shared test fixture across Tasks 5–6.

**Note for implementer:** Tasks 1–4 are backend (pure/httptest-testable; no new deps — `pkg/logs` polls, `pkg/news` uses `net/http`). Tasks 5–9 are frontend; each ends with **both** `npm test` and `npm run build`, and must keep output **pristine** (stub `EventSource`; add a `/api/news` MSW handler wherever `App`/sidebar renders). **No** `@tanstack/react-virtual`, SSE client lib, or other new dependency — bounded buffer + native EventSource only.
