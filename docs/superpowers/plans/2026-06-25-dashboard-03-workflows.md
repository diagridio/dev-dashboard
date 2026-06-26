# Dev Dashboard — Plan 3: Workflows + State Store + Terminate/Purge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface Dapr workflow executions across all running apps — a filterable/searchable **Workflows** list with cursor paging and a **live workflow detail** view (header, input/output/custom status, growing history timeline, wall-clock) — and let the user **remove** workflows via the hybrid Terminate→Purge / Purge / Force-delete tiers.

**Architecture:** Two new domain packages. `pkg/statestore` builds a Dapr **components-contrib** `state.Store` directly from a detected component YAML (Redis / SQLite / PostgreSQL all ride the same `state.KeysLiker` interface, so multi-backend support is nearly free) and exposes pattern key-listing, bulk-get, and delete. `pkg/workflow` lists workflow instances by `KeysLike` pattern, decodes the per-instance history-event keys with the **durabletask-go** decoder into status/input/output/custom-status/timeline DTOs, and runs removal: official sidecar beta1 Terminate/Purge HTTP calls when a sidecar is reachable, direct state-store key deletion as the Force fallback. The server gains `/api/workflows*` + `/api/statestores`; the SPA replaces the Workflows placeholder with a real list + detail, polling on the existing global interval.

**Tech Stack:** (builds on Plans 1–2) Go + chi · `github.com/dapr/components-contrib/state` (+ `/redis`, `/sqlite`, `/postgresql/v2`) · `github.com/dapr/durabletask-go/{api/protos,backend,backend/runtimestate}` · `github.com/alicebob/miniredis/v2` (integration tests) · `google.golang.org/protobuf` · `sigs.k8s.io/yaml` · React + TanStack Query + React Router.

**Builds on Plans 1–2 (Foundation + Discovery/Applications), both merged.** Real interfaces this plan consumes:
- Go: `server.Options{BasePath, DistFS, Version, Apps}`, `server.NewRouter(opts)`, `apiRouter(v version.Info, apps discovery.Service) http.Handler` (in `pkg/server/api.go`), `writeJSON(w, status, v)`, the `get()` test helper (`pkg/server/spa_test.go`); `discovery.Service.{List,Get}`, `discovery.Instance{AppID, HTTPPort, Health, ResourcePaths, ...}`, `discovery.Health` + `discovery.HealthHealthy`, `discovery.New`, `discovery.StandaloneScanner`.
- Web: `apiUrl(path)`/`fetchJSON<T>(path)` (`web/src/lib/api.ts`), `QueryProvider` (`web/src/lib/query.tsx`), `RefreshProvider`/`useRefreshInterval()`/`refetchMs(ctx)` (`web/src/lib/refresh.tsx`), `routes`/`router` (`web/src/router.tsx`), `Placeholder` (`web/src/pages/Placeholder.tsx`), the `.mono` class + theme tokens (`--ok/--warn/--bad`, `--space-1..6`, `--surface`, `--border`, `--text*`, `--link`), the `data-cy` + MSW test conventions (`web/src/test/setup.ts`), the copy-to-clipboard helper pattern from `web/src/pages/AppDetail.tsx`.

**Module path:** `github.com/diagridio/dev-dashboard`. **Go toolchain:** 1.26.x. **Node:** 20 (build-time only).

## Global Constraints

(Inherited verbatim from Plans 1–2 — single binary, desktop-only, light/Compact defaults, base-path-aware, WCAG-AA, lean bundle, headless primitives, theme tokens, monospace+tabular-nums, **local** timestamps, testify + `//go:build unit`, Vitest+RTL+MSW, `data-cy` selectors, never `git add web/dist/`, run `gofmt -w` before committing Go, **`cd web && npm run build` in every web task's verification** since Vitest doesn't typecheck.) Plan-3-specific:

- **Reuse the Dapr stack, don't reinvent it.** State stores are built from `components-contrib` constructors (`redis.NewRedisStateStore` / `sqlite.NewSQLiteStateStore` / `postgresql/v2.NewPostgreSQLStateStore`) + `.Init(ctx, state.Metadata{Base:{Properties: <yaml spec.metadata>}})`. Key listing uses the **public** `state.KeysLiker` interface (`KeysLike(ctx, *state.KeysLikeRequest) (*state.KeysLikeResponse, error)`). Workflow state/history is decoded with `durabletask-go/backend/runtimestate` helpers over `[]*protos.HistoryEvent` (proto `github.com/dapr/durabletask-go/api/protos`; `backend.HistoryEvent` is a type alias for `protos.HistoryEvent`). Do **not** depend on `dapr/dapr` internal runtime packages.
- **Workflow key layout (verified, v1.18.0).** Per-instance state-store keys are `<appId>||<workflowActorType>||<instanceId>||<suffix>` joined by `||`, where `workflowActorType = "dapr.internal." + namespace + "." + appId + ".workflow"` and `suffix ∈ {metadata, history-NNNNNN, customStatus, inbox-NNNNNN, propagated-history}`. Each `history-NNNNNN` value is a single `proto.Marshal`-ed `protos.HistoryEvent`. Namespace defaults to **`default`** (configurable; standalone `dapr run` uses `default`).
- **Removal tiers (spec §7), chosen per workflow:**
  - **Terminal** state (Completed / Failed / Terminated) + healthy sidecar → `POST /v1.0-beta1/workflows/{wfComponent}/{instanceId}/purge`.
  - **Non-terminal** (Running / Suspended / Pending) + healthy sidecar → **Terminate then Purge** (`.../terminate` then `.../purge`), never raw-delete a live workflow when the API is reachable.
  - **Force / no sidecar reachable** → direct state-store deletion of every key matching `<appId>||<workflowActorType>||<instanceId>||%`.
  - `wfComponent` is the Dapr built-in workflow component name **`dapr`** (constant).
  - Every destructive action requires explicit confirmation stating the **affected count** and **which mechanism** runs.
- **Workflow status colors (spec §9.7)** — six base hues, each resolved to a **theme-aware pair** (tinted bg + readable fg) meeting AA in both themes; state encoded as color **and** a text pill (never color alone): Running `#129AF3` · Completed `#0BDD39` · Failed `#DD0B46` · Terminated `#637381` · Suspended `#8330FF` · Pending `#B1AC00`. Define every token in `web/src/styles/theme.css` for light **and** dark — never hardcode theme-varying literals in components.
- **Single global autorefresh interval** drives the Workflows list **and** the detail view (reuse `useRefreshInterval`/`refetchMs`; 1s available for close watching). The **wall-clock ticks continuously** independent of the interval. Logs/SSE are out of scope (Plan 5).
- **Refresh never fights interaction:** detail history merges new events **by sequence id** (no duplicates), preserving expanded events + scroll position; open purge dialogs and row selection pause/ignore background refresh effects on the rows they touch.
- **View state in the URL:** the Workflows list encodes status filter, search text, and the active state-store in the query string (shareable, survives refresh/back-forward); the document `<title>` updates per view.
- **Rows aren't links:** the instance-id cell is the navigation link; the row is not a link. Row checkbox (bulk select) and kebab/actions are independent focusable controls.
- **Graceful degradation (spec §11):** state store not detected / unreachable → the Workflows view shows an actionable message + the `--statestore` hint; the rest of the dashboard keeps working. Multiple stores → user picks the active one.

## File Structure

```
pkg/statestore/
  keys.go            # WorkflowActorType, InstanceMetaPattern, InstancePrefix, ParseInstanceID, key-suffix consts
  keys_test.go
  store.go           # Store interface + Component spec type; New(spec) builds a components-contrib state.Store; Keys/BulkGet/Get/Delete
  detect.go          # Detect([]string resourcePaths) ([]Detected, error) — walk YAML, keep kind=state stores
  detect_test.go
  store_integration_test.go   # //go:build integration — miniredis-backed Keys/Get/Delete + round-trip
pkg/workflow/
  types.go           # Status + normalization; ExecutionSummary, Execution, HistoryEvent, ListResult, FailureDetails (JSON tags)
  types_test.go
  decode.go          # DecodeExecution(appID, instanceID, history, customStatus) ; decodeEvent(); status/name/io extraction
  decode_test.go
  removal.go         # Mechanism + SelectMechanism(status, sidecarHealthy, force)
  removal_test.go
  service.go         # Service interface + impl: List / Get over a statestore.Store
  service_test.go
  remove.go          # Remove(ctx, item, force) — terminate/purge HTTP + force key-delete; bulk
  remove_test.go
  workflow_integration_test.go # //go:build integration — seed miniredis with proto history, assert List/Get
pkg/server/
  workflows.go       # workflowsRouter(svc workflow.Service, stores statestore.Registry) + handlers
  workflows_test.go
  api.go             # MODIFY: apiRouter(v, apps, wf, stores) mounts /workflows + /statestores
  server.go          # MODIFY: Options.Workflows, Options.Stores; NewRouter passes them
  server_test.go     # MODIFY: pass fakes
cmd/root.go          # MODIFY: --statestore flag; detect stores; build workflow.Service; set Options
web/src/
  styles/theme.css   # MODIFY: 6 workflow status token pairs (light/dark)
  components/StatusPill.tsx
  components/StatusPill.test.tsx
  components/ConfirmRemoveDialog.tsx
  components/ConfirmRemoveDialog.test.tsx
  types/workflow.ts          # WorkflowStatus, WorkflowSummary, WorkflowExecution, WorkflowHistoryEvent, ListResult, StateStore
  hooks/useWorkflows.ts      # useWorkflows(query) list + cursor; useWorkflow(appId,id) detail; useStateStores()
  hooks/useWorkflows.test.tsx
  hooks/useWorkflowRemoval.ts # terminate/purge/bulk mutations (TanStack useMutation)
  hooks/useWorkflowRemoval.test.tsx
  lib/wallclock.ts           # elapsed(createdAt, endedAt?) formatting helper
  lib/wallclock.test.ts
  pages/Workflows.tsx        # list: filter + search + load-more + selection + bulk action
  pages/Workflows.test.tsx
  pages/WorkflowDetail.tsx   # header + wall-clock + copyable io/customStatus + live timeline
  pages/WorkflowDetail.test.tsx
  router.tsx                 # MODIFY: /workflows → Workflows; add /workflows/:appId/:instanceId
```

---

### Task 1: Workflow DTO types + status normalization

**Files:** Create `pkg/workflow/types.go`, `pkg/workflow/types_test.go`

**Interfaces — Produces:**
```go
type Status string
const (
  StatusPending    Status = "Pending"
  StatusRunning    Status = "Running"
  StatusCompleted  Status = "Completed"
  StatusFailed     Status = "Failed"
  StatusTerminated Status = "Terminated"
  StatusSuspended  Status = "Suspended"
)
// NormalizeStatus maps a durabletask ORCHESTRATION_STATUS_* string to a dashboard Status.
func NormalizeStatus(raw string) Status

type FailureDetails struct {
  ErrorType string `json:"errorType,omitempty"`
  Message   string `json:"message,omitempty"`
}
type HistoryEvent struct {
  SequenceID int32      `json:"sequenceId"`
  Timestamp  time.Time  `json:"timestamp"`
  Type       string     `json:"type"`           // e.g. "ExecutionStarted", "TaskCompleted"
  Name       string     `json:"name,omitempty"` // task / workflow name where applicable
  Input      *string    `json:"input,omitempty"`
  Output     *string    `json:"output,omitempty"`
}
type ExecutionSummary struct {
  AppID         string     `json:"appId"`
  InstanceID    string     `json:"instanceId"`
  Name          string     `json:"name"`
  Status        Status     `json:"status"`
  CreatedAt     *time.Time `json:"createdAt,omitempty"`
  LastUpdatedAt *time.Time `json:"lastUpdatedAt,omitempty"`
}
type Execution struct {
  ExecutionSummary
  Input          *string         `json:"input,omitempty"`
  Output         *string         `json:"output,omitempty"`
  CustomStatus   string          `json:"customStatus,omitempty"`
  ReplayCount    int             `json:"replayCount"`
  FailureDetails *FailureDetails `json:"failureDetails,omitempty"`
  History        []HistoryEvent  `json:"history"`
}
type ListResult struct {
  Items     []ExecutionSummary `json:"items"`
  NextToken string             `json:"nextToken,omitempty"`
}
```

