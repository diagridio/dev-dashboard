# Dev Dashboard — Plan 4: Resources / Actors / Subscriptions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four metadata/YAML-derived global views — **Actors**, **Subscriptions**, **Components**, **Configurations** — with a read-only YAML viewer and full cross-navigation (app ↔ component ↔ app), plus lean nav icons.

**Architecture:** Extend `pkg/discovery`'s `/v1.0/metadata` parsing to also capture each sidecar's actors, subscriptions, registered components, enabled features, and actor placement (carried on `Instance`). The server gains aggregation endpoints `/api/actors` + `/api/subscriptions` (flatten across apps, optional `?appId=` filter). A new `pkg/resources` package loads component + configuration YAML from the same paths discovery already knows; `/api/resources?kind=` lists them and `/api/resources/{kind}/{name}` returns raw YAML, with components enriched by `LoadedBy` (cross-referenced against app metadata in the handler). The SPA replaces the four placeholder routes with real pages, adds a `/resources/:kind/:name` detail with a hand-rolled lightweight YAML highlighter, wires component chips on the App detail, and adds a small local-SVG icon set to the nav.

**Tech Stack:** (builds on Plans 1–3) Go + chi · `sigs.k8s.io/yaml` (already a dep) · React + TanStack Query + React Router. **No new runtime dependencies** — the YAML highlighter is hand-rolled and icons are local inline SVG (no `@mui/material`/Emotion).

