# Workflow Store Graceful Degradation + Disconnect Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the Workflows page usable (header, store selector, filters) when the selected state store fails to load, showing an error banner instead of replacing the page; rename the connections panel's "Delete" action to "Disconnect".

**Architecture:** Frontend-only change. `Workflows.tsx` currently early-returns on `isError`, replacing the whole page; the fix derives a `loadError` string and renders it as a banner between the page header and the filters, leaving all page chrome interactive. `StateStoreConnectionsPanel.tsx` gets a pure wording/styling change. No API or server changes.

**Tech Stack:** React 19 + TypeScript, TanStack Query, Vitest + Testing Library + MSW. Tests run from `web/` with `npm test` (vitest run).

**Spec:** `docs/superpowers/specs/2026-07-06-workflow-store-graceful-degradation-design.md`

## Global Constraints

- Frontend only: no changes under `pkg/`, `cmd/`, or to any API route.
- The full-page "No state store detected" guidance for an **empty store list** (`noStores`) stays exactly as-is.
- `WorkflowDetail.tsx` is out of scope.
- Banner copy: the extracted server message followed by `Select another state store or check the connection.`
- Degraded table placeholder copy: `Couldn't load workflows from this store.`
- Modal reassurance copy: `The component YAML file on disk is not deleted.`
- Row Disconnect button: `btn ghost`. Modal confirm Disconnect button: `btn primary`. Toast: `Disconnected <name>`.

---

### Task 1: Workflows page — graceful degradation on load errors

**Files:**
- Modify: `web/src/pages/Workflows.tsx` (error block at lines 311–348; banner insertion after the `phead` div ~line 397; table placeholder ~line 534)
- Test: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: existing `useWorkflows` hook result (`{ data, isLoading, isError, error }`) — unchanged.
- Produces: no exports change. Behavior contract for tests: on any `/api/workflows` error the page renders (a) the store selector (`data-testid="store-select"`), (b) a banner `data-testid="load-error-banner"` containing the server message, (c) the filters, and (d) the placeholder text `Couldn't load workflows from this store.` in the table area.

**Background for the implementer:** Today `Workflows.tsx` has three early returns: `noStores` (keep), a 503 branch, and a generic error branch (both replaced by the banner). The 503 branch parses the server message out of `String(error)`, which looks like `API error 503: could not connect to state store "x" (host) for /api/workflows...`. That parsing moves into a `loadError` variable. Note: the old code special-cased a 503 whose message contains `no state store detected` to show the full-page guidance; under the new design that case only occurs with a non-empty store list (empty list is caught by `noStores` first), so it now shows the banner like any other error.

- [ ] **Step 1: Update the two existing 503 tests to expect the degraded page**

In `web/src/pages/Workflows.test.tsx`, replace the test `'shows the no-store message on 503'` (currently ~line 73) with:

```tsx
  it('degrades gracefully on a no-store 503: banner + chrome, no full-page guidance', async () => {
    server.use(
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'no state store detected' }, { status: 503 }),
      ),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent(/no state store detected/i)
    expect(banner).toHaveTextContent(/select another state store or check the connection/i)
    // Page chrome still rendered: store selector and filters are usable.
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
    expect(screen.getByRole('group', { name: 'Status filter' })).toBeInTheDocument()
    // The --statestore full-page guidance is only for an empty store list.
    expect(screen.queryByText(/--statestore/)).toBeNull()
  })
```

And in the `'Workflows page — store selector'` describe block, replace the test `'shows the server "could not connect…" message on an unreachable 503 (not the no-store guidance)'` (~line 773) with:

```tsx
  it('shows a banner with the server "could not connect…" message and keeps the store selector usable', async () => {
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', () =>
        HttpResponse.json({ error: 'could not connect to state store "statestore" (localhost:16379)' }, { status: 503 }),
      ),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    const banner = await screen.findByTestId('load-error-banner')
    expect(banner).toHaveTextContent(/could not connect to state store/i)
    expect(banner).toHaveTextContent(/localhost:16379/)
    // The --statestore guidance is only for the genuine no-store case.
    expect(screen.queryByText(/--statestore/)).toBeNull()
    // Chrome stays interactive and the table shows the degraded placeholder.
    expect(screen.getByTestId('store-select')).toBeInTheDocument()
    expect(screen.getByText(/couldn't load workflows from this store/i)).toBeInTheDocument()
  })
```

