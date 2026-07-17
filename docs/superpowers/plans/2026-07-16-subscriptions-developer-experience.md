# Subscriptions Developer Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the read-only Subscriptions page into an interactive dev tool — publish a test message to a topic, plus static-insight quick-wins (Type column, drop the dead Scopes column, inline rule inspection).

**Architecture:** A new instance-scoped backend endpoint `POST /api/apps/{appId}/publish` proxies to the resolved sidecar's `/v1.0/publish/{pubsub}/{topic}`. The frontend adds a per-row Publish button that opens a modal (payload editor + content-type + collapsed advanced), plus table changes for the static-insight wins. Follows existing mutation patterns (state-store CRUD, lifecycle actions).

**Tech Stack:** Go (chi router, stdlib `net/http`), React + TypeScript, `@tanstack/react-query`, Vitest + Testing Library + msw.

## Global Constraints

- Go tests use the `unit` build tag. Run: `go test -tags unit -race ./...` (or a single package/test with `-run`). Every new `*_test.go` file starts with `//go:build unit`.
- `gofmt` must be clean (`lint-go` fails otherwise). Run `gofmt -w` on changed Go files before committing.
- Vitest does **not** typecheck. After any `.ts`/`.tsx` change, run `cd web && npm run build` (`tsc -b && vite build`) to catch type errors — a passing `vitest` run alone is not sufficient.
- Frontend tests: `cd web && npx vitest run <file>` for one file, `cd web && npm test` for all.
- Reuse existing patterns: `writeJSON` + explicit status codes (backend); `apiUrl`, `useMutation`, and the `Modal` component (frontend). Do not add new HTTP client abstractions.
- Backend `discovery.Service.Get(ctx, key)` resolves an instance by InstanceKey first, then AppID. The route param is named `{appId}` but accepts either.

---

### Task 1: `Instance.BaseURL()` helper (discovery)

Publishing needs the sidecar's HTTP base URL from a resolved `discovery.Instance`. The logic already exists as the unexported `sidecarBaseURL` in `pkg/discovery/health.go`; expose it as a method on `Instance` so `pkg/server` can use it.

**Files:**
- Modify: `pkg/discovery/health.go`
- Test: `pkg/discovery/health_test.go`

**Interfaces:**
- Produces: `func (in Instance) BaseURL() string` — returns `DaprHTTPBaseURL` (trailing slash trimmed) when set, else `http://127.0.0.1:<HTTPPort>`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/discovery/health_test.go` (package `discovery`):

```go
func TestInstanceBaseURL(t *testing.T) {
	require.Equal(t, "http://127.0.0.1:3500", Instance{HTTPPort: 3500}.BaseURL())
	require.Equal(t, "http://proxy:8080", Instance{DaprHTTPBaseURL: "http://proxy:8080/", HTTPPort: 3500}.BaseURL())
}
```

If `require` is not yet imported in that file, add `"github.com/stretchr/testify/require"` and `"testing"` to its imports.

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/discovery/ -run TestInstanceBaseURL`
Expected: FAIL — `in.BaseURL undefined (type Instance has no field or method BaseURL)`.

- [ ] **Step 3: Write minimal implementation**

Add to `pkg/discovery/health.go`, directly below the `sidecarBaseURL` function:

```go
// BaseURL resolves this instance's daprd HTTP endpoint (aspire base URL wins,
// else the loopback-port form).
func (in Instance) BaseURL() string {
	return sidecarBaseURL(in.DaprHTTPBaseURL, in.HTTPPort)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/discovery/ -run TestInstanceBaseURL`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/discovery/health.go pkg/discovery/health_test.go
