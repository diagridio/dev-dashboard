# Surface workflow application errors in the detail view — design

Date: 2026-07-08
Status: approved

## Problem

When an exception is thrown inside a Dapr workflow activity, a
sub-orchestration, or the workflow (orchestrator) itself, the failure never
surfaces in the workflow detail page's event history. The event list shows a
bare `TaskFailed` / `SubOrchestrationFailed` row with just the type name — no
error message, no type, no stack trace — and a failed workflow shows no
explanation at all beyond the `Failed` status pill.

The data is available but discarded:

- **Per-event failure details are dropped at decode time.** In
  `pkg/workflow/decode.go`, `decodeEvent` handles `TaskFailed`,
  `ChildWorkflowInstanceFailed` (→ `SubOrchestrationFailed`), and
  `ExecutionCompleted` but never reads their `GetFailureDetails()`. The Go
  `HistoryEvent` struct (`pkg/workflow/types.go`) has no failure field, and
  neither does the TS `WorkflowHistoryEvent` (`web/src/types/workflow.ts`).
- **Workflow-level failure is decoded but never rendered.**
  `DecodeExecution` already populates `ex.FailureDetails` (errorType +
  message) via `runtimestate.FailureDetails`, and the API returns it, but a
  repo-wide search shows `execution.failureDetails` is never read in the UI.
- **Dead frontend code anticipates the fix.** `nodeClass` in
  `WorkflowDetail.tsx` already maps `n-fail` / `n-endfail`, and
  `lib/eventOrder.ts` lists an `ExecutionFailed` type in `TERMINAL_EXEC_TYPES`
  — but the backend never emits `ExecutionFailed`, so those paths are unused.

The underlying durabletask proto
(`github.com/dapr/durabletask-go/api/protos`) exposes everything needed:
`TaskFailedEvent.GetFailureDetails()`,
`ChildWorkflowInstanceFailedEvent.GetFailureDetails()`, and
`ExecutionCompletedEvent.GetFailureDetails()`, each returning a
`*TaskFailureDetails` with `GetErrorType()`, `GetErrorMessage()`,
`GetStackTrace() *StringValue`, `GetInnerFailure()`, and `GetIsNonRetriable()`.

## Prior art (old dashboard)

The old dashboard (`cloudgrid/tools/diagrid-dashboard`) JSON-marshalled
`TaskFailed.FailureDetails` into the event's `Output` field and colored failed
rows red by matching the event type. It also had an intended dedicated red
"Failure Details" box (message + stack trace), but that box keyed off fields
the real backend never emitted, so in practice the error only appeared as an
Output JSON blob. We take the structured approach the old UI intended but
never actually wired up.

## Decisions (from brainstorming)

- **Detail shown:** error **type + message + stack trace**. Stack traces can
  be long, so they are visually contained (scrollable / collapsed).
- **Surface in two places:** a **top-level failure banner** on the workflow
  detail page (driven by the already-fetched `execution.failureDetails`) **and**
  **per-event error details** in the event history list.
- **Failed workflow event type:** the backend will emit `ExecutionFailed`
  (instead of `ExecutionCompleted`) when the completion event carries failure
  details. This lights up the existing `n-endfail` node styling and
  `TERMINAL_EXEC_TYPES` ordering code.
- **Structured field, not marshalled-into-Output** — reject the old
  dashboard's approach; carry failure details as a dedicated typed object so
  the UI can style it distinctly.

## Design

### 1. Backend types (`pkg/workflow/types.go`)

Extend the existing `FailureDetails` struct with a stack trace (it is already
used for the workflow-level failure, so extending it serves both the banner
and per-event rendering):

```go
type FailureDetails struct {
	ErrorType  string `json:"errorType,omitempty"`
	Message    string `json:"message,omitempty"`
	StackTrace string `json:"stackTrace,omitempty"`
}
```

Add a failure field to `HistoryEvent`:

```go
type HistoryEvent struct {
	// ...existing fields...
	FailureDetails *FailureDetails `json:"failureDetails,omitempty"`
}
```

`IsNonRetriable` is intentionally omitted (YAGNI) — it can be added later if a
concrete need appears.

### 2. Backend decode (`pkg/workflow/decode.go`)

Add a helper that maps the proto failure details onto our struct:

```go
func failureFromProto(fd *protos.TaskFailureDetails) *FailureDetails {
	if fd == nil {
		return nil
	}
	return &FailureDetails{
		ErrorType:  fd.GetErrorType(),
		Message:    fd.GetErrorMessage(),
		StackTrace: fd.GetStackTrace().GetValue(),
	}
}
```

Wire it into `decodeEvent`:

- `TaskFailed`:
  `ev.FailureDetails = failureFromProto(e.GetTaskFailed().GetFailureDetails())`
- `SubOrchestrationFailed`:
  `ev.FailureDetails = failureFromProto(e.GetChildWorkflowInstanceFailed().GetFailureDetails())`
