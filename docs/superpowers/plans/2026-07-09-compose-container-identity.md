# Compose App Instance Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each compose-run Dapr app instance individually addressable by its container name (`InstanceKey`), so multiple sidecars sharing one `-app-id` get distinct rows, detail pages, and log streams.

**Architecture:** A new routing identity (`InstanceKey`) lives alongside the Dapr identity (`AppID`). It is derived per scan result — compose: app container name → daprd container name → app-id; standalone: always app-id — and resolved in `service.Get` via a two-pass lookup (exact key match first, app-id fallback). The frontend links every per-instance surface by `instanceKey` and keeps Dapr-keyed data (workflows) on `appId`.

**Tech Stack:** Go 1.x (chi, testify, `-tags unit`), React + TypeScript (vite, vitest, msw, testing-library).

**Spec:** `docs/superpowers/specs/2026-07-09-compose-container-identity-design.md`

## Global Constraints

- Zero observable change for `dapr run` / Aspire apps: their `instanceKey` equals `appId`, URLs and UI render identically to today.
- `InstanceKey` fallback order for compose: `AppContainerName` → `DaprdContainerName` → `AppID`.
- `Get` resolution order: exact InstanceKey match across ALL results first, then first AppID match. Unknown key → `ErrNotFound`.
- Workflow pages keep linking by `appId` — do NOT touch `WorkflowDetail.tsx`, `workflows.go`, or `statestore` keys.
- Spec note: the spec describes `InstanceKey` as a field on `ScanResult`; we implement it as a computed method `ScanResult.Key()` (same semantics, no scanner changes) plus a serialized `Instance.InstanceKey` field.
- Go tests: `go test -tags unit -race ./pkg/... ` (or `make test-go`). Web tests: `cd web && npm test`.
- Vitest does NOT typecheck: any `.ts/.tsx` change (test files included) must also pass `cd web && npm run build` (runs `tsc -b`).
- Commit after every green task.

---

### Task 1: Backend — `ScanResult.Key()` + `Instance.InstanceKey` + stable sort

**Files:**
- Modify: `pkg/discovery/service.go` (add `Key()` after the `ScanResult` struct ~line 50; set `InstanceKey` in `enrich` ~line 109; sort ~line 89)
- Modify: `pkg/discovery/types.go` (add field after `AppID`, line 15)
- Test: `pkg/discovery/service_test.go` (append)

**Interfaces:**
- Consumes: existing `ScanResult`, `Instance`, `service.List`/`enrich`.
- Produces: `func (r ScanResult) Key() string` and `Instance.InstanceKey string` with JSON tag `instanceKey` — Tasks 2–3 call `r.Key()` / read `in.InstanceKey`; the frontend (Tasks 4–7) reads the `instanceKey` JSON field.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/discovery/service_test.go`:

```go
func TestScanResultKey(t *testing.T) {
	t.Run("compose uses app container name", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose, AppContainerName: "daprmq-host-1", DaprdContainerName: "daprmq-host-1-dapr"}
		require.Equal(t, "daprmq-host-1", r.Key())
	})
	t.Run("compose falls back to daprd container name", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose, DaprdContainerName: "daprmq-host-1-dapr"}
		require.Equal(t, "daprmq-host-1-dapr", r.Key())
	})
	t.Run("compose falls back to app id", func(t *testing.T) {
		r := ScanResult{AppID: "daprmq-service", Source: SourceCompose}
		require.Equal(t, "daprmq-service", r.Key())
	})
	t.Run("standalone always keys by app id", func(t *testing.T) {
		r := ScanResult{AppID: "order", Source: SourceStandalone, AppContainerName: "ignored"}
		require.Equal(t, "order", r.Key())
	})
	t.Run("empty source keys by app id", func(t *testing.T) {
		require.Equal(t, "order", ScanResult{AppID: "order"}.Key())
	})
}