git add pkg/discovery/health.go pkg/discovery/health_test.go
git commit -m "feat: add Instance.BaseURL() helper for sidecar endpoint resolution"
```

---

### Task 2: Publish endpoint (backend)

Add `POST /api/apps/{appId}/publish` to `appsRouter`. It resolves the instance, validates the pub/sub component + topic, then proxies to the sidecar's publish API and maps the response.

**Files:**
- Modify: `pkg/server/apps.go`
- Test: `pkg/server/apps_test.go`

**Interfaces:**
- Consumes: `discovery.Service.Get`, `discovery.Instance.BaseURL()` (Task 1), `discovery.Instance.SidecarReachable`, `discovery.Instance.Components`.
- Produces: route `POST /{appId}/publish`; request body shape `{pubsubName, topic, data, contentType, metadata}`; success body `{"status":"published"}`.

- [ ] **Step 1: Write the failing tests**

Add to `pkg/server/apps_test.go`:

```go
func TestPublishProxiesToSidecar(t *testing.T) {
	var gotPath, gotCT, gotBody, gotQuery string
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		gotQuery = r.URL.RawQuery
		gotCT = r.Header.Get("Content-Type")
		b, _ := io.ReadAll(r.Body)
		gotBody = string(b)
		w.WriteHeader(http.StatusNoContent)
	}))
	defer sidecar.Close()

	apps := &fakeApps{instances: []discovery.Instance{{
		AppID:            "order",
		SidecarReachable: true,
		DaprHTTPBaseURL:  sidecar.URL,
		Components:       []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())

	body := `{"pubsubName":"pubsub","topic":"orders","data":"{\"id\":1}","contentType":"application/json","metadata":{"ttlInSeconds":"60"}}`
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(body))
	res, respBody := doReq(t, h, req)

	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, respBody, `"status":"published"`)
	require.Equal(t, "/v1.0/publish/pubsub/orders", gotPath)
	require.Equal(t, "application/json", gotCT)
	require.Equal(t, `{"id":1}`, gotBody)
	require.Equal(t, "metadata.ttlInSeconds=60", gotQuery)
}

func TestPublishRejectsUnknownPubsub(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"nope","topic":"orders"}`))
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
	require.Contains(t, body, "unknown pub/sub component")
}

func TestPublishRejectsEmptyTopic(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":""}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusBadRequest, res.StatusCode)
}

func TestPublishUnreachableSidecar(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{{AppID: "order", SidecarReachable: false}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}

func TestPublishUnknownApp(t *testing.T) {
	h := appsRouter(&fakeApps{}, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/ghost/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, _ := doReq(t, h, req)
	require.Equal(t, http.StatusNotFound, res.StatusCode)
}

func TestPublishPassesThroughDaprdError(t *testing.T) {
	sidecar := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"errorCode":"ERR","message":"denied"}`))
	}))
	defer sidecar.Close()
	apps := &fakeApps{instances: []discovery.Instance{{
		AppID: "order", SidecarReachable: true, DaprHTTPBaseURL: sidecar.URL,
		Components: []discovery.Component{{Name: "pubsub", Type: "pubsub.redis"}},
	}}}
	h := appsRouter(apps, nil, nil, FullCapabilities())
	req := httptest.NewRequest(http.MethodPost, "/order/publish", strings.NewReader(`{"pubsubName":"pubsub","topic":"orders"}`))
	res, body := doReq(t, h, req)
	require.Equal(t, http.StatusForbidden, res.StatusCode)
	require.Contains(t, body, "denied")
}
```

`apps_test.go` already imports `context`, `encoding/json`, `errors`, `fmt`, `net/http`, `net/http/httptest`, `testing`, `discovery`, `lifecycle`, `require`. Add `"io"` and `"strings"` to its import block.

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/server/ -run TestPublish`
Expected: FAIL — the `/publish` route is unregistered, so requests 405/404 and assertions fail.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/apps.go`, add these imports to the existing block: `"encoding/json"`, `"fmt"`, `"io"`, `"net/url"`, `"strings"`, `"time"`.

Register the route inside `appsRouter`, immediately after the `r.Get("/{appId}", ...)` handler (before the `caps.Logs` block):

```go
	r.Post("/{appId}/publish", publishHandler(svc))