**Builds on Plans 1–3 (all merged, `main` @ `3d8fdaf`).** Real interfaces this plan consumes:
- Go: `discovery.Service{List,Get}`, `discovery.Instance{AppID, HTTPPort, Health, ResourcePaths, ConfigPath, RuntimeVersion, MetadataOK, ...}`, `discovery.FetchMetadata(ctx, *http.Client, httpPort) (Metadata, error)`, `discovery.Metadata`, `discovery.New`, `discovery.ErrNotFound`; `statestore.Detect`/`rawComponent` pattern (YAML walking via `sigs.k8s.io/yaml`); `server.Options{BasePath, DistFS, Version, Apps, Backend, Stores}`, `server.NewRouter(opts)`, `apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry) http.Handler`, `writeJSON(w, status, v)`, the `get()`/`postJSON()` test helpers (`pkg/server/spa_test.go`/`workflows_test.go`); `cmd/root.go runServe` (scan-paths logic: `~/.dapr/components` + each app's `ResourcePaths`).
- Web: `apiUrl`/`fetchJSON<T>` (`web/src/lib/api.ts`), `QueryProvider`, `RefreshProvider`/`useRefreshInterval`/`refetchMs` (`web/src/lib/refresh.tsx`), `routes`/`router` (`web/src/router.tsx`), `NAV_ITEMS`/`TopNav` (`web/src/components/TopNav.tsx`), `Placeholder` (`web/src/pages/Placeholder.tsx`), the `Applications.tsx` dense-table pattern (`thStyle`/`tdStyle`, `.mono`, react-router `<Link>` for the id cell, rows-aren't-links), the `copyText` clipboard helper + `Field`/section styling in `AppDetail.tsx`, the `data-cy` + MSW conventions (`web/src/test/setup.ts`), theme tokens (`--surface`, `--border`, `--text*`, `--link`, `--space-1..6`, `.mono`).

**Module path:** `github.com/diagridio/dev-dashboard`. **Go toolchain:** 1.26.x. **Node:** 20 (build-time only).

## Global Constraints

(Inherited verbatim from Plans 1–3 — single binary, desktop-only, light/Compact defaults, base-path-aware, WCAG-AA, **lean bundle (≈300 KB gzipped soft budget)**, headless primitives, theme tokens, monospace+tabular-nums, **local** timestamps, testify + `//go:build unit`, Vitest+RTL+MSW, `data-cy` selectors, never `git add web/dist/`, run `gofmt -w` before committing Go, **`cd web && npm run build` in every web task's verification** since Vitest doesn't typecheck, **test output must be PRISTINE** — no `[MSW] Error: intercepted a request without a matching` lines.) Plan-4-specific:

- **No new runtime dependencies.** Do **not** add `@mui/material`, `@mui/icons-material`, Emotion, or a syntax-highlighting library. The spec's icon system is implemented via the sanctioned lean fallback (§9.5): a tiny local `<svg>` wrapper component, not MUI's `SvgIcon`. The YAML viewer uses a hand-rolled line-based highlighter.
- **Metadata is the source of truth for Actors/Subscriptions** (degrade gracefully when a sidecar's metadata is unavailable — those apps simply contribute no rows). `/v1.0/metadata` JSON shapes (verified, v1.18.0): `actors: [{type, count}]`; `components: [{name, type, version, capabilities?}]`; `subscriptions: [{pubsubname, topic, rules?: [{match, path}], deadLetterTopic, type}]`; `actorRuntime: {runtimeStatus, placement}`; `enabledFeatures: [string]`. Fields not present in metadata (actor idle-timeout, reminders, subscription scopes) are **out of scope** — do not invent them; show only what metadata provides.
- **YAML resources** (Components + Configurations) load from the same paths discovery uses: components from `~/.dapr/components` + each running app's `ResourcePaths`; configurations from `~/.dapr/config.yaml` + each app's `ConfigPath` + any `*.yaml` of `kind: Configuration` under the resource paths. Parse with `sigs.k8s.io/yaml` (mirror `statestore.Detect`). Skip non-YAML / unparseable files silently.
- **Cross-navigation (spec §9.1):** Actors + Subscriptions app columns are `<Link>`s to `/apps/{appId}`; the App detail's loaded-component chips link to `/resources/component/{name}`; the component detail's `LoadedBy` apps link back to `/apps/{appId}`. **Rows aren't links** — the name/id cell (or chip) is the link; the row is not.
- **View state in the URL:** the Actors + Subscriptions pages encode their `?appId=` filter in the query string (shareable, survives refresh/back-forward); document `<title>` updates per view.
- **Autorefresh:** Actors + Subscriptions poll on the single global interval (reuse `useRefreshInterval`/`refetchMs`). Components/Configurations are near-static (`staleTime`, no interval). Logs/SSE remain out of scope (Plan 5).
- **API surface (spec §8):** `GET /api/actors`, `GET /api/subscriptions` (aggregations; `?appId=` optional), `GET /api/resources?kind=component|configuration`, `GET /api/resources/{kind}/{name}`. JSON camelCase keys.

## File Structure

```
pkg/discovery/
  metadata.go        # MODIFY: parse actors/components/subscriptions/enabledFeatures/placement
  metadata_test.go   # MODIFY: assert the new fields decode
  types.go           # MODIFY: Instance gains Actors/Subscriptions/Components/EnabledFeatures/Placement
  service.go         # MODIFY: enrich() copies the new metadata fields onto Instance
  service_test.go    # MODIFY: assert enrich populates them
pkg/resources/
  resources.go       # Kind, Resource, Service interface, New(paths) loader (List/Get)
  resources_test.go
pkg/server/
  actors.go          # actorsRouter(apps discovery.Service) — GET / (aggregate, ?appId)
  actors_test.go
  subscriptions.go   # subscriptionsRouter(apps discovery.Service) — GET / (aggregate, ?appId)
  subscriptions_test.go
  resources.go       # resourcesRouter(res resources.Service, apps discovery.Service) — list + detail + LoadedBy
  resources_test.go
  api.go             # MODIFY: mount /actors, /subscriptions, /resources
  server.go          # MODIFY: Options.Resources resources.Service
  server_test.go     # MODIFY: pass fakes
cmd/root.go          # MODIFY: build resources.New(scanPaths) ; set Options.Resources
web/src/
  components/icons/
    Icon.tsx               # tiny <svg> wrapper (IconProps) + named nav glyphs
    Icon.test.tsx
  components/TopNav.tsx     # MODIFY: render an icon left of each nav label
  types/resources.ts        # Actor, Subscription, ResourceSummary, ResourceDetail TS types
  hooks/useResources.ts     # useActors, useSubscriptions, useResources(kind), useResource(kind,name)
  hooks/useResources.test.tsx
  lib/yaml-highlight.tsx    # highlightYaml(text): ReactNode (line-based, no dep)
  lib/yaml-highlight.test.tsx
  pages/Actors.tsx
  pages/Actors.test.tsx
  pages/Subscriptions.tsx
  pages/Subscriptions.test.tsx
  pages/ResourceList.tsx    # shared list for Components + Configurations (kind prop)
  pages/ResourceList.test.tsx
  pages/ResourceDetail.tsx  # YAML viewer + LoadedBy
  pages/ResourceDetail.test.tsx
  pages/AppDetail.tsx       # MODIFY: add Metadata section (enabled features + component chips)
  pages/AppDetail.test.tsx  # MODIFY: assert chips render + link
  router.tsx                # MODIFY: real Actors/Subscriptions/Components/Configurations + /resources/:kind/:name
```

---

### Task 1: Discovery — parse actors / subscriptions / components from metadata

**Files:** Modify `pkg/discovery/metadata.go`, `pkg/discovery/metadata_test.go`

**Interfaces — Produces (extends `discovery.Metadata`):**
```go
type ActorType struct {
  Type  string `json:"type"`
  Count int    `json:"count"`
}
type SubRule struct {
  Match string `json:"match,omitempty"`
  Path  string `json:"path,omitempty"`
}
type Subscription struct {
  PubsubName      string    `json:"pubsubName"`
  Topic           string    `json:"topic"`
  Rules           []SubRule `json:"rules,omitempty"`
  DeadLetterTopic string    `json:"deadLetterTopic,omitempty"`
  Type            string    `json:"type,omitempty"`
}
type Component struct {
  Name    string `json:"name"`
  Type    string `json:"type"`
  Version string `json:"version,omitempty"`
}
// Metadata gains these fields (in addition to the existing ID/RuntimeVersion/AppPID/...):
//   Actors          []ActorType
//   Subscriptions   []Subscription
//   Components       []Component
//   EnabledFeatures []string
//   Placement       string   // from actorRuntime.placement
```

- [ ] **Step 1: Write the failing test** — extend `metadata_test.go`'s server payload to include `actors`, `components`, `subscriptions`, `actorRuntime`, `enabledFeatures`, and assert they decode:
```go
func TestFetchMetadataRichFields(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{
			"id":"order","runtimeVersion":"1.18.0",
			"enabledFeatures":["ServiceInvocation","StateStore"],
			"actors":[{"type":"OrderActor","count":3}],
			"components":[{"name":"statestore","type":"state.redis","version":"v1"}],
			"subscriptions":[{"pubsubname":"pubsub","topic":"orders","deadLetterTopic":"orders-dlq","type":"PROGRAMMATIC","rules":[{"match":"","path":"/orders"}]}],
			"actorRuntime":{"runtimeStatus":"RUNNING","placement":"placement: connected","hostReady":true},
			"extended":{"appCommand":"go run ./cmd/order"}
		}`))
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())

	md, err := FetchMetadata(context.Background(), &http.Client{Timeout: 2 * time.Second}, port)
	require.NoError(t, err)
	require.Equal(t, []string{"ServiceInvocation", "StateStore"}, md.EnabledFeatures)
	require.Len(t, md.Actors, 1)
	require.Equal(t, "OrderActor", md.Actors[0].Type)
	require.Equal(t, 3, md.Actors[0].Count)
	require.Len(t, md.Components, 1)
	require.Equal(t, "statestore", md.Components[0].Name)
	require.Equal(t, "state.redis", md.Components[0].Type)
	require.Len(t, md.Subscriptions, 1)
	require.Equal(t, "pubsub", md.Subscriptions[0].PubsubName)
	require.Equal(t, "orders", md.Subscriptions[0].Topic)
	require.Equal(t, "orders-dlq", md.Subscriptions[0].DeadLetterTopic)
	require.Equal(t, "/orders", md.Subscriptions[0].Rules[0].Path)
	require.Equal(t, "placement: connected", md.Placement)
}
```
- [ ] **Step 2: Run → fail.** `go test -tags unit ./pkg/discovery/ -run TestFetchMetadataRichFields -v`
- [ ] **Step 3: Implement** — add the types above to `metadata.go`, extend `Metadata` with the five fields, extend `rawMetadata` to decode them, and map them in `FetchMetadata`:
```go
type rawMetadata struct {
	ID             string            `json:"id"`
	RuntimeVersion string            `json:"runtimeVersion"`
	EnabledFeatures []string         `json:"enabledFeatures"`
	Extended       map[string]string `json:"extended"`
	Actors         []ActorType       `json:"actors"`
	Components     []Component       `json:"components"`
	Subscriptions  []rawSubscription `json:"subscriptions"`
	ActorRuntime   struct {
		Placement string `json:"placement"`
	} `json:"actorRuntime"`
}
type rawSubscription struct {
	PubsubName      string    `json:"pubsubname"`
	Topic           string    `json:"topic"`
	Rules           []SubRule `json:"rules"`
	DeadLetterTopic string    `json:"deadLetterTopic"`
	Type            string    `json:"type"`
}
```
In `FetchMetadata`, after decoding `raw`, populate the new `Metadata` fields (map `raw.Subscriptions` → `[]Subscription`; copy `raw.Actors`/`raw.Components`/`raw.EnabledFeatures`/`raw.ActorRuntime.Placement`).
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/discovery/ -v` (the existing `TestFetchMetadata` must still pass — the new fields are additive).
- [ ] **Step 5: Commit.** `gofmt -w pkg/discovery && git add pkg/discovery/metadata.go pkg/discovery/metadata_test.go && git commit -m "feat(discovery): parse actors/subscriptions/components/features from metadata"`