func TestListSetsInstanceKeyAndSortsWithinAppID(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-host-2"},
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-gateway-1"},
			{AppID: "aaa-app"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})
	list, err := svc.List(context.Background())
	require.NoError(t, err)
	require.Len(t, list, 3)
	require.Equal(t, "aaa-app", list[0].AppID)
	require.Equal(t, "aaa-app", list[0].InstanceKey) // standalone: key == app id
	require.Equal(t, "daprmq-gateway-1", list[1].InstanceKey)
	require.Equal(t, "daprmq-host-2", list[2].InstanceKey)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/discovery/ -run 'TestScanResultKey|TestListSetsInstanceKey' -v`
Expected: FAIL — `r.Key undefined` / `list[0].InstanceKey undefined` (compile errors).

- [ ] **Step 3: Implement**

In `pkg/discovery/service.go`, immediately after the `ScanResult` struct (after line 50):

```go
// Key returns the routing identity for this scan result. Compose sidecars can
// share one -app-id (scaled instances), so they key by container name — the
// app container when paired, else the daprd container; everything else keys
// by AppID. Container names are unique per host, so keys are unique whenever
// a container name is available.
func (r ScanResult) Key() string {
	if r.Source == SourceCompose {
		if r.AppContainerName != "" {
			return r.AppContainerName
		}
		if r.DaprdContainerName != "" {
			return r.DaprdContainerName
		}
	}
	return r.AppID
}
```

In `pkg/discovery/types.go`, add after `AppID` (line 15):

```go
	// InstanceKey is the routing identity: container name for compose apps
	// (falling back to app id), app id otherwise. Unique per instance even
	// when several compose sidecars share one -app-id.
	InstanceKey string `json:"instanceKey"`
```

In `pkg/discovery/service.go` `enrich` (line 109), add `InstanceKey: r.Key(),` to the `Instance` literal, right after `AppID: r.AppID,`:

```go
	in := Instance{
		AppID: r.AppID, InstanceKey: r.Key(), HTTPPort: r.HTTPPort, GRPCPort: r.GRPCPort, AppPort: r.AppPort,
```

In `service.List` (line 89), replace the sort:

```go
	sort.SliceStable(out, func(a, b int) bool {
		if out[a].AppID != out[b].AppID {
			return out[a].AppID < out[b].AppID
		}
		return out[a].InstanceKey < out[b].InstanceKey
	})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -v`
Expected: PASS (all discovery tests, including pre-existing ones).

- [ ] **Step 5: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/types.go pkg/discovery/service_test.go
git commit -m "feat(discovery): add InstanceKey routing identity for compose apps"
```

---

### Task 2: Backend — two-pass `Get` resolution

**Files:**
- Modify: `pkg/discovery/service.go:94-106` (`Get`), `pkg/discovery/service.go:52-55` (`Service` interface doc)
- Test: `pkg/discovery/service_test.go` (append)

**Interfaces:**
- Consumes: `ScanResult.Key()` from Task 1.
- Produces: `Get(ctx, key string)` semantics — exact InstanceKey match first, AppID fallback. All existing callers (`pkg/server/apps.go`, `pkg/server/logs.go`, `cmd/workflow.go`) pass a string and need NO changes.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/discovery/service_test.go`:

```go
func TestGetResolvesInstanceKeyThenAppID(t *testing.T) {
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-gateway-1", DaprdContainerID: "aaa"},
			{AppID: "daprmq-service", Source: SourceCompose, SidecarReachable: false, AppContainerName: "daprmq-host-1", DaprdContainerID: "bbb"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})

	// Exact instance-key hit returns that instance, not the first app-id match.
	in, err := svc.Get(context.Background(), "daprmq-host-1")
	require.NoError(t, err)
	require.Equal(t, "bbb", in.DaprdContainerID)
	require.Equal(t, "daprmq-host-1", in.InstanceKey)

	// A plain app id falls back to the first matching instance (legacy links).
	in, err = svc.Get(context.Background(), "daprmq-service")
	require.NoError(t, err)
	require.Equal(t, "aaa", in.DaprdContainerID)

	// Unknown key still errors.
	_, err = svc.Get(context.Background(), "nope")
	require.ErrorIs(t, err, ErrNotFound)
}

