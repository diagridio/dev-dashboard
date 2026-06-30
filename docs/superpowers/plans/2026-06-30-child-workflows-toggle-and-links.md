# Child Workflows: list toggle + event-history links — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the parent/child (sub-orchestration) relationship that already exists in the workflow state-store data: a toggle to show/hide child workflows in the execution list (with a `child` badge), the child workflow name on each `SubOrchestrationCreated` event, and a link from that event to the child's detail page.

**Architecture:** The `durabletask-go` proto data already carries everything. The backend decoder extracts (a) a child's parent-instance ID from its own `ExecutionStarted` event, and (b) the child instance ID + name from each `SubOrchestrationCreated` event. The list/stats service filters children server-side (keeps pagination + stat counts correct). The frontend adds a checkbox that threads an `includeChildren` query param through the list and stats fetches, a `child` badge on child rows, and a link on the sub-orchestration event row.

**Tech Stack:** Go (chi router, durabletask-go v0.12.1, testify), React + TypeScript (TanStack Query, react-router, Vitest + MSW).

## Global Constraints

- Go unit tests use the `unit` build tag. Run with: `go test -tags unit -race ./pkg/...`.
- Frontend tests use Vitest. Run from `web/` with: `npx vitest run <path>`.
- Default behavior must be unchanged: when the `includeChildren` query param is absent, children are **shown** (param defaults to `true`).
- JSON field names are camelCase and must match between Go struct tags and TypeScript interfaces: `parentInstanceId`, `instanceId`.
- The `SubOrchestrationCreated` event carries no appID; child links assume the parent's appID. Document this with a code comment.
- Follow existing patterns: keep the decoder's `switch` style, keep the service's `matches()` predicate as the single filter point, reuse existing CSS chip/badge classes (`typechip`, `chip`) and the `detailPath`/`celllink` link patterns.

---

### Task 1: Backend — extract parent/child data in the decoder

Add the two new data fields and populate them from the proto history. This is the foundation both later backend and frontend tasks depend on.

**Files:**
- Modify: `pkg/workflow/types.go` (add `ParentInstanceID` to `ExecutionSummary`; add `InstanceID` to `HistoryEvent`)
- Modify: `pkg/workflow/decode.go` (`DecodeExecution` loop; `decodeEvent` `SubOrchestrationCreated` case)
- Test: `pkg/workflow/decode_test.go`

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - `workflow.ExecutionSummary.ParentInstanceID string` (JSON `parentInstanceId`) — non-empty ⇒ this instance is a child.
  - `workflow.HistoryEvent.InstanceID string` (JSON `instanceId`) — for a `SubOrchestrationCreated` event, the child instance ID. `HistoryEvent.Name` carries the child workflow name.

- [ ] **Step 1: Write the failing tests**

Add these two tests to `pkg/workflow/decode_test.go`:

```go
func TestDecodeExecutionParentInstanceID(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name: "ChildWorkflow",
			ParentInstance: &protos.ParentInstanceInfo{
				WorkflowInstance: &protos.WorkflowInstance{InstanceId: "parent-inst-1"},
			},
		}}},
	}
	ex := DecodeExecution("order", "child-inst-1", history, "")
	require.Equal(t, "parent-inst-1", ex.ParentInstanceID)
}

func TestDecodeSubOrchestrationCreated(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "ParentWorkflow"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceCreated{ChildWorkflowInstanceCreated: &protos.ChildWorkflowInstanceCreatedEvent{
			InstanceId: "child-inst-9",
			Name:       "ChildWorkflow",
		}}},
	}
	ex := DecodeExecution("order", "parent-inst-1", history, "")
	require.Equal(t, "", ex.ParentInstanceID) // parent has no parent
	require.Len(t, ex.History, 2)
	require.Equal(t, "SubOrchestrationCreated", ex.History[1].Type)
	require.Equal(t, "ChildWorkflow", ex.History[1].Name)
	require.Equal(t, "child-inst-9", ex.History[1].InstanceID)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestDecodeExecutionParentInstanceID|TestDecodeSubOrchestrationCreated' -v`
Expected: FAIL — `ex.ParentInstanceID` and `ev.InstanceID` undefined (compile error), then once fields exist, assertions fail because nothing populates them.

- [ ] **Step 3: Add the new struct fields**

In `pkg/workflow/types.go`, change `HistoryEvent` (add `InstanceID`) and `ExecutionSummary` (add `ParentInstanceID`):