---

### Task 2: Discovery — carry metadata collections on Instance

**Files:** Modify `pkg/discovery/types.go`, `pkg/discovery/service.go`, `pkg/discovery/service_test.go`

**Interfaces — Produces (extends `Instance`):**
```go
//   Actors          []ActorType    `json:"actors,omitempty"`
//   Subscriptions   []Subscription `json:"subscriptions,omitempty"`
//   Components       []Component    `json:"components,omitempty"`
//   EnabledFeatures []string       `json:"enabledFeatures,omitempty"`
//   Placement       string         `json:"placement,omitempty"`
```

- [ ] **Step 1: Write the failing test** — extend `TestServiceListEnriches` (or add a focused test) so the metadata server returns actors+components+subscriptions and assert the enriched `Instance` carries them:
```go
func TestServiceEnrichCarriesMetadataCollections(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1.0/healthz":
			w.WriteHeader(204)
		case "/v1.0/metadata":
			_, _ = w.Write([]byte(`{"id":"order","runtimeVersion":"1.18.0","enabledFeatures":["StateStore"],"actors":[{"type":"OrderActor","count":2}],"components":[{"name":"statestore","type":"state.redis","version":"v1"}],"subscriptions":[{"pubsubname":"pubsub","topic":"orders"}],"actorRuntime":{"placement":"connected"}}`))
		}
	}))
	t.Cleanup(srv.Close)
	u, _ := url.Parse(srv.URL)
	port, _ := strconv.Atoi(u.Port())
	scan := func() ([]ScanResult, error) {
		return []ScanResult{{AppID: "order", HTTPPort: port, Command: "go run ./cmd/order"}}, nil
	}
	svc := New(scan, &http.Client{Timeout: 2 * time.Second})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	in := list[0]
	require.Equal(t, []string{"StateStore"}, in.EnabledFeatures)
	require.Equal(t, "OrderActor", in.Actors[0].Type)
	require.Equal(t, "statestore", in.Components[0].Name)
	require.Equal(t, "orders", in.Subscriptions[0].Topic)
	require.Equal(t, "connected", in.Placement)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add the five fields to `Instance` in `types.go` (JSON tags above), and in `service.go`'s `enrich`, after `md, err := FetchMetadata(...)` succeeds, copy them: `in.Actors = md.Actors; in.Subscriptions = md.Subscriptions; in.Components = md.Components; in.EnabledFeatures = md.EnabledFeatures; in.Placement = md.Placement`.
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/discovery/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/discovery && git add pkg/discovery/ && git commit -m "feat(discovery): carry actors/subs/components on Instance"`

---

### Task 3: API — `/api/actors` aggregation

**Files:** Create `pkg/server/actors.go`, `pkg/server/actors_test.go`; **modify** `pkg/server/api.go`.

**Interfaces — Produces:**
```go
type ActorRow struct {
  AppID     string `json:"appId"`
  Type      string `json:"type"`
  Count     int    `json:"count"`
  Placement string `json:"placement,omitempty"`
}
func actorsRouter(apps discovery.Service) http.Handler // GET / → []ActorRow (optional ?appId= filter)
```
`GET /` lists apps via `apps.List(ctx)`, flattens each instance's `Actors` into `ActorRow`s (carrying `AppID` + `Placement`), sorted by `(AppID, Type)`. `?appId=x` restricts to that app. Apps with no actors contribute nothing.

- [ ] **Step 1: Write the failing test** with a fake `discovery.Service` (reuse the `fakeApps` pattern from `apps_test.go`; if `fakeApps` is shared, set its instances' `Actors`):
```go
//go:build unit

package server

import (
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/stretchr/testify/require"
)

func TestActorsAggregate(t *testing.T) {
	apps := fakeApps{items: []discovery.Instance{
		{AppID: "order", Placement: "connected", Actors: []discovery.ActorType{{Type: "OrderActor", Count: 2}}},
		{AppID: "cart", Actors: []discovery.ActorType{{Type: "CartActor", Count: 1}}},
	}}
	h := actorsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"appId":"order"`)
	require.Contains(t, body, `"type":"OrderActor"`)
	require.Contains(t, body, `"type":"CartActor"`)

	res, body = get(t, h, "/?appId=order")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"OrderActor"`)
	require.NotContains(t, body, `"CartActor"`)
}
```
> If `fakeApps` (from `apps_test.go`) lacks an `Actors`-bearing constructor, just set the field on the literal as shown. `fakeApps.List` returns its `items`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `actors.go`:
```go
package server

import (
	"net/http"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/go-chi/chi/v5"
)

type ActorRow struct {
	AppID     string `json:"appId"`
	Type      string `json:"type"`
	Count     int    `json:"count"`
	Placement string `json:"placement,omitempty"`
}

func actorsRouter(apps discovery.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		list, err := apps.List(req.Context())
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		filter := req.URL.Query().Get("appId")
		rows := []ActorRow{}
		for _, in := range list {
			if filter != "" && in.AppID != filter {
				continue
			}
			for _, a := range in.Actors {
				rows = append(rows, ActorRow{AppID: in.AppID, Type: a.Type, Count: a.Count, Placement: in.Placement})
			}
		}
		sort.SliceStable(rows, func(i, j int) bool {
			if rows[i].AppID != rows[j].AppID {
				return rows[i].AppID < rows[j].AppID
			}
			return rows[i].Type < rows[j].Type
		})
		writeJSON(w, http.StatusOK, rows)
	})
	return r
}
```
- [ ] **Step 4: Modify `api.go`** — add `r.Mount("/actors", actorsRouter(apps))` (no signature change; `apps` is already a param).
- [ ] **Step 5: Run → pass.** `go test -tags unit ./pkg/server/ -v`
- [ ] **Step 6: Commit.** `gofmt -w pkg/server && git add pkg/server/actors.go pkg/server/actors_test.go pkg/server/api.go && git commit -m "feat(server): /api/actors aggregation"`

