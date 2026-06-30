# Child Workflows: list toggle + event-history links — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Summary

Surface the parent/child (sub-orchestration) relationship that already exists in
the workflow state-store data but is currently discarded by the dashboard. Three
user-facing capabilities:

1. A toggle on the workflow execution list to **show/hide child workflows**, with
   a `child` badge on child rows.
2. The **child workflow name** displayed on each `SubOrchestrationCreated` event in
   the workflow detail page's event history.
3. A **link** from each `SubOrchestrationCreated` event to the child workflow
   instance's detail page.

## Background — where the data lives

Backed by `durabletask-go` v0.12.1 protos read from the state store:

- A child workflow's own `ExecutionStartedEvent` carries
  `ParentInstance *ParentInstanceInfo` (parent instance ID, name, optional appID).
  Presence of a parent ⇒ the instance is a child.
- The `SubOrchestrationCreated` event maps to proto
  `ChildWorkflowInstanceCreatedEvent`, which carries the child's `InstanceId`,
  `Name`, and `Input`.

Today neither is exposed:

- `pkg/workflow/decode.go:114` handles `SubOrchestrationCreated` by setting only
  the event `Type` — `Name`/`InstanceId` are thrown away.
- `ExecutionStarted` decoding does not read `ParentInstance`.
- `ExecutionSummary` (list/stats data model) has no parent field.

The service's `List`/`Stats` already call `service.go:load`, which reads each
instance's **full history**, so computing "is this a child" during list building
is essentially free (no extra store reads).

## Decisions (from brainstorming)

| Question | Decision |
| --- | --- |
| List layout when children shown | Flat list (no nesting), with a `child` badge on child rows |
| Default toggle state on load | **Shown** (matches today's behavior) |
| Stats counts vs toggle | Stats **match the toggle** (exclude children when hidden) |
| Filtering location | **Backend** — required because stats + server-side pagination must both respect the toggle |
| Toggle label | "Show child workflows" |
| Badge placement | Next to the workflow name |

## Part A — Backend

### A1. `pkg/workflow/decode.go`

- `ExecutionStarted` branch: read
  `ParentInstance.WorkflowInstance.InstanceId` and set a new `ParentInstanceID`
  on the decoded execution summary. (Parent *name* is not needed by any of the
  three features, so it is not extracted.)
- `SubOrchestrationCreated` branch: read the event's `Name` → `HistoryEvent.Name`;
  read the child `InstanceId` → new `HistoryEvent.InstanceID`.

### A2. Types — `pkg/workflow/types.go` + `web/src/types/workflow.ts`

- `ExecutionSummary` / `WorkflowSummary`: add `parentInstanceId?: string`
  (`ParentInstanceID string \`json:"parentInstanceId,omitempty"\``).
- `HistoryEvent` / `WorkflowHistoryEvent`: add `instanceId?: string`
  (`InstanceID string \`json:"instanceId,omitempty"\``) — used by
  `SubOrchestrationCreated` to hold the child instance ID.

### A3. Service — `pkg/workflow/service.go`

- Add `IncludeChildren bool` to `ListQuery`.
- In `List`: when `IncludeChildren` is false, skip any summary whose
  `ParentInstanceID` is non-empty.
- In `Stats`: apply the same exclusion so counts agree with the list.

### A4. Server — `pkg/server/workflows.go`

- Parse an `includeChildren` query param on `GET /` and `GET /stats`.
- **Default `true`** (children shown) when the param is absent or unparable, so
  existing behavior is preserved.

## Part B — Frontend

### B1. Toggle — `web/src/pages/Workflows.tsx`

- A checkbox/switch near the existing filters, label **"Show child workflows"**,
  default checked.
- State flows into the query via `useWorkflows.ts`.

### B2. Hook — `web/src/hooks/useWorkflows.ts`

- Add `includeChildren` to the query params for **both** the list fetch and the
  stats fetch so they stay consistent.

### B3. Badge — `web/src/pages/Workflows.tsx`

- Rows where `parentInstanceId` is set render a small `child` badge next to the
  workflow name, reusing existing pill/badge styling.

### B4. Event-history link — `web/src/pages/WorkflowDetail.tsx`

- `SubOrchestrationCreated` rows display the child workflow `name` (now
  populated).
- The child `instanceId` renders as a `Link` to `/workflows/{appId}/{instanceId}`
  using the existing `detailPath` helper and the **parent's** `appId`.

## Edge cases & caveats

- **Cross-app children:** the `SubOrchestrationCreated` event carries no appID, so
  the link assumes the parent's app. Correct for same-app sub-orchestrations (the
  Dapr norm); a cross-app child link could 404. Note this in code with a comment.
- **Pagination correctness:** filtering server-side keeps page sizes accurate; a
  client-side filter would not.
- **Reachability:** hidden children remain reachable via the toggle and via the
  parent's event-history link.
- **Backward compatibility:** absent `includeChildren` param ⇒ children shown,
  identical to today.

## Testing

**Go**
- `decode_test.go`: assert `ParentInstanceID` is extracted from an
  `ExecutionStarted` event with a `ParentInstance`; assert `SubOrchestrationCreated`
  decodes child `Name` and `InstanceID`.
- `service` test: `IncludeChildren=false` filters child summaries from both
  `List` and `Stats`; `IncludeChildren=true` includes them.

**Frontend**
- Toggle flips the `includeChildren` query param on list and stats fetches.
- `child` badge renders only for rows with `parentInstanceId`.
- `SubOrchestrationCreated` row renders the child name and a link resolving to
  `/workflows/{appId}/{childInstanceId}`.
