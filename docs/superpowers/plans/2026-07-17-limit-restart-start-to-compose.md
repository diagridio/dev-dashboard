# Limit Restart & Start to Compose mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict the Restart and Start lifecycle actions to Docker Compose apps only, in both the backend Manager and the Application detail UI, while leaving Stop available for every mode where it works today.

**Architecture:** A single policy guard in `lifecycle.doStandalone` rejects any non-stop action with `ErrUnsupported`; the existing `standaloneStart` machinery stays in place, dormant behind the gate. In `AppDetail.tsx`, the Restart/Start buttons (header and per-panel) gain an `isCompose` gate, and a hint explains the absence for running dapr-run apps. Stop, Remove-from-list, the registry stop-snapshot, and stopped-instance visibility are untouched.

**Tech Stack:** Go (backend `pkg/lifecycle`), React + TypeScript + Vitest + MSW (frontend `web/src`).

## Global Constraints

- Stop must remain available for Compose, Dapr run (standalone), Aspire, and orphaned sidecars — only Restart and Start are being restricted.
- Compose (`doCompose`) and Testcontainers behavior is unchanged.
- `RecordStop` and stopped-instance registry visibility must stay intact so stopped dapr-run apps still render as *stopped* and offer **Remove from list**.
- Real dapr-run apps always arrive with `source: 'standalone'` (the server normalizes empty source to `standalone` in `pkg/discovery/service.go:220`).
- Vitest does NOT typecheck — run `cd web && npx tsc -b` (or `make build`) after any `.tsx` change, test files included.
- Commit message trailer: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.

---

### Task 1: Backend — gate start/restart to Compose in the lifecycle Manager

**Files:**
- Modify: `pkg/lifecycle/manager.go:136-163` (`doStandalone`)
- Test: `pkg/lifecycle/manager_test.go` (replace the standalone start/restart success cases)

**Interfaces:**
- Consumes: existing `manager.Do` → `doStandalone(ctx, in, target, action)`, sentinel `ErrUnsupported`, `ActionStop`/`ActionStart`/`ActionRestart`, `TargetAll`/`TargetApp`/`TargetDaprd`.
- Produces: no new exported symbols. Behavior change only: `Do` on a standalone (non-compose, non-testcontainers) instance returns `ErrUnsupported` for any action other than `ActionStop`.

- [ ] **Step 1: Write the failing test**

Add this test to `pkg/lifecycle/manager_test.go` (e.g. right after `TestStandaloneStopSingleTargetEscalatesToKill`, near line 224):

