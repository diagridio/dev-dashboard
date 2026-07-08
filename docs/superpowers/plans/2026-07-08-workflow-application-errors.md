# Workflow Application Errors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface application errors (exceptions thrown in Dapr workflow activities, sub-orchestrations, or the workflow itself) in the workflow detail page — as per-event error details in the event history list and a top-level failure banner.

**Architecture:** The Go backend already reads durabletask history from the state store but discards failure details during decoding. We capture `TaskFailureDetails` (type, message, stack trace) onto each `HistoryEvent`, re-type a failed `ExecutionCompleted` as `ExecutionFailed`, and reuse the already-decoded workflow-level `FailureDetails`. The React frontend adds a red error box inside failed event rows and a dismissible-detail failure banner near the page header.

**Tech Stack:** Go (durabletask-go protos, testify), React 19 + TypeScript, Vitest + Testing Library + MSW, plain CSS with theme tokens.

## Global Constraints

- Backend unit tests use the `//go:build unit` build tag and run with `-tags unit`.
- New JSON fields use `omitempty` so existing golden output (`testdata/golden/execution_running.golden.json`, a no-failure run) stays byte-identical.
- Vitest does NOT typecheck — after any `.ts`/`.tsx` change run `cd web && npx tsc -b` (or `npm run build`).
- Reuse existing theme tokens (`--fail-fg`, `--fail-bg`, `--text`, `--surface-2`, `--line-soft`, `--muted`) — do not introduce new color values.
- Follow existing patterns: copy buttons use `copyText(...)` + `toast.show(...)`; long code uses `<pre className="json">` (already `max-height: 23.25em; overflow: auto`).

---

### Task 1: Backend — capture failure details during decode

**Files:**
- Modify: `pkg/workflow/types.go` (add `StackTrace` to `FailureDetails`; add `FailureDetails` field to `HistoryEvent`)
- Modify: `pkg/workflow/decode.go` (add `failureFromProto` helper; populate per-event and workflow-level)
- Test: `pkg/workflow/decode_test.go` (new cases)

**Interfaces:**
- Consumes: `github.com/dapr/durabletask-go/api/protos` — `TaskFailureDetails{ErrorType string, ErrorMessage string, StackTrace *wrapperspb.StringValue}`; getters `GetFailureDetails()` on `TaskFailedEvent`, `ChildWorkflowInstanceFailedEvent`, `ExecutionCompletedEvent`; `runtimestate.FailureDetails(rs) (*protos.TaskFailureDetails, error)`.
- Produces:
  - `type FailureDetails struct { ErrorType, Message, StackTrace string }` (JSON: `errorType`, `message`, `stackTrace`, all `omitempty`)
  - `HistoryEvent.FailureDetails *FailureDetails` (JSON: `failureDetails,omitempty`)
  - `func failureFromProto(fd *protos.TaskFailureDetails) *FailureDetails`
  - Event type `"ExecutionFailed"` emitted for a failed `ExecutionCompleted`.

- [ ] **Step 1: Write the failing tests**

Append to `pkg/workflow/decode_test.go` (the file already imports `protos`, `require`, `timestamppb`, `wrapperspb`):