func TestGetInstanceKeyMatchBeatsAppIDMatch(t *testing.T) {
	// "orders" is app-id of the FIRST result but instance key of the SECOND;
	// the key pass must win even though the app-id match appears earlier.
	scan := func() ([]ScanResult, error) {
		return []ScanResult{
			{AppID: "orders", Source: SourceCompose, SidecarReachable: false, AppContainerName: "orders-ctr", DaprdContainerID: "first"},
			{AppID: "other", Source: SourceCompose, SidecarReachable: false, AppContainerName: "orders", DaprdContainerID: "second"},
		}, nil
	}
	svc := New(scan, &http.Client{Timeout: time.Millisecond})
	in, err := svc.Get(context.Background(), "orders")
	require.NoError(t, err)
	require.Equal(t, "second", in.DaprdContainerID)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/discovery/ -run TestGet -v`
Expected: `TestGetResolvesInstanceKeyThenAppID` FAILS — `Get("daprmq-host-1")` returns ErrNotFound (only app-id matching exists today). `TestGetInstanceKeyMatchBeatsAppIDMatch` FAILS — returns "first".

- [ ] **Step 3: Implement**

Replace `Get` in `pkg/discovery/service.go:94-106`:

```go
// Get resolves key as an instance key first (container name for compose
// apps), then as an app id. The app-id fallback keeps legacy links working —
// e.g. workflow pages, which only know the daprd app id — and resolves
// duplicates to the first instance in scan order.
func (s *service) Get(ctx context.Context, key string) (Instance, error) {
	results, err := s.scan()
	if err != nil {
		logger().Error("app scan failed", "err", err)
		return Instance{}, err
	}
	for _, r := range results {
		if r.Key() == key {
			return s.enrich(ctx, r), nil
		}
	}
	for _, r := range results {
		if r.AppID == key {
			return s.enrich(ctx, r), nil
		}
	}
	return Instance{}, fmt.Errorf("%w: %s", ErrNotFound, key)
}
```

Update the interface (line 52-55) to document the semantics:

```go
type Service interface {
	List(ctx context.Context) ([]Instance, error)
	// Get resolves key as an InstanceKey first, then as an AppID (first match).
	Get(ctx context.Context, key string) (Instance, error)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/discovery/ -v`
Expected: PASS. (Note: for standalone results `Key() == AppID`, so pass 1 already satisfies every pre-existing `Get` test.)

- [ ] **Step 5: Run the full Go suite (callers compile, server tests green)**

Run: `go test -tags unit -race ./...`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add pkg/discovery/service.go pkg/discovery/service_test.go
git commit -m "feat(discovery): Get resolves InstanceKey first, AppID as fallback"
```

---

### Task 3: Backend — `instanceKey` on actor/subscription rows; loadedBy uses instance keys

**Files:**
- Modify: `pkg/server/actors.go` (row struct line 12-17, loop line 29-36)
- Modify: `pkg/server/subscriptions.go` (row struct line 12-19, loop line 31-45)
- Modify: `pkg/server/resources.go` (`loadedByFor` line 64-80, `loadedByIndex` line 82-98)
- Test: `pkg/server/actors_test.go`, `pkg/server/subscriptions_test.go`, `pkg/server/resources_test.go` (append)

**Interfaces:**
- Consumes: `Instance.InstanceKey` from Task 1 (empty in old test fixtures — fall back to `AppID`).
- Produces: JSON `instanceKey` on every `/api/actors` and `/api/subscriptions` row; `loadedBy` arrays contain instance keys (== app ids for non-compose). Tasks 4/7 consume these.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/server/actors_test.go`:

```go
func TestActorsRowsCarryInstanceKey(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Actors: []discovery.ActorType{{Type: "QueueActor", Count: 1}}},
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-2", Actors: []discovery.ActorType{{Type: "QueueActor", Count: 2}}},
		// Fixture without InstanceKey (pre-existing shape) falls back to app id.
		{AppID: "cart", Actors: []discovery.ActorType{{Type: "CartActor", Count: 1}}},
	}}
	h := actorsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceKey":"daprmq-host-1"`)
	require.Contains(t, body, `"instanceKey":"daprmq-host-2"`)
	require.Contains(t, body, `"instanceKey":"cart"`)
}
```

Append to `pkg/server/subscriptions_test.go`:

```go
func TestSubscriptionsRowsCarryInstanceKey(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Subscriptions: []discovery.Subscription{{PubsubName: "kafka-pubsub", Topic: "orders"}}},
		{AppID: "cart", Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "carts"}}},
	}}
	h := subscriptionsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceKey":"daprmq-host-1"`)
	require.Contains(t, body, `"instanceKey":"cart"`)
}
```

Append to `pkg/server/resources_test.go`:

```go
func TestLoadedByUsesInstanceKeys(t *testing.T) {
	res := fakeResources{items: []resources.Resource{{Name: "statestore", Kind: resources.KindComponent, Type: "state.postgresql"}}}
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-1", Components: []discovery.Component{{Name: "statestore"}}},
		{AppID: "daprmq-service", InstanceKey: "daprmq-host-2", Components: []discovery.Component{{Name: "statestore"}}},
	}}
	h := resourcesRouter(res, apps)

	r1, body := get(t, h, "/component/statestore")
	require.Equal(t, http.StatusOK, r1.StatusCode)
	require.Contains(t, body, `"loadedBy":["daprmq-host-1","daprmq-host-2"]`)

	r2, body2 := get(t, h, "/?kind=component")
	require.Equal(t, http.StatusOK, r2.StatusCode)
	require.Contains(t, body2, `"loadedBy":["daprmq-host-1","daprmq-host-2"]`)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit -race ./pkg/server/ -run 'TestActorsRowsCarryInstanceKey|TestSubscriptionsRowsCarryInstanceKey|TestLoadedByUsesInstanceKeys' -v`
Expected: FAIL — `unknown field InstanceKey` is NOT an error (Instance has it from Task 1); the assertions on `"instanceKey":` fail because rows don't serialize it yet, and `loadedBy` contains `["daprmq-service","daprmq-service"]`.

- [ ] **Step 3: Implement**

In `pkg/server/actors.go`, add the field and a shared helper:

```go
// ActorRow is a single actor-type entry returned by GET /api/actors.
type ActorRow struct {
	AppID       string `json:"appId"`
	InstanceKey string `json:"instanceKey"`
	Type        string `json:"type"`
	Count       int    `json:"count"`
	Placement   string `json:"placement,omitempty"`
}