```go
type HistoryEvent struct {
	SequenceID int32     `json:"sequenceId"`
	Timestamp  time.Time `json:"timestamp"`
	Type       string    `json:"type"`
	Name       string    `json:"name,omitempty"`
	InstanceID string    `json:"instanceId,omitempty"` // child instance id for SubOrchestrationCreated
	Input      *string   `json:"input,omitempty"`
	Output     *string   `json:"output,omitempty"`
}

type ExecutionSummary struct {
	AppID            string     `json:"appId"`
	InstanceID       string     `json:"instanceId"`
	Name             string     `json:"name"`
	Status           Status     `json:"status"`
	ParentInstanceID string     `json:"parentInstanceId,omitempty"` // non-empty ⇒ this is a child workflow
	CreatedAt        *time.Time `json:"createdAt,omitempty"`
	LastUpdatedAt    *time.Time `json:"lastUpdatedAt,omitempty"`
}
```

- [ ] **Step 4: Populate `ParentInstanceID` in `DecodeExecution`**

In `pkg/workflow/decode.go`, replace the existing replay-count loop (the `for _, e := range history` block around lines 52-58) with one that also captures the parent instance id:

```go
	replays := 0
	for _, e := range history {
		if e.GetOrchestratorStarted() != nil {
			replays++
		}
		// A child workflow's own ExecutionStarted event carries its parent's
		// instance id; its presence is what marks this instance as a child.
		if es := e.GetExecutionStarted(); es != nil && ex.ParentInstanceID == "" {
			if pi := es.GetParentInstance(); pi != nil {
				if wi := pi.GetWorkflowInstance(); wi != nil {
					ex.ParentInstanceID = wi.GetInstanceId()
				}
			}
		}
		ex.History = append(ex.History, decodeEvent(e))
	}
```

- [ ] **Step 5: Populate child name + instance id in `decodeEvent`**

In `pkg/workflow/decode.go`, replace the `SubOrchestrationCreated` case (around lines 114-115):

```go
	case e.GetSubOrchestrationInstanceCreated() != nil:
		ev.Type = "SubOrchestrationCreated"
		s := e.GetSubOrchestrationInstanceCreated()
		ev.Name = s.GetName()
		ev.InstanceID = s.GetInstanceId()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestDecodeExecutionParentInstanceID|TestDecodeSubOrchestrationCreated' -v`
Expected: PASS (both tests).

- [ ] **Step 7: Run the full workflow package tests to check for regressions**