```go
// Start and restart are Compose-only: dapr-run (standalone) instances reject
// both with ErrUnsupported and touch no process or starter, even when a stop
// snapshot exists that could tempt a re-run. Stop stays supported (covered by
// the standalone stop tests).
func TestStandaloneStartRestartRejected(t *testing.T) {
	proc := newFakeProc()
	proc.snaps[100] = ProcSnapshot{PID: 100, Argv: []string{"go", "run", "."}, Dir: "/src"}
	proc.alive[100] = true
	st := &fakeStarter{}
	reg := NewRegistry()
	reg.RecordStop(standaloneInst(), map[Target]ProcSnapshot{
		TargetAll: {PID: 300, Argv: []string{"dapr", "run", "--app-id", "orders"}, Dir: "/src"},
	})
	m := New(fakeApps{items: map[string]discovery.Instance{"orders": standaloneInst()}}, reg, nil, proc, st)

	cases := []struct {
		target Target
		action Action
	}{
		{TargetAll, ActionStart},
		{TargetApp, ActionStart},
		{TargetAll, ActionRestart},
		{TargetDaprd, ActionRestart},
	}
	for _, tc := range cases {
		require.ErrorIs(t, m.Do(context.Background(), "orders", tc.target, tc.action), ErrUnsupported)
	}
	require.Empty(t, st.started, "standalone start machinery must not run")
	require.Empty(t, proc.terminated, "restart must not signal any process")
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `go test ./pkg/lifecycle/ -run TestStandaloneStartRestartRejected -v`
Expected: FAIL — start/restart currently succeed, so `require.ErrorIs(... ErrUnsupported)` fails (and `st.started`/`proc.terminated` are non-empty).

- [ ] **Step 3: Add the policy guard in `doStandalone`**

In `pkg/lifecycle/manager.go`, insert the guard after the orphaned-sidecar check and before the `switch action` block. The surrounding code becomes:

```go
	if in.SidecarOrphaned && action != ActionStop {
		return fmt.Errorf("%w: orphaned sidecar — only stop is supported", ErrUnsupported)
	}
	// Restart and start only work reliably for Docker Compose apps, where the
	// container runtime restarts containers cleanly. For dapr-run instances the
	// re-run-from-snapshot path is unreliable, so only stop is offered. The
	// standaloneStart machinery below stays in place, dormant behind this gate,
	// for when standalone start becomes reliable.
	if action != ActionStop {
		return fmt.Errorf("%w: restart and start are only supported for Docker Compose apps", ErrUnsupported)
	}
	switch action {
	case ActionStop:
		return m.standaloneStop(ctx, in, target)
	case ActionStart:
		return m.standaloneStart(ctx, in, target)
	default: // restart
		if err := m.standaloneStop(ctx, in, target); err != nil {
			return err
		}
		return m.standaloneStart(ctx, in, target)
	}
```

Leave the `switch` intact — its start/restart arms are now unreachable but keep `standaloneStart` referenced (dormant machinery, no dead-code removal). Leave the Aspire and orphan guards above it as-is so they keep their specific messages.

- [ ] **Step 4: Run the new test to verify it passes**

Run: `go test ./pkg/lifecycle/ -run TestStandaloneStartRestartRejected -v`
Expected: PASS.

- [ ] **Step 5: Remove the now-superseded standalone start/restart success tests**

Delete these four tests from `pkg/lifecycle/manager_test.go` (they assert start/restart success, which no longer holds):
- `TestStandaloneStartAllRerunsCLICommand`
- `TestStandaloneStartSingleTarget`
- `TestStandaloneRestartStopsThenStarts`
- `TestStandaloneStartAllWithoutCLISnapshotStartsHalvesInOrder`

Also delete `TestStandaloneStartWithoutSnapshotRejected` — it still passes but for a now-misleading reason (the new blanket guard, not the missing snapshot); the consolidated test covers rejection.

Keep `fakeStarter` (still used by `TestStandaloneStartRestartRejected`). Keep all stop tests, `TestAspireStartRejectedStopAllowed`, `TestOrphanedSidecarOnlyStopAllowed`, and the compose tests unchanged.

- [ ] **Step 6: Run the full lifecycle package tests**

Run: `make test-go` (server tests sit behind the `//go:build unit` tag, so `make test-go` / `go test -tags unit ./...` is required; a plain `go test ./pkg/server/...` silently reports "no test files").
Expected: PASS. (`pkg/server/apps_test.go` already maps `ErrUnsupported` → HTTP 400 via a `fakeLifecycle` double, so no server test changes are needed.)

- [ ] **Step 7: Build the Go module**

Run: `go build ./...`
Expected: no errors (`standaloneStart` remains referenced by the switch, so no unused-symbol issues).

- [ ] **Step 8: Commit**

```bash
git add pkg/lifecycle/manager.go pkg/lifecycle/manager_test.go
git commit -m "feat(lifecycle): restrict start/restart to Docker Compose apps

Dapr-run start/restart via process-snapshot re-run is unreliable; gate
doStandalone to stop-only. standaloneStart machinery kept dormant behind
the gate. Consolidate the standalone start/restart tests into a rejection test.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — gate Restart/Start to Compose and add the dapr-run hint

**Files:**
- Modify: `web/src/pages/AppDetail.tsx` (`panelActions`, page header buttons, hints block)
- Test: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: existing `isCompose = app.source === 'compose'`, `isTestcontainers`, `orphaned = !!app.sidecarOrphaned`, `anyRunning`, `allStopped`, `caps.lifecycle`, `runAction(target, action, what)`.
- Produces: no new exports. UI change: Restart/Start buttons render only when `isCompose`; a `.hint` renders for running standalone apps.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/AppDetail.test.tsx`, add three new tests inside the `describe('AppDetail', …)` block (place near the other lifecycle tests, e.g. after `'funnels sidecar stop to the whole instance for dapr run apps'`):