- [ ] **Step 1: Write the failing test** (`types_test.go`, `//go:build unit`):
```go
//go:build unit

package workflow

import (
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestNormalizeStatus(t *testing.T) {
	cases := map[string]Status{
		"ORCHESTRATION_STATUS_RUNNING":          StatusRunning,
		"ORCHESTRATION_STATUS_CONTINUED_AS_NEW": StatusRunning,
		"ORCHESTRATION_STATUS_COMPLETED":        StatusCompleted,
		"ORCHESTRATION_STATUS_FAILED":           StatusFailed,
		"ORCHESTRATION_STATUS_TERMINATED":       StatusTerminated,
		"ORCHESTRATION_STATUS_CANCELED":         StatusTerminated,
		"ORCHESTRATION_STATUS_SUSPENDED":        StatusSuspended,
		"ORCHESTRATION_STATUS_PENDING":          StatusPending,
		"ORCHESTRATION_STATUS_STALLED":          StatusRunning,
		"something-unknown":                     StatusPending,
	}
	for raw, want := range cases {
		t.Run(raw, func(t *testing.T) { require.Equal(t, want, NormalizeStatus(raw)) })
	}
}

func TestExecutionJSONKeys(t *testing.T) {
	b, err := json.Marshal(Execution{
		ExecutionSummary: ExecutionSummary{AppID: "order", InstanceID: "abc", Status: StatusRunning},
		ReplayCount:      2,
		History:          []HistoryEvent{},
	})
	require.NoError(t, err)
	s := string(b)
	require.Contains(t, s, `"instanceId":"abc"`)
	require.Contains(t, s, `"status":"Running"`)
	require.Contains(t, s, `"replayCount":2`)
	require.Contains(t, s, `"history":[]`)
}
```
- [ ] **Step 2: Run → fail.** `go test -tags unit ./pkg/workflow/ -run TestNormalizeStatus -v` → FAIL (no package).
- [ ] **Step 3: Implement** `types.go`:
```go
package workflow

import "time"

type Status string

const (
	StatusPending    Status = "Pending"
	StatusRunning    Status = "Running"
	StatusCompleted  Status = "Completed"
	StatusFailed     Status = "Failed"
	StatusTerminated Status = "Terminated"
	StatusSuspended  Status = "Suspended"
)

// NormalizeStatus maps a durabletask ORCHESTRATION_STATUS_* string onto the
// six dashboard statuses. Unknown / not-yet-started values map to Pending.
func NormalizeStatus(raw string) Status {
	switch raw {
	case "ORCHESTRATION_STATUS_COMPLETED":
		return StatusCompleted
	case "ORCHESTRATION_STATUS_FAILED":
		return StatusFailed
	case "ORCHESTRATION_STATUS_TERMINATED", "ORCHESTRATION_STATUS_CANCELED":
		return StatusTerminated
	case "ORCHESTRATION_STATUS_SUSPENDED":
		return StatusSuspended
	case "ORCHESTRATION_STATUS_RUNNING", "ORCHESTRATION_STATUS_CONTINUED_AS_NEW", "ORCHESTRATION_STATUS_STALLED":
		return StatusRunning
	default:
		return StatusPending
	}
}

// IsTerminal reports whether a status is final (no further events expected).
func (s Status) IsTerminal() bool {
	return s == StatusCompleted || s == StatusFailed || s == StatusTerminated
}

type FailureDetails struct {
	ErrorType string `json:"errorType,omitempty"`
	Message   string `json:"message,omitempty"`
}

type HistoryEvent struct {
	SequenceID int32     `json:"sequenceId"`
	Timestamp  time.Time `json:"timestamp"`
	Type       string    `json:"type"`
	Name       string    `json:"name,omitempty"`
	Input      *string   `json:"input,omitempty"`
	Output     *string   `json:"output,omitempty"`
}

type ExecutionSummary struct {
	AppID         string     `json:"appId"`
	InstanceID    string     `json:"instanceId"`
	Name          string     `json:"name"`
	Status        Status     `json:"status"`
	CreatedAt     *time.Time `json:"createdAt,omitempty"`
	LastUpdatedAt *time.Time `json:"lastUpdatedAt,omitempty"`
}

type Execution struct {
	ExecutionSummary
	Input          *string         `json:"input,omitempty"`
	Output         *string         `json:"output,omitempty"`
	CustomStatus   string          `json:"customStatus,omitempty"`
	ReplayCount    int             `json:"replayCount"`
	FailureDetails *FailureDetails `json:"failureDetails,omitempty"`
	History        []HistoryEvent  `json:"history"`
}

type ListResult struct {
	Items     []ExecutionSummary `json:"items"`
	NextToken string             `json:"nextToken,omitempty"`
}
```
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/workflow/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/workflow && git add pkg/workflow/types.go pkg/workflow/types_test.go && git commit -m "feat(workflow): execution DTOs + status normalization"`

---

### Task 2: Decode history → Execution DTO

**Files:** Create `pkg/workflow/decode.go`, `pkg/workflow/decode_test.go`

**Interfaces — Produces:**
```go
// DecodeExecution assembles a full Execution from an instance's decoded history
// events and optional custom status. history is ordered as loaded from the store.
func DecodeExecution(appID, instanceID string, history []*protos.HistoryEvent, customStatus string) Execution
```
Uses `runtimestate.NewOrchestrationRuntimeState(instanceID, customStatusWrapper, history)` then `runtimestate.{Name,Input,Output,RuntimeStatus,CreatedTime,LastUpdatedTime,FailureDetails}` for the header; builds the `[]HistoryEvent` timeline by walking each `protos.HistoryEvent` (sequence id = `GetEventId()`, timestamp = `GetTimestamp().AsTime().Local()`, type via a oneof switch, input/output extracted per event type); `ReplayCount` = count of `OrchestratorStarted`/`WorkflowStarted` events minus 1 (min 0). `LastUpdatedAt` is set only when the status is terminal.

**Interfaces — Consumes:** `protos` = `github.com/dapr/durabletask-go/api/protos`; `runtimestate` = `github.com/dapr/durabletask-go/backend/runtimestate`; `wrapperspb` = `google.golang.org/protobuf/types/known/wrapperspb`.

- [ ] **Step 1: Add deps.** `go get github.com/dapr/durabletask-go@v0.12.1` (promotes the existing indirect dep to direct; `google.golang.org/protobuf` is already present).
- [ ] **Step 2: Write the failing test** with constructed proto history (mirrors the prototype's `execution_test.go` pattern):
```go
//go:build unit

package workflow

import (
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func TestDecodeExecutionRunning(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: -1, Timestamp: now, EventType: &protos.HistoryEvent_OrchestratorStarted{OrchestratorStarted: &protos.OrchestratorStartedEvent{}}},
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name:  "OrderWorkflow",
			Input: &wrapperspb.StringValue{Value: `{"id":1}`},
		}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "Charge"}}},
	}
	ex := DecodeExecution("order", "inst-1", history, "step 2/3")

	require.Equal(t, "order", ex.AppID)
	require.Equal(t, "inst-1", ex.InstanceID)
	require.Equal(t, "OrderWorkflow", ex.Name)
	require.Equal(t, StatusRunning, ex.Status)
	require.NotNil(t, ex.CreatedAt)
	require.Nil(t, ex.LastUpdatedAt) // not terminal
	require.NotNil(t, ex.Input)
	require.Equal(t, `{"id":1}`, *ex.Input)
	require.Equal(t, "step 2/3", ex.CustomStatus)
	require.Len(t, ex.History, 3)
	require.Equal(t, "ExecutionStarted", ex.History[1].Type)
	require.Equal(t, "Charge", ex.History[2].Name)
}

func TestDecodeExecutionCompleted(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
			OrchestrationStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:              &wrapperspb.StringValue{Value: `"done"`},
		}}},
	}
	ex := DecodeExecution("order", "inst-2", history, "")
	require.Equal(t, StatusCompleted, ex.Status)
	require.NotNil(t, ex.LastUpdatedAt)
	require.NotNil(t, ex.Output)
	require.Equal(t, `"done"`, *ex.Output)
}
```
> Note: the implementer should confirm proto oneof getter names with `go doc github.com/dapr/durabletask-go/api/protos.HistoryEvent` — the field accessors (`GetExecutionStarted()`, `GetTaskScheduled()`, `GetTaskCompleted()`, `GetExecutionCompleted()`, `GetOrchestratorStarted()`, `GetTimerCreated()`, `GetTimerFired()`, `GetTaskFailed()`, `GetExecutionTerminated()`, `GetExecutionSuspended()`, `GetExecutionResumed()`, `GetEventRaised()`, `GetEventSent()`, `GetSubOrchestrationInstanceCreated()` …) drive the `decodeEvent` type switch.
- [ ] **Step 3: Run → fail.**
- [ ] **Step 4: Implement** `decode.go`:
```go
package workflow