- [ ] **Step 2: Add a recovery test — switching stores from the degraded state loads rows**

Append inside the same `'Workflows page — store selector'` describe block:

```tsx
  it('recovers when the user switches to a reachable store from the degraded state', async () => {
    // Store b (persisted selection) is unreachable; store a works.
    window.localStorage.setItem('devdash.workflowStore', 'statestore-b')
    server.use(
      http.get('/api/statestores', () => HttpResponse.json(twoStores)),
      http.get('/api/workflows', ({ request }) => {
        const url = new URL(request.url)
        if (url.searchParams.get('store') === 'statestore-b') {
          return HttpResponse.json(
            { error: 'could not connect to state store "statestore" (localhost:16379)' },
            { status: 503 },
          )
        }
        return HttpResponse.json({
          items: [{ appId: 'order', instanceId: 'a1', name: 'OrderWorkflow', status: 'Running', createdAt: '2026-06-29T10:00:00Z' }],
        })
      }),
      http.get('/api/apps', () => HttpResponse.json([])),
    )
    renderAt()
    await screen.findByTestId('load-error-banner')
    const storeSelect = screen.getByTestId('store-select') as HTMLSelectElement
    await userEvent.selectOptions(storeSelect, 'statestore-a')
    // Rows from the reachable store render and the banner clears.
    expect(await screen.findByRole('link', { name: 'a1' })).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByTestId('load-error-banner')).toBeNull())
  })
```

- [ ] **Step 3: Run the Workflows tests to verify the new/updated tests fail**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx`
Expected: the three tests above FAIL (no element with testid `load-error-banner`; old full-page error still rendered). All other tests in the file still pass.

- [ ] **Step 4: Implement the degraded state in `Workflows.tsx`**

Replace the whole error-states section (from the `// --- Error states ---` comment through the end of the `if (isError) { … }` block, currently lines 311–348) with:

```tsx
  // --- Error states ---

  // No-store guidance block — full-page, only when the store list itself is empty
  // (there is no selector to degrade to in that case).
  const noStoreGuidance = (
    <div className="page">
      <p className="err b">No state store detected</p>
      <p className="muted" style={{ marginTop: 8 }}>
        Dapr requires a state store to persist workflow state. Configure one with the{' '}
        <span className="mono">--statestore</span> flag or add a state store component.
      </p>
    </div>
  )

  if (noStores) return noStoreGuidance

  // Any workflow-list load error degrades gracefully: the page chrome (store
  // selector, filters) stays rendered and usable; the error is shown as a
  // banner above the filters so the user can switch to a reachable store.
  let loadError: string | null = null
  if (isError) {
    const errStr = String(error)
    if (errStr.includes('503')) {
      // The server message follows the "API error 503: <message> for <path>" shape.
      // Fall back to a generic message if the separator isn't present.
      const extracted = errStr.replace(/^.*?503[:\s]+/, '').replace(/\s*for\s+\/\S*$/, '').trim()
      loadError = extracted && extracted !== errStr ? extracted : 'state store unavailable'
    } else {
      loadError = `Error loading workflows: ${errStr}`
    }
  }
```

Then insert the banner right after the closing `</div>` of the `phead` header block (before the `{/* Remove status banner */}` comment):

```tsx
      {/* Load-error banner — page stays usable so the user can switch stores */}
      {loadError && (
        <div
          data-testid="load-error-banner"
          style={{
            marginBottom: 12,
            padding: '8px 12px',
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--surface)',
            color: 'var(--fail-fg)',
            fontSize: 13,
          }}
        >
          {loadError} — Select another state store or check the connection.
        </div>
      )}
```

Finally, make the table area show a degraded placeholder instead of "No workflows found" when errored. Replace the tablewrap ternary's first two branches (currently ~line 534):

```tsx
          {(isLoading || (!noStores && selectedStore === null)) ? (
            <p className="muted" style={{ padding: 20 }}>Loading…</p>
          ) : isError ? (
            <p className="muted" style={{ padding: 20 }}>Couldn't load workflows from this store.</p>
          ) : items.length === 0 ? (
            <p className="muted" style={{ padding: 20 }}>No workflows found</p>
          ) : (
```

(The final `<table>` branch and everything after are unchanged.)

- [ ] **Step 5: Run the Workflows tests to verify they pass**