```go
func TestDecodeTaskAndSubOrchFailureDetails(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_TaskScheduled{TaskScheduled: &protos.TaskScheduledEvent{Name: "Charge"}}},
		{EventId: 2, Timestamp: now, EventType: &protos.HistoryEvent_TaskFailed{TaskFailed: &protos.TaskFailedEvent{
			TaskScheduledId: 1,
			FailureDetails: &protos.TaskFailureDetails{
				ErrorType:    "ChargeError",
				ErrorMessage: "card declined",
				StackTrace:   &wrapperspb.StringValue{Value: "at Charge()\n at Run()"},
			},
		}}},
		{EventId: 3, Timestamp: now, EventType: &protos.HistoryEvent_ChildWorkflowInstanceFailed{ChildWorkflowInstanceFailed: &protos.ChildWorkflowInstanceFailedEvent{
			TaskScheduledId: 1,
			FailureDetails: &protos.TaskFailureDetails{
				ErrorType:    "ChildError",
				ErrorMessage: "child boom",
			},
		}}},
	}
	ex := DecodeExecution("order", "inst-tf", history, "")

	byType := map[string]HistoryEvent{}
	for _, e := range ex.History {
		byType[e.Type] = e
	}

	tf := byType["TaskFailed"]
	require.NotNil(t, tf.FailureDetails)
	require.Equal(t, "ChargeError", tf.FailureDetails.ErrorType)
	require.Equal(t, "card declined", tf.FailureDetails.Message)
	require.Equal(t, "at Charge()\n at Run()", tf.FailureDetails.StackTrace)

	sf := byType["SubOrchestrationFailed"]
	require.NotNil(t, sf.FailureDetails)
	require.Equal(t, "ChildError", sf.FailureDetails.ErrorType)
	require.Equal(t, "child boom", sf.FailureDetails.Message)
	require.Equal(t, "", sf.FailureDetails.StackTrace) // none provided
}

func TestDecodeExecutionFailed(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_FAILED,
			FailureDetails: &protos.TaskFailureDetails{
				ErrorType:    "System.InvalidOperationException",
				ErrorMessage: "boom",
				StackTrace:   &wrapperspb.StringValue{Value: "at Foo()\n at Bar()"},
			},
		}}},
	}
	ex := DecodeExecution("order", "inst-f", history, "")

	require.Equal(t, StatusFailed, ex.Status)

	// Workflow-level failure details populated, incl. stack trace.
	require.NotNil(t, ex.FailureDetails)
	require.Equal(t, "System.InvalidOperationException", ex.FailureDetails.ErrorType)
	require.Equal(t, "boom", ex.FailureDetails.Message)
	require.Equal(t, "at Foo()\n at Bar()", ex.FailureDetails.StackTrace)

	// Terminal event re-typed to ExecutionFailed with its own failure details.
	last := ex.History[len(ex.History)-1]
	require.Equal(t, "ExecutionFailed", last.Type)
	require.NotNil(t, last.FailureDetails)
	require.Equal(t, "boom", last.FailureDetails.Message)
	require.Nil(t, last.Output)
}

func TestDecodeExecutionCompletedNoFailure(t *testing.T) {
	now := timestamppb.Now()
	history := []*protos.HistoryEvent{
		{EventId: 0, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionStarted{ExecutionStarted: &protos.ExecutionStartedEvent{Name: "W"}}},
		{EventId: 1, Timestamp: now, EventType: &protos.HistoryEvent_ExecutionCompleted{ExecutionCompleted: &protos.ExecutionCompletedEvent{
			WorkflowStatus: protos.OrchestrationStatus_ORCHESTRATION_STATUS_COMPLETED,
			Result:         &wrapperspb.StringValue{Value: `"done"`},
		}}},
	}
	ex := DecodeExecution("order", "inst-ok", history, "")
	last := ex.History[len(ex.History)-1]
	require.Equal(t, "ExecutionCompleted", last.Type)
	require.Nil(t, last.FailureDetails)
	require.NotNil(t, last.Output)
	require.Equal(t, `"done"`, *last.Output)
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestDecodeTaskAndSubOrchFailureDetails|TestDecodeExecutionFailed|TestDecodeExecutionCompletedNoFailure' -v`
Expected: compile error — `FailureDetails` field on `HistoryEvent` and `StackTrace` field on `FailureDetails` do not exist yet.

- [ ] **Step 3: Extend the types**

In `pkg/workflow/types.go`, replace the `FailureDetails` struct:

```go
type FailureDetails struct {
	ErrorType  string `json:"errorType,omitempty"`
	Message    string `json:"message,omitempty"`
	StackTrace string `json:"stackTrace,omitempty"`
}
```

And add a field to `HistoryEvent` (after `Output`):