- `ExecutionCompleted`: if
  `e.GetExecutionCompleted().GetFailureDetails() != nil`, set
  `ev.Type = "ExecutionFailed"` and attach the failure; otherwise keep
  `ExecutionCompleted` and the existing `Output` result.

Also ensure the workflow-level `ex.FailureDetails` carries the stack trace.
`runtimestate.FailureDetails(rs)` returns the same `*TaskFailureDetails`, so
reuse `failureFromProto` in `DecodeExecution` instead of the current
inline two-field construction.

### 3. Frontend types (`web/src/types/workflow.ts`)

```ts
export interface WorkflowFailureDetails {
  errorType?: string
  message?: string
  stackTrace?: string
}

export interface WorkflowHistoryEvent {
  // ...existing fields...
  failureDetails?: WorkflowFailureDetails
}

export interface WorkflowExecution extends WorkflowSummary {
  // ...
  failureDetails?: WorkflowFailureDetails // was inline { errorType?; message? }
  // ...
}
```

### 4. Frontend event row (`EventRow` in `web/src/pages/WorkflowDetail.tsx`)

- Treat a present `event.failureDetails` as "has details" so failed events
  become expandable (today, with no input/output, they render as bare static
  rows): `const hasDetails = !!(event.input || event.output || event.failureDetails)`.
- Add an **error branch** in the expandable body, rendered **above** Input /
  Output when present:
  - A red-tinted, red-bordered box showing the **error type** (as a heading /
    label) and the **error message**.
  - The **stack trace** in a scrollable `<pre>` (contained height), with a
    **copy button** matching the existing Input/Output copy pattern. Omitted
    entirely when there is no stack trace.
- **Node dot styling:** ensure `nodeClass` returns `n-fail` for `TaskFailed` /
  `SubOrchestrationFailed` and `n-endfail` for `ExecutionFailed` (classes
  already exist in CSS; verify the mapping covers the actual emitted type
  strings).

### 5. Frontend page banner (`WorkflowDetail`)

When `execution.failureDetails` is present, render an **error banner** near the
top of the detail page (below the header / status pill):

- Red-tinted banner with the error type + message always visible.
- Stack trace behind a **"Show stack trace"** toggle (collapsed by default) so
  it does not dominate the page. Omitted when there is no stack trace.

### 6. Styling

Reuse existing failure CSS affordances (`n-fail`, `n-endfail`) and the app's
error color tokens. The error box and banner share a consistent red-tinted,
red-bordered treatment. No new color tokens unless the existing palette lacks
an error tint.

## Error handling / edge cases

- **Activity fails with no stack trace:** the stack-trace section is omitted;
  type + message still render.
- **Workflow fails without a failed activity event** (e.g. orchestrator throws
  directly): the top-level banner still shows from `execution.failureDetails`,
  and the terminal event is `ExecutionFailed` with its own failure details.
- **Message-only failure:** renders type (if any) + message; no stack trace box.
- **Non-failed events:** unchanged — no failure field, no error branch.

## Testing

### Backend (`pkg/workflow`)

- Decode tests asserting `failureDetails` (type, message, stack trace) is
  populated for:
  - a `TaskFailed` event,
  - a `SubOrchestrationFailed` (`ChildWorkflowInstanceFailed`) event,
  - an `ExecutionCompleted` carrying failure details → decoded as
    `ExecutionFailed` with failure details, and the workflow-level
    `execution.failureDetails` populated including stack trace.
- A non-failing `ExecutionCompleted` still decodes as `ExecutionCompleted`
  with its `Output` result and no `failureDetails`.
- Fixtures can be adapted from the old dashboard's
  `pkg/workflow/history/history_test.go`.

### Frontend (`web`)

- `EventRow`: renders the red error box (type + message) and a stack-trace
  `<pre>` with copy button for an event carrying `failureDetails`; the row is
  expandable.
- `EventRow`: an event with `failureDetails` but no stack trace omits the
  stack-trace section.
- Banner: appears with type + message when `execution.failureDetails` is set,
  and the stack trace is toggled behind "Show stack trace".

### Build / typecheck

Run `make build` (or `tsc -b`) after frontend type changes — vitest alone does
not typecheck.

## Files touched

- `pkg/workflow/types.go` — extend `FailureDetails`, add field to `HistoryEvent`
- `pkg/workflow/decode.go` — `failureFromProto` helper; populate per-event and
  reuse for workflow-level
- `pkg/workflow/decode_test.go` (or existing decode test file) — new cases
- `web/src/types/workflow.ts` — `WorkflowFailureDetails`, event + execution fields
- `web/src/pages/WorkflowDetail.tsx` — `EventRow` error branch, banner, node class
- `web/src/pages/WorkflowDetail.css` (or the relevant stylesheet) — error box /
  banner styling if not already covered
- Frontend test file for `WorkflowDetail` / `EventRow`

## Non-goals

- Rendering `innerFailure` chains (nested exception causes).
- Surfacing `isNonRetriable` / retry-attempt metadata.
- Any change to how errors are stored or emitted by the Dapr runtime.