---

### Task 4: API — `/api/subscriptions` aggregation

**Files:** Create `pkg/server/subscriptions.go`, `pkg/server/subscriptions_test.go`; **modify** `pkg/server/api.go`.

**Interfaces — Produces:**
```go
type SubscriptionRow struct {
  AppID           string                  `json:"appId"`
  PubsubName      string                  `json:"pubsubName"`
  Topic           string                  `json:"topic"`
  Rules           []discovery.SubRule     `json:"rules,omitempty"`
  DeadLetterTopic string                  `json:"deadLetterTopic,omitempty"`
  Type            string                  `json:"type,omitempty"`
}
func subscriptionsRouter(apps discovery.Service) http.Handler // GET / → []SubscriptionRow (?appId=)
```
Same flatten-across-apps pattern as actors; sort by `(AppID, PubsubName, Topic)`.

- [ ] **Step 1: Write the failing test:**
```go
func TestSubscriptionsAggregate(t *testing.T) {
	apps := fakeApps{items: []discovery.Instance{
		{AppID: "order", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "orders", DeadLetterTopic: "orders-dlq", Rules: []discovery.SubRule{{Path: "/orders"}}}}},
		{AppID: "cart", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "carts"}}},
	}}
	h := subscriptionsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"topic":"orders"`)
	require.Contains(t, body, `"deadLetterTopic":"orders-dlq"`)
	require.Contains(t, body, `"topic":"carts"`)

	res, body = get(t, h, "/?appId=cart")
	require.Contains(t, body, `"carts"`)
	require.NotContains(t, body, `"orders"`)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `subscriptions.go` mirroring `actors.go` (flatten `in.Subscriptions` into `SubscriptionRow{AppID, PubsubName, Topic, Rules, DeadLetterTopic, Type}`; same `?appId` filter + stable sort by AppID then PubsubName then Topic).
- [ ] **Step 4: Modify `api.go`** — add `r.Mount("/subscriptions", subscriptionsRouter(apps))`.
- [ ] **Step 5: Run → pass.**
- [ ] **Step 6: Commit.** `gofmt -w pkg/server && git add pkg/server/subscriptions.go pkg/server/subscriptions_test.go pkg/server/api.go && git commit -m "feat(server): /api/subscriptions aggregation"`

---

### Task 5: Resources package — YAML loader

**Files:** Create `pkg/resources/resources.go`, `pkg/resources/resources_test.go`

**Interfaces — Produces:**
```go
type Kind string
const (KindComponent Kind = "component"; KindConfiguration Kind = "configuration")

type Resource struct {
  Name     string   `json:"name"`
  Kind     Kind     `json:"kind"`
  Type     string   `json:"type,omitempty"`    // spec.type (components)
  Version  string   `json:"version,omitempty"` // spec.version
  Path     string   `json:"path"`
  Raw      string   `json:"raw,omitempty"`     // full YAML text (Get only)
  LoadedBy []string `json:"loadedBy,omitempty"`// app ids (filled by server, components only)
}
type Service interface {
  List(ctx context.Context, kind Kind) ([]Resource, error)
  Get(ctx context.Context, kind Kind, name string) (Resource, error)
}
func New(paths []string) Service
var ErrNotFound = errors.New("resource not found")
```
`New(paths)` stores the scan paths. `List(kind)` walks them for `*.yaml`/`*.yml`, parses `kind`/`metadata.name`/`spec.type`/`spec.version` (reuse the `statestore.Detect` rawComponent approach), keeps entries whose `kind` matches (`Component` → `KindComponent`, `Configuration` → `KindConfiguration`), dedup by absolute path, sorted by Name. `Get(kind, name)` finds the matching file and returns the `Resource` with `Raw` = file contents; `ErrNotFound` if none.

- [ ] **Step 1: Write the failing test** (temp YAML dir with a component, a configuration, and a pubsub to exclude):
```go
//go:build unit

package resources

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const compYAML = "apiVersion: dapr.io/v1alpha1\nkind: Component\nmetadata:\n  name: statestore\nspec:\n  type: state.redis\n  version: v1\n"
const cfgYAML = "apiVersion: dapr.io/v1alpha1\nkind: Configuration\nmetadata:\n  name: appconfig\nspec:\n  tracing:\n    samplingRate: \"1\"\n"

func TestResourcesListAndGet(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "statestore.yaml"), []byte(compYAML), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "appconfig.yaml"), []byte(cfgYAML), 0o600))
	svc := New([]string{dir})

	comps, err := svc.List(context.Background(), KindComponent)
	require.NoError(t, err)
	require.Len(t, comps, 1)
	require.Equal(t, "statestore", comps[0].Name)
	require.Equal(t, "state.redis", comps[0].Type)
	require.Empty(t, comps[0].Raw) // List does not include raw

	cfgs, err := svc.List(context.Background(), KindConfiguration)
	require.NoError(t, err)
	require.Len(t, cfgs, 1)
	require.Equal(t, "appconfig", cfgs[0].Name)

	got, err := svc.Get(context.Background(), KindComponent, "statestore")
	require.NoError(t, err)
	require.Contains(t, got.Raw, "state.redis")

	_, err = svc.Get(context.Background(), KindComponent, "missing")
	require.ErrorIs(t, err, ErrNotFound)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `resources.go`. Use `sigs.k8s.io/yaml` to unmarshal a minimal struct (`kind`, `metadata.name`, `spec.type`, `spec.version`); map `kind: Component`→`KindComponent`, `kind: Configuration`→`KindConfiguration`; walk with `filepath.Walk`, `.yaml`/`.yml` only, dedup by `filepath.Abs`. `Get` re-walks (or reuses List) to find the named resource of that kind and reads the file via `os.ReadFile` into `Raw`.
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/resources/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/resources && git add pkg/resources/ && git commit -m "feat(resources): component + configuration YAML loader"`