```go
type HistoryEvent struct {
	SequenceID     int32           `json:"sequenceId"`
	Timestamp      time.Time       `json:"timestamp"`
	Type           string          `json:"type"`
	Name           string          `json:"name,omitempty"`
	InstanceID     string          `json:"instanceId,omitempty"`  // child instance id for SubOrchestrationCreated
	ScheduledID    *int32          `json:"scheduledId,omitempty"` // start event's EventId; set on completion/fired events
	Input          *string         `json:"input,omitempty"`
	Output         *string         `json:"output,omitempty"`
	FailureDetails *FailureDetails `json:"failureDetails,omitempty"` // set on TaskFailed / SubOrchestrationFailed / ExecutionFailed
}
```

- [ ] **Step 4: Add the helper and wire it into decode**

In `pkg/workflow/decode.go`, add the helper near `strval` / `i32ptr` at the bottom:

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

Replace the workflow-level block in `DecodeExecution` (currently lines 42-44):

```go
	if fd, err := runtimestate.FailureDetails(rs); err == nil && fd != nil {
		ex.FailureDetails = failureFromProto(fd)
	}
```

In `decodeEvent`, replace the `ExecutionCompleted`, `TaskFailed`, and `ChildWorkflowInstanceFailed` cases:

```go
	case e.GetExecutionCompleted() != nil:
		c := e.GetExecutionCompleted()
		if fd := c.GetFailureDetails(); fd != nil {
			ev.Type = "ExecutionFailed"
			ev.FailureDetails = failureFromProto(fd)
		} else {
			ev.Type = "ExecutionCompleted"
			ev.Output = strval(c.GetResult())
		}
```

```go
	case e.GetTaskFailed() != nil:
		ev.Type = "TaskFailed"
		f := e.GetTaskFailed()
		ev.ScheduledID = i32ptr(f.GetTaskScheduledId())
		ev.FailureDetails = failureFromProto(f.GetFailureDetails())
```

```go
	case e.GetChildWorkflowInstanceFailed() != nil:
		ev.Type = "SubOrchestrationFailed"
		f := e.GetChildWorkflowInstanceFailed()
		ev.ScheduledID = i32ptr(f.GetTaskScheduledId())
		ev.FailureDetails = failureFromProto(f.GetFailureDetails())
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `go test -tags unit ./pkg/workflow/ -run 'TestDecodeTaskAndSubOrchFailureDetails|TestDecodeExecutionFailed|TestDecodeExecutionCompletedNoFailure' -v`
Expected: PASS (3 tests).

- [ ] **Step 6: Run the full package suite (guard the golden test)**

Run: `go test -tags unit ./pkg/workflow/... && go test -tags integration ./pkg/workflow/ -run Golden`
Expected: PASS. The golden run has no failures, so `omitempty` keeps its output unchanged. (If the integration build tag needs the sqlite deps and fails to build in your environment, run at least the unit suite and note it.)

- [ ] **Step 7: Commit**

```bash
git add pkg/workflow/types.go pkg/workflow/decode.go pkg/workflow/decode_test.go
git commit -m "feat(workflow): decode activity/workflow failure details"
```

---

### Task 2: Frontend — failure types + per-event error box

**Files:**
- Modify: `web/src/types/workflow.ts` (add `WorkflowFailureDetails`; wire into event + execution)
- Modify: `web/src/pages/WorkflowDetail.tsx` (`EventRow`: treat failure as details, render error box)
- Modify: `web/src/styles/theme.css` (`.evfail*` classes)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (`EventRow` cases)

**Interfaces:**
- Consumes: `FailureDetails` JSON shape from Task 1 (`errorType`, `message`, `stackTrace`); existing `copyText`, `toast.show`, `.evbody`/`.lblrow`/`.lbl`/`.copybtn`/`.json` styles.
- Produces:
  - `export interface WorkflowFailureDetails { errorType?: string; message?: string; stackTrace?: string }`
  - `WorkflowHistoryEvent.failureDetails?: WorkflowFailureDetails`
  - `WorkflowExecution.failureDetails?: WorkflowFailureDetails`
  - CSS classes `.evfail`, `.evfail-type`, `.evfail-msg` (consumed by Task 3 banner styling context only for tokens).

- [ ] **Step 1: Write the failing tests**

Add to the `describe('EventRow', ...)` block in `web/src/pages/WorkflowDetail.test.tsx`:

```tsx
it('renders a red error box (type + message + copyable stack trace) for a failed event', async () => {
  const { container } = row({
    type: 'TaskFailed',
    sequenceId: 4,
    timestamp: '2026-06-28T10:00:02.000Z',
    failureDetails: {
      errorType: 'ChargeError',
      message: 'card declined',
      stackTrace: 'at Charge()\n at Run()',
    },
  })
  // Row is expandable (was a bare static row before).
  expect(container.querySelector('details')).not.toBeNull()
  expect(container.querySelector('.evfail')).not.toBeNull()
  expect(screen.getByText('ChargeError')).toBeInTheDocument()
  expect(screen.getByText('card declined')).toBeInTheDocument()
  expect(screen.getByText(/at Charge\(\)/)).toBeInTheDocument()
  expect(screen.getByText('Stack trace')).toBeInTheDocument()
})