import (
	"time"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/dapr/durabletask-go/backend/runtimestate"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// DecodeExecution builds a full Execution from an instance's history events.
func DecodeExecution(appID, instanceID string, history []*protos.HistoryEvent, customStatus string) Execution {
	var cs *wrapperspb.StringValue
	if customStatus != "" {
		cs = &wrapperspb.StringValue{Value: customStatus}
	}
	rs := runtimestate.NewOrchestrationRuntimeState(instanceID, cs, history)

	status := NormalizeStatus(runtimestate.RuntimeStatus(rs).String())
	ex := Execution{
		ExecutionSummary: ExecutionSummary{
			AppID:      appID,
			InstanceID: instanceID,
			Status:     status,
		},
		CustomStatus: customStatus,
		History:      make([]HistoryEvent, 0, len(history)),
	}
	if name, err := runtimestate.Name(rs); err == nil {
		ex.Name = name
	}
	if created, err := runtimestate.CreatedTime(rs); err == nil && !created.IsZero() {
		c := created.Local()
		ex.CreatedAt = &c
	}
	if in, err := runtimestate.Input(rs); err == nil && in != nil {
		v := in.GetValue()
		ex.Input = &v
	}
	if out, err := runtimestate.Output(rs); err == nil && out != nil {
		v := out.GetValue()
		ex.Output = &v
	}
	if fd, err := runtimestate.FailureDetails(rs); err == nil && fd != nil {
		ex.FailureDetails = &FailureDetails{ErrorType: fd.GetErrorType(), Message: fd.GetErrorMessage()}
	}
	if status.IsTerminal() {
		if upd, err := runtimestate.LastUpdatedTime(rs); err == nil && !upd.IsZero() {
			u := upd.Local()
			ex.LastUpdatedAt = &u
		}
	}

	replays := 0
	for _, e := range history {
		if e.GetOrchestratorStarted() != nil {
			replays++
		}
		ex.History = append(ex.History, decodeEvent(e))
	}
	if replays > 0 {
		ex.ReplayCount = replays - 1
	}
	return ex
}

func decodeEvent(e *protos.HistoryEvent) HistoryEvent {
	ev := HistoryEvent{SequenceID: e.GetEventId()}
	if ts := e.GetTimestamp(); ts != nil {
		ev.Timestamp = ts.AsTime().Local()
	}
	switch {
	case e.GetExecutionStarted() != nil:
		ev.Type = "ExecutionStarted"
		s := e.GetExecutionStarted()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetExecutionCompleted() != nil:
		ev.Type = "ExecutionCompleted"
		ev.Output = strval(e.GetExecutionCompleted().GetResult())
	case e.GetExecutionTerminated() != nil:
		ev.Type = "ExecutionTerminated"
		ev.Output = strval(e.GetExecutionTerminated().GetInput())
	case e.GetExecutionSuspended() != nil:
		ev.Type = "ExecutionSuspended"
	case e.GetExecutionResumed() != nil:
		ev.Type = "ExecutionResumed"
	case e.GetTaskScheduled() != nil:
		ev.Type = "TaskScheduled"
		s := e.GetTaskScheduled()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetTaskCompleted() != nil:
		ev.Type = "TaskCompleted"
		ev.Output = strval(e.GetTaskCompleted().GetResult())
	case e.GetTaskFailed() != nil:
		ev.Type = "TaskFailed"
	case e.GetTimerCreated() != nil:
		ev.Type = "TimerCreated"
	case e.GetTimerFired() != nil:
		ev.Type = "TimerFired"
	case e.GetEventRaised() != nil:
		ev.Type = "EventRaised"
		s := e.GetEventRaised()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetEventSent() != nil:
		ev.Type = "EventSent"
		s := e.GetEventSent()
		ev.Name = s.GetName()
		ev.Input = strval(s.GetInput())
	case e.GetOrchestratorStarted() != nil:
		ev.Type = "OrchestratorStarted"
	case e.GetOrchestratorCompleted() != nil:
		ev.Type = "OrchestratorCompleted"
	case e.GetSubOrchestrationInstanceCreated() != nil:
		ev.Type = "SubOrchestrationCreated"
	default:
		ev.Type = "Unknown"
	}
	return ev
}

func strval(v *wrapperspb.StringValue) *string {
	if v == nil {
		return nil
	}
	s := v.GetValue()
	return &s
}

var _ = time.Time{} // keep time import if trimmed by future edits
```
> Drop the trailing `time` placeholder line if `time` is otherwise referenced (it is, via the struct). Run `go vet`; remove unused imports. The `decodeEvent` switch is best-effort — if a getter name differs in the pinned protos, the implementer adjusts that case; unrecognized events fall to `"Unknown"` and never panic.
- [ ] **Step 5: Run → pass.** `go test -tags unit ./pkg/workflow/ -v`
- [ ] **Step 6: Commit.** `gofmt -w pkg/workflow && go mod tidy && git add pkg/workflow/decode.go pkg/workflow/decode_test.go go.mod go.sum && git commit -m "feat(workflow): decode durabletask history into Execution DTO"`

---

### Task 3: State-store key helpers

**Files:** Create `pkg/statestore/keys.go`, `pkg/statestore/keys_test.go`

**Interfaces — Produces:**
```go
const (
  KeyDelimiter      = "||"
  SuffixMetadata    = "metadata"
  SuffixCustomStatus = "customStatus"
  HistoryPrefix     = "history-"
)
// WorkflowActorType returns "dapr.internal.<namespace>.<appId>.workflow".
func WorkflowActorType(namespace, appID string) string
// InstanceMetaPattern returns a KeysLike LIKE pattern matching every instance's
// metadata key for an app: "<appId>||<actorType>||%||metadata".
func InstanceMetaPattern(namespace, appID string) string
// InstancePrefix returns "<appId>||<actorType>||<instanceID>||".
func InstancePrefix(namespace, appID, instanceID string) string
// InstanceKeyPattern returns "<appId>||<actorType>||<instanceID>||%" (all keys of one instance).
func InstanceKeyPattern(namespace, appID, instanceID string) string
// ParseInstanceID extracts the instanceID segment (index 2) from a "||"-joined key; ok=false if malformed.
func ParseInstanceID(key string) (instanceID string, ok bool)
```

- [ ] **Step 1: Write the failing test:**
```go
//go:build unit

package statestore

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestWorkflowActorType(t *testing.T) {
	require.Equal(t, "dapr.internal.default.order.workflow", WorkflowActorType("default", "order"))
}

func TestPatterns(t *testing.T) {
	require.Equal(t, "order||dapr.internal.default.order.workflow||%||metadata", InstanceMetaPattern("default", "order"))
	require.Equal(t, "order||dapr.internal.default.order.workflow||abc||", InstancePrefix("default", "order", "abc"))
	require.Equal(t, "order||dapr.internal.default.order.workflow||abc||%", InstanceKeyPattern("default", "order", "abc"))
}

func TestParseInstanceID(t *testing.T) {
	id, ok := ParseInstanceID("order||dapr.internal.default.order.workflow||abc-123||metadata")
	require.True(t, ok)
	require.Equal(t, "abc-123", id)

	_, ok = ParseInstanceID("too||few")
	require.False(t, ok)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `keys.go`:
```go
package statestore

import "strings"

const (
	KeyDelimiter       = "||"
	SuffixMetadata     = "metadata"
	SuffixCustomStatus = "customStatus"
	HistoryPrefix      = "history-"
)

// WorkflowActorType builds the Dapr workflow actor type for an app.
func WorkflowActorType(namespace, appID string) string {
	return "dapr.internal." + namespace + "." + appID + ".workflow"
}

// InstanceMetaPattern is a KeysLike LIKE pattern matching every instance's
// metadata key for an app ("%" matches the instance-id segment).
func InstanceMetaPattern(namespace, appID string) string {
	return appID + KeyDelimiter + WorkflowActorType(namespace, appID) + KeyDelimiter + "%" + KeyDelimiter + SuffixMetadata
}

// InstancePrefix is the "<appId>||<actorType>||<instanceID>||" prefix.
func InstancePrefix(namespace, appID, instanceID string) string {
	return appID + KeyDelimiter + WorkflowActorType(namespace, appID) + KeyDelimiter + instanceID + KeyDelimiter
}

// InstanceKeyPattern matches every state key belonging to one instance.
func InstanceKeyPattern(namespace, appID, instanceID string) string {
	return InstancePrefix(namespace, appID, instanceID) + "%"
}

// ParseInstanceID returns the instance-id segment of a "||"-joined workflow key.
func ParseInstanceID(key string) (string, bool) {
	parts := strings.Split(key, KeyDelimiter)
	if len(parts) < 3 || parts[2] == "" {
		return "", false
	}
	return parts[2], true
}
```
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/statestore/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/statestore && git add pkg/statestore/keys.go pkg/statestore/keys_test.go && git commit -m "feat(statestore): workflow key patterns + parsing"`

---

### Task 4: State-store client (components-contrib backed)

**Files:** Create `pkg/statestore/store.go`

**Interfaces — Produces:**
```go
// Component is the parsed subset of a Dapr state-store component YAML we need.
type Component struct {
  Name     string            // metadata.name
  Type     string            // spec.type, e.g. "state.redis"
  Version  string            // spec.version
  Metadata map[string]string // spec.metadata name->value
  Path     string            // source file path (for display / disambiguation)
}

// Store is the read + delete surface the workflow service needs.
type Store interface {
  // Keys lists keys matching a LIKE pattern, with opaque cursor paging.
  Keys(ctx context.Context, pattern string, token string, pageSize int) (keys []string, next string, err error)
  Get(ctx context.Context, key string) ([]byte, error)         // nil bytes if missing
  BulkGet(ctx context.Context, keys []string) (map[string][]byte, error)
  Delete(ctx context.Context, key string) error
  Close() error
}

// New builds and initializes a components-contrib state store from a component spec.
// Supports state.redis, state.sqlite, state.postgresql (v2). Returns ErrUnsupported otherwise.
func New(ctx context.Context, c Component) (Store, error)

var ErrUnsupported = errors.New("unsupported state store type")
```
Implementation: switch on `c.Type` → `redis.NewRedisStateStore(logger.NewLogger("dashboard"))` / `sqlite.NewSQLiteStateStore(...)` / `pgv2.NewPostgreSQLStateStore(...)`; `.Init(ctx, state.Metadata{Base: metadata.Base{Name: c.Name, Properties: c.Metadata}})`. `Keys` type-asserts `state.KeysLiker` (→ `fmt.Errorf("store %q does not support key listing", c.Type)` if absent) and calls `KeysLike(ctx, &state.KeysLikeRequest{Pattern: pattern, ContinuationToken: tokenPtr, PageSize: sizePtr})`. `Get` → `store.Get(ctx, &state.GetRequest{Key: key})` returning `resp.Data`. `Delete` → `store.Delete(ctx, &state.DeleteRequest{Key: key})`. `Close` calls `io.Closer`/`Closer` if implemented, else nil.

> No unit test here (it needs a live backend; covered by the miniredis integration test in Task 10). Verify it compiles + `go vet` passes. The implementer confirms exact constructor import paths with `go doc github.com/dapr/components-contrib/state/redis` etc., and the `logger` package path `github.com/dapr/kit/logger`.

- [ ] **Step 1: Add deps.** `go get github.com/dapr/components-contrib@v1.18.0` (promotes indirect → direct; redis/sqlite/pg drivers come transitively).
- [ ] **Step 2: Implement** `store.go` per the interface above. Key skeleton:
```go
package statestore

import (
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/dapr/components-contrib/metadata"
	"github.com/dapr/components-contrib/state"
	"github.com/dapr/components-contrib/state/postgresql/v2"
	"github.com/dapr/components-contrib/state/redis"
	"github.com/dapr/components-contrib/state/sqlite"
	"github.com/dapr/kit/logger"
)

var ErrUnsupported = errors.New("unsupported state store type")

type Component struct {
	Name     string
	Type     string
	Version  string
	Metadata map[string]string
	Path     string
}

type Store interface {
	Keys(ctx context.Context, pattern, token string, pageSize int) ([]string, string, error)
	Get(ctx context.Context, key string) ([]byte, error)
	BulkGet(ctx context.Context, keys []string) (map[string][]byte, error)
	Delete(ctx context.Context, key string) error
	Close() error
}

type ccStore struct{ inner state.Store }

func New(ctx context.Context, c Component) (Store, error) {
	log := logger.NewLogger("dev-dashboard")
	var inner state.Store
	switch c.Type {
	case "state.redis":
		inner = redis.NewRedisStateStore(log)
	case "state.sqlite":
		inner = sqlite.NewSQLiteStateStore(log)
	case "state.postgresql", "state.postgres":
		inner = postgresql.NewPostgreSQLStateStore(log)
	default:
		return nil, fmt.Errorf("%w: %s", ErrUnsupported, c.Type)
	}
	if err := inner.Init(ctx, state.Metadata{Base: metadata.Base{Name: c.Name, Properties: c.Metadata}}); err != nil {
		return nil, fmt.Errorf("init %s: %w", c.Type, err)
	}
	return &ccStore{inner: inner}, nil
}

func (s *ccStore) Keys(ctx context.Context, pattern, token string, pageSize int) ([]string, string, error) {
	kl, ok := s.inner.(state.KeysLiker)
	if !ok {
		return nil, "", fmt.Errorf("store does not support key listing")
	}
	req := &state.KeysLikeRequest{Pattern: pattern}
	if token != "" {
		req.ContinuationToken = &token
	}
	if pageSize > 0 {
		ps := uint32(pageSize)
		req.PageSize = &ps
	}
	resp, err := kl.KeysLike(ctx, req)
	if err != nil {
		return nil, "", err
	}
	next := ""
	if resp.ContinuationToken != nil {
		next = *resp.ContinuationToken
	}
	return resp.Keys, next, nil
}

func (s *ccStore) Get(ctx context.Context, key string) ([]byte, error) {
	resp, err := s.inner.Get(ctx, &state.GetRequest{Key: key})
	if err != nil {
		return nil, err
	}
	return resp.Data, nil
}

func (s *ccStore) BulkGet(ctx context.Context, keys []string) (map[string][]byte, error) {
	out := make(map[string][]byte, len(keys))
	for _, k := range keys {
		b, err := s.Get(ctx, k)
		if err != nil {
			return nil, err
		}
		out[k] = b
	}
	return out, nil
}

func (s *ccStore) Delete(ctx context.Context, key string) error {
	return s.inner.Delete(ctx, &state.DeleteRequest{Key: key})
}

func (s *ccStore) Close() error {
	if c, ok := s.inner.(io.Closer); ok {
		return c.Close()
	}
	return nil
}
```
> `BulkGet` is a simple per-key loop in v1 (correct for the modest local key counts); a future optimization can use `state.BulkStore` if a backend benefits. Confirm the postgres v2 import alias resolves (`go doc github.com/dapr/components-contrib/state/postgresql/v2`); adjust the alias if the package name isn't `postgresql`.
- [ ] **Step 3: Verify.** `go build ./... && go vet -tags unit ./...`
- [ ] **Step 4: Commit.** `gofmt -w pkg/statestore && go mod tidy && git add pkg/statestore/store.go go.mod go.sum && git commit -m "feat(statestore): components-contrib backed store (redis/sqlite/postgres)"`

---

### Task 5: State-store detection from component YAML

**Files:** Create `pkg/statestore/detect.go`, `pkg/statestore/detect_test.go`

**Interfaces — Produces:**
```go
// Detect walks the given resource paths (files or dirs) for Dapr component
// YAML of kind "Component" whose spec.type starts with "state.", returning one
// Component per match. Non-YAML files and parse errors for individual files are skipped.
func Detect(paths []string) ([]Component, error)
```
Parses each `*.yaml`/`*.yml` with `sigs.k8s.io/yaml` into a minimal struct (`kind`, `metadata.name`, `spec.type`, `spec.version`, `spec.metadata[]{name,value}`); keeps only `kind: Component` + `strings.HasPrefix(spec.type, "state.")`.

- [ ] **Step 1: Write the failing test** (writes a temp YAML dir):
```go
//go:build unit

package statestore

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/require"
)

const redisComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: statestore
spec:
  type: state.redis
  version: v1
  metadata:
    - name: redisHost
      value: localhost:6379
    - name: actorStateStore
      value: "true"
`

const pubsubComponent = `
apiVersion: dapr.io/v1alpha1
kind: Component
metadata:
  name: pubsub
spec:
  type: pubsub.redis
  version: v1
`

func TestDetect(t *testing.T) {
	dir := t.TempDir()
	require.NoError(t, os.WriteFile(filepath.Join(dir, "redis.yaml"), []byte(redisComponent), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "pubsub.yaml"), []byte(pubsubComponent), 0o600))
	require.NoError(t, os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("ignore me"), 0o600))

	got, err := Detect([]string{dir})
	require.NoError(t, err)
	require.Len(t, got, 1)
	require.Equal(t, "statestore", got[0].Name)
	require.Equal(t, "state.redis", got[0].Type)
	require.Equal(t, "localhost:6379", got[0].Metadata["redisHost"])
	require.Equal(t, "true", got[0].Metadata["actorStateStore"])
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `detect.go`:
```go
package statestore

import (
	"os"
	"path/filepath"
	"strings"

	"sigs.k8s.io/yaml"
)

type rawComponent struct {
	Kind     string `json:"kind"`
	Metadata struct {
		Name string `json:"name"`
	} `json:"metadata"`
	Spec struct {
		Type     string `json:"type"`
		Version  string `json:"version"`
		Metadata []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"metadata"`
	} `json:"spec"`
}

// Detect finds state-store components under the given files or directories.
func Detect(paths []string) ([]Component, error) {
	var out []Component
	seen := map[string]bool{}
	for _, p := range paths {
		_ = filepath.Walk(p, func(path string, info os.FileInfo, err error) error {
			if err != nil || info.IsDir() {
				return nil
			}
			ext := strings.ToLower(filepath.Ext(path))
			if ext != ".yaml" && ext != ".yml" {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return nil
			}
			var rc rawComponent
			if err := yaml.Unmarshal(data, &rc); err != nil {
				return nil
			}
			if rc.Kind != "Component" || !strings.HasPrefix(rc.Spec.Type, "state.") {
				return nil
			}
			md := make(map[string]string, len(rc.Spec.Metadata))
			for _, m := range rc.Spec.Metadata {
				md[m.Name] = m.Value
			}
			key := path
			if seen[key] {
				return nil
			}
			seen[key] = true
			out = append(out, Component{
				Name: rc.Metadata.Name, Type: rc.Spec.Type, Version: rc.Spec.Version,
				Metadata: md, Path: path,
			})
			return nil
		})
	}
	return out, nil
}
```
> `sigs.k8s.io/yaml` is already in the module graph (it converts YAML→JSON, so `json` tags work). A multi-doc YAML file with several components is rare for state stores; if needed later, split on `---`. Out of scope for v1.
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/statestore/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/statestore && git add pkg/statestore/detect.go pkg/statestore/detect_test.go && git commit -m "feat(statestore): detect state-store components from YAML"`

---

### Task 6: Workflow service — List

**Files:** Create `pkg/workflow/service.go`, `pkg/workflow/service_test.go`

**Interfaces — Produces:**
```go
type ListQuery struct {
  AppID     string   // "" = all apps
  Status    []Status // empty = all
  Search    string   // substring match on instanceID or name (case-insensitive)
  PageSize  int      // 0 = default (50)
  PageToken string   // opaque cursor
}
type Service interface {
  List(ctx context.Context, q ListQuery) (ListResult, error)
  Get(ctx context.Context, appID, instanceID string) (Execution, error)
}
// New builds a Service. appIDs is the set of app ids to scan (from discovery).
// store is the active state store; namespace defaults to "default" if empty.
func New(store statestore.Store, namespace string, appIDs func(context.Context) ([]string, error)) Service

var ErrNotFound = errors.New("workflow not found")
var ErrNoStore   = errors.New("no state store configured")
```
`List`: for each appID (from `appIDs`), `store.Keys(InstanceMetaPattern(ns, appID), token, pageSize)`; parse instanceIDs; for each, load its history (helper `loadHistory`) + customStatus, `DecodeExecution`, then **filter** by Status/Search; sort by `CreatedAt` descending (nil last); cap to PageSize and surface the store's `next` token. `Get`: load one instance's history + customStatus → `DecodeExecution`; `ErrNotFound` if no keys.

**Interfaces — Consumes:** `statestore.Store`, `statestore.{InstanceMetaPattern,InstancePrefix,InstanceKeyPattern,ParseInstanceID,SuffixCustomStatus,HistoryPrefix,SuffixMetadata}`; `proto.Unmarshal` (`google.golang.org/protobuf/proto`) into `protos.HistoryEvent`.

- [ ] **Step 1: Write the failing test** with an in-memory fake `statestore.Store` seeded with proto-marshaled history (shared `fakeStore` helper defined here, reused by Tasks 7 & 9):
```go
//go:build unit

package workflow

import (
	"context"
	"sort"
	"strings"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// fakeStore is an in-memory statestore.Store for unit tests.
type fakeStore struct{ kv map[string][]byte }

func newFakeStore() *fakeStore { return &fakeStore{kv: map[string][]byte{}} }

func (f *fakeStore) Keys(_ context.Context, pattern, _ string, _ int) ([]string, string, error) {
	like := strings.TrimSuffix(pattern, "%") // crude prefix match good enough for tests
	var prefix, suffix string
	if i := strings.Index(pattern, "%"); i >= 0 {
		prefix = pattern[:i]
		suffix = pattern[i+1:]
	} else {
		prefix = pattern
	}
	_ = like
	var out []string
	for k := range f.kv {
		if strings.HasPrefix(k, prefix) && strings.HasSuffix(k, suffix) {
			out = append(out, k)
		}
	}
	sort.Strings(out)
	return out, "", nil
}
func (f *fakeStore) Get(_ context.Context, key string) ([]byte, error) { return f.kv[key], nil }
func (f *fakeStore) BulkGet(_ context.Context, keys []string) (map[string][]byte, error) {
	m := map[string][]byte{}
	for _, k := range keys {
		m[k] = f.kv[k]
	}
	return m, nil
}
func (f *fakeStore) Delete(_ context.Context, key string) error { delete(f.kv, key); return nil }
func (f *fakeStore) Close() error                               { return nil }

// seedWorkflow writes metadata + history-* keys for one instance into the fake store.
func seedWorkflow(t *testing.T, f *fakeStore, ns, appID, instanceID, name string, events []*protos.HistoryEvent) {
	t.Helper()
	prefix := statestore.InstancePrefix(ns, appID, instanceID)
	f.kv[prefix+statestore.SuffixMetadata] = []byte(`{}`)
	for i, e := range events {
		b, err := proto.Marshal(e)
		require.NoError(t, err)
		f.kv[prefix+statestore.HistoryPrefix+pad6(i)] = b
	}
}

func pad6(i int) string {
	s := "000000" + itoa(i)
	return s[len(s)-6:]
}
func itoa(i int) string { // tiny helper to avoid strconv import noise in the test
	if i == 0 {
		return "0"
	}
	var b []byte
	for i > 0 {
		b = append([]byte{byte('0' + i%10)}, b...)
		i /= 10
	}
	return string(b)
}

func startedEvent(name string) *protos.HistoryEvent {
	return &protos.HistoryEvent{EventId: 0, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionStarted{
		ExecutionStarted: &protos.ExecutionStartedEvent{Name: name, Input: &wrapperspb.StringValue{Value: `{}`}},
	}}
}

func TestServiceListAndFilter(t *testing.T) {
	f := newFakeStore()
	seedWorkflow(t, f, "default", "order", "inst-a", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})
	seedWorkflow(t, f, "default", "order", "inst-b", "OrderWorkflow", []*protos.HistoryEvent{startedEvent("OrderWorkflow")})

	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })

	res, err := svc.List(context.Background(), ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 2)
	require.Equal(t, StatusRunning, res.Items[0].Status)

	// search narrows to one
	res, err = svc.List(context.Background(), ListQuery{Search: "inst-a"})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, "inst-a", res.Items[0].InstanceID)

	// status filter that matches nothing
	res, err = svc.List(context.Background(), ListQuery{Status: []Status{StatusCompleted}})
	require.NoError(t, err)
	require.Empty(t, res.Items)
}