```

Add at the end of `pkg/server/apps.go`:

```go
// publishClient proxies publish requests to sidecars. Its timeout bounds a
// single publish; the sidecar is always local (loopback or aspire proxy).
var publishClient = &http.Client{Timeout: 10 * time.Second}

// publishBody is the POST /api/apps/{appId}/publish request body.
type publishBody struct {
	PubsubName  string            `json:"pubsubName"`
	Topic       string            `json:"topic"`
	Data        string            `json:"data"`
	ContentType string            `json:"contentType"`
	Metadata    map[string]string `json:"metadata"`
}

// publishHandler proxies a message to the resolved instance's sidecar
// /v1.0/publish/{pubsub}/{topic}. daprd errors are surfaced verbatim.
func publishHandler(svc discovery.Service) http.HandlerFunc {
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
		if !in.SidecarReachable {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "sidecar unreachable"})
			return
		}
		var body publishBody
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON body"})
			return
		}
		if body.Topic == "" {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "topic is required"})
			return
		}
		if !hasPubsubComponent(in, body.PubsubName) {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": fmt.Sprintf("unknown pub/sub component: %s", body.PubsubName)})
			return
		}
		contentType := body.ContentType
		if contentType == "" {
			contentType = "application/json"
		}
		u := fmt.Sprintf("%s/v1.0/publish/%s/%s", in.BaseURL(), url.PathEscape(body.PubsubName), url.PathEscape(body.Topic))
		if len(body.Metadata) > 0 {
			q := make(url.Values)
			for k, v := range body.Metadata {
				q.Set("metadata."+k, v)
			}
			u += "?" + q.Encode()
		}
		preq, err := http.NewRequestWithContext(req.Context(), http.MethodPost, u, strings.NewReader(body.Data))
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		preq.Header.Set("Content-Type", contentType)
		resp, err := publishClient.Do(preq)
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": err.Error()})
			return
		}
		defer func() { _ = resp.Body.Close() }()
		if resp.StatusCode >= 200 && resp.StatusCode < 300 {
			writeJSON(w, http.StatusOK, map[string]string{"status": "published"})
			return
		}
		msg, _ := io.ReadAll(resp.Body)
		writeJSON(w, resp.StatusCode, map[string]string{"error": strings.TrimSpace(string(msg))})
	}
}

// hasPubsubComponent reports whether the instance exposes a pub/sub component
// with the given name (type prefixed "pubsub.").
func hasPubsubComponent(in discovery.Instance, name string) bool {
	for _, c := range in.Components {
		if c.Name == name && strings.HasPrefix(c.Type, "pubsub.") {
			return true
		}
	}
	return false
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/server/ -run TestPublish`
Expected: PASS (all six).

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/server/apps.go pkg/server/apps_test.go
git add pkg/server/apps.go pkg/server/apps_test.go
git commit -m "feat: add POST /api/apps/:appId/publish sidecar publish endpoint"
```

---

### Task 3: Expose sidecar reachability on subscription rows (backend)

The frontend Publish button must be disabled when a subscription's sidecar is unreachable. The `/api/subscriptions` row doesn't carry that today — add a `reachable` field sourced from `Instance.SidecarReachable`.

**Files:**
- Modify: `pkg/server/subscriptions.go`
- Test: `pkg/server/subscriptions_test.go`

**Interfaces:**
- Produces: `SubscriptionRow.Reachable bool` (`json:"reachable"`), set from `in.SidecarReachable`.

- [ ] **Step 1: Write the failing test**

Add to `pkg/server/subscriptions_test.go`:

```go
func TestSubscriptionsCarryReachable(t *testing.T) {
	apps := &fakeApps{instances: []discovery.Instance{
		{AppID: "order", SidecarReachable: true, Subscriptions: []discovery.Subscription{{PubsubName: "pubsub", Topic: "orders"}}},
	}}
	h := subscriptionsRouter(apps)
	res, body := get(t, h, "/")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"reachable":true`)
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestSubscriptionsCarryReachable`
Expected: FAIL — body does not contain `"reachable":true`.

- [ ] **Step 3: Write minimal implementation**

In `pkg/server/subscriptions.go`, add the field to `SubscriptionRow` (after `Type`):

```go
	Type            string              `json:"type,omitempty"`
	Reachable       bool                `json:"reachable"`