---

### Task 6: API — `/api/resources` list + detail (+ LoadedBy)

**Files:** Create `pkg/server/resources.go`, `pkg/server/resources_test.go`; **modify** `pkg/server/api.go`, `pkg/server/server.go`, `pkg/server/server_test.go`.

**Interfaces — Produces:**
- `resourcesRouter(res resources.Service, apps discovery.Service) http.Handler` mounting `GET /` (list; required `?kind=component|configuration`; 400 on missing/invalid kind) and `GET /{kind}/{name}` (detail; 404 on `resources.ErrNotFound`). For `kind=component`, the list **and** detail set `LoadedBy` = sorted app ids whose `Instance.Components` contains a component with that `Name` (from `apps.List`).
- `Options` gains `Resources resources.Service`; `apiRouter(v, apps, backend, stores, res)` mounts `/resources`.

- [ ] **Step 1: Write the failing test** with a fake `resources.Service` + `fakeApps`:
```go
//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/stretchr/testify/require"
)

type fakeResources struct{ items []resources.Resource }

func (f fakeResources) List(_ context.Context, kind resources.Kind) ([]resources.Resource, error) {
	var out []resources.Resource
	for _, r := range f.items {
		if r.Kind == kind {
			out = append(out, r)
		}
	}
	return out, nil
}
func (f fakeResources) Get(_ context.Context, kind resources.Kind, name string) (resources.Resource, error) {
	for _, r := range f.items {
		if r.Kind == kind && r.Name == name {
			return r, nil
		}
	}
	return resources.Resource{}, resources.ErrNotFound
}

func TestResourcesListWithLoadedBy(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{Name: "statestore", Kind: resources.KindComponent, Type: "state.redis"}}}
	apps := fakeApps{items: []discovery.Instance{{AppID: "order", Components: []discovery.Component{{Name: "statestore"}}}}}
	h := resourcesRouter(res, apps)

	r1, body := get(t, h, "/?kind=component")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	require.Contains(t, body, `"name":"statestore"`)
	require.Contains(t, body, `"loadedBy":["order"]`)

	r2, _ := get(t, h, "/")
	require.Equal(t, http.StatusBadRequest, r2.StatusCode)

	r3, body3 := get(t, h, "/component/statestore")
	require.Equal(t, http.StatusOK, r3.StatusCode)
	require.Contains(t, body3, `"loadedBy":["order"]`)

	r4, _ := get(t, h, "/component/missing")
	require.Equal(t, http.StatusNotFound, r4.StatusCode)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `resources.go`:
```go
package server

import (
	"errors"
	"net/http"
	"sort"

	"github.com/diagridio/dev-dashboard/pkg/discovery"
	"github.com/diagridio/dev-dashboard/pkg/resources"
	"github.com/go-chi/chi/v5"
)

func resourcesRouter(res resources.Service, apps discovery.Service) http.Handler {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(req.URL.Query().Get("kind"))
		if kind != resources.KindComponent && kind != resources.KindConfiguration {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "kind must be component or configuration"})
			return
		}
		list, err := res.List(req.Context(), kind)
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if kind == resources.KindComponent {
			loaded := loadedByIndex(req.Context(), apps)
			for i := range list {
				list[i].LoadedBy = loaded[list[i].Name]
			}
		}
		if list == nil {
			list = []resources.Resource{}
		}
		writeJSON(w, http.StatusOK, list)
	})
	r.Get("/{kind}/{name}", func(w http.ResponseWriter, req *http.Request) {
		kind := resources.Kind(chi.URLParam(req, "kind"))
		got, err := res.Get(req.Context(), kind, chi.URLParam(req, "name"))
		if errors.Is(err, resources.ErrNotFound) {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "resource not found"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		if kind == resources.KindComponent {
			got.LoadedBy = loadedByIndex(req.Context(), apps)[got.Name]
		}
		writeJSON(w, http.StatusOK, got)
	})
	return r
}

// loadedByIndex maps component name -> sorted app ids that loaded it.
func loadedByIndex(ctx context.Context, apps discovery.Service) map[string][]string {
	idx := map[string][]string{}
	list, err := apps.List(ctx)
	if err != nil {
		return idx
	}
	for _, in := range list {
		for _, c := range in.Components {
			idx[c.Name] = append(idx[c.Name], in.AppID)
		}
	}
	for k := range idx {
		sort.Strings(idx[k])
	}
	return idx
}
```
(add `"context"` import.)
- [ ] **Step 4: Modify `api.go`** — `apiRouter(v version.Info, apps discovery.Service, backend WorkflowBackend, stores StoreRegistry, res resources.Service) http.Handler` and add `r.Mount("/resources", resourcesRouter(res, apps))`.
- [ ] **Step 5: Modify `server.go`** — add `Resources resources.Service` to `Options`; pass `opts.Resources` in the `apiRouter(...)` call.
- [ ] **Step 6: Modify `server_test.go` + `api_test.go`** — update the `apiRouter(...)` call sites to pass a `fakeResources{}` (or `nil` where resources aren't exercised) so they compile; confirm existing tests still pass.
- [ ] **Step 7: Run → pass.** `go test -tags unit ./pkg/server/ -v`
- [ ] **Step 8: Commit.** `gofmt -w pkg/server && git add pkg/server/ && git commit -m "feat(server): /api/resources list + detail with LoadedBy"`

---

### Task 7: Wire resources loader into the CLI

**Files:** Modify `cmd/root.go`

**Interfaces — Consumes:** `resources.New`, `server.Options.Resources`.

- [ ] **Step 1: In `runServe`,** build the resources scan paths (reuse the existing state-store scan-path logic — it already collects `~/.dapr/components` + each app's `ResourcePaths`; ALSO add `~/.dapr/config.yaml`'s dir and each app's `ConfigPath` dir for configurations). Concretely, after `appsSvc` is built:
```go
	var resPaths []string
	if home, err := os.UserHomeDir(); err == nil {
		resPaths = append(resPaths, filepath.Join(home, ".dapr", "components"), filepath.Join(home, ".dapr"))
	}
	if apps, err := appsSvc.List(ctx); err == nil {
		for _, a := range apps {
			resPaths = append(resPaths, a.ResourcePaths...)
			if a.ConfigPath != "" {
				resPaths = append(resPaths, filepath.Dir(a.ConfigPath))
			}
		}
	}
	resSvc := resources.New(resPaths)