func TestServiceListNoStore(t *testing.T) {
	svc := New(nil, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	_, err := svc.List(context.Background(), ListQuery{})
	require.ErrorIs(t, err, ErrNoStore)
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `service.go`:
```go
package workflow

import (
	"context"
	"errors"
	"sort"
	"strings"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"google.golang.org/protobuf/proto"
)

var (
	ErrNotFound = errors.New("workflow not found")
	ErrNoStore  = errors.New("no state store configured")
)

const defaultPageSize = 50

type ListQuery struct {
	AppID     string
	Status    []Status
	Search    string
	PageSize  int
	PageToken string
}

type Service interface {
	List(ctx context.Context, q ListQuery) (ListResult, error)
	Get(ctx context.Context, appID, instanceID string) (Execution, error)
}

type service struct {
	store     statestore.Store
	namespace string
	appIDs    func(context.Context) ([]string, error)
}

func New(store statestore.Store, namespace string, appIDs func(context.Context) ([]string, error)) Service {
	if namespace == "" {
		namespace = "default"
	}
	return &service{store: store, namespace: namespace, appIDs: appIDs}
}

func (s *service) List(ctx context.Context, q ListQuery) (ListResult, error) {
	if s.store == nil {
		return ListResult{}, ErrNoStore
	}
	apps, err := s.appIDs(ctx)
	if err != nil {
		return ListResult{}, err
	}
	if q.AppID != "" {
		apps = []string{q.AppID}
	}
	pageSize := q.PageSize
	if pageSize <= 0 {
		pageSize = defaultPageSize
	}

	var items []ExecutionSummary
	var next string
	for _, appID := range apps {
		keys, tok, err := s.store.Keys(ctx, statestore.InstanceMetaPattern(s.namespace, appID), q.PageToken, pageSize)
		if err != nil {
			return ListResult{}, err
		}
		if tok != "" {
			next = tok
		}
		for _, k := range keys {
			id, ok := statestore.ParseInstanceID(k)
			if !ok {
				continue
			}
			ex, err := s.load(ctx, appID, id)
			if err != nil {
				continue
			}
			if matches(ex.ExecutionSummary, q) {
				items = append(items, ex.ExecutionSummary)
			}
		}
	}
	sort.SliceStable(items, func(a, b int) bool {
		return afterOrZero(items[a].CreatedAt, items[b].CreatedAt)
	})
	if len(items) > pageSize {
		items = items[:pageSize]
	}
	return ListResult{Items: items, NextToken: next}, nil
}

func (s *service) Get(ctx context.Context, appID, instanceID string) (Execution, error) {
	if s.store == nil {
		return Execution{}, ErrNoStore
	}
	ex, err := s.load(ctx, appID, instanceID)
	if err != nil {
		return Execution{}, err
	}
	if len(ex.History) == 0 && ex.Status == StatusPending && ex.Name == "" {
		return Execution{}, ErrNotFound
	}
	return ex, nil
}

// load reads an instance's history-* and customStatus keys and decodes them.
func (s *service) load(ctx context.Context, appID, instanceID string) (Execution, error) {
	keys, _, err := s.store.Keys(ctx, statestore.InstanceKeyPattern(s.namespace, appID, instanceID), "", 0)
	if err != nil {
		return Execution{}, err
	}
	if len(keys) == 0 {
		return Execution{}, ErrNotFound
	}
	values, err := s.store.BulkGet(ctx, keys)
	if err != nil {
		return Execution{}, err
	}
	prefix := statestore.InstancePrefix(s.namespace, appID, instanceID)
	var history []*protos.HistoryEvent
	var historyKeys []string
	customStatus := ""
	for k := range values {
		suffix := strings.TrimPrefix(k, prefix)
		switch {
		case strings.HasPrefix(suffix, statestore.HistoryPrefix):
			historyKeys = append(historyKeys, k)
		case suffix == statestore.SuffixCustomStatus:
			customStatus = string(values[k])
		}
	}
	sort.Strings(historyKeys) // history-000000, history-000001, ... lexical == chronological
	for _, hk := range historyKeys {
		var e protos.HistoryEvent
		if err := proto.Unmarshal(values[hk], &e); err != nil {
			continue
		}
		history = append(history, &e)
	}
	return DecodeExecution(appID, instanceID, history, customStatus), nil
}

func matches(s ExecutionSummary, q ListQuery) bool {
	if len(q.Status) > 0 {
		found := false
		for _, st := range q.Status {
			if s.Status == st {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	if q.Search != "" {
		needle := strings.ToLower(q.Search)
		if !strings.Contains(strings.ToLower(s.InstanceID), needle) && !strings.Contains(strings.ToLower(s.Name), needle) {
			return false
		}
	}
	return true
}

func afterOrZero(a, b *interface{ }) bool { return false } // replaced below
```
> Remove the bogus `afterOrZero` stub above and implement it correctly with `*time.Time` (add the `time` import):
```go
func afterOrZero(a, b *time.Time) bool {
	if a == nil {
		return false
	}
	if b == nil {
		return true
	}
	return a.After(*b)
}
```
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/workflow/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/workflow && git add pkg/workflow/service.go pkg/workflow/service_test.go && git commit -m "feat(workflow): list service (scan + decode + filter + search)"`

---

### Task 7: Workflow service — Get detail (history timeline)

**Files:** Modify `pkg/workflow/service_test.go` (add a detail test). `Get` is already implemented in Task 6; this task hardens it with an explicit history/output test and the not-found path.

- [ ] **Step 1: Add the failing test** to `service_test.go`:
```go
func TestServiceGetDetail(t *testing.T) {
	f := newFakeStore()
	completed := &protos.HistoryEvent{EventId: 1, Timestamp: timestamppb.Now(), EventType: &protos.HistoryEvent_ExecutionCompleted{
		ExecutionCompleted: &protos.ExecutionCompletedEvent{
			OrchestrationStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:              &wrapperspb.StringValue{Value: `"ok"`},
		},
	}}
	seedWorkflow(t, f, "default", "order", "inst-c", "OrderWorkflow",
		[]*protos.HistoryEvent{startedEvent("OrderWorkflow"), completed})

	svc := New(f, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	ex, err := svc.Get(context.Background(), "order", "inst-c")
	require.NoError(t, err)
	require.Equal(t, StatusCompleted, ex.Status)
	require.Len(t, ex.History, 2)
	require.NotNil(t, ex.Output)
	require.Equal(t, `"ok"`, *ex.Output)

	_, err = svc.Get(context.Background(), "order", "missing")
	require.ErrorIs(t, err, ErrNotFound)
}
```
- [ ] **Step 2: Run.** `go test -tags unit ./pkg/workflow/ -run TestServiceGetDetail -v` — if it passes, `Get` already satisfies the detail contract. If the not-found path fails because an empty `Keys` result isn't reached, confirm `load` returns `ErrNotFound` on zero keys (it does) and that `InstanceKeyPattern` for a missing id yields no fake-store matches.
- [ ] **Step 3: Commit.** `git add pkg/workflow/service_test.go && git commit -m "test(workflow): detail history + not-found coverage"`

---

### Task 8: Removal tier selection

**Files:** Create `pkg/workflow/removal.go`, `pkg/workflow/removal_test.go`

**Interfaces — Produces:**
```go
type Mechanism string
const (
  MechTerminateThenPurge Mechanism = "terminate_then_purge"
  MechPurge              Mechanism = "purge"
  MechForce              Mechanism = "force"
)
// SelectMechanism chooses the removal path for one workflow (spec §7).
func SelectMechanism(status Status, sidecarHealthy, force bool) Mechanism
```
Rules: `force || !sidecarHealthy` → `MechForce`; terminal status (Completed/Failed/Terminated) → `MechPurge`; otherwise (Running/Suspended/Pending) → `MechTerminateThenPurge`.

- [ ] **Step 1: Write the failing test** (table-driven):
```go
//go:build unit

package workflow

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSelectMechanism(t *testing.T) {
	cases := []struct {
		name     string
		status   Status
		healthy  bool
		force    bool
		want     Mechanism
	}{
		{"completed healthy", StatusCompleted, true, false, MechPurge},
		{"failed healthy", StatusFailed, true, false, MechPurge},
		{"terminated healthy", StatusTerminated, true, false, MechPurge},
		{"running healthy", StatusRunning, true, false, MechTerminateThenPurge},
		{"suspended healthy", StatusSuspended, true, false, MechTerminateThenPurge},
		{"pending healthy", StatusPending, true, false, MechTerminateThenPurge},
		{"running no sidecar", StatusRunning, false, false, MechForce},
		{"completed forced", StatusCompleted, true, true, MechForce},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			require.Equal(t, c.want, SelectMechanism(c.status, c.healthy, c.force))
		})
	}
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `removal.go`:
```go
package workflow

type Mechanism string

const (
	MechTerminateThenPurge Mechanism = "terminate_then_purge"
	MechPurge              Mechanism = "purge"
	MechForce              Mechanism = "force"
)

// SelectMechanism chooses the removal path for one workflow (spec §7).
func SelectMechanism(status Status, sidecarHealthy, force bool) Mechanism {
	if force || !sidecarHealthy {
		return MechForce
	}
	if status.IsTerminal() {
		return MechPurge
	}
	return MechTerminateThenPurge
}
```
- [ ] **Step 4: Run → pass.**
- [ ] **Step 5: Commit.** `gofmt -w pkg/workflow && git add pkg/workflow/removal.go pkg/workflow/removal_test.go && git commit -m "feat(workflow): removal-tier selection"`

---

### Task 9: Removal execution — terminate/purge HTTP + force delete

**Files:** Create `pkg/workflow/remove.go`, `pkg/workflow/remove_test.go`

**Interfaces — Produces:**
```go
const WorkflowComponent = "dapr" // Dapr built-in workflow component name

type RemoveTarget struct {
  AppID      string
  InstanceID string
  Status     Status
  HTTPPort   int  // sidecar http port; 0 = no sidecar reachable
  Healthy    bool // sidecar health (from discovery)
}
type RemoveResult struct {
  InstanceID string    `json:"instanceId"`
  Mechanism  Mechanism `json:"mechanism"`
  OK         bool      `json:"ok"`
  Error      string    `json:"error,omitempty"`
}
type Remover struct { /* http client + statestore.Store + namespace */ }
func NewRemover(client *http.Client, store statestore.Store, namespace string) *Remover
func (r *Remover) Remove(ctx context.Context, t RemoveTarget, force bool) RemoveResult
func (r *Remover) RemoveMany(ctx context.Context, targets []RemoveTarget, force bool) []RemoveResult
```
`Remove` selects the mechanism, then:
- `MechPurge` → `POST http://127.0.0.1:{port}/v1.0-beta1/workflows/dapr/{id}/purge`.
- `MechTerminateThenPurge` → `POST .../terminate?non_recursive=false` then `.../purge`; if terminate fails, return the error (don't purge).
- `MechForce` → list `InstanceKeyPattern` keys via the store and `Delete` each.
Each HTTP call uses a fresh request with the context; non-2xx → error including the status + body snippet.

**Interfaces — Consumes:** `statestore.Store`, `statestore.{InstanceKeyPattern}`, `SelectMechanism`. Reuses the `fakeStore` from `service_test.go` (same package).

- [ ] **Step 1: Write the failing test** (httptest sidecar + fake store force path):
```go
//go:build unit

package workflow

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestRemovePurgeTerminal(t *testing.T) {
	var gotPath string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	port := mustPort(t, srv.URL)

	r := NewRemover(&http.Client{Timeout: time.Second}, newFakeStore(), "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "inst-1", Status: StatusCompleted, HTTPPort: port, Healthy: true}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechPurge, res.Mechanism)
	require.Equal(t, "/v1.0-beta1/workflows/dapr/inst-1/purge", gotPath)
}

func TestRemoveTerminateThenPurge(t *testing.T) {
	var calls []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.URL.Path)
		w.WriteHeader(http.StatusAccepted)
	}))
	t.Cleanup(srv.Close)
	port := mustPort(t, srv.URL)

	r := NewRemover(&http.Client{Timeout: time.Second}, newFakeStore(), "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "live", Status: StatusRunning, HTTPPort: port, Healthy: true}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechTerminateThenPurge, res.Mechanism)
	require.Len(t, calls, 2)
	require.True(t, strings.HasSuffix(calls[0], "/terminate"))
	require.True(t, strings.HasSuffix(calls[1], "/purge"))
}

func TestRemoveForceDeletesKeys(t *testing.T) {
	f := newFakeStore()
	prefix := statestore.InstancePrefix("default", "order", "stuck")
	f.kv[prefix+"metadata"] = []byte("{}")
	f.kv[prefix+"history-000000"] = []byte("x")
	f.kv["order||other||keep||metadata"] = []byte("keep")

	r := NewRemover(&http.Client{Timeout: time.Second}, f, "default")
	res := r.Remove(context.Background(), RemoveTarget{AppID: "order", InstanceID: "stuck", Status: StatusRunning, Healthy: false}, false)
	require.True(t, res.OK, res.Error)
	require.Equal(t, MechForce, res.Mechanism)
	require.NotContains(t, f.kv, prefix+"metadata")
	require.NotContains(t, f.kv, prefix+"history-000000")
	require.Contains(t, f.kv, "order||other||keep||metadata") // untouched
}

func mustPort(t *testing.T, raw string) int {
	t.Helper()
	u, err := url.Parse(raw)
	require.NoError(t, err)
	p, err := strconv.Atoi(u.Port())
	require.NoError(t, err)
	return p
}
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `remove.go`:
```go
package workflow

import (
	"context"
	"fmt"
	"io"
	"net/http"

	"github.com/diagridio/dev-dashboard/pkg/statestore"
)

const WorkflowComponent = "dapr"

type RemoveTarget struct {
	AppID      string
	InstanceID string
	Status     Status
	HTTPPort   int
	Healthy    bool
}

type RemoveResult struct {
	InstanceID string    `json:"instanceId"`
	Mechanism  Mechanism `json:"mechanism"`
	OK         bool      `json:"ok"`
	Error      string    `json:"error,omitempty"`
}

type Remover struct {
	client    *http.Client
	store     statestore.Store
	namespace string
}

func NewRemover(client *http.Client, store statestore.Store, namespace string) *Remover {
	if namespace == "" {
		namespace = "default"
	}
	return &Remover{client: client, store: store, namespace: namespace}
}

func (r *Remover) Remove(ctx context.Context, t RemoveTarget, force bool) RemoveResult {
	mech := SelectMechanism(t.Status, t.Healthy && t.HTTPPort > 0, force)
	res := RemoveResult{InstanceID: t.InstanceID, Mechanism: mech}
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
		return res
	}
	res.OK = true
	return res
}

func (r *Remover) RemoveMany(ctx context.Context, targets []RemoveTarget, force bool) []RemoveResult {
	out := make([]RemoveResult, 0, len(targets))
	for _, t := range targets {
		out = append(out, r.Remove(ctx, t, force))
	}
	return out
}

func (r *Remover) terminate(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t.HTTPPort, t.InstanceID, "terminate")
}
func (r *Remover) purge(ctx context.Context, t RemoveTarget) error {
	return r.post(ctx, t.HTTPPort, t.InstanceID, "purge")
}

func (r *Remover) post(ctx context.Context, port int, instanceID, action string) error {
	url := fmt.Sprintf("http://127.0.0.1:%d/v1.0-beta1/workflows/%s/%s/%s", port, WorkflowComponent, instanceID, action)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, url, nil)
	if err != nil {
		return err
	}
	resp, err := r.client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return fmt.Errorf("%s: status %d: %s", action, resp.StatusCode, string(b))
	}
	return nil
}