```

And set it in the row-append loop (after `Type: s.Type,`):

```go
				Type:            s.Type,
				Reachable:       in.SidecarReachable,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -run TestSubscriptionsCarryReachable`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
gofmt -w pkg/server/subscriptions.go pkg/server/subscriptions_test.go
git add pkg/server/subscriptions.go pkg/server/subscriptions_test.go
git commit -m "feat: expose sidecar reachability on subscription rows"
```

---

### Task 4: Static-insight quick-wins (frontend — Phase 2)

Add a Type column, remove the permanently-empty Scopes column, and make multi-rule subscriptions expand inline to show match/path.

**Files:**
- Modify: `web/src/pages/Subscriptions.tsx`
- Modify: `web/src/types/resources.ts`
- Test: `web/src/pages/Subscriptions.test.tsx`

**Interfaces:**
- Consumes: `Subscription` type (`type`, `rules`, `deadLetterTopic` fields already present).
- Produces: table with columns App | Pub/Sub | Topic | Route(s) | Type | Dead-letter topic; `Subscription.scopes` removed.

- [ ] **Step 1: Update tests**

In `web/src/types/resources.ts`, remove the `scopes?: string[]` line from `interface Subscription`.

In `web/src/pages/Subscriptions.test.tsx`:

Delete the entire `it('renders scope chips when scopes are present', ...)` test (lines ~99-120).

In the first test (`renders a row with topic, pub/sub, route, and app-id link`), replace the trailing scopes comment + assertion:

```ts
    // Scopes absent → em-dash(s) rendered as .none (dead-letter + scopes both show —)
    expect(row.getAllByText('—').length).toBeGreaterThanOrEqual(1)
```

with:

```ts
    // programmatic type badge is shown
    expect(row.getByText('programmatic')).toBeInTheDocument()
```

Add two new tests inside the `describe('Subscriptions', ...)` block:

```ts
  it('does not render a Scopes column', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([{ appId: 'order', pubsubName: 'pubsub', topic: 'orders' }]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    expect(screen.queryByRole('columnheader', { name: /scopes/i })).not.toBeInTheDocument()
  })

  it('expands multi-rule subscriptions to show match/path', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([
          {
            appId: 'order',
            pubsubName: 'pubsub',
            topic: 'orders',
            rules: [
              { match: 'event.type == "A"', path: '/orders/a' },
              { match: 'event.type == "B"', path: '/orders/b' },
            ],
          },
        ]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    const badge = screen.getByRole('button', { name: /2 rules/i })
    await userEvent.click(badge)
    expect(await screen.findByText('event.type == "A"')).toBeInTheDocument()
    expect(screen.getByText('/orders/b')).toBeInTheDocument()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Subscriptions.test.tsx`
Expected: FAIL — no Type badge, `2 rules` is not a button, expansion text absent.

- [ ] **Step 3: Implement**

In `web/src/pages/Subscriptions.tsx`, add `useState` to the React import at the top:

```ts
import { useState } from 'react'
```

Replace the `<thead>` row (the `<tr>` with column headers) with:

```tsx
              <tr>
                <th>App</th>
                <th>Pub/Sub</th>
                <th>Topic</th>
                <th>Route(s)</th>
                <th>Type</th>
                <th>Dead-letter topic</th>
              </tr>
```

Replace the closing hint `<p>` with:

```tsx
      <p className="hint">
        Topics with routing rules show a <span className="rulebadge">rules</span> badge — click it to inspect match expressions.
      </p>
```

Replace the entire `SubscriptionRow` function with:

```tsx
function SubscriptionRow({ sub }: { sub: Subscription }) {
  const [expanded, setExpanded] = useState(false)
  const rules = sub.rules ?? []
  const firstPath = rules[0]?.path
  const hasMultipleRules = rules.length > 1
  const key = sub.instanceKey ?? sub.appId

  return (
    <>
      <tr>
        <td className="b">
          <Link to={`/apps/${key}`}>
            {sub.appId}
            {key !== sub.appId && (
              <span className="muted" style={{ fontSize: 11, fontWeight: 400, marginLeft: 6 }}>({key})</span>
            )}
          </Link>
        </td>
        <td className="mono">{sub.pubsubName}</td>
        <td className="mono">{sub.topic}</td>
        <td>
          {firstPath ? <span className="route">{firstPath}</span> : <span className="none">—</span>}
          {hasMultipleRules && (
            <button
              type="button"
              className="rulebadge"
              aria-expanded={expanded}
              onClick={() => setExpanded((v) => !v)}
            >
              {rules.length} rules
            </button>
          )}
        </td>
        <td>{sub.type ? <span className="badge">{sub.type}</span> : <span className="none">—</span>}</td>
        <td>
          {sub.deadLetterTopic ? (
            <span className="dlq">{sub.deadLetterTopic}</span>
          ) : (
            <span className="none">—</span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr className="subrules">
          <td colSpan={6}>
            <ul className="rulelist">
              {rules.map((r, i) => (
                <li key={i}>
                  <span className="mono">{r.match || '(default)'}</span>
                  {' → '}
                  <span className="route">{r.path}</span>
                </li>
              ))}
            </ul>
          </td>
        </tr>
      )}
    </>
  )
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/Subscriptions.test.tsx && npm run build`
Expected: tests PASS; build (tsc) succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/Subscriptions.tsx web/src/pages/Subscriptions.test.tsx web/src/types/resources.ts
git commit -m "feat: add Type column, inline rule inspection; drop dead Scopes column"
```

---

### Task 5: Publish hook + dialog (frontend)

A `usePublishMessage` mutation hook and a `PublishMessageDialog` modal (payload editor, content-type, collapsed advanced with ttl + rawPayload, success-with-logs-link, error passthrough).

**Files:**
- Create: `web/src/hooks/usePublishMessage.ts`
- Create: `web/src/components/PublishMessageDialog.tsx`
- Test: `web/src/components/PublishMessageDialog.test.tsx`

**Interfaces:**
- Produces:
  - `usePublishMessage(key: string)` → react-query mutation; `mutate(payload: PublishPayload)`.
  - `PublishPayload = { pubsubName: string; topic: string; data: string; contentType: string; metadata?: Record<string, string> }`.
  - `<PublishMessageDialog open onClose instanceKey appId pubsubName topic />`.

- [ ] **Step 1: Write the failing test**

Create `web/src/components/PublishMessageDialog.test.tsx`:

```tsx
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect, vi } from 'vitest'
import { QueryClient } from '@tanstack/react-query'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { PublishMessageDialog } from './PublishMessageDialog'

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: 0 }, mutations: { retry: 0 } } })
  const onClose = vi.fn()
  const router = createMemoryRouter(
    [{ path: '/', element: (
      <PublishMessageDialog open onClose={onClose} instanceKey="order" appId="order" pubsubName="pubsub" topic="orders" />
    ) }, { path: '/logs', element: <div>logs page</div> }],
    { initialEntries: ['/'], future: { v7_relativeSplatPath: true } },
  )
  render(
    <QueryProvider client={client}>
      <RouterProvider router={router} future={{ v7_startTransition: true }} />
    </QueryProvider>,
  )
  return { onClose }
}