```
Then add `Resources: resSvc` to the `server.Options{...}` literal.
- [ ] **Step 2: Verify.** `go build ./... && go vet -tags unit ./... && go test -tags unit ./...` all green.
- [ ] **Step 3: Manual smoke.** `go run . --no-open --port 9097` then `curl -s 'localhost:9097/api/resources?kind=component'`, `curl -s localhost:9097/api/actors`, `curl -s localhost:9097/api/subscriptions` return JSON arrays (possibly `[]`). Stop.
- [ ] **Step 4: Commit.** `gofmt -w cmd && git add cmd/root.go && git commit -m "feat(cmd): wire resources loader into serve"`

---

### Task 8: Frontend — resource types + hooks

**Files:** Create `web/src/types/resources.ts`, `web/src/hooks/useResources.ts`, `web/src/hooks/useResources.test.tsx`

**Interfaces — Produces:**
```ts
export interface Actor { appId: string; type: string; count: number; placement?: string }
export interface SubRule { match?: string; path?: string }
export interface Subscription { appId: string; pubsubName: string; topic: string; rules?: SubRule[]; deadLetterTopic?: string; type?: string }
export type ResourceKind = 'component' | 'configuration'
export interface ResourceSummary { name: string; kind: ResourceKind; type?: string; version?: string; path: string; loadedBy?: string[] }
export interface ResourceDetail extends ResourceSummary { raw?: string }
```
Hooks: `useActors(appId?)` + `useSubscriptions(appId?)` poll on the global interval (append `?appId=` when set); `useResources(kind)` + `useResource(kind, name)` use `staleTime: 60_000` (near-static, no poll).

- [ ] **Step 1: Write the failing test** (MSW), asserting `useActors` hits `/api/actors` and a filtered call carries `?appId=`:
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useActors } from './useResources'

function Probe({ appId }: { appId?: string }) {
  const { data } = useActors(appId)
  return <div>{data?.map((a) => <span key={a.appId + a.type}>{a.type}</span>)}</div>
}

describe('useActors', () => {
  it('lists actors and passes appId filter', async () => {
    server.use(http.get('/api/actors', ({ request }) => {
      expect(new URL(request.url).searchParams.get('appId')).toBe('order')
      return HttpResponse.json([{ appId: 'order', type: 'OrderActor', count: 2 }])
    }))
    render(<QueryProvider><RefreshProvider><Probe appId="order" /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('OrderActor')).toBeInTheDocument())
  })
})
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `types/resources.ts` and `useResources.ts` (use `fetchJSON`, `useRefreshInterval`/`refetchMs`; queryKeys include the appId/kind/name; `useResources`/`useResource` set `staleTime: 60_000` and no `refetchInterval`).
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run useResources && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/types/resources.ts web/src/hooks/useResources.ts web/src/hooks/useResources.test.tsx && git commit -m "feat(web): resource/actor/subscription types + hooks"`

---

### Task 9: Frontend — lightweight YAML highlighter

**Files:** Create `web/src/lib/yaml-highlight.tsx`, `web/src/lib/yaml-highlight.test.tsx`

**Interfaces — Produces:** `highlightYaml(text: string): React.ReactNode` — splits into lines and wraps tokens in `<span>`s with theme-token colors: comments (`#…`) → `--text-faint`; the `key:` portion of `key: value` → `--link`; quoted/scalar values → `--text`; list-dash markers preserved. Returns a `<pre>`-friendly fragment (caller wraps in `<pre className="mono">`). Pure/deterministic; no dependency.

- [ ] **Step 1: Write the failing test:**
```tsx
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { highlightYaml } from './yaml-highlight'

describe('highlightYaml', () => {
  it('highlights keys, comments, and values', () => {
    const { container } = render(<pre>{highlightYaml('# comment\nname: statestore\n')}</pre>)
    const text = container.textContent ?? ''
    expect(text).toContain('# comment')
    expect(text).toContain('name')
    expect(text).toContain('statestore')
    // a key span exists
    expect(container.querySelector('[data-cy="yaml-key"]')).not.toBeNull()
  })
})
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `yaml-highlight.tsx` — for each line: if it (trimmed) starts with `#`, render the whole line in a `--text-faint` span; else match a leading `^(\s*-?\s*)([\w.-]+)(:)(.*)$` — render the indent/dash as-is, the key in a `data-cy="yaml-key"` span colored `--link`, the colon plain, and the remainder (value/comment) plain (`--text`); lines that don't match render verbatim. Join lines with `\n`. Each line should be keyed (`<React.Fragment key={i}>`).
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run yaml-highlight && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/lib/yaml-highlight.tsx web/src/lib/yaml-highlight.test.tsx && git commit -m "feat(web): hand-rolled lightweight YAML highlighter"`

---

### Task 10: Frontend — Actors page

**Files:** Create `web/src/pages/Actors.tsx`, `web/src/pages/Actors.test.tsx`; **modify** `web/src/router.tsx`.

**Interfaces — Produces:** `<Actors/>` — dense table (App · Actor type · Active count · Placement) using `useActors`. **The App cell is a `<Link to={'/apps/'+appId}>`; the row is not a link.** An `?appId=` filter read from the URL (via `useSearchParams`) restricts the list (when present, show a "filtered to {appId} ✕" affordance that clears it). Loading + friendly empty state ("No actors registered"). Polls on the global interval (hook handles it).

- [ ] **Step 1: Write the failing test** (MSW `/api/actors`): a row renders with the app id as a link to `/apps/order`, and empty state when `[]`. (Wrap in `QueryProvider`+`RefreshProvider`+`createMemoryRouter` like the Plan-3 page tests.)
```tsx
// asserts: findByRole('link', { name: 'order' }) has href '/apps/order'; 'OrderActor' + count render;
// and the empty state on [].
```
(Write the two `it` blocks fully, mirroring `Workflows.test.tsx`'s structure: a populated case and an empty case.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Actors.tsx` (mirror `Applications.tsx` table styling; App cell `<Link>`; `.mono` for counts) and change `router.tsx`'s `{ path: 'actors', element: <Placeholder title="Actors" /> }` → `<Actors />`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run Actors && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/Actors.tsx web/src/pages/Actors.test.tsx web/src/router.tsx && git commit -m "feat(web): Actors page"`