func (r *Remover) forceDelete(ctx context.Context, t RemoveTarget) error {
	if r.store == nil {
		return fmt.Errorf("force delete unavailable: no state store")
	}
	keys, _, err := r.store.Keys(ctx, statestore.InstanceKeyPattern(r.namespace, t.AppID, t.InstanceID), "", 0)
	if err != nil {
		return err
	}
	for _, k := range keys {
		if err := r.store.Delete(ctx, k); err != nil {
			return fmt.Errorf("delete %s: %w", k, err)
		}
	}
	return nil
}
```
- [ ] **Step 4: Run → pass.** `go test -tags unit ./pkg/workflow/ -v`
- [ ] **Step 5: Commit.** `gofmt -w pkg/workflow && git add pkg/workflow/remove.go pkg/workflow/remove_test.go && git commit -m "feat(workflow): hybrid terminate/purge/force removal"`

---

### Task 10: Integration test — miniredis (state store + workflow)

**Files:** Create `pkg/statestore/store_integration_test.go`, `pkg/workflow/workflow_integration_test.go` (both `//go:build integration`)

**Interfaces — Consumes:** `github.com/alicebob/miniredis/v2`, `statestore.New`, `workflow.New`. Validates the auto-detect → client-build → read/force-delete flow against a real (in-memory) Redis.

- [ ] **Step 1: Add deps.** `go get github.com/alicebob/miniredis/v2@latest && go get github.com/redis/go-redis/v9@latest` (both already in the graph; promotes to direct/test deps).
- [ ] **Step 2: Write `pkg/statestore/store_integration_test.go`:**
```go
//go:build integration

package statestore_test

import (
	"context"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/stretchr/testify/require"
)

func TestRedisStoreRoundTrip(t *testing.T) {
	mr := miniredis.RunT(t)

	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "statestore", Type: "state.redis", Version: "v1",
		Metadata: map[string]string{"redisHost": mr.Addr(), "redisPassword": ""},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	// Seed two keys via the store's own Set path is not exposed; write directly through miniredis-compatible client is overkill.
	// Instead seed via the redis server and read back through KeysLike.
	mr.Set("k||a||1||metadata", "v1")
	mr.Set("k||a||1||history-000000", "v2")

	keys, _, err := store.Keys(context.Background(), "k||a||1||%", "", 0)
	require.NoError(t, err)
	require.Len(t, keys, 2)

	got, err := store.Get(context.Background(), "k||a||1||metadata")
	require.NoError(t, err)
	require.Equal(t, "v1", string(got))

	require.NoError(t, store.Delete(context.Background(), "k||a||1||metadata"))
	keys, _, err = store.Keys(context.Background(), "k||a||1||%", "", 0)
	require.NoError(t, err)
	require.Len(t, keys, 1)
}
```
> The Redis state store may wrap stored values (the components-contrib redis store stores a JSON envelope / hash). If `Get` returns wrapped bytes for keys seeded raw via `mr.Set`, seed instead through a `go-redis` client using the exact storage shape the component expects, **or** assert on `Keys`/`Delete` only and move the value-decode assertions to the workflow integration test (next file), which seeds proto bytes through the same `store` write path. The implementer reconciles the envelope by inspecting `components-contrib/state/redis` behavior with miniredis; keep the test asserting the **observable** contract (list/delete by pattern).
- [ ] **Step 3: Write `pkg/workflow/workflow_integration_test.go`** — start miniredis, build a `statestore.Store`, seed an instance's `metadata` + proto-marshaled `history-*` keys using a `go-redis` client (writing the raw bytes the components-contrib redis store reads back), then assert `workflow.New(store,...).List` returns the instance with the decoded status and `Get` returns the history. If the redis envelope makes raw seeding impractical, gate this assertion on a small helper that writes through the same encoding; otherwise assert List/Get against the SQLite backend using a real temp-file DB (`state.sqlite`, `connectionString: file:<tmp>?cache=shared`), which stores values verbatim and is the more reliable seed path.
```go
//go:build integration

package workflow_test

import (
	"context"
	"path/filepath"
	"testing"

	"github.com/dapr/durabletask-go/api/protos"
	"github.com/diagridio/dev-dashboard/pkg/statestore"
	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func TestWorkflowListGetSQLite(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "wf.db")
	store, err := statestore.New(context.Background(), statestore.Component{
		Name: "statestore", Type: "state.sqlite", Version: "v1",
		Metadata: map[string]string{"connectionString": dbPath},
	})
	require.NoError(t, err)
	t.Cleanup(func() { _ = store.Close() })

	prefix := statestore.InstancePrefix("default", "order", "inst-1")
	started := &protos.HistoryEvent{EventId: 0, Timestamp: timestamppb.Now(),
		EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{
			Name: "OrderWorkflow", Input: &wrapperspb.StringValue{Value: `{}`}}}}
	b, err := proto.Marshal(started)
	require.NoError(t, err)
	// statestore.Store has no Set; seed via the inner store using a thin test-only Set helper
	// (add a Set method to the test by type-asserting, OR expose a SeedKey test helper in statestore).
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+"metadata", []byte("{}")))
	require.NoError(t, statestore.SeedForTest(context.Background(), store, prefix+"history-000000", b))

	svc := workflow.New(store, "default", func(context.Context) ([]string, error) { return []string{"order"}, nil })
	res, err := svc.List(context.Background(), workflow.ListQuery{})
	require.NoError(t, err)
	require.Len(t, res.Items, 1)
	require.Equal(t, workflow.StatusRunning, res.Items[0].Status)

	ex, err := svc.Get(context.Background(), "order", "inst-1")
	require.NoError(t, err)
	require.Len(t, ex.History, 1)
}
```
- [ ] **Step 4: Add a tiny seed helper** to `pkg/statestore/store.go` so integration tests can write keys through the same store (the `Store` interface is read+delete only). Add to the interface **and** impl:
```go
// In the Store interface:
//   Set(ctx context.Context, key string, value []byte) error
// In ccStore:
func (s *ccStore) Set(ctx context.Context, key string, value []byte) error {
	return s.inner.Set(ctx, &state.SetRequest{Key: key, Value: value})
}
```
And a thin exported helper used only by integration tests:
```go
// SeedForTest writes a raw value; intended for integration tests only.
func SeedForTest(ctx context.Context, s Store, key string, value []byte) error { return s.Set(ctx, key, value) }
```
> Adding `Set` to the `Store` interface means the unit `fakeStore` (Task 6) must gain a `Set` method too — add `func (f *fakeStore) Set(_ context.Context, k string, v []byte) error { f.kv[k] = v; return nil }`. Update Task 6's fake in the same change if not already present.
- [ ] **Step 5: Run.** `go test -tags integration ./pkg/statestore/ ./pkg/workflow/ -v` → PASS. Then re-run unit: `go test -tags unit ./... ` stays green.
- [ ] **Step 6: Commit.** `gofmt -w pkg/statestore pkg/workflow && go mod tidy && git add pkg/statestore pkg/workflow go.mod go.sum && git commit -m "test(integration): miniredis/sqlite store + workflow list/get"`

---

### Task 11: API — `/api/workflows` list + detail

**Files:** Create `pkg/server/workflows.go`, `pkg/server/workflows_test.go`; **modify** `pkg/server/api.go`, `pkg/server/server.go`, `pkg/server/server_test.go`.

**Interfaces — Produces:**
- `workflowsRouter(svc workflow.Service, rem WorkflowRemover, stores StoreRegistry) http.Handler` mounting: `GET /` (list; query params `appId`, `status` CSV, `search`, `limit`, `page`), `GET /{appId}/{instanceId}` (detail; 404 on `workflow.ErrNotFound`, 503 on `workflow.ErrNoStore`), `POST /{appId}/{instanceId}/terminate`, `POST /{appId}/{instanceId}/purge` (body `{force?:bool}`), `POST /purge` (bulk: `{ids?:[{appId,instanceId}], force?:bool}` — Task 12).
- `Options` gains `Workflows workflow.Service`, `WorkflowRemover` (interface with `RemoveMany`), and `Stores StoreRegistry`; `apiRouter` signature extended.

This task ships **list + detail + the router skeleton**; Task 12 adds the removal handlers + `/statestores`.

- [ ] **Step 1: Write the failing test** (`workflows_test.go`) with a fake `workflow.Service`:
```go
//go:build unit

package server

import (
	"context"
	"net/http"
	"testing"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/stretchr/testify/require"
)

type fakeWF struct {
	list workflow.ListResult
	one  workflow.Execution
	err  error
}

func (f fakeWF) List(context.Context, workflow.ListQuery) (workflow.ListResult, error) {
	return f.list, f.err
}
func (f fakeWF) Get(_ context.Context, appID, id string) (workflow.Execution, error) {
	if f.err != nil {
		return workflow.Execution{}, f.err
	}
	return f.one, nil
}

func TestWorkflowsList(t *testing.T) {
	svc := fakeWF{list: workflow.ListResult{Items: []workflow.ExecutionSummary{{AppID: "order", InstanceID: "abc", Status: workflow.StatusRunning}}}}
	h := workflowsRouter(svc, nil, nil)
	res, body := get(t, h, "/?status=Running&search=ab")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"abc"`)
}