Run: `go test -tags unit -race ./pkg/workflow/...`
Expected: PASS. (Note: `golden_test.go` may compare serialized output — if a golden file now includes the new `omitempty` fields only when set, it should be unaffected; if it fails, inspect and regenerate per that test's documented update command.)

- [ ] **Step 8: Commit**

```bash
git add pkg/workflow/types.go pkg/workflow/decode.go pkg/workflow/decode_test.go
git commit -m "feat(workflow): decode parent-instance id and sub-orchestration child name/id"
```

---

### Task 2: Backend — server-side child filtering on list + stats

Add an `IncludeChildren` query option that excludes child instances from both `List` and `Stats`, wired to an `includeChildren` HTTP query param that defaults to `true`.

**Files:**
- Modify: `pkg/workflow/service.go` (`ListQuery` struct; `matches()`; `Stats()` searchQ construction)
- Modify: `pkg/server/workflows.go` (`parseListQuery`)
- Test: `pkg/workflow/service_test.go`, `pkg/server/workflows_test.go`

**Interfaces:**
- Consumes: `workflow.ExecutionSummary.ParentInstanceID` (Task 1).
- Produces: `workflow.ListQuery.IncludeChildren bool`. When `false`, `List` and `Stats` omit summaries whose `ParentInstanceID != ""`. The `parseListQuery` HTTP helper sets it to `true` unless the query string contains `includeChildren=false`.

- [ ] **Step 1: Write the failing service test**

Add to `pkg/workflow/service_test.go`. This seeds a parent and a child (the child's `ExecutionStarted` has a `ParentInstance`) and asserts filtering:

```go
func childStartedEvent(name, parentInstanceID string) *protos.HistoryEvent {
	return &protos.HistoryEvent{EventId: 0, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionStarted{
		ExecutionStarted: &protos.ExecutionStartedEvent{
			Name:           name,
			ParentInstance: &protos.ParentInstanceInfo{WorkflowInstance: &protos.WorkflowInstance{InstanceId: parentInstanceID}},
		},
	}}
}

func TestServiceListExcludesChildren(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "parent-1", "ParentWorkflow", []*protos.HistoryEvent{startedEvent("ParentWorkflow")})
	seedWorkflow(t, f, "default", "order", "child-1", "ChildWorkflow", []*protos.HistoryEvent{childStartedEvent("ChildWorkflow", "parent-1")})
	svc := New(f, "default")

	all, err := svc.List(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Len(t, all.Items, 2)

	topOnly, err := svc.List(context.Background(), ListQuery{IncludeChildren: false})
	require.NoError(t, err)
	require.Len(t, topOnly.Items, 1)
	require.Equal(t, "parent-1", topOnly.Items[0].InstanceID)
}

func TestServiceStatsExcludesChildren(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "parent-1", "ParentWorkflow", []*protos.HistoryEvent{startedEvent("ParentWorkflow")})
	seedWorkflow(t, f, "default", "order", "child-1", "ChildWorkflow", []*protos.HistoryEvent{childStartedEvent("ChildWorkflow", "parent-1")})
	svc := New(f, "default")

	all, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: true})
	require.NoError(t, err)
	require.Equal(t, 2, all.Total)

	topOnly, err := svc.Stats(context.Background(), ListQuery{IncludeChildren: false})
	require.NoError(t, err)
	require.Equal(t, 1, topOnly.Total)
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestServiceListExcludesChildren|TestServiceStatsExcludesChildren' -v`
Expected: FAIL — `IncludeChildren` field undefined (compile error), then assertions fail (no filtering yet).

- [ ] **Step 3: Add `IncludeChildren` to `ListQuery`**

In `pkg/workflow/service.go`, extend the struct:

```go
type ListQuery struct {
	AppID           string
	Status          []Status
	Search          string
	PageSize        int
	PageToken       string
	IncludeChildren bool
}
```

- [ ] **Step 4: Filter children in `matches()`**

In `pkg/workflow/service.go`, add this guard at the top of `matches()` (before the status block):

```go
func matches(s ExecutionSummary, q ListQuery) bool {
	if !q.IncludeChildren && s.ParentInstanceID != "" {
		return false
	}
	if len(q.Status) > 0 {
```

- [ ] **Step 5: Carry `IncludeChildren` into the Stats predicate**

In `pkg/workflow/service.go`, `Stats()` builds a stripped `searchQ`. Include the flag so stats honor the toggle:

```go
	searchQ := ListQuery{Search: q.Search, IncludeChildren: q.IncludeChildren}
```

- [ ] **Step 6: Run the service tests to verify they pass**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestServiceListExcludesChildren|TestServiceStatsExcludesChildren' -v`
Expected: PASS.

- [ ] **Step 7: Write the failing server param test**

Add to `pkg/server/workflows_test.go` (the `parseListQuery` function is package-internal, so this test calls it directly):

```go
func TestParseListQueryIncludeChildren(t *testing.T) {
	// Absent param ⇒ children shown (default true).
	req := httptest.NewRequest(http.MethodGet, "/workflows", nil)
	require.True(t, parseListQuery(req).IncludeChildren)

	// Explicit false ⇒ children hidden.
	req = httptest.NewRequest(http.MethodGet, "/workflows?includeChildren=false", nil)
	require.False(t, parseListQuery(req).IncludeChildren)

	// Explicit true ⇒ children shown.
	req = httptest.NewRequest(http.MethodGet, "/workflows?includeChildren=true", nil)
	require.True(t, parseListQuery(req).IncludeChildren)
}
```

- [ ] **Step 8: Run it to verify it fails**

Run: `go test -tags unit ./pkg/server/ -run TestParseListQueryIncludeChildren -v`
Expected: FAIL — `IncludeChildren` is `false` for the absent-param case (default is the zero value until we set it).

- [ ] **Step 9: Default the param to true in `parseListQuery`**

In `pkg/server/workflows.go`, in `parseListQuery`, initialize `IncludeChildren: true` and flip it off only on an explicit `=false`:

```go
func parseListQuery(req *http.Request) workflow.ListQuery {
	q := workflow.ListQuery{
		AppID:           req.URL.Query().Get("appId"),
		Search:          req.URL.Query().Get("search"),
		PageToken:       req.URL.Query().Get("page"),
		IncludeChildren: true,
	}
	if req.URL.Query().Get("includeChildren") == "false" {
		q.IncludeChildren = false
	}
```

(Leave the rest of the function — status splitting and limit parsing — unchanged.)

- [ ] **Step 10: Run the server test to verify it passes**

Run: `go test -tags unit ./pkg/server/ -run TestParseListQueryIncludeChildren -v`
Expected: PASS.

- [ ] **Step 11: Run both packages to check for regressions**

Run: `go test -tags unit -race ./pkg/workflow/... ./pkg/server/...`
Expected: PASS.

- [ ] **Step 12: Commit**

```bash
git add pkg/workflow/service.go pkg/workflow/service_test.go pkg/server/workflows.go pkg/server/workflows_test.go
git commit -m "feat(workflow): filter child workflows from list and stats via includeChildren"
```

---

### Task 3: Frontend — toggle + child badge on the Workflows list

Add the `parentInstanceId` type, thread `includeChildren` through the list and stats hooks, render a "Show child workflows" checkbox (default on), and show a `child` badge on child rows.

**Files:**
- Modify: `web/src/types/workflow.ts` (`WorkflowSummary`)
- Modify: `web/src/hooks/useWorkflows.ts` (`WorkflowsParams`, `queryString`, `useWorkflowStats`)
- Modify: `web/src/pages/Workflows.tsx` (state, hook calls, filter UI, row name cell)
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: backend JSON `parentInstanceId` on list items; `includeChildren` query param (Task 2).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Write the failing tests**

Add to `web/src/pages/Workflows.test.tsx`. The first asserts the `child` badge renders for a row with `parentInstanceId`; the second asserts unchecking the toggle issues a list request with `includeChildren=false`.

```ts
it('shows a child badge for child workflow rows', async () => {
  server.use(
    http.get('/api/workflows', () =>
      HttpResponse.json({
        items: [
          { appId: 'order', instanceId: 'child-1', name: 'ChildWorkflow', status: 'Running', parentInstanceId: 'parent-1' },
        ],
      }),
    ),
  )
  renderAt()
  expect(await screen.findByText('child')).toBeInTheDocument()
})

it('requests includeChildren=false when the toggle is unchecked', async () => {
  const urls: string[] = []
  server.use(
    http.get('/api/workflows', ({ request }) => {
      urls.push(request.url)
      return HttpResponse.json({ items: [] })
    }),
  )
  renderAt()
  // wait for the initial list request (default: children shown)
  await waitFor(() => expect(urls.length).toBeGreaterThan(0))
  const toggle = screen.getByLabelText('Show child workflows')
  await userEvent.click(toggle)
  await waitFor(() => expect(urls.some((u) => u.includes('includeChildren=false'))).toBe(true))
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx -t 'child badge'` and `npx vitest run src/pages/Workflows.test.tsx -t 'includeChildren'`
Expected: FAIL — no `child` text rendered; no checkbox labeled "Show child workflows".

- [ ] **Step 3: Add `parentInstanceId` to the type**

In `web/src/types/workflow.ts`, extend `WorkflowSummary`:

```ts
export interface WorkflowSummary {
  appId: string
  instanceId: string
  name: string
  status: WorkflowStatus
  parentInstanceId?: string
  createdAt?: string
  lastUpdatedAt?: string
}
```

- [ ] **Step 4: Thread `includeChildren` through the hooks**

In `web/src/hooks/useWorkflows.ts`:

Add the param to the interface and query string builder:

```ts
interface WorkflowsParams {
  appId?: string
  status?: WorkflowStatus[]
  search?: string
  page?: string
  limit?: number
  store?: string
  includeChildren?: boolean
  enabled?: boolean
}

function queryString(p: WorkflowsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.status && p.status.length) sp.set('status', p.status.join(','))
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  if (p.store) sp.set('store', p.store)
  if (p.includeChildren === false) sp.set('includeChildren', 'false')
  const s = sp.toString()
  return s ? `?${s}` : ''
}
```

And add `includeChildren` to `useWorkflowStats` so stats match the toggle:

```ts
export function useWorkflowStats(params: { appId?: string; search?: string; store?: string; includeChildren?: boolean; enabled?: boolean }) {
  const ctx = useRefreshInterval()
  const sp = new URLSearchParams()
  if (params.appId) sp.set('appId', params.appId)
  if (params.search) sp.set('search', params.search)
  if (params.store) sp.set('store', params.store)
  if (params.includeChildren === false) sp.set('includeChildren', 'false')
  const qs = sp.toString() ? `?${sp.toString()}` : ''
  return useQuery<WorkflowStats>({
    queryKey: ['workflow-stats', qs],
    queryFn: () => fetchJSON<WorkflowStats>(`/workflows/stats${qs}`),
    refetchInterval: refetchMs(ctx),
    enabled: params.enabled !== false,
  })
}
```

- [ ] **Step 5: Add toggle state and pass it to both hooks in `Workflows.tsx`**

In `web/src/pages/Workflows.tsx`, add state near the other filter state (after the `page` state around line 60):

```tsx
  const [showChildren, setShowChildren] = useState(true)
```

Then pass `includeChildren` into both hook calls (around lines 179-193):

```tsx
  const { data, isLoading, isError, error } = useWorkflows({
    status: activeStatus ? [activeStatus] : undefined,
    search: debouncedSearch || undefined,
    page,
    appId: selectedApp || undefined,
    store: selectedStore ?? undefined,
    includeChildren: showChildren,
    enabled: selectedStore !== null,
  })

  const { data: stats } = useWorkflowStats({
    appId: selectedApp || undefined,
    search: debouncedSearch || undefined,
    store: selectedStore ?? undefined,
    includeChildren: showChildren,
    enabled: selectedStore !== null,
  })
```

- [ ] **Step 6: Render the toggle in the filters bar**

In `web/src/pages/Workflows.tsx`, add the checkbox at the end of the `{/* Filters */}` `<div className="filters">` block, after the search `<label>` (around line 471):

```tsx
        {/* Show/hide child workflows */}
        <label className="search" style={{ gap: 6 }}>
          <input
            type="checkbox"
            aria-label="Show child workflows"
            checked={showChildren}
            onChange={(e) => {
              setShowChildren(e.target.checked)
              resetPaging()
            }}
          />
          Show child workflows
        </label>
```

- [ ] **Step 7: Render the `child` badge on the name cell**

In `web/src/pages/Workflows.tsx`, replace the workflow-name cell (around line 572):

```tsx
                      <td className="wfname">
                        {wf.name}
                        {wf.parentInstanceId && (
                          <span className="typechip" style={{ marginLeft: '6px' }}>
                            child
                          </span>
                        )}
                      </td>
```

- [ ] **Step 8: Run the tests to verify they pass**

Run (from `web/`): `npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS (new tests + existing ones).

- [ ] **Step 9: Typecheck**

Run (from `web/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add web/src/types/workflow.ts web/src/hooks/useWorkflows.ts web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): toggle to show/hide child workflows with child badge"
```

---

### Task 4: Frontend — child name + link on the SubOrchestrationCreated event

Show the child workflow name on each `SubOrchestrationCreated` event in the detail page's event history and link the child instance id to its detail page.

**Files:**
- Modify: `web/src/types/workflow.ts` (`WorkflowHistoryEvent`)
- Modify: `web/src/pages/WorkflowDetail.tsx` (`EventRow`)
- Test: `web/src/pages/WorkflowDetail.test.tsx`

**Interfaces:**
- Consumes: backend JSON `instanceId` + `name` on `SubOrchestrationCreated` history events (Task 1); the existing route `/workflows/:appId/:instanceId`.
- Produces: nothing later tasks depend on.

Facts confirmed from the codebase (no code change needed for these):
- In `web/src/pages/WorkflowDetail.tsx`, `Link` is **already imported** from `react-router-dom` (line 2) — no new import needed.
- The `EventRow` call site is around lines 627-635 inside `displayHistory.map(...)`. In scope there: `event`, `execution` (the detail data), `newestEvent`, `toast`, and the route params `appId`/`instanceId` (from `useParams`, possibly `undefined`) plus `store` (from `useSearchParams`, line 223).
- The detail test render helper is `renderDetail(client?: QueryClient, entry = '/workflows/order/abc')`. `beforeEach` already mocks `/api/apps`.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/WorkflowDetail.test.tsx`. Mock the detail endpoint to return a `SubOrchestrationCreated` event and assert a link to the child detail page renders:

```ts
it('links a SubOrchestrationCreated event to the child workflow detail', async () => {
  server.use(
    http.get('/api/workflows/order/parent-1', () =>
      HttpResponse.json({
        appId: 'order',
        instanceId: 'parent-1',
        name: 'ParentWorkflow',
        status: 'Running',
        createdAt: '2026-06-26T10:00:00Z',
        replayCount: 0,
        history: [
          { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'ParentWorkflow' },
          { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'SubOrchestrationCreated', name: 'ChildWorkflow', instanceId: 'child-9' },
        ],
      }),
    ),
  )
  renderDetail(undefined, '/workflows/order/parent-1')
  const link = await screen.findByRole('link', { name: /child-9/ })
  expect(link).toHaveAttribute('href', expect.stringContaining('/workflows/order/child-9'))
})
```

- [ ] **Step 2: Run it to verify it fails**

Run (from `web/`): `npx vitest run src/pages/WorkflowDetail.test.tsx -t 'SubOrchestrationCreated'`
Expected: FAIL — no link to `child-9` (the event renders as a plain static row today).

- [ ] **Step 3: Add `instanceId` to the event type**

In `web/src/types/workflow.ts`, extend `WorkflowHistoryEvent`:

```ts
export interface WorkflowHistoryEvent {
  sequenceId: number
  timestamp: string
  type: string
  name?: string
  instanceId?: string
  input?: string
  output?: string
}
```

- [ ] **Step 4: Pass parent `appId` + `store` into `EventRow`**

In `web/src/pages/WorkflowDetail.tsx`:

Add the two props to the `EventRow` signature (the destructured params + the inline type, around lines 98-110). Keep the existing props; append `appId` and `store`:

```tsx
export function EventRow({
  event,
  createdAt,
  isNewest,
  toast,
  anchorId,
  appId,
  store,
}: {
  event: WorkflowHistoryEvent
  createdAt: string | undefined
  isNewest: boolean
  toast: ToastHandle
  anchorId: string
  appId: string
  store?: string
}) {
```

Then update the `EventRow` call site inside `displayHistory.map(...)` (around lines 627-635). The route `appId` (from `useParams`, possibly `undefined`) and `store` (from `useSearchParams`, line 223) are already in scope; pass them down:

```tsx
          {displayHistory.map((event, idx) => (
            <EventRow
              key={idx}
              event={event}
              createdAt={execution.createdAt}
              isNewest={event === newestEvent}
              toast={toast}
              anchorId={eventAnchorId(canonicalIndex.get(event) ?? idx)}
              appId={appId ?? ''}
              store={store}
            />
          ))}
```

(`Link` is already imported from `react-router-dom` at line 2 — no import change needed.)

- [ ] **Step 5: Render the child name + link in the static-row branch**

In `EventRow`, the `SubOrchestrationCreated` event has no input/output, so it renders via the `evstatic` branch (around lines 194-209). Add a child link after the existing `evname` span in that branch. Build the child detail path mirroring the list's `detailPath` (parent appId, child instance id, optional store):

```tsx
            <div className="evstatic-head">
              <span className="caretspace" aria-hidden="true">▸</span>
              <span className="evtype">{event.type}</span>
              {event.name && <span className="evname">{event.name}</span>}
              {/* Child instance link. The event carries no appId, so we assume the
                  parent's app (correct for same-app sub-orchestrations). */}
              {event.type === 'SubOrchestrationCreated' && event.instanceId && (
                <Link
                  className="celllink"
                  to={`/workflows/${appId}/${event.instanceId}${store ? `?store=${encodeURIComponent(store)}` : ''}`}
                >
                  {event.instanceId}
                </Link>
              )}
              {eventIdTag && <span className="evtag">{eventIdTag}</span>}
```

- [ ] **Step 6: Run the test to verify it passes**

Run (from `web/`): `npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS (new test + existing ones).

- [ ] **Step 7: Typecheck**

Run (from `web/`): `npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/types/workflow.ts web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(web): link SubOrchestrationCreated events to the child workflow detail"
```

---

## Final verification

- [ ] Run the full Go unit suite: `go test -tags unit -race ./...` — Expected: PASS.
- [ ] Run the full frontend suite (from `web/`): `npx vitest run` — Expected: PASS.
- [ ] Frontend typecheck (from `web/`): `npx tsc -b --noEmit` — Expected: no errors.
- [ ] Manual smoke (optional, requires a state store with sub-orchestrations): start the dashboard, confirm the "Show child workflows" toggle adds/removes child rows and adjusts the status counts, confirm child rows show the `child` badge, and confirm a `SubOrchestrationCreated` event links to the child's detail page.
