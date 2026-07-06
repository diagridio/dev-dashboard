# Workflow store graceful degradation + Disconnect rename — design

Date: 2026-07-06
Status: approved

## Problem

1. **Workflows page blocks on store errors.** When the selected workflow state
   store cannot be reached (e.g. a docker-compose project was brought down but
   its auto-persisted registry entry — and the user's persisted selection in
   `localStorage` — still point at it), `Workflows.tsx` returns early on
   `isError` and replaces the entire page with the error text. The page header
   (which contains the store selector), filters, and table never render, so
   the user cannot switch to a reachable store from the page itself.

2. **"Delete" mislabels disconnecting.** On the Components page, the
   connections panel's per-row button and confirm dialog say "Delete", which
   suggests the component YAML file is deleted. It only removes the entry from
   the dashboard's connection registry (`connections.yaml`); the YAML file on
   disk is untouched.

## Decisions (from brainstorming)

- Graceful degradation applies to **all** workflow-list load errors (store
  unreachable, server error, network failure) — one consistent degraded state.
- The full-page "No state store detected" guidance stays as-is: with zero
  stores there is no selector to degrade to.
- **List page only.** `WorkflowDetail.tsx`'s error path is out of scope; the
  list page (now recoverable) is how users reach it.
- No auto-fallback to the active store and no server-side health filtering —
  the user keeps their selection and switches manually, guided by a banner.
- The row's Disconnect button uses the **ghost** style (not `danger`): the
  action is non-destructive, and the red styling was part of what implied
  deletion. The confirm modal's Disconnect button uses `primary`.

## Design

### 1. Workflows page graceful degradation (`web/src/pages/Workflows.tsx`)

- Keep the `noStores` early return (full-page guidance) unchanged.
- Remove the `if (isError) return …` block. Instead derive a `loadError`
  message from `error`, reusing the existing 503-message extraction:
  - 503 with a server message → the extracted message (e.g.
    `could not connect to state store "statestore" (postgres://…)`);
  - 503 without a parsable message → `state store unavailable`;
  - any other error → `Error loading workflows: <error>`.
- Render an error banner between the page header and the filters row when
  `loadError` is set — same visual pattern as the existing remove-status
  banner, error-colored. Content: the message, followed by the hint
  "Select another state store or check the connection."
- Table area: when `isError`, show a muted placeholder
  "Couldn't load workflows from this store." instead of "No workflows found".
- Everything else renders as normal: store selector, app filter, search,
  child-workflow toggle, stats segments (they show 0 — their query fails
  independently and already defaults to 0), and pager ("No results").
- Switching stores in the degraded state works exactly as today
  (`onStoreChange` resets filters/paging and the queries refetch).

### 2. Rename Delete → Disconnect (`web/src/components/StateStoreConnectionsPanel.tsx`)

- Row button: label `Delete` → `Disconnect`; aria-label `delete ${name}` →
  `disconnect ${name}`; class `btn danger` → `btn ghost`.
- Confirm modal: title `Delete connection?` → `Disconnect state store?`;
  confirm button `Delete` → `Disconnect`, styled `btn primary` (a clear,
  non-danger primary action; Cancel stays `btn ghost`, order unchanged).
  Body text keeps the existing auto/manual nuance and adds the reassurance:
  "The component YAML file on disk is not deleted."
- Toast: `Removed ${name}` → `Disconnected ${name}`.
- No API changes: `DELETE /statestores/:id` and registry semantics untouched.

## Error handling

- The banner reflects whatever `useWorkflows` reports; a store that recovers
  (compose brought back up) clears the banner on the next successful refetch.
- Disconnect failures keep today's behavior: the modal stays open and shows
  the error inline.

## Testing

- `Workflows.test.tsx`: update the 503 tests — assert the store selector and
  filters remain rendered alongside the banner text; assert the table shows
  the degraded placeholder; add a case where switching stores from the
  degraded state triggers a refetch and renders rows from the second store.
- Connections panel tests: update for the new labels (`Disconnect`, modal
  title, toast text, aria-labels) and ghost styling class.