// instanceKey returns the instance's routing identity, tolerating fixtures
// (and any pre-InstanceKey producer) that only set AppID.
func instanceKey(in discovery.Instance) string {
	if in.InstanceKey != "" {
		return in.InstanceKey
	}
	return in.AppID
}
```

and in the row-building loop (line ~34):

```go
			for _, a := range in.Actors {
				rows = append(rows, ActorRow{AppID: in.AppID, InstanceKey: instanceKey(in), Type: a.Type, Count: a.Count, Placement: in.Placement})
			}
```

In `pkg/server/subscriptions.go`:

```go
// SubscriptionRow is a single subscription entry returned by GET /api/subscriptions.
type SubscriptionRow struct {
	AppID           string              `json:"appId"`
	InstanceKey     string              `json:"instanceKey"`
	PubsubName      string              `json:"pubsubName"`
	Topic           string              `json:"topic"`
	Rules           []discovery.SubRule `json:"rules,omitempty"`
	DeadLetterTopic string              `json:"deadLetterTopic,omitempty"`
	Type            string              `json:"type,omitempty"`
}
```

and in its loop (line ~36):

```go
				rows = append(rows, SubscriptionRow{
					AppID:           in.AppID,
					InstanceKey:     instanceKey(in),
					PubsubName:      s.PubsubName,
					Topic:           s.Topic,
					Rules:           s.Rules,
					DeadLetterTopic: s.DeadLetterTopic,
					Type:            s.Type,
				})
```

In `pkg/server/resources.go`, switch both helpers to instance keys (update their doc comments too):

```go
// loadedByFor returns the sorted instance keys whose instance contains component name.
// It lists apps once and scans only for the requested name, avoiding a full index build.
func loadedByFor(ctx context.Context, apps discovery.Service, name string) []string {
	list, err := apps.List(ctx)
	if err != nil {
		return nil
	}
	var ids []string
	for _, in := range list {
		for _, c := range in.Components {
			if c.Name == name {
				ids = append(ids, instanceKey(in))
				break
			}
		}
	}
	sort.Strings(ids)
	return ids
}