it('omits the stack-trace section when a failed event has no stack trace', () => {
  const { container } = row({
    type: 'SubOrchestrationFailed',
    sequenceId: 5,
    timestamp: '2026-06-28T10:00:03.000Z',
    failureDetails: { errorType: 'ChildError', message: 'child boom' },
  })
  expect(container.querySelector('.evfail')).not.toBeNull()
  expect(screen.getByText('child boom')).toBeInTheDocument()
  expect(screen.queryByText('Stack trace')).toBeNull()
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t 'error box|omits the stack-trace'`
Expected: FAIL — no `.evfail` element; the `TaskFailed` row is static (no `details`), so `container.querySelector('details')` is null and the error text is absent.

- [ ] **Step 3: Add the types**

In `web/src/types/workflow.ts`, add the interface (above `WorkflowHistoryEvent`):

```ts
export interface WorkflowFailureDetails {
  errorType?: string
  message?: string
  stackTrace?: string
}
```

Add the field to `WorkflowHistoryEvent` (after `output`):

```ts
  output?: string
  failureDetails?: WorkflowFailureDetails
```

Replace the inline `failureDetails` on `WorkflowExecution`:

```ts
  failureDetails?: WorkflowFailureDetails
```

- [ ] **Step 4: Render the error box in `EventRow`**

In `web/src/pages/WorkflowDetail.tsx`:

Import the new type — change the existing type import:

```tsx
import type { WorkflowStatus, WorkflowHistoryEvent, WorkflowFailureDetails } from '../types/workflow'
```

In `EventRow`, replace the `hasDetails` line (currently line 156):

```tsx
  const failure = event.failureDetails
  const hasDetails = !!(event.input || event.output || failure)
```

Inside the expandable `<div className="evbody">` (before the `event.input` block, currently line 201), add the error box:

```tsx
              {failure && (
                <div className="evfail">
                  <span className="evfail-type">{failure.errorType || 'Error'}</span>
                  {failure.message && <div className="evfail-msg">{failure.message}</div>}
                  {failure.stackTrace && (
                    <div>
                      <div className="lblrow">
                        <span className="lbl">Stack trace</span>
                        <button
                          className="copybtn"
                          onClick={() => {
                            copyText(failure.stackTrace ?? '')
                            toast.show('Stack trace copied')
                          }}
                        >
                          ⧉ Copy
                        </button>
                      </div>
                      <pre className="json">{failure.stackTrace}</pre>
                    </div>
                  )}
                </div>
              )}
```

- [ ] **Step 5: Add the CSS**

In `web/src/styles/theme.css`, after the `.evbody .lblrow .copybtn` rule (around line 446), add:

```css
.evbody .evfail { display: grid; gap: 6px; padding: 9px 11px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--fail-fg) 35%, transparent); background: color-mix(in srgb, var(--fail-fg) 10%, transparent); }
.evfail-type { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--fail-fg); }
.evfail-msg { font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t 'error box|omits the stack-trace'`
Expected: PASS (2 tests).

- [ ] **Step 7: Typecheck**

Run: `cd web && npx tsc -b`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/types/workflow.ts web/src/pages/WorkflowDetail.tsx web/src/styles/theme.css web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(web): show per-event failure details in workflow history"
```

---

### Task 3: Frontend — top-level failure banner

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx` (add `FailureBanner` component; render below `dhead`)
- Modify: `web/src/styles/theme.css` (`.failbanner*` classes)
- Test: `web/src/pages/WorkflowDetail.test.tsx` (banner cases via full-page render)

**Interfaces:**
- Consumes: `WorkflowExecution.failureDetails` (Task 2 type); `WorkflowFailureDetails`; existing `.tbtn`, `.lblrow`, `.lbl`, `.copybtn`, `.json` styles; `useState` (already imported), `copyText`, `ToastHandle`.
- Produces: `FailureBanner` (internal component, not exported); DOM class `.failbanner` with a "Show stack trace" / "Hide stack trace" toggle button.

- [ ] **Step 1: Write the failing tests**

Add a new `describe` block near the end of `web/src/pages/WorkflowDetail.test.tsx` (it already imports `renderDetail`, `server`, `http`, `HttpResponse`, `screen`, `waitFor`, `userEvent`):

```tsx
describe('WorkflowDetail — failure banner', () => {
  beforeEach(() => {
    server.use(http.get('/api/apps', () => HttpResponse.json([{ appId: 'order', health: 'healthy' }])))
  })

  it('shows a failure banner with type + message, stack trace hidden until toggled', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Failed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:05Z',
          replayCount: 0,
          failureDetails: {
            errorType: 'System.InvalidOperationException',
            message: 'boom',
            stackTrace: 'at Foo()\n at Bar()',
          },
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
            { sequenceId: 1, timestamp: '2026-06-26T10:00:05Z', type: 'ExecutionFailed', failureDetails: { errorType: 'System.InvalidOperationException', message: 'boom', stackTrace: 'at Foo()\n at Bar()' } },
          ],
        }),
      ),
    )
    renderDetail()
    const banner = await screen.findByRole('alert')
    expect(banner).toHaveTextContent('System.InvalidOperationException')
    expect(banner).toHaveTextContent('boom')
    // Stack trace hidden initially.
    expect(screen.queryByText(/at Foo\(\)/)).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: /show stack trace/i }))
    expect(screen.getByText(/at Foo\(\)/)).toBeInTheDocument()
  })

  it('shows no failure banner for a completed workflow', async () => {
    server.use(
      http.get('/api/workflows/order/abc', () =>
        HttpResponse.json({
          appId: 'order',
          instanceId: 'abc',
          name: 'OrderWorkflow',
          status: 'Completed',
          createdAt: '2026-06-26T10:00:00Z',
          lastUpdatedAt: '2026-06-26T10:00:05Z',
          replayCount: 0,
          history: [
            { sequenceId: 0, timestamp: '2026-06-26T10:00:00Z', type: 'ExecutionStarted', name: 'OrderWorkflow' },
          ],
        }),
      ),
    )
    renderDetail()
    await waitFor(() => expect(screen.getByText('COMPLETED')).toBeInTheDocument())
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t 'failure banner'`
Expected: FAIL — no element with `role="alert"` is rendered.

- [ ] **Step 3: Add the `FailureBanner` component**

In `web/src/pages/WorkflowDetail.tsx`, add this component just above `export function WorkflowDetail()` (after the `EventRow` definition):

```tsx
function FailureBanner({ failure, toast }: { failure: WorkflowFailureDetails; toast: ToastHandle }) {
  const [showStack, setShowStack] = useState(false)
  return (
    <div className="failbanner" role="alert">
      <div className="failbanner-head">
        <span className="failbanner-icon" aria-hidden="true">⚠</span>
        <span className="failbanner-type">{failure.errorType || 'Workflow failed'}</span>
        {failure.stackTrace && (
          <button className="tbtn" onClick={() => setShowStack((s) => !s)}>
            {showStack ? 'Hide stack trace' : 'Show stack trace'}
          </button>
        )}
      </div>
      {failure.message && <div className="failbanner-msg">{failure.message}</div>}
      {failure.stackTrace && showStack && (
        <div>
          <div className="lblrow">
            <span className="lbl">Stack trace</span>
            <button
              className="copybtn"
              onClick={() => {
                copyText(failure.stackTrace ?? '')
                toast.show('Stack trace copied')
              }}
            >
              ⧉ Copy
            </button>
          </div>
          <pre className="json">{failure.stackTrace}</pre>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Render the banner below the page header**

In `WorkflowDetail`'s returned JSX, immediately after the closing `</div>` of the `dhead` block (the page header — currently line 517, right before the `{/* Meta grid */}` comment), add:

```tsx
      {execution.failureDetails && (
        <FailureBanner failure={execution.failureDetails} toast={toast} />
      )}
```

- [ ] **Step 5: Add the CSS**

In `web/src/styles/theme.css`, after the `.evfail-msg` rule added in Task 2, add:

```css
.failbanner { display: grid; gap: 8px; padding: 12px 14px; margin-bottom: 18px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--fail-fg) 40%, transparent); background: var(--fail-bg); }
.failbanner-head { display: flex; align-items: center; gap: 9px; }
.failbanner-icon { color: var(--fail-fg); }
.failbanner-type { font-family: var(--mono); font-size: 13px; font-weight: 600; color: var(--fail-fg); }
.failbanner-head .tbtn { margin-left: auto; }
.failbanner-msg { font-size: 13px; color: var(--text); white-space: pre-wrap; word-break: break-word; }
.failbanner .lblrow { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd web && npx vitest run src/pages/WorkflowDetail.test.tsx -t 'failure banner'`
Expected: PASS (2 tests).

- [ ] **Step 7: Full frontend suite + typecheck**

Run: `cd web && npx tsc -b && npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: no type errors; all `WorkflowDetail`/`EventRow` tests pass.

- [ ] **Step 8: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/styles/theme.css web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat(web): add workflow failure banner to detail page"
```

---

### Task 4: End-to-end verification

**Files:** none (verification only)

- [ ] **Step 1: Full build + tests**

Run: `make build && make test`
Expected: web build (`tsc -b && vite build`) succeeds; `test-go` (unit) and `test-web` pass.

- [ ] **Step 2: Manual smoke check (optional but recommended)**

Use the `run` skill (or `make build && ./bin/dev-dashboard`) to launch the dashboard against a store containing a failed workflow instance, and confirm on the workflow detail page:
- the red failure banner appears below the header with error type + message and a working "Show stack trace" toggle + copy button;
- a `TaskFailed` / `SubOrchestrationFailed` row is expandable and shows the red error box with type, message, and (when present) a copyable stack trace;
- a failed run's terminal event renders as `ExecutionFailed` with the `n-endfail` node dot;
- completed / running workflows show no banner and no error boxes (regression check).

If no failed instance is readily available, note that automated tests (Tasks 1–3) cover the behavior and state that the manual check was skipped.

---

## Notes on existing code that already supports this

- `nodeClass` in `WorkflowDetail.tsx` already maps `TaskFailed`/`SubOrchestrationFailed` → `n-fail` (via `endsWith('Failed') && !startsWith('Execution')`) and `ExecutionFailed` → `n-endfail`. **No change needed.**
- `lib/eventOrder.ts` already lists `ExecutionFailed` in `TERMINAL_EXEC_TYPES`, so a re-typed terminal event pins to the bottom (asc) correctly. **No change needed.**
- `.n-fail` / `.n-endfail` node-dot CSS already exists in `theme.css`. **No change needed.**