describe('PublishMessageDialog', () => {
  it('prefills pub/sub and topic', () => {
    renderDialog()
    expect(screen.getByText('pubsub')).toBeInTheDocument()
    expect(screen.getByText('orders')).toBeInTheDocument()
  })

  it('blocks submit on invalid JSON payload', async () => {
    let called = false
    server.use(http.post('/api/apps/order/publish', () => { called = true; return new HttpResponse(null, { status: 200 }) }))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{ not json')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    expect(screen.getByText(/invalid json/i)).toBeInTheDocument()
    expect(called).toBe(false)
  })

  it('publishes and shows success with a logs link', async () => {
    let gotBody: unknown
    server.use(http.post('/api/apps/order/publish', async ({ request }) => {
      gotBody = await request.json()
      return HttpResponse.json({ status: 'published' })
    }))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{"id":1}')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    expect(await screen.findByText(/published to/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /logs/i })).toHaveAttribute('href', '/logs?app=order&source=app')
    expect(gotBody).toMatchObject({ pubsubName: 'pubsub', topic: 'orders', data: '{"id":1}', contentType: 'application/json' })
  })

  it('shows the daprd error on failure', async () => {
    server.use(http.post('/api/apps/order/publish', () => HttpResponse.json({ error: 'component pubsub not found' }, { status: 400 })))
    renderDialog()
    await userEvent.clear(screen.getByLabelText(/payload/i))
    await userEvent.type(screen.getByLabelText(/payload/i), '{{"id":1}')
    await userEvent.click(screen.getByRole('button', { name: /^publish$/i }))
    await waitFor(() => expect(screen.getByText(/component pubsub not found/i)).toBeInTheDocument())
  })
})
```

Note: `userEvent.type` treats `{{` as a literal `{`, so `'{{"id":1}'` types `{"id":1}`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web && npx vitest run src/components/PublishMessageDialog.test.tsx`
Expected: FAIL — `PublishMessageDialog` module does not exist.

- [ ] **Step 3: Implement the hook**

Create `web/src/hooks/usePublishMessage.ts`:

```ts
import { useMutation } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'

export interface PublishPayload {
  pubsubName: string
  topic: string
  data: string
  contentType: string
  metadata?: Record<string, string>
}

async function publish(key: string, p: PublishPayload): Promise<void> {
  const res = await fetch(apiUrl(`/apps/${encodeURIComponent(key)}/publish`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  })
  if (!res.ok) {
    let msg = `request failed: ${res.status}`
    try {
      const data = (await res.json()) as { error?: unknown }
      if (data && typeof data.error === 'string') msg = data.error
    } catch {
      // non-JSON body; keep status-only message
    }
    throw new Error(msg)
  }
}

/** Publish a message to a topic via POST /api/apps/:key/publish. */
export function usePublishMessage(key: string) {
  return useMutation({
    mutationFn: (p: PublishPayload) => publish(key, p),
  })
}
```

- [ ] **Step 4: Implement the dialog**

Create `web/src/components/PublishMessageDialog.tsx`:

```tsx
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Modal } from './Modal'
import { usePublishMessage } from '../hooks/usePublishMessage'

interface Props {
  open: boolean
  onClose: () => void
  instanceKey: string
  appId: string
  pubsubName: string
  topic: string
}

const CONTENT_TYPES = ['application/json', 'text/plain', 'application/octet-stream']

function isJSONType(ct: string): boolean {
  return ct.includes('json')
}

export function PublishMessageDialog({ open, onClose, instanceKey, appId, pubsubName, topic }: Props) {
  const [data, setData] = useState('{}')
  const [contentType, setContentType] = useState('application/json')
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [ttl, setTtl] = useState('')
  const [rawPayload, setRawPayload] = useState(false)
  const [jsonError, setJsonError] = useState('')
  const pub = usePublishMessage(instanceKey)

  function submit() {
    setJsonError('')
    if (isJSONType(contentType) && data.trim() !== '') {
      try {
        JSON.parse(data)
      } catch {
        setJsonError('Invalid JSON payload')
        return
      }
    }
    const metadata: Record<string, string> = {}
    if (ttl.trim() !== '') metadata.ttlInSeconds = ttl.trim()
    if (rawPayload) metadata.rawPayload = 'true'
    pub.mutate({ pubsubName, topic, data, contentType, metadata: Object.keys(metadata).length ? metadata : undefined })
  }

  return (
    <Modal open={open} title="Publish a message" onClose={onClose}>
      <p className="muted">
        Publishing to <span className="mono">{pubsubName}</span> / <span className="mono">{topic}</span> sends a real
        message to the broker.
      </p>

      {pub.isSuccess ? (
        <div>
          <p className="ok">Published to {topic}.</p>
          <p>
            <Link to={`/logs?app=${encodeURIComponent(appId)}&source=app`}>Open {appId} logs</Link> to watch it get
            handled.
          </p>
          <div className="modal-actions">
            <button type="button" onClick={onClose}>Close</button>
          </div>
        </div>
      ) : (
        <div>
          <label htmlFor="pub-data">Payload</label>
          <textarea
            id="pub-data"
            className="mono"
            rows={6}
            value={data}
            onChange={(e) => setData(e.target.value)}
          />
          {jsonError && <p className="err">{jsonError}</p>}

          <label htmlFor="pub-ct">Content-Type</label>
          <select id="pub-ct" value={contentType} onChange={(e) => setContentType(e.target.value)}>
            {CONTENT_TYPES.map((ct) => (
              <option key={ct} value={ct}>{ct}</option>
            ))}
          </select>

          <button type="button" className="linklike" aria-expanded={showAdvanced} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? 'Hide' : 'Show'} advanced
          </button>
          {showAdvanced && (
            <div>
              <label htmlFor="pub-ttl">ttlInSeconds</label>
              <input id="pub-ttl" type="number" min="0" value={ttl} onChange={(e) => setTtl(e.target.value)} />
              <label>
                <input type="checkbox" checked={rawPayload} onChange={(e) => setRawPayload(e.target.checked)} /> rawPayload
                (bypass CloudEvent wrapping)
              </label>
            </div>
          )}

          {pub.isError && <p className="err">{(pub.error as Error).message}</p>}

          <div className="modal-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button type="button" className="primary" disabled={pub.isPending} onClick={submit}>
              Publish
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd web && npx vitest run src/components/PublishMessageDialog.test.tsx && npm run build`
Expected: tests PASS; build succeeds.

If `ok`/`err`/`linklike`/`primary`/`modal-actions` CSS classes don't exist, that's fine — they degrade gracefully; tests assert text/roles, not styling. (Styling is polished in the manual check.)

- [ ] **Step 6: Commit**

```bash
git add web/src/hooks/usePublishMessage.ts web/src/components/PublishMessageDialog.tsx web/src/components/PublishMessageDialog.test.tsx
git commit -m "feat: add publish-message hook and dialog"
```

---

### Task 6: Wire Publish button into the Subscriptions page (frontend)

Add a Publish action column that opens the dialog for the row's subscription, disabled when the sidecar is unreachable.

**Files:**
- Modify: `web/src/pages/Subscriptions.tsx`
- Modify: `web/src/types/resources.ts`
- Test: `web/src/pages/Subscriptions.test.tsx`

**Interfaces:**
- Consumes: `PublishMessageDialog` (Task 5), `SubscriptionRow.Reachable` → `Subscription.reachable` (Task 3).
- Produces: per-row Publish button; `Subscription.reachable?: boolean`.

- [ ] **Step 1: Write the failing tests**

In `web/src/types/resources.ts`, add to `interface Subscription`:

```ts
  reachable?: boolean
```

Add to `web/src/pages/Subscriptions.test.tsx`:

```ts
  it('opens the publish dialog from a reachable row', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([{ appId: 'order', pubsubName: 'pubsub', topic: 'orders', reachable: true }]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    await userEvent.click(screen.getByRole('button', { name: /publish/i }))
    expect(await screen.findByRole('dialog')).toBeInTheDocument()
    expect(screen.getByText(/publish a message/i)).toBeInTheDocument()
  })

  it('disables Publish when the sidecar is unreachable', async () => {
    server.use(
      http.get('/api/subscriptions', () =>
        HttpResponse.json([{ appId: 'order', pubsubName: 'pubsub', topic: 'orders', reachable: false }]),
      ),
    )
    renderAt()
    await screen.findByRole('link', { name: 'order' })
    expect(screen.getByRole('button', { name: /publish/i })).toBeDisabled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/Subscriptions.test.tsx`
Expected: FAIL — no Publish button rendered.

- [ ] **Step 3: Implement**

In `web/src/pages/Subscriptions.tsx`:

Add the dialog import near the top:

```ts
import { PublishMessageDialog } from '../components/PublishMessageDialog'
```

In the `Subscriptions` component, add dialog state (next to the existing `useSearchParams` line):

```tsx
  const [publishTarget, setPublishTarget] = useState<Subscription | null>(null)
```

Add a header cell to the `<thead>` row (after `Dead-letter topic`):

```tsx
                <th></th>
```

Change the row mapping to pass the callback:

```tsx
              {subscriptions.map((sub) => (
                <SubscriptionRow
                  key={`${sub.instanceKey ?? sub.appId}/${sub.pubsubName}/${sub.topic}`}
                  sub={sub}
                  onPublish={() => setPublishTarget(sub)}
                />
              ))}
```

Render the dialog just before the closing `</div>` of the `page` wrapper (after the hint `<p>`):

```tsx
      {publishTarget && (
        <PublishMessageDialog
          open
          onClose={() => setPublishTarget(null)}
          instanceKey={publishTarget.instanceKey ?? publishTarget.appId}
          appId={publishTarget.appId}
          pubsubName={publishTarget.pubsubName}
          topic={publishTarget.topic}
        />
      )}
```

Update `SubscriptionRow` to accept `onPublish`, add the action cell, and bump the expansion `colSpan` to 7:

```tsx
function SubscriptionRow({ sub, onPublish }: { sub: Subscription; onPublish: () => void }) {
```

Add this `<td>` as the last cell of the main `<tr>` (after the dead-letter cell):

```tsx
        <td>
          <button
            type="button"
            className="rowbtn"
            disabled={sub.reachable === false}
            title={sub.reachable === false ? 'Sidecar unreachable' : 'Publish a test message'}
            onClick={onPublish}
          >
            Publish
          </button>
        </td>
```

And change the expansion row's `colSpan={6}` to `colSpan={7}`.

- [ ] **Step 4: Run tests + typecheck**

Run: `cd web && npx vitest run src/pages/Subscriptions.test.tsx && npm run build`
Expected: tests PASS; build succeeds.

- [ ] **Step 5: Full test + lint sweep**

Run: `cd web && npm test && npm run lint` then `go test -tags unit -race ./...`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Subscriptions.tsx web/src/pages/Subscriptions.test.tsx web/src/types/resources.ts
git commit -m "feat: add per-row Publish action to Subscriptions page"
```

---

## Manual verification (after all tasks)

With a real Dapr pub/sub app running (e.g. `dapr run -f .` in `pub_sub/csharp/sdk` with resources at `pub_sub/components`), start the dashboard and open Subscriptions:

1. Confirm the Type column shows the subscription type, no Scopes column, and multi-rule rows expand.
2. Click Publish on a reachable row; send a JSON payload; confirm the success message + logs link, and that the app receives the message (check its logs).
3. Trigger an error (e.g. stop the app's sidecar) and confirm the daprd/unreachable error surfaces.

## Spec coverage self-check

- Phase 1 backend endpoint + validation + proxy + error mapping → Tasks 1, 2.
- Publish button, disabled-when-unreachable, modal, payload editor, content-type, advanced (ttl/rawPayload), success-with-logs-link, error passthrough → Tasks 3, 5, 6.
- On-by-default guardrails (no flag, no extra confirm) → Task 2 (route registered unconditionally), Task 6 (modal is the only step).
- Phase 2: Type column, remove Scopes, inline rule inspection → Task 4.
- Phase 3 (metrics) → intentionally out of scope (separate spec).
- Testing (backend table-driven + frontend) → each task's test steps.