// loadedByIndex maps component name -> sorted instance keys that loaded it.
func loadedByIndex(ctx context.Context, apps discovery.Service) map[string][]string {
	idx := map[string][]string{}
	list, err := apps.List(ctx)
	if err != nil {
		return idx
	}
	for _, in := range list {
		for _, c := range in.Components {
			idx[c.Name] = append(idx[c.Name], instanceKey(in))
		}
	}
	for k := range idx {
		sort.Strings(idx[k])
	}
	return idx
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit -race ./pkg/server/ -v`
Expected: PASS — including the pre-existing `TestResourcesListWithLoadedBy` (`loadedBy:["order"]` still holds via the AppID fallback) and `TestActorsAggregate`.

- [ ] **Step 5: Commit**

```bash
git add pkg/server/actors.go pkg/server/subscriptions.go pkg/server/resources.go pkg/server/actors_test.go pkg/server/subscriptions_test.go pkg/server/resources_test.go
git commit -m "feat(server): expose instanceKey on actor/subscription rows and loadedBy"
```

---

### Task 4: Frontend — types, `appKey` helper, Applications overview

**Files:**
- Modify: `web/src/types/api.ts` (AppSummary, line 8-30)
- Create: `web/src/lib/appKey.ts`
- Modify: `web/src/pages/Applications.tsx` (list loop line 97-99, `AppRow` line 109-148)
- Test: `web/src/pages/Applications.test.tsx` (append)

**Interfaces:**
- Consumes: `instanceKey` JSON field from Task 1.
- Produces: `AppSummary.instanceKey?: string`; `export function appKey(app: Pick<AppSummary, 'appId' | 'instanceKey'>): string` in `web/src/lib/appKey.ts` — Tasks 5 and 6 import `appKey` from `'../lib/appKey'`.

- [ ] **Step 1: Write the failing tests**

Append inside the `describe('Applications', ...)` block in `web/src/pages/Applications.test.tsx`:

```tsx
  it('compose apps with duplicate app ids link by container name with the app id underneath', async () => {
    mockApps([
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-1', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
      { ...baseApp, appId: 'daprmq-service', instanceKey: 'daprmq-host-2', source: 'compose', composeProject: 'dapr-mq', sidecarReachable: true, runTemplate: '' },
    ])
    renderAt()
    const link1 = await screen.findByRole('link', { name: /daprmq-host-1/ })
    expect(link1).toHaveAttribute('href', '/apps/daprmq-host-1')
    expect(screen.getByRole('link', { name: /daprmq-host-2/ })).toHaveAttribute('href', '/apps/daprmq-host-2')
    // The app id renders as a secondary line in each of the two rows.
    expect(screen.getAllByText('daprmq-service')).toHaveLength(2)
  })

  it('non-compose apps render a single-line app id and link by app id', async () => {
    mockApps([{ ...baseApp, instanceKey: 'order' }])
    renderAt()
    const link = await screen.findByRole('link', { name: 'order' })
    expect(link).toHaveAttribute('href', '/apps/order')
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: FAIL — links still `href="/apps/daprmq-service"`, no secondary app-id line (`getAllByText('daprmq-service')` finds links, not 2 secondary spans; the href assertion fails first).

- [ ] **Step 3: Implement**

`web/src/types/api.ts` — add to `AppSummary` after `appId`:

```ts
  /** routing identity: container name for compose apps, appId otherwise */
  instanceKey?: string
```

Create `web/src/lib/appKey.ts`:

```ts
import type { AppSummary } from '../types/api'

/**
 * Routing identity for an app instance: instanceKey (container name for
 * compose apps) with appId fallback for older payloads and test fixtures.
 */
export function appKey(app: Pick<AppSummary, 'appId' | 'instanceKey'>): string {
  return app.instanceKey || app.appId
}
```

`web/src/pages/Applications.tsx` — import the helper:

```tsx
import { appKey } from '../lib/appKey'
```

Replace the list loop (line 97-99):

```tsx
              {apps.map((app) => (
                <AppRow key={appKey(app)} app={app} onOpen={() => navigate(`/apps/${appKey(app)}`)} />
              ))}
```

In `AppRow`, replace the App ID cell (line 125-129). Compose apps with a distinct key show the container name as the primary line and the app id as a smaller muted line; everything else is unchanged:

```tsx
  const key = appKey(app)
  const hasContainerName = key !== app.appId
```

(place these two lines at the top of `AppRow`, after the `unreachable` const), then:

```tsx
      <td className="b">
        <Link className="celllink" to={`/apps/${key}`} onClick={(e) => e.stopPropagation()}>
          {hasContainerName ? (
            <>
              {key}
              <span className="muted" style={{ display: 'block', fontSize: 11, fontWeight: 400 }}>
                {app.appId}
              </span>
            </>
          ) : (
            app.appId
          )}
        </Link>
      </td>
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Applications.test.tsx`
Expected: PASS (new tests and all pre-existing ones — old fixtures have no `instanceKey`, so `appKey` falls back to `appId`).

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/api.ts web/src/lib/appKey.ts web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat(web): Applications rows keyed and linked by instanceKey"
```

---

### Task 5: Frontend — App detail shows container name, links logs by key

**Files:**
- Modify: `web/src/pages/AppDetail.tsx` (header lines 36-51, logs link line 49, doc title line 15)
- Test: `web/src/pages/AppDetail.test.tsx` (append)

**Interfaces:**
- Consumes: `appKey` from `'../lib/appKey'` (Task 4); `instanceKey` on the `/api/apps/:key` payload (Task 1). The `:appId` route param needs no rename — the backend resolves keys and app ids alike (Task 2).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing test**

Append inside `describe('AppDetail', ...)` in `web/src/pages/AppDetail.test.tsx`:

```tsx
  it('shows the container name under the title and links logs by instance key', async () => {
    server.use(
      http.get('/api/apps/order', () =>
        HttpResponse.json({
          appId: 'daprmq-service',
          instanceKey: 'daprmq-host-1',
          health: 'healthy',
          runtime: 'dotnet',
          httpPort: 3502,
          grpcPort: 50003,
          appPort: 8080,
          metadataOk: true,
          source: 'compose',
          composeProject: 'dapr-mq',
          sidecarReachable: true,
          daprdContainerId: 'aaa111bbb222',
          daprdContainerName: 'daprmq-host-1-dapr',
          appContainerId: 'ccc333ddd444',
          appContainerName: 'daprmq-host-1',
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'daprmq-service' })).toBeInTheDocument())
    // Container name appears as the header sub-line (also as the Container kv value).
    expect(screen.getAllByText('daprmq-host-1').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByRole('link', { name: /view logs/i })).toHaveAttribute(
      'href',
      '/logs?app=daprmq-host-1&source=daprd',
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: FAIL — logs link href is `/logs?app=daprmq-service&source=daprd` and only one `daprmq-host-1` text node exists (the Container kv value).

- [ ] **Step 3: Implement**

In `web/src/pages/AppDetail.tsx`, import the helper:

```tsx
import { appKey } from '../lib/appKey'
```

At the top of `AppDetailContent`, next to the existing consts (line 22-24):

```tsx
  const key = appKey(app)
  const hasContainerName = key !== app.appId
```

Replace the page-header block (lines 36-51) so the container name renders as a sub-line under the title, and the logs link carries the key:

```tsx
      {/* Page header */}
      <div className="phead">
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <h1>{app.appId}</h1>
            <span className="health">
              <span className={`led ${ledClass(app.health)}`} /> {app.health}
            </span>
            <span className="lang">
              <span className="sw" style={{ background: runtimeSwatch(app.runtime) }} />
              {app.runtime}
            </span>
          </div>
          {hasContainerName && <div className="sub mono">{key}</div>}
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="tbtn" onClick={() => navigate('/')}>← Back</button>
          <Link className="tbtn" to={`/logs?app=${key}&source=daprd`}>View logs</Link>
        </div>
      </div>
```

Update the document title (line 15) so browser tabs distinguish instances:

```tsx
  useDocumentTitle(appKey(app))
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: PASS — including `sets the document title to the app id` (fixture has no `instanceKey`, so `appKey` returns `order`).

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(web): AppDetail shows container name and links logs by instanceKey"
```

---

### Task 6: Frontend — Logs dropdown distinguishes instances

**Files:**
- Modify: `web/src/pages/Logs.tsx` (line 389-390 `appIds`, line 501-507 options)
- Test: `web/src/pages/Logs.test.tsx` (append)

**Interfaces:**
- Consumes: `appKey` from `'../lib/appKey'`; `instanceKey` on `/api/apps` summaries. `useApp(appId)` / `useLogStream` already accept any identifier string — the backend resolves it (Task 2); no hook changes.
- Produces: dropdown option values are instance keys; labels read `appId (instanceKey)` when they differ.

- [ ] **Step 1: Write the failing test**

Append inside the top-level `describe` in `web/src/pages/Logs.test.tsx` (reuse the existing `COMPOSE_SUMMARY`/`COMPOSE_DETAIL` fixtures and `renderAt` helper):

```tsx
  it('app dropdown lists duplicate-app-id compose instances as distinct options keyed by instanceKey', async () => {
    const host1 = { ...COMPOSE_SUMMARY, appId: 'daprmq-service', instanceKey: 'daprmq-host-1' }
    const host2 = { ...COMPOSE_SUMMARY, appId: 'daprmq-service', instanceKey: 'daprmq-host-2' }
    server.use(
      http.get('/api/apps', () => HttpResponse.json([host1, host2])),
      http.get('/api/apps/daprmq-host-1', () =>
        HttpResponse.json({ ...COMPOSE_DETAIL, appId: 'daprmq-service', instanceKey: 'daprmq-host-1' }),
      ),
    )
    renderAt('/logs?app=daprmq-host-1&source=daprd')
    const select = await screen.findByLabelText('App')
    const values = Array.from(select.querySelectorAll('option')).map(o => o.value)
    expect(values).toContain('daprmq-host-1')
    expect(values).toContain('daprmq-host-2')
    // Labels disambiguate: app id + container name.
    expect(screen.getByRole('option', { name: 'daprmq-service (daprmq-host-1)' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'daprmq-service (daprmq-host-2)' })).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx`
Expected: FAIL — option values are `daprmq-service` twice.

- [ ] **Step 3: Implement**

In `web/src/pages/Logs.tsx`, import the helper:

```tsx
import { appKey } from '../lib/appKey'
```

Replace line 390 (`const appIds = ...`):

```tsx
  const appOptions = (apps ?? []).map(a => {
    const key = appKey(a)
    return { key, label: key !== a.appId ? `${a.appId} (${key})` : a.appId }
  })
```

Replace the options render (lines 502-506):

```tsx
          {appOptions.map(o => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Logs.test.tsx`
Expected: PASS (all pre-existing Logs tests too — non-compose fixtures produce `key === appId`, identical options).

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx
git commit -m "feat(web): Logs app selector keys options by instanceKey"
```

---

### Task 7: Frontend — Actors & Subscriptions link by instance key

**Files:**
- Modify: `web/src/types/resources.ts` (Actor line 1-6, Subscription line 13-21)
- Modify: `web/src/pages/Actors.tsx` (row key line 107, `ActorRow` line 122-147, hosting-apps stat line 65)
- Modify: `web/src/pages/Subscriptions.tsx` (row key line 79, `SubscriptionRow` line 92-125)
- Test: `web/src/pages/Actors.test.tsx`, `web/src/pages/Subscriptions.test.tsx` (append)

Note: `ResourceDetail.tsx` needs NO change — `loadedBy` values are already instance keys after Task 3 and the existing `to={'/apps/' + appId}` link renders them correctly.

**Interfaces:**
- Consumes: `instanceKey` on actor/subscription rows (Task 3).
- Produces: nothing consumed downstream.

- [ ] **Step 1: Write the failing tests**

Append to `web/src/pages/Actors.test.tsx` inside its `describe` (both test files define `function renderAt(entry = …)` and mock via `server.use(http.get(...))`):

```tsx
  it('duplicate-app-id instances render distinct rows linking by instanceKey', async () => {
    server.use(
      http.get('/api/actors', () =>
        HttpResponse.json([
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-1', type: 'QueueActor', count: 1, placement: 'connected' },
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-2', type: 'QueueActor', count: 2, placement: 'connected' },
        ]),
      ),
    )
    renderAt()
    const links = await screen.findAllByRole('link', { name: /daprmq-service/ })
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/apps/daprmq-host-1', '/apps/daprmq-host-2'])
    // Container names shown to tell the rows apart.
    expect(screen.getByText('(daprmq-host-1)')).toBeInTheDocument()
    expect(screen.getByText('(daprmq-host-2)')).toBeInTheDocument()
  })
```

Append to `web/src/pages/Subscriptions.test.tsx` inside its `describe` (same `renderAt()` pattern, mocking `GET /api/subscriptions`):

```tsx
  it('duplicate-app-id instances render distinct rows linking by instanceKey', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-1', pubsubName: 'kafka-pubsub', topic: 'orders' },
          { appId: 'daprmq-service', instanceKey: 'daprmq-host-2', pubsubName: 'kafka-pubsub', topic: 'orders' },
        ]),
      ),
    )
    renderAt()
    const links = await screen.findAllByRole('link', { name: /daprmq-service/ })
    expect(links.map(l => l.getAttribute('href'))).toEqual(['/apps/daprmq-host-1', '/apps/daprmq-host-2'])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Actors.test.tsx src/pages/Subscriptions.test.tsx`
Expected: FAIL — hrefs are `/apps/daprmq-service` for both rows (and Actors may render only via duplicate React keys).

- [ ] **Step 3: Implement**

`web/src/types/resources.ts` — add to both interfaces after `appId`:

```ts
  /** routing identity: container name for compose apps, appId otherwise */
  instanceKey?: string
```

`web/src/pages/Actors.tsx`:

Row keys (line 107):

```tsx
              {actors.map((actor) => (
                <ActorRow key={`${actor.instanceKey ?? actor.appId}/${actor.type}`} actor={actor} />
              ))}
```

Hosting-apps stat counts instances (line 65):

```tsx
  const hostingApps = new Set(actors.map((a) => a.instanceKey ?? a.appId)).size
```

`ActorRow` host-app cell (line 126-128):

```tsx
function ActorRow({ actor }: { actor: Actor }) {
  const isInternal = actor.type.toLowerCase().includes(INTERNAL_PREFIX)
  const key = actor.instanceKey ?? actor.appId
  return (
    <tr>
      <td className="b">
        <Link className="celllink" to={`/apps/${key}`}>
          {actor.appId}
          {key !== actor.appId && (
            <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({key})</span>
          )}
        </Link>
      </td>
```

(rest of the row unchanged)

`web/src/pages/Subscriptions.tsx`:

Row keys (line 79):

```tsx
              {subscriptions.map((sub) => (
                <SubscriptionRow key={`${sub.instanceKey ?? sub.appId}/${sub.pubsubName}/${sub.topic}`} sub={sub} />
              ))}
```

`SubscriptionRow` app cell (line 100-102):

```tsx
function SubscriptionRow({ sub }: { sub: Subscription }) {
  const rules = sub.rules ?? []
  const firstPath = rules[0]?.path
  const hasMultipleRules = rules.length > 1
  const scopes = sub.scopes ?? []
  const key = sub.instanceKey ?? sub.appId

  return (
    <tr>
      <td className="b">
        <Link to={`/apps/${key}`}>
          {sub.appId}
          {key !== sub.appId && (
            <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({key})</span>
          )}
        </Link>
      </td>
```

(rest of the row unchanged)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Actors.test.tsx src/pages/Subscriptions.test.tsx src/pages/ResourceDetail.test.tsx`
Expected: PASS.

- [ ] **Step 5: Typecheck**

Run: `cd web && npm run build`
Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/types/resources.ts web/src/pages/Actors.tsx web/src/pages/Subscriptions.tsx web/src/pages/Actors.test.tsx web/src/pages/Subscriptions.test.tsx
git commit -m "feat(web): Actors and Subscriptions link app instances by instanceKey"
```

---

### Task 8: Full verification — suites, build, live daprmq stack

**Files:**
- No source changes expected (fix anything the suites surface).

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Run the complete test matrix**

```bash
make lint && make test
```

Expected: gofmt/vet/eslint clean; all Go unit tests and all vitest suites PASS.

- [ ] **Step 2: Build the binary (includes web tsc + vite build)**

```bash
make build
```

Expected: `bin/dev-dashboard` produced, exit 0.

- [ ] **Step 3: Verify live against the running dapr-mq stack (4 sidecars share app-id `daprmq-service`)**

The stack from `/Users/marcduiker/dev/temp/dapr-mq/docker-compose.yml` must be up (`docker ps` shows `daprmq-host-1..3` and `daprmq-gateway-1` plus their `-dapr` sidecars). Stop the user's running dev-dashboard instance first if it holds the port, then:

```bash
./bin/dev-dashboard &
sleep 3
curl -s http://localhost:9090/api/apps | python3 -c "import json,sys; [print(a['instanceKey'], a['appId']) for a in json.load(sys.stdin)]"
```

Expected output — four distinct keys, one shared app id:

```
daprmq-gateway-1 daprmq-service
daprmq-host-1 daprmq-service
daprmq-host-2 daprmq-service
daprmq-host-3 daprmq-service
```

Then per-instance detail resolves precisely:

```bash
curl -s http://localhost:9090/api/apps/daprmq-host-2 | python3 -c "import json,sys; a=json.load(sys.stdin); print(a['instanceKey'], a['appContainerName'], a['httpPort'])"
```

Expected: `daprmq-host-2 daprmq-host-2 3503` — and the app-id fallback still resolves:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:9090/api/apps/daprmq-service
```

Expected: `200`.

- [ ] **Step 4: Browser spot-check**

Open `http://localhost:9090`: the Applications page shows 4 rows (container name primary, `daprmq-service` muted underneath); clicking each row opens a distinct detail page; "View logs" streams that instance's logs; the Logs dropdown offers `daprmq-service (daprmq-host-1)` … `(daprmq-gateway-1)`.

- [ ] **Step 5: Commit (only if fixes were needed) and report**

```bash
git status
```

Report suite results and live-check findings to the user before merging/PR.