func TestWorkflowDetailAndNotFound(t *testing.T) {
	svc := fakeWF{one: workflow.Execution{ExecutionSummary: workflow.ExecutionSummary{AppID: "order", InstanceID: "abc", Status: workflow.StatusCompleted}}}
	h := workflowsRouter(svc, nil, nil)
	res, body := get(t, h, "/order/abc")
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"status":"Completed"`)

	res, _ = get(t, h, "/order/missing")
	require.Equal(t, http.StatusOK, res.StatusCode) // fake returns one regardless; not-found path covered in integration

	noStore := fakeWF{err: workflow.ErrNoStore}
	h2 := workflowsRouter(noStore, nil, nil)
	res, _ = get(t, h2, "/")
	require.Equal(t, http.StatusServiceUnavailable, res.StatusCode)
}
```
> The detail 404 path is exercised end-to-end in the integration test; here the fake always returns one. To assert the 404 mapping precisely, the implementer may extend `fakeWF.Get` to return `workflow.ErrNotFound` for id `"missing"` and assert `http.StatusNotFound` — recommended.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `workflows.go` (list + detail; removal handlers stubbed to 501 until Task 12, or omit routes until Task 12 — prefer adding them in Task 12):
```go
package server

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"github.com/diagridio/dev-dashboard/pkg/workflow"
	"github.com/go-chi/chi/v5"
)

// WorkflowRemover is the removal surface the API needs (impl: *workflow.Remover).
type WorkflowRemover interface {
	RemoveMany(ctx context.Context, targets []workflow.RemoveTarget, force bool) []workflow.RemoveResult
}

// StoreRegistry exposes detected/active state stores to the API (Task 12).
type StoreRegistry interface {
	Stores() []StoreInfo
}
type StoreInfo struct {
	Name   string `json:"name"`
	Type   string `json:"type"`
	Path   string `json:"path"`
	Active bool   `json:"active"`
}

func workflowsRouter(svc workflow.Service, rem WorkflowRemover, stores StoreRegistry) http.Handler {
	r := chi.NewRouter()

	r.Get("/", func(w http.ResponseWriter, req *http.Request) {
		q := parseListQuery(req)
		res, err := svc.List(req.Context(), q)
		if errors.Is(err, workflow.ErrNoStore) {
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
			return
		}
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	r.Get("/{appId}/{instanceId}", func(w http.ResponseWriter, req *http.Request) {
		ex, err := svc.Get(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		switch {
		case errors.Is(err, workflow.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
		case errors.Is(err, workflow.ErrNoStore):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "no state store detected"})
		case err != nil:
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		default:
			writeJSON(w, http.StatusOK, ex)
		}
	})

	// removal + statestores handlers added in Task 12 (rem, stores)
	_ = rem
	_ = stores
	return r
}

func parseListQuery(req *http.Request) workflow.ListQuery {
	q := workflow.ListQuery{
		AppID:     req.URL.Query().Get("appId"),
		Search:    req.URL.Query().Get("search"),
		PageToken: req.URL.Query().Get("page"),
	}
	if s := req.URL.Query().Get("status"); s != "" {
		for _, part := range strings.Split(s, ",") {
			if part = strings.TrimSpace(part); part != "" {
				q.Status = append(q.Status, workflow.Status(part))
			}
		}
	}
	if l := req.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil {
			q.PageSize = n
		}
	}
	return q
}
```
- [ ] **Step 4: Modify `api.go`** — `func apiRouter(v version.Info, apps discovery.Service, wf workflow.Service, rem WorkflowRemover, stores StoreRegistry) http.Handler` and add `r.Mount("/workflows", workflowsRouter(wf, rem, stores))`.
- [ ] **Step 5: Modify `server.go`** — add `Workflows workflow.Service`, `Remover WorkflowRemover`, `Stores StoreRegistry` to `Options`; pass them in `apiRouter(opts.Version, opts.Apps, opts.Workflows, opts.Remover, opts.Stores)`.
- [ ] **Step 6: Modify `server_test.go`** — existing router tests build `Options{}`; add a minimal `Workflows: fakeWF{}` (and leave `Remover`/`Stores` nil) so `/api/workflows` mounts. Confirm `/api/health`, `/api/apps`, SPA tests still pass.
- [ ] **Step 7: Run → pass.** `go test -tags unit ./pkg/server/ -v`
- [ ] **Step 8: Commit.** `gofmt -w pkg/server && git add pkg/server && git commit -m "feat(server): /api/workflows list + detail"`

---

### Task 12: API — terminate / purge / bulk + `/api/statestores`

**Files:** Modify `pkg/server/workflows.go`, `pkg/server/workflows_test.go`, `pkg/server/api.go` (mount `/statestores`).

**Interfaces — Produces:** in `workflowsRouter`: `POST /{appId}/{instanceId}/terminate`, `POST /{appId}/{instanceId}/purge` (body `{force?:bool}`), `POST /purge` (bulk `{ids:[{appId,instanceId}], force?:bool}`), each returning `[]workflow.RemoveResult`. Plus a top-level `GET /api/statestores` returning `stores.Stores()`. The handler must resolve each target's `Status`/`HTTPPort`/`Healthy` — it gets these from the `workflow.Service.Get` (status) and from a `discovery.Service` lookup (port + health). To keep the router self-contained, `workflowsRouter` gains a `targets TargetResolver` param:
```go
type TargetResolver interface {
  Resolve(ctx context.Context, appID, instanceID string) (workflow.RemoveTarget, error)
}
```
Implemented in `cmd` (Task 13) by combining `discovery.Service.Get` (port/health) + `workflow.Service.Get` (status).

- [ ] **Step 1: Write the failing test** — fake remover + resolver:
```go
func TestWorkflowPurgeSingle(t *testing.T) {
	rem := &fakeRemover{}
	resolver := fakeResolver{}
	h := workflowsRouterFull(fakeWF{}, rem, nil, resolver)
	res, body := postJSON(t, h, "/order/abc/purge", `{"force":false}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"ok":true`)
	require.Len(t, rem.calls, 1)
	require.Equal(t, "abc", rem.calls[0].InstanceID)
}

func TestWorkflowBulkPurge(t *testing.T) {
	rem := &fakeRemover{}
	h := workflowsRouterFull(fakeWF{}, rem, nil, fakeResolver{})
	res, body := postJSON(t, h, "/purge", `{"ids":[{"appId":"order","instanceId":"a"},{"appId":"order","instanceId":"b"}],"force":true}`)
	require.Equal(t, http.StatusOK, res.StatusCode)
	require.Contains(t, body, `"instanceId":"a"`)
	require.Len(t, rem.calls, 2)
}
```
Add test helpers in `workflows_test.go`: a `postJSON(t, h, path, body)` (mirrors `get`), `fakeRemover` (records `targets`, returns OK results), `fakeResolver` (returns a `workflow.RemoveTarget{Status: StatusCompleted, HTTPPort: 3500, Healthy: true}`), and a `workflowsRouterFull(...)` constructor signature note — **rename** `workflowsRouter` to accept the resolver: `workflowsRouter(svc, rem, stores, targets)`. Update Task 11's call sites + `api.go`.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** the removal handlers in `workflows.go`:
```go
type removeBody struct {
	IDs   []targetRef `json:"ids"`
	Force bool        `json:"force"`
}
type targetRef struct {
	AppID      string `json:"appId"`
	InstanceID string `json:"instanceId"`
}

// inside workflowsRouter, after detail route:
r.Post("/{appId}/{instanceId}/terminate", removeOne(svc, rem, targets, false))
r.Post("/{appId}/{instanceId}/purge", removeOne(svc, rem, targets, false))
r.Post("/purge", func(w http.ResponseWriter, req *http.Request) {
	var body removeBody
	_ = json.NewDecoder(req.Body).Decode(&body)
	var tgts []workflow.RemoveTarget
	for _, ref := range body.IDs {
		t, err := targets.Resolve(req.Context(), ref.AppID, ref.InstanceID)
		if err != nil {
			continue
		}
		tgts = append(tgts, t)
	}
	writeJSON(w, http.StatusOK, rem.RemoveMany(req.Context(), tgts, body.Force))
})
```
where:
```go
func removeOne(svc workflow.Service, rem WorkflowRemover, targets TargetResolver, _ bool) http.HandlerFunc {
	return func(w http.ResponseWriter, req *http.Request) {
		var body removeBody
		_ = json.NewDecoder(req.Body).Decode(&body)
		t, err := targets.Resolve(req.Context(), chi.URLParam(req, "appId"), chi.URLParam(req, "instanceId"))
		if err != nil {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "workflow not found"})
			return
		}
		results := rem.RemoveMany(req.Context(), []workflow.RemoveTarget{t}, body.Force)
		if len(results) == 1 {
			writeJSON(w, http.StatusOK, results[0])
			return
		}
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "removal produced no result"})
	}
}
```
> The `terminate` endpoint reuses the same `removeOne`; the actual mechanism is decided by `SelectMechanism` in the Remover (terminate-then-purge for a running workflow), so a "terminate" button on a running workflow purges it after terminating — matching spec §7 (terminate is the graceful first step, not a standalone leave-it-running action). If a future requirement needs terminate-without-purge, add a `RemoveMode` to the Remover; out of scope for v1.
- [ ] **Step 4: Add `/api/statestores`** — in `api.go`, `r.Get("/statestores", func...)` returning `stores.Stores()` (or `[]StoreInfo{}` when `stores == nil`).
- [ ] **Step 5: Run → pass.** `go test -tags unit ./pkg/server/ -v`
- [ ] **Step 6: Commit.** `gofmt -w pkg/server && git add pkg/server && git commit -m "feat(server): workflow terminate/purge/bulk + /api/statestores"`

---

### Task 13: Wire workflow + state store into the CLI

**Files:** Modify `cmd/root.go` (+ a small `cmd/workflow.go` for the resolver/registry adapters)

**Interfaces — Consumes:** `statestore.Detect`, `statestore.New`, `workflow.New`, `workflow.NewRemover`, `discovery.Service`, `server.Options.{Workflows,Remover,Stores}` + the `TargetResolver` from Task 12.

- [ ] **Step 1: Add the `--statestore` flag** and namespace flag to `NewRootCmd`:
```go
c.Flags().StringVar(&stateStore, "statestore", "", "path to a state-store component YAML (overrides auto-detect)")
c.Flags().StringVar(&namespace, "namespace", "default", "Dapr namespace for workflow keys")
```
- [ ] **Step 2: In `runServe`, detect + build the store and workflow service.** After `appsSvc` is built:
```go
	// Resolve resource paths to scan for state-store components.
	var scanPaths []string
	if stateStore != "" {
		scanPaths = []string{stateStore}
	} else {
		// default Dapr components dir + any live --resources-path from running apps
		if home, err := os.UserHomeDir(); err == nil {
			scanPaths = append(scanPaths, filepath.Join(home, ".dapr", "components"))
		}
		if apps, err := appsSvc.List(ctx); err == nil {
			for _, a := range apps {
				scanPaths = append(scanPaths, a.ResourcePaths...)
			}
		}
	}
	detected, _ := statestore.Detect(scanPaths)
	registry := newStoreRegistry(detected) // picks the actorStateStore=true one, or the first, as active

	var wfStore statestore.Store
	if active := registry.active(); active != nil {
		if st, err := statestore.New(ctx, *active); err == nil {
			wfStore = st
			defer func() { _ = wfStore.Close() }()
		} else {
			fmt.Printf("warning: state store %q init failed: %v\n", active.Name, err)
		}
	}

	appIDs := func(ctx context.Context) ([]string, error) {
		apps, err := appsSvc.List(ctx)
		if err != nil {
			return nil, err
		}
		ids := make([]string, 0, len(apps))
		for _, a := range apps {
			ids = append(ids, a.AppID)
		}
		return ids, nil
	}
	wfSvc := workflow.New(wfStore, namespace, appIDs)
	remover := workflow.NewRemover(&http.Client{Timeout: 10 * time.Second}, wfStore, namespace)
	resolver := newTargetResolver(appsSvc, wfSvc) // discovery port/health + workflow status
```
- [ ] **Step 3: Pass to `server.Options`:** add `Workflows: wfSvc, Remover: remover, Stores: registry, Resolver: resolver` (extend `Options` + `apiRouter`/`workflowsRouter` call to include the resolver — finalize the Task-12 signature here).
- [ ] **Step 4: Implement `cmd/workflow.go`** — `storeRegistry` (`Stores() []server.StoreInfo`, `active() *statestore.Component`; active = the component with `actorStateStore=="true"`, else first detected), and `targetResolver` (`Resolve` → `discovery.Get(appID)` for `HTTPPort`+`Healthy(== HealthHealthy)`, `workflow.Get(appID,id)` for `Status`; returns `workflow.RemoveTarget`). Keep these in `cmd` so `pkg/server` stays free of `discovery`↔`workflow` cross-wiring.
- [ ] **Step 5: Verify.** `go build ./... && go vet -tags unit ./... && go test -tags unit ./...` all green. Manual smoke (if a `dapr run -f` workflow app is running): `go run . --no-open` then `curl -s localhost:9090/api/statestores` and `curl -s localhost:9090/api/workflows` return JSON (empty `{"items":...}`/`[]` is fine when nothing is running).
- [ ] **Step 6: Commit.** `gofmt -w cmd && go mod tidy && git add cmd go.mod go.sum && git commit -m "feat(cmd): wire state-store detection + workflow service into serve"`

---

### Task 14: Frontend — workflow status tokens + StatusPill

**Files:** Modify `web/src/styles/theme.css`; create `web/src/components/StatusPill.tsx`, `web/src/components/StatusPill.test.tsx`.

**Interfaces — Produces:** `<StatusPill status={WorkflowStatus} />` — a text pill (label + theme-aware bg/fg), `data-cy="status-pill"`, never color-only.

- [ ] **Step 1: Extend `theme.css`** — add six status token **pairs** (bg + fg) under both `:root[data-theme='light']` and `:root[data-theme='dark']`. Use the spec base hues, with a tinted bg and AA-contrast fg per theme. Suggested values (implementer may fine-tune for AA with a contrast check):
```css
/* light */
--wf-running-bg:#e3f2fd;   --wf-running-fg:#0b66b3;
--wf-completed-bg:#e3f9e5; --wf-completed-fg:#0a7a28;
--wf-failed-bg:#fde4ec;    --wf-failed-fg:#b30a45;
--wf-terminated-bg:#eceff2;--wf-terminated-fg:#4a5560;
--wf-suspended-bg:#f0e7ff; --wf-suspended-fg:#6a1fd0;
--wf-pending-bg:#fbf8d8;   --wf-pending-fg:#7a7600;
/* dark */
--wf-running-bg:#13344d;   --wf-running-fg:#7cc4f7;
--wf-completed-bg:#10331b; --wf-completed-fg:#79e08f;
--wf-failed-bg:#3d1322;    --wf-failed-fg:#ff8198;
--wf-terminated-bg:#28323d;--wf-terminated-fg:#b0bac4;
--wf-suspended-bg:#2a1d44; --wf-suspended-fg:#c4a3ff;
--wf-pending-bg:#33310f;   --wf-pending-fg:#e0da6a;
```
- [ ] **Step 2: Write the failing test** (`StatusPill.test.tsx`):
```tsx
import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { StatusPill } from './StatusPill'

describe('StatusPill', () => {
  it('renders the status label as text', () => {
    render(<StatusPill status="Failed" />)
    const pill = screen.getByText('Failed')
    expect(pill).toBeInTheDocument()
    expect(pill).toHaveAttribute('data-cy', 'status-pill')
  })
})
```
- [ ] **Step 3: Run → fail.**
- [ ] **Step 4: Implement** `StatusPill.tsx`:
```tsx
import type { WorkflowStatus } from '../types/workflow'

const TOKENS: Record<WorkflowStatus, string> = {
  Running: 'running',
  Completed: 'completed',
  Failed: 'failed',
  Terminated: 'terminated',
  Suspended: 'suspended',
  Pending: 'pending',
}

export function StatusPill({ status }: { status: WorkflowStatus }) {
  const t = TOKENS[status] ?? 'pending'
  return (
    <span
      data-cy="status-pill"
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.5,
        background: `var(--wf-${t}-bg)`,
        color: `var(--wf-${t}-fg)`,
        whiteSpace: 'nowrap',
      }}
    >
      {status}
    </span>
  )
}
```
> `web/src/types/workflow.ts` (Task 15) defines `WorkflowStatus`; if implementing this task first, add the `export type WorkflowStatus = 'Pending'|'Running'|'Completed'|'Failed'|'Terminated'|'Suspended'` line to that file now so the import resolves.
- [ ] **Step 5: Run → pass + typecheck.** `cd web && npm test && npm run build`
- [ ] **Step 6: Commit.** `git add web/src/styles/theme.css web/src/components/StatusPill.tsx web/src/components/StatusPill.test.tsx && git commit -m "feat(web): workflow status tokens + StatusPill"`

---

### Task 15: Frontend — workflow types + query hooks

**Files:** Create `web/src/types/workflow.ts`, `web/src/hooks/useWorkflows.ts`, `web/src/hooks/useWorkflows.test.tsx`.

**Interfaces — Produces:**
```ts
export type WorkflowStatus = 'Pending'|'Running'|'Completed'|'Failed'|'Terminated'|'Suspended'
export interface WorkflowSummary { appId:string; instanceId:string; name:string; status:WorkflowStatus; createdAt?:string; lastUpdatedAt?:string }
export interface WorkflowHistoryEvent { sequenceId:number; timestamp:string; type:string; name?:string; input?:string; output?:string }
export interface WorkflowExecution extends WorkflowSummary { input?:string; output?:string; customStatus?:string; replayCount:number; failureDetails?:{errorType?:string;message?:string}; history:WorkflowHistoryEvent[] }
export interface WorkflowListResult { items:WorkflowSummary[]; nextToken?:string }
export interface StateStore { name:string; type:string; path:string; active:boolean }
```
Hooks: `useWorkflows(params:{appId?:string;status?:WorkflowStatus[];search?:string})` builds a query string and polls on the global interval; `useWorkflow(appId,instanceId)` polls on the global interval; `useStateStores()` (no poll, `staleTime: Infinity`-ish).

- [ ] **Step 1: Write the failing test** (`useWorkflows.test.tsx`, MSW):
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { useWorkflows } from './useWorkflows'

function Probe() {
  const { data } = useWorkflows({ status: ['Running'], search: 'ab' })
  return <div>{data?.items.map((w) => <span key={w.instanceId}>{w.instanceId}</span>)}</div>
}

describe('useWorkflows', () => {
  it('lists workflows with filter params', async () => {
    server.use(http.get('/api/workflows', ({ request }) => {
      const url = new URL(request.url)
      expect(url.searchParams.get('status')).toBe('Running')
      expect(url.searchParams.get('search')).toBe('ab')
      return HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'W', status: 'Running' }] })
    }))
    render(<QueryProvider><RefreshProvider><Probe /></RefreshProvider></QueryProvider>)
    await waitFor(() => expect(screen.getByText('abc')).toBeInTheDocument())
  })
})
```
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `types/workflow.ts` and `useWorkflows.ts`:
```ts
import { useQuery } from '@tanstack/react-query'
import { fetchJSON } from '../lib/api'
import { useRefreshInterval, refetchMs } from '../lib/refresh'
import type { WorkflowExecution, WorkflowListResult, StateStore } from '../types/workflow'