```tsx
it('hides Restart and Start for a running dapr run app but keeps Stop and shows a hint', async () => {
  server.use(http.get('/api/apps/order', () => HttpResponse.json({ ...runningApp, source: 'standalone' })))
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Restart' })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  expect(screen.getAllByRole('button', { name: 'Stop' }).length).toBeGreaterThan(0)
  expect(screen.getByText(/restart and start it from your terminal/i)).toBeInTheDocument()
})

it('keeps Restart for a running compose app', async () => {
  server.use(http.get('/api/apps/order', () => HttpResponse.json({ ...runningApp, source: 'compose' })))
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.getAllByRole('button', { name: 'Restart' }).length).toBeGreaterThan(0)
  // Nothing is stopped, so no Start button; and no dapr-run hint for compose.
  expect(screen.queryByText(/restart and start it from your terminal/i)).not.toBeInTheDocument()
})

it('hides Start for a fully stopped dapr run app, offering Remove instead', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({
        ...runningApp,
        source: 'standalone',
        health: 'unknown',
        appStatus: 'stopped',
        daprdStatus: 'stopped',
        appPid: 0,
        daprdPid: 0,
      }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.queryByRole('button', { name: 'Start' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Remove from list' })).toBeInTheDocument()
})
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx -t "dapr run"`
Expected: FAIL — the running dapr-run app currently shows Restart/Start and no hint; the fully-stopped dapr-run app currently shows a whole-instance Start.

- [ ] **Step 3: Gate the per-panel Restart/Start on `isCompose`**

In `web/src/pages/AppDetail.tsx`, update `panelActions` (currently around lines 121-147). Replace the `!app.isAspire && !orphaned` Restart gate with `isCompose`, and replace the Start condition with a plain `isCompose` gate. The block becomes:

```tsx
  const panelActions = (target: AppTarget, status: string | undefined, what: string) => {
    if (!caps.lifecycle || isTestcontainers) return null
    return (
      <span style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
        {status === 'running' && (
          <>
            {isCompose && (
              <button className="btn ghost" disabled={busy} onClick={() => runAction(target, 'restart', what)}>
                Restart
              </button>
            )}
            <button className="btn danger" disabled={busy} onClick={() => runAction(target, 'stop', what)}>
              Stop
            </button>
          </>
        )}
        {/* Restart and Start are Compose-only: they only work reliably for
            containers driven by the runtime. dapr-run/Aspire panels show Stop
            only. */}
        {status === 'stopped' && isCompose && (
          <button className="btn ghost" disabled={busy} onClick={() => runAction(target, 'start', what)}>
            Start
          </button>
        )}
      </span>
    )
  }
```

- [ ] **Step 4: Gate the header Restart/Start on `isCompose`**

In the page header (currently lines 182-216), gate the header Restart on `isCompose` and the header Start on `caps.lifecycle && isCompose && allStopped`. The Stop button and Remove-from-list button are unchanged. The block becomes:

```tsx
        <div style={{ display: 'flex', gap: 8 }}>
          {caps.lifecycle && !isTestcontainers && anyRunning && (
            <>
              {isCompose && (
                <button
                  className="btn ghost"
                  disabled={busy}
                  onClick={() => runAction('all', 'restart', `"${app.appId}" (app + sidecar)`)}
                >
                  Restart
                </button>
              )}
              <button
                className="btn danger"
                disabled={busy}
                onClick={() => runAction('all', 'stop', `"${app.appId}" (app + sidecar)`)}
              >
                Stop
              </button>
            </>
          )}
          {caps.lifecycle && removable && (
            <button className="btn ghost" disabled={busy || forget.isPending} onClick={removeFromList}>
              Remove from list
            </button>
          )}
          {caps.lifecycle && isCompose && allStopped && (
            <button
              className="btn ghost"
              disabled={busy}
              onClick={() => runAction('all', 'start', `"${app.appId}" (app + sidecar)`)}
            >
              Start
            </button>
          )}
          <button className="tbtn" onClick={() => navigate('/')}>← Back</button>
          {caps.logs && (
            <Link className="tbtn" to={`/logs?app=${key}&source=daprd`}>View logs</Link>
          )}
        </div>
```

- [ ] **Step 5: Add the dapr-run hint**

In the hints region (after the Aspire hint block, currently around lines 233-240), add a hint for a running standalone app. Insert:

```tsx
      {caps.lifecycle && app.source === 'standalone' && !app.isAspire && !orphaned && anyRunning && (
        <div className="hint">
          Started with <span className="mono">dapr run</span> — restart and start it from your terminal.
        </div>
      )}
```

- [ ] **Step 6: Update the two existing tests broken by the change**

In `web/src/pages/AppDetail.test.tsx`:

Replace the test `'offers per-panel Start for a stopped non-Aspire target'` (currently ~line 104) with a compose variant:

```tsx
it('offers per-panel Start for a stopped compose target', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({ ...runningApp, source: 'compose', daprdStatus: 'stopped' }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(screen.getByRole('heading', { name: 'order' })).toBeInTheDocument())
  expect(screen.getAllByRole('button', { name: 'Start' }).length).toBeGreaterThan(0)
})
```

Delete the test `'offers a single whole-instance Start when a dapr run app is fully stopped'` (currently ~line 545) — its premise (dapr-run fully stopped → one Start) is exactly the behavior being removed, and the new `'hides Start for a fully stopped dapr run app…'` test covers the replacement.

- [ ] **Step 7: Run the AppDetail tests to verify they pass**

Run: `cd web && npx vitest run src/pages/AppDetail.test.tsx`
Expected: PASS (all tests, including the three new ones and the compose per-panel Start test).

- [ ] **Step 8: Typecheck the web app (Vitest does not typecheck)**

Run: `cd web && npx tsc -b`
Expected: no type errors.

- [ ] **Step 9: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat(app-detail): limit Restart & Start to Compose apps

Gate the header and per-panel Restart/Start buttons on isCompose; keep Stop
for all modes. Add a hint for running dapr-run apps pointing to the terminal.
Fully stopped dapr-run apps offer Remove from list instead of Start.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Self-Review

**Spec coverage:**
- Restart/Start Compose-only in UI → Task 2 Steps 3-4. ✓
- Stop unchanged for all modes → preserved in both tasks (Stop buttons untouched; backend `ActionStop` still routed). ✓
- Running dapr-run hint → Task 2 Step 5 + test Step 1. ✓
- Backend guard in `doStandalone` → Task 1 Step 3. ✓
- `RecordStop`/stopped visibility/Remove-from-list intact → untouched; verified by Task 2 Step 6 fully-stopped test asserting Remove is offered. ✓
- Aspire already stop-only, Testcontainers already blocked → unchanged; existing tests retained. ✓
- Test updates (both packages) → Task 1 Steps 1/5, Task 2 Steps 1/6. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases"; every code step shows full code. ✓

**Type/name consistency:** `isCompose`, `orphaned`, `anyRunning`, `allStopped`, `caps.lifecycle`, `runAction`, `ErrUnsupported`, `ActionStop`, `TargetAll/App/Daprd`, `fakeStarter`, `standaloneInst`, `newFakeProc` all match the current source. `app.source === 'standalone'` matches the wire type union in `web/src/types/api.ts`. ✓