Run: `cd web && npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 6: Run the full web suite and typecheck**

Run: `cd web && npm test && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat(web): degrade Workflows page gracefully on state-store load errors"
```

---

### Task 2: Connections panel — rename Delete to Disconnect

**Files:**
- Modify: `web/src/components/StateStoreConnectionsPanel.tsx`
- Test: `web/src/components/StateStoreConnectionsPanel.test.tsx`

**Interfaces:**
- Consumes: nothing from Task 1 (independent task).
- Produces: no exports change. Behavior contract: row button accessible name `disconnect <name>` with class `btn ghost`; modal dialog name `Disconnect state store?`; confirm button text `Disconnect` with class `btn primary`; success toast `Disconnected <name>`; modal body contains `The component YAML file on disk is not deleted.`

- [ ] **Step 1: Update the panel tests for the new wording**

In `web/src/components/StateStoreConnectionsPanel.test.tsx` apply these replacements:

- Every `{ name: /delete orders-pg/i }` → `{ name: /disconnect orders-pg/i }` (all occurrences: lines ~31, 69, 70, 85, 86, 105).
- Every `{ name: /delete statestore/i }` → `{ name: /disconnect statestore/i }` (~line 104).
- Every `{ name: /delete projstore/i }` → `{ name: /disconnect projstore/i }` (~lines 115, 116).
- Both `fireEvent.click(screen.getByRole('button', { name: 'Delete' }))` → `fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))` (~lines 71, 87).
- Both `{ name: /delete connection/i }` dialog queries → `{ name: /disconnect state store/i }` (~lines 75, 90).
- `expect(screen.getByText('Removed orders-pg')).toBeInTheDocument()` → `expect(screen.getByText('Disconnected orders-pg')).toBeInTheDocument()` (~line 92).
- In the test `'shows auto rows read-only and manual rows with actions'`, after the existing disconnect-button assertion, add the styling check:

```tsx
    // Disconnect is non-destructive: ghost styling, not danger.
    const btn = screen.getByRole('button', { name: /disconnect orders-pg/i })
    expect(btn.className).toContain('ghost')
    expect(btn.className).not.toContain('danger')
```

- In the test `'explains durable dismissal when removing an auto-discovered connection'`, add after the existing assertion:

```tsx
    expect(screen.getByText(/the component yaml file on disk is not deleted/i)).toBeInTheDocument()
```

- [ ] **Step 2: Run the panel tests to verify they fail**

Run: `cd web && npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: FAIL — buttons named `disconnect …` not found (still labeled Delete).

- [ ] **Step 3: Implement the rename in `StateStoreConnectionsPanel.tsx`**

Row button (line ~64):

```tsx
                <button className="btn ghost" aria-label={`disconnect ${s.name}`} onClick={() => openDeleteConfirm(s)}>Disconnect</button>
```

Toast in `handleConfirmDelete` (line ~35):

```tsx
      toast.show(`Disconnected ${pendingDelete.name}`)
```

Confirm modal (lines ~93–105):

```tsx
      <Modal open={pendingDelete !== null} title="Disconnect state store?" onClose={closeDeleteConfirm}>
        <p style={{ margin: '0 0 8px', color: 'var(--muted)', fontSize: 14 }}>
          Disconnect <b>{pendingDelete?.name}</b>? The component YAML file on disk is not deleted.{' '}
          {pendingDelete?.source === 'auto'
            ? 'It will stay hidden unless it becomes the active workflow state store again.'
            : 'This only removes it from the dashboard registry.'}
        </p>
        {deleteError && <p className="field-err">{deleteError}</p>}
        <div className="modal-actions">
          <button className="btn ghost" onClick={closeDeleteConfirm}>Cancel</button>
          <button className="btn primary" onClick={handleConfirmDelete}>Disconnect</button>
        </div>
      </Modal>
```

Internal identifiers (`pendingDelete`, `openDeleteConfirm`, `deleteStore`, etc.) stay as they are — the API call is still a DELETE; only user-facing copy changes.

- [ ] **Step 4: Run the panel tests to verify they pass**

Run: `cd web && npx vitest run src/components/StateStoreConnectionsPanel.test.tsx`
Expected: PASS, all tests.

- [ ] **Step 5: Run the full web suite and typecheck**

Run: `cd web && npm test && npx tsc -b`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/components/StateStoreConnectionsPanel.tsx web/src/components/StateStoreConnectionsPanel.test.tsx
git commit -m "feat(web): rename state-store connection Delete to Disconnect"
```