interface WorkflowsParams { appId?: string; status?: string[]; search?: string; page?: string; limit?: number }

function queryString(p: WorkflowsParams): string {
  const sp = new URLSearchParams()
  if (p.appId) sp.set('appId', p.appId)
  if (p.status && p.status.length) sp.set('status', p.status.join(','))
  if (p.search) sp.set('search', p.search)
  if (p.page) sp.set('page', p.page)
  if (p.limit) sp.set('limit', String(p.limit))
  const s = sp.toString()
  return s ? `?${s}` : ''
}

export function useWorkflows(params: WorkflowsParams) {
  const ctx = useRefreshInterval()
  const qs = queryString(params)
  return useQuery<WorkflowListResult>({
    queryKey: ['workflows', qs],
    queryFn: () => fetchJSON<WorkflowListResult>(`/workflows${qs}`),
    refetchInterval: refetchMs(ctx),
  })
}

export function useWorkflow(appId: string, instanceId: string) {
  const ctx = useRefreshInterval()
  return useQuery<WorkflowExecution>({
    queryKey: ['workflow', appId, instanceId],
    queryFn: () => fetchJSON<WorkflowExecution>(`/workflows/${appId}/${instanceId}`),
    refetchInterval: refetchMs(ctx),
    enabled: !!appId && !!instanceId,
  })
}

export function useStateStores() {
  return useQuery<StateStore[]>({
    queryKey: ['statestores'],
    queryFn: () => fetchJSON<StateStore[]>('/statestores'),
    staleTime: 60_000,
  })
}
```
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/types/workflow.ts web/src/hooks/useWorkflows.ts web/src/hooks/useWorkflows.test.tsx && git commit -m "feat(web): workflow types + query hooks"`

---

### Task 16: Frontend — Workflows list page

**Files:** Create `web/src/pages/Workflows.tsx`, `web/src/pages/Workflows.test.tsx`; **modify** `web/src/router.tsx` (`/workflows` → `<Workflows/>`).

**Interfaces — Produces:** `<Workflows/>` — dense table (checkbox · Status pill · Instance ID (link to detail) · Name · App · Created · Age). A status-filter control (multi-select of the six statuses) + debounced search box (`/` focuses it — reuse global if present, else local) whose state is mirrored to the URL query (`?status=&search=`). A **Load more** button when `nextToken` is present. Row checkboxes drive a bulk **Remove selected** action (opens the confirm dialog, Task 18). The "no state store" 503 renders the actionable message + `--statestore` hint; empty list → friendly empty state. Autorefreshes (hook already polls). **Instance-id cell is the only link; the row is not a link.**

- [ ] **Step 1: Write the failing test** (MSW; asserts a row + link, status filter reflected in URL, empty/no-store states):
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { Workflows } from './Workflows'

function renderAt(entry = '/workflows') {
  const router = createMemoryRouter(
    [
      { path: '/workflows', element: <Workflows /> },
      { path: '/workflows/:appId/:instanceId', element: <div>detail</div> },
    ],
    { initialEntries: [entry] },
  )
  return render(<QueryProvider><RefreshProvider><RouterProvider router={router} /></RefreshProvider></QueryProvider>)
}

describe('Workflows', () => {
  it('renders a workflow row linking to detail', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [{ appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-26T10:00:00Z' }] })))
    renderAt()
    const link = await screen.findByRole('link', { name: 'abc' })
    expect(link).toHaveAttribute('href', '/workflows/order/abc')
    expect(screen.getByText('Running')).toBeInTheDocument()
  })

  it('shows the no-store message on 503', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ error: 'no state store detected' }, { status: 503 })))
    renderAt()
    await waitFor(() => expect(screen.getByText(/state store/i)).toBeInTheDocument())
    expect(screen.getByText(/--statestore/)).toBeInTheDocument()
  })

  it('shows an empty state', async () => {
    server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
    renderAt()
    await waitFor(() => expect(screen.getByText(/no workflows/i)).toBeInTheDocument())
  })
})
```
> The hook throws on 503 (fetchJSON throws on non-2xx); the page reads `isError` + the error and renders the no-store message. To distinguish 503 from other errors, have `fetchJSON` errors carry the status (the message already includes it: `API error 503 …`); the page checks `String(error).includes('503')`. Acceptable for v1; a typed error is a follow-up.
- [ ] **Step 2: Run → fail.**
- [ ] **Step 3: Implement** `Workflows.tsx` — table with theme tokens + `.mono`, `<StatusPill>`, instance-id `<Link>`, checkbox column, a status `<select multiple>` (or a small chip toggle group) + debounced search input (~250ms) writing to `useSearchParams`, Load-more button on `nextToken`, and the three states (no-store/empty/loading). Use `useSearchParams` from react-router-dom to read/write `status` + `search`. Bulk-remove button is disabled until ≥1 row selected and opens `<ConfirmRemoveDialog>` (Task 18) — for this task, wire a local `selected` state + a button that's present but the dialog can be added in Task 18 (leave a `data-cy="bulk-remove"` button calling a `onBulkRemove` placeholder). Change `router.tsx`'s `{ path: 'workflows', element: <Placeholder title="Workflows" /> }` to `<Workflows />`.
- [ ] **Step 4: Run → pass + typecheck.** `cd web && npm test && npm run build`
- [ ] **Step 5: Commit.** `git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx web/src/router.tsx && git commit -m "feat(web): Workflows list (filter, search, paging, selection)"`

---

### Task 17: Frontend — Workflow detail page (live timeline + wall-clock)

**Files:** Create `web/src/lib/wallclock.ts`, `web/src/lib/wallclock.test.ts`, `web/src/pages/WorkflowDetail.tsx`, `web/src/pages/WorkflowDetail.test.tsx`; **modify** `web/src/router.tsx` (add `/workflows/:appId/:instanceId`).

**Interfaces — Produces:**
- `elapsed(createdAt:string, endedAt?:string|null, now?:number): string` → `"mm:ss"`/`"h:mm:ss"` between created and ended (or now). `wallclock.test.ts` covers it deterministically (pass an explicit `now`).
- `<WorkflowDetail/>` — header (instance id mono + copy, `<StatusPill>`, name, app link to `/apps/:appId`, created/ended, replay count), a **wall-clock** that ticks every 1s via `setInterval` while non-terminal (`elapsed(createdAt, lastUpdatedAt)`), copyable **input/output/custom status** (reuse the `copyText` helper pattern from `AppDetail.tsx`), and a **history timeline** rendered from `execution.history`, **merged by `sequenceId`** so existing rows/expanded state survive refresh (keep an expanded-set keyed by `sequenceId`). Each event row shows type, name, timestamp (local), and expandable input/output with copy. A per-row **Remove** action opens the confirm dialog (Task 18). Honors `prefers-reduced-motion` for the wall-clock/pulse (no animation when set).

- [ ] **Step 1: Write the failing test** for `elapsed` (`wallclock.test.ts`):
```ts
import { describe, it, expect } from 'vitest'
import { elapsed } from './wallclock'