---

### Task 11: Frontend — Subscriptions page

**Files:** Create `web/src/pages/Subscriptions.tsx`, `web/src/pages/Subscriptions.test.tsx`; **modify** `web/src/router.tsx`.

**Interfaces — Produces:** `<Subscriptions/>` — dense table (App · Pub/Sub · Topic · Route(s) · Dead-letter · Type) using `useSubscriptions`. App cell `<Link>` to `/apps/{appId}`. **Route(s)** renders the rules' `path`s; when a subscription has >1 rule, show a small **rules badge** (e.g. "{n} rules") next to the first path. `?appId=` URL filter (same affordance as Actors). Loading + empty state ("No subscriptions").

- [ ] **Step 1: Write the failing test** (MSW `/api/subscriptions`): a row renders with the topic + the app-id link, a multi-rule subscription shows a rules badge, and the empty state on `[]`. (Write both `it` blocks.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Subscriptions.tsx` (mirror the table pattern; rules badge when `rules.length > 1`; dead-letter + type cells; `?appId` filter) and change `router.tsx`'s `subscriptions` route → `<Subscriptions />`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run Subscriptions && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/Subscriptions.tsx web/src/pages/Subscriptions.test.tsx web/src/router.tsx && git commit -m "feat(web): Subscriptions page"`

---

### Task 12: Frontend — Components & Configurations list (shared)

**Files:** Create `web/src/pages/ResourceList.tsx`, `web/src/pages/ResourceList.test.tsx`; **modify** `web/src/router.tsx`.

**Interfaces — Produces:** `<ResourceList kind="component" />` and `<ResourceList kind="configuration" />` — a dense table using `useResources(kind)`. Columns for **component**: Name · Type · Version · Loaded by. For **configuration**: Name · Path. **The Name cell is a `<Link to={'/resources/'+kind+'/'+name}>`.** For components, **Loaded by** renders each app id as a `<Link to={'/apps/'+appId}>` chip (or "—" when none). Loading + empty state ("No components"/"No configurations"). Near-static (no poll).

- [ ] **Step 1: Write the failing test** (MSW `/api/resources?kind=component`): a component row's Name links to `/resources/component/statestore`, the Type renders, and a `loadedBy` app renders as a link to `/apps/order`; plus the empty state. Add a second test for `kind=configuration` (Name links to `/resources/configuration/appconfig`).
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `ResourceList.tsx` (the `kind` prop drives the columns + which `useResources(kind)` query); update `router.tsx`: `{ path: 'components', element: <ResourceList kind="component" /> }` and `{ path: 'configurations', element: <ResourceList kind="configuration" /> }`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run ResourceList && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/ResourceList.tsx web/src/pages/ResourceList.test.tsx web/src/router.tsx && git commit -m "feat(web): Components + Configurations list"`

---

### Task 13: Frontend — Resource detail (YAML viewer + LoadedBy)

**Files:** Create `web/src/pages/ResourceDetail.tsx`, `web/src/pages/ResourceDetail.test.tsx`; **modify** `web/src/router.tsx`.

**Interfaces — Produces:** `<ResourceDetail/>` — reads `:kind`/`:name` via `useParams`, calls `useResource(kind, name)`. Header (name `.mono`, kind, type/version). A read-only **YAML viewer**: `<pre className="mono">{highlightYaml(detail.raw ?? '')}</pre>` inside a bordered, horizontally-scrollable container, with a click-to-copy (reuse `copyText` from `AppDetail.tsx`) for the raw text. For components, a **Loaded by** section listing each app id as a `<Link to={'/apps/'+appId}>` (or "not currently loaded"). Loading + not-found states.

- [ ] **Step 1: Write the failing test** (MSW `/api/resources/component/statestore`): asserts the name header, that the YAML body shows `state.redis`, and that a `loadedBy` app links to `/apps/order`; plus a not-found case (404 → "not found" message). Use `createMemoryRouter` with `initialEntries: ['/resources/component/statestore']`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `ResourceDetail.tsx` and add `{ path: 'resources/:kind/:name', element: <ResourceDetail /> }` as a child of the `App` route in `router.tsx`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run ResourceDetail && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/ResourceDetail.tsx web/src/pages/ResourceDetail.test.tsx web/src/router.tsx && git commit -m "feat(web): Resource detail (YAML viewer + loaded-by)"`

---

### Task 14: Frontend — App detail Metadata section (component chips cross-nav)

**Files:** Modify `web/src/pages/AppDetail.tsx`, `web/src/pages/AppDetail.test.tsx`; `web/src/types/api.ts`.

**Interfaces — Consumes:** the `AppDetail` API type gains `enabledFeatures?: string[]`, `actors?: {type;count}[]`, `subscriptions?: {...}[]`, `components?: {name;type;version}[]`, `placement?: string` (mirror the Go `Instance` JSON added in Task 2). **Produces:** a new **Metadata** section on the App detail rendering runtime version, enabled features (comma list), and **loaded components as chips** — each chip a `<Link to={'/resources/component/'+name}>` (cross-nav to the component detail). When `components` is empty/absent, show "—".

- [ ] **Step 1: Write the failing test** — extend `AppDetail.test.tsx`: the `/api/apps/order` mock now returns `components: [{name:'statestore',type:'state.redis',version:'v1'}]` and `enabledFeatures: ['StateStore']`; assert a chip link with `name: 'statestore'` has `href` `/resources/component/statestore`, and that "StateStore" renders. (Wrap with a router that also has `/resources/:kind/:name` so the link resolves.)
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** — add the fields to the `AppDetail` interface in `web/src/types/api.ts`, then add a "Metadata" section to `AppDetail.tsx` (after the Dapr sidecar section): enabled features (join `, ` or "—"), and a chips row mapping `app.components` to `<Link>` chips styled with theme tokens (`--surface` bg, `--border`, `--link` text). Row is not a link; each chip is its own link.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run AppDetail && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx web/src/types/api.ts && git commit -m "feat(web): App detail metadata section + component chips (cross-nav)"`

---

### Task 15: Frontend — nav icons (lean local SVG)

**Files:** Create `web/src/components/icons/Icon.tsx`, `web/src/components/icons/Icon.test.tsx`; **modify** `web/src/components/TopNav.tsx`.

**Interfaces — Produces:** a tiny `Icon` component — `function Icon({ name, size = 16 }: { name: IconName; size?: number })` returning an inline `<svg width=size height=size viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">` with a per-name `<path>` (so it inherits `currentColor` + sizing from context; no MUI, no Emotion). `IconName` covers the 7 nav views: `applications, workflows, actors, subscriptions, components, configurations, logs` (use simple, recognizable Material-style outline paths — e.g. apps grid, flow nodes, people, broadcast, puzzle/cube, gear, list). Each `<path>` is hardcoded SVG path data.

- [ ] **Step 1: Write the failing test:**
```tsx
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Icon } from './Icon'

describe('Icon', () => {
  it('renders an svg that inherits currentColor', () => {
    const { container } = render(<Icon name="workflows" />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
    expect(container.querySelector('path')).not.toBeNull()
  })
})
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Icon.tsx` with the `IconName` union + a `Record<IconName, string>` of path data + the `<svg>` wrapper. Then in `TopNav.tsx`, add an `icon: IconName` field to `NavItem` (map each existing item to its icon) and render `<Icon name={item.icon} />` left of the label inside each `NavLink` (wrap label+icon in a flex span with `gap: var(--space-1)`). Keep the existing active-state styling.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test -- --run Icon && npm test -- --run TopNav && npm run build`
- [ ] **Step 5: Build + manual verify.** `make build && ./bin/dev-dashboard --no-open` → the nav shows icons; Actors/Subscriptions list real data (or empty states); Components/Configurations list YAML resources; clicking a component opens the YAML viewer; app-detail component chips navigate to the component detail and its "loaded by" links back. Stop.
- [ ] **Step 6: Commit.** `git add web/src/components/icons/ web/src/components/TopNav.tsx && git commit -m "feat(web): lean local SVG nav icons"`

---

## Self-Review

**Spec coverage (Plan 4 scope):**
- §6.4 Actors global page (host app, actor type, active count, placement; app-link; `?appId` filter) → Tasks 1–3, 8, 10. Idle-timeout/reminders are **not in `/v1.0/metadata`** → intentionally omitted (Global Constraints). ✓
- §6.5 Subscriptions global page (app, pubsub, topic, routes + rules badge, dead-letter, type; app-link) → Tasks 1, 4, 8, 11. Scopes are **not in metadata** → omitted. ✓
- §6.6 Components & Configurations list + read-only YAML viewer + `LoadedBy` → Tasks 5–6, 8, 9, 12, 13. ✓
- §9.1 cross-navigation (app detail component chips → component detail; component "loaded by" → app detail; Actors/Subs app columns → app detail) → Tasks 6, 10–14. ✓
- §9.1 URL-encoded filter state (`?appId=`), per-view `<title>` → Tasks 10–11 (+ each page sets `document.title`). ✓
- §8 API surface `/api/actors`, `/api/subscriptions`, `/api/resources?kind=`, `/api/resources/{kind}/{name}` → Tasks 3, 4, 6. ✓
- §2 / §9.5 Icons row — implemented via the spec's sanctioned **lean fallback** (local SVG wrapper, no `@mui/material`/Emotion) to protect the bundle budget → Task 15. ✓
- Read-only YAML viewer via a **lightweight** (hand-rolled, zero-dep) highlighter, not Monaco → Task 9. ✓
- **Deferred to later plans:** Logs/SSE + News/Resources sidebar (Plan 5); packaging (Plan 6). The collapsible left "Resources" sidebar (§9.6) is Plan 5, not this plan.

**Placeholder scan:** none. Judgment points are explicitly flagged: metadata fields the spec lists but the endpoint doesn't provide (actor idle-timeout/reminders, subscription scopes) are documented as out-of-scope rather than invented; the icon-system and YAML-highlighter dependency decisions are pinned in Global Constraints (lean/zero-dep). React-page tasks give the test contract + precise prose (mirroring Plan 3's successful approach); the Go tasks carry full code.

**Type consistency:** Go — `discovery.{ActorType,SubRule,Subscription,Component,Metadata(+5 fields),Instance(+5 fields)}`, `resources.{Kind,KindComponent,KindConfiguration,Resource,Service,New,ErrNotFound}`, `server.{ActorRow,SubscriptionRow,actorsRouter,subscriptionsRouter,resourcesRouter,loadedByIndex,Options.Resources,apiRouter(v,apps,backend,stores,res)}` are referenced consistently. Note the `apiRouter` signature gains a 5th param `res` in Task 6 — Tasks 3/4 mount `/actors` + `/subscriptions` inside the existing `apiRouter` body (no signature change), and Task 6 adds the `res` param + updates all call sites (`server.go`, `api_test.go`, `server_test.go`). Web — `Actor/Subscription/ResourceKind/ResourceSummary/ResourceDetail` types, `useActors/useSubscriptions/useResources/useResource`, `highlightYaml`, `Icon/IconName`, and the `AppDetail` type's new fields are used consistently; all reuse Plan 1–3 `fetchJSON`/`QueryProvider`/`RefreshProvider`/`refetchMs`/`copyText`/`get()`/MSW helpers and theme tokens.

**Note for implementer:** Tasks 1–7 are backend (pure/httptest-testable; no new deps — `sigs.k8s.io/yaml` is already present). Tasks 8–15 are frontend; each ends with **both** `npm test` and `npm run build`, and must keep test output **pristine** (add MSW handlers for any `/api/*` a newly-wired page or `App.test.tsx` route-switch triggers — `/api/actors`, `/api/subscriptions`, `/api/resources?kind=...` — exactly as Plan 3 did for `/api/workflows`/`/api/statestores`). No `@mui/*`/Emotion/syntax-highlighter dependencies.