describe('elapsed', () => {
  it('formats mm:ss between created and now', () => {
    const created = '2026-06-26T10:00:00Z'
    const now = Date.parse('2026-06-26T10:01:30Z')
    expect(elapsed(created, null, now)).toBe('01:30')
  })
  it('freezes at total duration when ended', () => {
    expect(elapsed('2026-06-26T10:00:00Z', '2026-06-26T11:02:05Z')).toBe('1:02:05')
  })
})
```
- [ ] **Step 2: Run → fail.** Implement `wallclock.ts`:
```ts
export function elapsed(createdAt: string, endedAt?: string | null, now?: number): string {
  const start = Date.parse(createdAt)
  if (isNaN(start)) return ''
  const end = endedAt ? Date.parse(endedAt) : (now ?? Date.now())
  let secs = Math.max(0, Math.floor((end - start) / 1000))
  const h = Math.floor(secs / 3600); secs -= h * 3600
  const m = Math.floor(secs / 60); const s = secs - m * 60
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
```
- [ ] **Step 3: Run → pass.** `cd web && npm test -- wallclock`
- [ ] **Step 4: Write the failing test** for the page (`WorkflowDetail.test.tsx`, MSW): asserts header (instance id + status pill), an input value, and that two history events render; plus a re-render merge sanity check (status pill updates Running→Completed without losing the rows).
```tsx
import { render, screen, waitFor } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { RefreshProvider } from '../lib/refresh'
import { WorkflowDetail } from './WorkflowDetail'

function renderDetail() {
  const router = createMemoryRouter(
    [{ path: '/workflows/:appId/:instanceId', element: <WorkflowDetail /> }],
    { initialEntries: ['/workflows/order/abc'] },
  )
  return render(<QueryProvider><RefreshProvider><RouterProvider router={router} /></RefreshProvider></QueryProvider>)
}

describe('WorkflowDetail', () => {
  it('renders header, input and history', async () => {
    server.use(http.get('/api/workflows/order/abc', () => HttpResponse.json({
      appId: 'order', instanceId: 'abc', name: 'OrderWorkflow', status: 'Running',
      createdAt: '2026-06-26T10:00:00Z', replayCount: 0, input: '{"id":1}',
      history: [
        { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
        { sequenceId: 1, timestamp: '2026-06-26T10:00:01Z', type: 'TaskScheduled', name: 'Charge' },
      ],
    })))
    renderDetail()
    await waitFor(() => expect(screen.getByText('OrderWorkflow')).toBeInTheDocument())
    expect(screen.getByText('Running')).toBeInTheDocument()
    expect(screen.getByText('ExecutionStarted')).toBeInTheDocument()
    expect(screen.getByText('Charge')).toBeInTheDocument()
  })
})
```
- [ ] **Step 5: Run → fail.** Implement `WorkflowDetail.tsx` + add `{ path: 'workflows/:appId/:instanceId', element: <WorkflowDetail /> }` to `router.tsx` (child of `App`). Use `useParams`, `useWorkflow`, the `copyText` helper, an expanded-set `useState<Set<number>>`, and a 1s wall-clock `setInterval` cleared on unmount/terminal. The history list keys by `sequenceId` so React preserves rows across merges. (Virtualization for very long histories is a Plan-5/perf follow-up — note it; v1 renders the list directly with a bounded note.)
- [ ] **Step 6: Run → pass + typecheck.** `cd web && npm test && npm run build`
- [ ] **Step 7: Commit.** `git add web/src/lib/wallclock.ts web/src/lib/wallclock.test.ts web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx web/src/router.tsx && git commit -m "feat(web): Workflow detail (wall-clock + live history timeline)"`

---

### Task 18: Frontend — Terminate/Purge confirm dialog + mutations

**Files:** Create `web/src/components/ConfirmRemoveDialog.tsx`, `web/src/components/ConfirmRemoveDialog.test.tsx`, `web/src/hooks/useWorkflowRemoval.ts`, `web/src/hooks/useWorkflowRemoval.test.tsx`; **modify** `web/src/pages/Workflows.tsx` + `web/src/pages/WorkflowDetail.tsx` to wire the dialog.

**Interfaces — Produces:**
- `useRemoveWorkflows()` → TanStack `useMutation` posting bulk `/workflows/purge` with `{ids:[{appId,instanceId}], force}`; on success invalidates `['workflows']` + `['workflow']` queries and returns the `RemoveResult[]` summary. `useRemoveWorkflow(appId,instanceId)` single helper.
- `<ConfirmRemoveDialog open targets={[{appId,instanceId,status}]} onConfirm(force) onCancel />` — a focus-trapped dialog (headless primitive or a minimal accessible `role="dialog"` with focus trap + Esc) stating the **affected count** and the **mechanism** it will run (computed client-side from each target's status via a `mechanismFor(status, force)` mirror of `SelectMechanism`), with a **Force delete** checkbox (its own labeled control) and confirm/cancel. `data-cy="confirm-remove"`, `data-cy="confirm-force"`.

- [ ] **Step 1: Write the failing test** for the dialog (`ConfirmRemoveDialog.test.tsx`): asserts the count + mechanism text, that toggling Force switches the mechanism label to "Force delete", and that confirm fires `onConfirm(force)`.
```tsx
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, it, expect, vi } from 'vitest'
import { ConfirmRemoveDialog } from './ConfirmRemoveDialog'

describe('ConfirmRemoveDialog', () => {
  it('states count + mechanism and confirms with force', async () => {
    const onConfirm = vi.fn()
    render(<ConfirmRemoveDialog open targets={[{ appId: 'o', instanceId: 'a', status: 'Completed' }, { appId: 'o', instanceId: 'b', status: 'Running' }]} onConfirm={onConfirm} onCancel={() => {}} />)
    expect(screen.getByText(/remove 2 workflow/i)).toBeInTheDocument()
    await userEvent.click(screen.getByTestId('confirm-force'))
    await userEvent.click(screen.getByTestId('confirm-remove'))
    expect(onConfirm).toHaveBeenCalledWith(true)
  })
})
```
- [ ] **Step 2: Run → fail.** Implement `ConfirmRemoveDialog.tsx` with `mechanismFor(status, force)` (force→"Force delete"; terminal→"Purge"; else→"Terminate + Purge"); summarize the set (e.g. "Remove 2 workflows? 1 will be purged, 1 will be terminated + purged" — or, when mixed, list per-mechanism counts). Focus-trap: autofocus the cancel button, trap Tab within the dialog, Esc → `onCancel`. Use theme tokens + `--bad` for the confirm button.
- [ ] **Step 3: Write the failing test** for `useRemoveWorkflows` (`useWorkflowRemoval.test.tsx`, MSW): posts to `/api/workflows/purge`, asserts body + returns results.
```tsx
import { renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { describe, it, expect } from 'vitest'
import { server } from '../test/setup'
import { QueryProvider } from '../lib/query'
import { useRemoveWorkflows } from './useWorkflowRemoval'

describe('useRemoveWorkflows', () => {
  it('posts bulk purge', async () => {
    server.use(http.post('/api/workflows/purge', async ({ request }) => {
      const body = await request.json()
      expect(body.force).toBe(true)
      expect(body.ids).toHaveLength(1)
      return HttpResponse.json([{ instanceId: 'a', mechanism: 'force', ok: true }])
    }))
    const { result } = renderHook(() => useRemoveWorkflows(), { wrapper: ({ children }) => <QueryProvider>{children}</QueryProvider> })
    result.current.mutate({ ids: [{ appId: 'o', instanceId: 'a' }], force: true })
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(result.current.data?.[0].ok).toBe(true)
  })
})
```
- [ ] **Step 4: Run → fail.** Implement `useWorkflowRemoval.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiUrl } from '../lib/api'
import type { WorkflowStatus } from '../types/workflow'

export interface RemoveRef { appId: string; instanceId: string; status?: WorkflowStatus }
export interface RemoveResult { instanceId: string; mechanism: string; ok: boolean; error?: string }

async function postPurge(body: { ids: { appId: string; instanceId: string }[]; force: boolean }): Promise<RemoveResult[]> {
  const res = await fetch(apiUrl('/workflows/purge'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`purge failed: ${res.status}`)
  return res.json() as Promise<RemoveResult[]>
}

export function useRemoveWorkflows() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (vars: { ids: { appId: string; instanceId: string }[]; force: boolean }) => postPurge(vars),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflows'] })
      qc.invalidateQueries({ queryKey: ['workflow'] })
    },
  })
}
```
- [ ] **Step 5: Wire into pages.** In `Workflows.tsx`, the bulk-remove button opens `<ConfirmRemoveDialog>` with the selected rows' `{appId,instanceId,status}`; on confirm call `useRemoveWorkflows().mutate(...)`, then show a toast/inline summary of succeeded/failed and clear selection. In `WorkflowDetail.tsx`, the per-row/header Remove opens the same dialog with a single target; on success navigate back to `/workflows`. Background refresh is paused while the dialog is open (gate the `enabled`/render or simply rely on invalidate-after).
- [ ] **Step 6: Run → pass + typecheck.** `cd web && npm test && npm run build`
- [ ] **Step 7: Build + manual verify.** `make build && ./bin/dev-dashboard --no-open` against a `dapr run -f` workflow app: Workflows list shows executions with status pills; filter/search/paging work; opening one shows the live timeline + ticking wall-clock; a completed workflow purges via the dialog; a running one terminates+purges; force-delete works with no sidecar. Empty/no-store states render. Stop.
- [ ] **Step 8: Commit.** `git add web/src/components/ConfirmRemoveDialog.tsx web/src/components/ConfirmRemoveDialog.test.tsx web/src/hooks/useWorkflowRemoval.ts web/src/hooks/useWorkflowRemoval.test.tsx web/src/pages/Workflows.tsx web/src/pages/WorkflowDetail.tsx && git commit -m "feat(web): terminate/purge confirm dialog + bulk removal"`

---

## Self-Review

**Spec coverage (Plan 3 scope):**
- §6.3 Workflows list (status filter, app/name/instance search, cursor "load more", autorefresh) → Tasks 6, 11, 15, 16. ✓
- §6.3 detail (header, input/output/custom status, full history timeline w/ per-event io + timestamps + replay count, derived status) → Tasks 2, 7, 17. ✓
- §6.3 live event history merge-by-sequence + preserve expanded/scroll; polling not SSE → Task 17. ✓
- §6.3 wall-clock (continuous, freezes on terminal, computed from createdAt) → Task 17 (`wallclock.ts`). ✓
- §6.3 custom status (shown when set, live) + copyable fields (input/output/custom status/instance id, Clipboard API + execCommand fallback) → Tasks 1, 17 (reuses `AppDetail` copy helper). ✓
- §7 hybrid removal (terminal→Purge; running→Terminate+Purge; force/no-sidecar→state-store delete; bulk; confirmation w/ count + mechanism) → Tasks 8, 9, 12, 18. ✓
- §8 API (`/api/workflows`, `/api/workflows/{appId}/{instanceId}`, terminate, purge, bulk purge, `/api/statestores`) → Tasks 11, 12. ✓
- §9 single global interval drives list + detail; refresh-doesn't-fight-interaction → Tasks 15, 16, 17. ✓
- §9.1 URL-encoded filter/search/store state; rows-aren't-links → Task 16. ✓
- §9.7 six workflow status colors as theme-aware pills (color + text) → Task 14. ✓
- §11 state-store-not-detected / unreachable actionable message + `--statestore` hint; multiple stores → pick active → Tasks 13, 16. ✓
- §12 testing: unit (status normalize, history decode, removal-tier select, list/filter), integration miniredis/SQLite (KeysLike list, decode, force-delete), Vitest+MSW (table/filter/timeline-merge/copy/confirm) → Tasks 1–10, 14–18. ✓
- **State store discovery** (auto-detect from resource paths, `--statestore` override, active pick) → Tasks 5, 13. ✓
- **Deferred to later plans:** Resources/Actors/Subscriptions YAML pages (Plan 4), Logs/News/SSE (Plan 5), packaging (Plan 6). Bulk "all matching filter across pages" (§7) is implemented as **selected-rows** bulk in v1; "all matching the full server-side set" is noted as a Plan-3 follow-up (needs a server-side iterate-all endpoint) — see follow-ups note.

**Placeholder scan:** The judgment points are explicitly flagged, not hidden: (1) exact durabletask proto getter names (Task 2 — `go doc` instruction, unknown events fall to `"Unknown"`); (2) components-contrib constructor/import aliases incl. postgres v2 (Task 4 — `go doc` instruction); (3) the Redis storage-envelope seeding wrinkle in integration tests (Task 10 — fall back to SQLite verbatim seeding, assert the observable list/delete contract); (4) typed 503 vs generic error on the list page (Task 16 — string-match `503` in v1, typed error a follow-up). The bogus `afterOrZero` stub in Task 6 Step 3 is called out and corrected in the same step.

**Type consistency:** Go — `workflow.{Status,NormalizeStatus,Execution,ExecutionSummary,HistoryEvent,ListResult,ListQuery,Service,New,Get,List,ErrNotFound,ErrNoStore,DecodeExecution,Mechanism,SelectMechanism,Remover,NewRemover,RemoveTarget,RemoveResult,RemoveMany,WorkflowComponent}`; `statestore.{Component,Store,New,Detect,Keys,Get,BulkGet,Delete,Set,Close,WorkflowActorType,InstanceMetaPattern,InstancePrefix,InstanceKeyPattern,ParseInstanceID,SuffixMetadata,SuffixCustomStatus,HistoryPrefix,SeedForTest,ErrUnsupported}`; `server.{Options.Workflows,Options.Remover,Options.Stores,WorkflowRemover,StoreRegistry,StoreInfo,TargetResolver,workflowsRouter,apiRouter(v,apps,wf,rem,stores,targets)}` are used consistently across Tasks 1–13. Note: the `workflowsRouter` signature gains the `targets TargetResolver` param in Task 12 — Task 11's call sites and `api.go` must be updated to match when Task 12 lands (called out in Task 12 Step 1). Web — `WorkflowStatus/WorkflowSummary/WorkflowExecution/WorkflowHistoryEvent/WorkflowListResult/StateStore`, `useWorkflows/useWorkflow/useStateStores/useRemoveWorkflows`, `StatusPill`, `ConfirmRemoveDialog`, `elapsed`, `mechanismFor` referenced consistently; all reuse Plan-1/2 `fetchJSON`, `QueryProvider`, `RefreshProvider`/`refetchMs`, the `get()`/MSW helpers, the `copyText` pattern, and theme tokens.

**Note for implementer:** Tasks 1–3, 5, 8 are pure/unit-testable with no live backend. Task 2 promotes `durabletask-go`, Task 4 promotes `components-contrib` (heavy but already in the module graph as indirect deps — `go mod tidy` after each). The Service is unit-tested against an in-memory `fakeStore` (Task 6) and integration-tested against miniredis + a real temp-file SQLite (Task 10); the live Redis envelope is the one place to reconcile against real behavior — prefer the SQLite verbatim-seed path for the decode assertions. Frontend tasks each end with **both** `npm test` and `npm run build` (Vitest doesn't typecheck). Namespace defaults to `default`; revisit reading it from sidecar metadata when discovery exposes it.
