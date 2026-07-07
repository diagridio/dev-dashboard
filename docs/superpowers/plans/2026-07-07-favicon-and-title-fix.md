# Favicon and Document Title Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Diagrid "D" mark favicon to the dashboard, and make the browser tab title always reflect the current page, ending with ` | Diagrid Dev Dashboard`.

**Architecture:** The favicon is a new static SVG asset served from `web/public/` and linked from `web/index.html`. The title fix centralizes the " | Diagrid Dev Dashboard" suffix inside the existing `useDocumentTitle` hook, then extends the existing per-page-hook-call pattern to the six pages that currently never call it.

**Tech Stack:** React 19, react-router-dom v6, Vite, Vitest + @testing-library/react, MSW for API mocking. All commands below run from the `web/` directory.

## Global Constraints

- Title suffix is exactly ` | Diagrid Dev Dashboard` (space, pipe, space), appended by the hook — no page should append its own suffix.
- Favicon is SVG only, transparent background, no PNG/ICO fallback.
- Follow the existing `useDocumentTitle(title)` per-page-hook pattern — do not introduce router-level title metadata.
- Dynamic per-page titles use the existing `—` (em dash) convention seen in `Actors.tsx`/`Subscriptions.tsx` (e.g. `` `Actors — ${appIdFilter}` ``).

---

### Task 1: Add the favicon

**Files:**
- Create: `web/public/favicon.svg`
- Modify: `web/index.html`

**Interfaces:**
- Produces: a static asset at the site root path `/favicon.svg`, referenced by a `<link>` tag in `web/index.html`. No other task depends on this.

- [ ] **Step 1: Create the favicon SVG**

Create `web/public/favicon.svg` with just the green D-glyph path, extracted from `web/src/components/Logo.tsx` line 12, re-cropped so the glyph fills the viewBox tightly (source path spans roughly `x: 0–14.4, y: 0–41` inside the original `viewBox="0 0 176 55"`):

```svg
<svg viewBox="0 0 15 41" xmlns="http://www.w3.org/2000/svg">
  <path d="M10.0949 41.0122C7.48164 41.0122 5.67389 40.4912 4.67156 39.4493C3.66923 38.4075 3.16806 36.794 3.16806 34.6094V27.1981C3.16806 25.9211 2.93538 24.9632 2.47002 24.3246C2.00466 23.6525 1.18131 23.2491 0 23.1145V18.3757C1.3245 18.2075 2.18365 17.7536 2.57742 17.0144C2.97117 16.2412 3.16806 15.0986 3.16806 13.586V6.88072C3.16806 4.69603 3.66923 3.08272 4.67156 2.0408C5.67389 0.965272 7.48164 0.42749 10.0949 0.42749H14.3734V6.04837H13.1795H11.9857C11.0907 6.04837 10.4822 6.25004 10.16 6.65339C9.87363 7.0231 9.73044 7.64487 9.73044 8.51875V16.006C9.73044 17.0479 9.49776 17.9891 9.03238 18.8292C8.60282 19.6359 7.92267 20.2745 6.99195 20.745C7.92267 21.2156 8.60282 21.871 9.03238 22.7113C9.49776 23.5181 9.73044 24.4422 9.73044 25.4842V32.9713C9.73044 33.8116 9.87363 34.4334 10.16 34.8368C10.4822 35.2064 11.0907 35.3913 11.9857 35.3913H14.3734V41.0122H10.0949Z" fill="#41BD9B" />
</svg>
```

**Note for the implementer:** the viewBox above (`0 0 15 41`) is a tight crop around the path's own coordinates (the path data is unchanged, only the viewBox is cropped to it, so no transform is needed). After creating the file, open it directly in a browser tab (`file:///.../web/public/favicon.svg`) and confirm it shows the D mark filling the frame with no clipping and no large empty margins. If it looks off-center or clipped, adjust the viewBox's four numbers (min-x, min-y, width, height) — do not touch the path's `d` data.

- [ ] **Step 2: Link the favicon in index.html**

Modify `web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <title>Dev Dashboard</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 3: Verify in the dev server**

Run: `npm run dev` (from `web/`)

Open the printed local URL in a browser and confirm the browser tab shows the green D mark as the favicon instead of the generic default icon. Stop the dev server (Ctrl+C) when done.

- [ ] **Step 4: Commit**

```bash
git add web/public/favicon.svg web/index.html
git commit -m "feat: add Diagrid D-mark favicon"
```

---

### Task 2: Centralize the title suffix in useDocumentTitle

**Files:**
- Modify: `web/src/lib/useDocumentTitle.ts`
- Modify: `web/src/lib/useDocumentTitle.test.tsx`

**Interfaces:**
- Consumes: none (this is the hook every page task below calls).
- Produces: `useDocumentTitle(title: string): void` — same signature as before. Internally sets `document.title` to `` `${title} | Diagrid Dev Dashboard` `` instead of the raw `title`. On unmount it still restores whatever `document.title` was before it mounted (unchanged behavior). Every later task's `expect(document.title).toBe(...)` assertions must include the ` | Diagrid Dev Dashboard` suffix.

- [ ] **Step 1: Update the failing tests to expect the suffix**

Replace the contents of `web/src/lib/useDocumentTitle.test.tsx`:

```tsx
import { render, act } from '@testing-library/react'
import { describe, it, expect, beforeEach } from 'vitest'
import { useDocumentTitle } from './useDocumentTitle'

function TitleSetter({ title }: { title: string }) {
  useDocumentTitle(title)
  return null
}

describe('useDocumentTitle', () => {
  beforeEach(() => {
    document.title = 'Dapr Dev Dashboard'
  })

  it('sets document.title to the provided value plus the branding suffix', () => {
    render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
  })

  it('restores the previous title on unmount', () => {
    document.title = 'Original'
    const { unmount } = render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
    act(() => unmount())
    expect(document.title).toBe('Original')
  })

  it('updates title when prop changes, keeping the suffix', () => {
    const { rerender } = render(<TitleSetter title="Actors" />)
    expect(document.title).toBe('Actors | Diagrid Dev Dashboard')
    rerender(<TitleSetter title="Actors — order" />)
    expect(document.title).toBe('Actors — order | Diagrid Dev Dashboard')
  })
})
```

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `npx vitest run src/lib/useDocumentTitle.test.tsx`
Expected: FAIL — actual `document.title` is `"Actors"` etc., missing the suffix.

- [ ] **Step 3: Add the suffix in the hook**

Replace the contents of `web/src/lib/useDocumentTitle.ts`:

```ts
import { useEffect, useRef } from 'react'

const TITLE_SUFFIX = ' | Diagrid Dev Dashboard'

export function useDocumentTitle(title: string): void {
  const prevTitleRef = useRef<string>(document.title)

  useEffect(() => {
    const prev = prevTitleRef.current
    document.title = `${title}${TITLE_SUFFIX}`
    return () => {
      document.title = prev
    }
  }, [title])
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `npx vitest run src/lib/useDocumentTitle.test.tsx`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/useDocumentTitle.ts web/src/lib/useDocumentTitle.test.tsx
git commit -m "feat: centralize the Diagrid Dev Dashboard title suffix in useDocumentTitle"
```

---

### Task 3: Simplify Logs.tsx's title branch

**Files:**
- Modify: `web/src/pages/Logs.tsx:450-456`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from Task 2 (now appends the suffix itself).
- Produces: no change to any other file's interface.

- [ ] **Step 1: Write a failing test for the no-filter title**

Add a new top-level `describe` block to `web/src/pages/Logs.test.tsx` (after the existing `describe('parseLogTime', ...)` block, or anywhere at the top level of the file), reusing the file's existing `renderAt(initialEntry)` helper (defined at line 113; it defaults to `/logs?app=order&source=daprd`, so pass `/logs` explicitly here to get the no-filter case):

```tsx
describe('Logs document title', () => {
  it('sets the document title to Logs (plus suffix) when no app or control-plane filter is active', async () => {
    renderAt('/logs')
    await waitFor(() => expect(document.title).toBe('Logs | Diagrid Dev Dashboard'))
  })
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/Logs.test.tsx -t "sets the document title to Logs"`
Expected: FAIL — actual title is `"Logs — Dapr Dev Dashboard | Diagrid Dev Dashboard"` (Task 2's suffix stacked on top of the old hardcoded one).

- [ ] **Step 3: Simplify the title logic**

In `web/src/pages/Logs.tsx`, replace lines 450-456:

```ts
  useDocumentTitle(
    isCpView
      ? `Logs — ${cp}`
      : appId
        ? `Logs — ${appId}`
        : 'Logs — Dapr Dev Dashboard',
  )
```

with:

```ts
  useDocumentTitle(
    isCpView
      ? `Logs — ${cp}`
      : appId
        ? `Logs — ${appId}`
        : 'Logs',
  )
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/Logs.test.tsx -t "sets the document title to Logs"`
Expected: PASS

- [ ] **Step 5: Run the full Logs test file to check for regressions**

Run: `npx vitest run src/pages/Logs.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Logs.tsx web/src/pages/Logs.test.tsx
git commit -m "fix: drop Logs.tsx's redundant hardcoded title suffix"
```

---

### Task 4: Set the document title on the Applications page

**Files:**
- Modify: `web/src/pages/Applications.tsx`
- Modify: `web/src/pages/Applications.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../lib/useDocumentTitle` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Applications.test.tsx` (inside the existing `describe` block, using the file's existing `renderAt()` helper and `mockApps()` helper already defined in that file):

```tsx
it('sets the document title to Applications', async () => {
  mockApps(sampleApps)
  renderAt()
  await waitFor(() => expect(document.title).toBe('Applications | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/Applications.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` is unchanged from whatever jsdom's default is (empty string), not `'Applications | Diagrid Dev Dashboard'`.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/Applications.tsx`, add the import:

```ts
import { useDocumentTitle } from '../lib/useDocumentTitle'
```

and inside `export function Applications() { ... }`, right after the `useApps()` call:

```ts
export function Applications() {
  const navigate = useNavigate()
  const { data: apps, isLoading } = useApps()

  useDocumentTitle('Applications')

  if (isLoading) {
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/Applications.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/Applications.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Applications.tsx web/src/pages/Applications.test.tsx
git commit -m "feat: set document title on the Applications page"
```

---

### Task 5: Set the document title on the AppDetail page

**Files:**
- Modify: `web/src/pages/AppDetail.tsx`
- Modify: `web/src/pages/AppDetail.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../lib/useDocumentTitle` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/AppDetail.test.tsx` (inside the existing `describe('AppDetail', ...)` block, reusing the file's `renderDetail()` helper and the same mock server response shape used in its first test):

```tsx
it('sets the document title to the app id', async () => {
  server.use(
    http.get('/api/apps/order', () =>
      HttpResponse.json({
        appId: 'order',
        health: 'healthy',
        runtime: 'go',
        httpPort: 3500,
        grpcPort: 50001,
        appPort: 8080,
        daprdPid: 48230,
        appPid: 48213,
        cliPid: 48201,
        command: 'go run ./cmd/order',
        runtimeVersion: '1.14.4',
        metadataOk: true,
      }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(document.title).toBe('order | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/AppDetail.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` never changes.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/AppDetail.tsx`, add the import:

```ts
import { useDocumentTitle } from '../lib/useDocumentTitle'
```

and inside `function AppDetailContent({ app }: { app: AppDetailType }) { ... }` (the title is only known once `app` has loaded, so the call belongs in the content component, not the loading/error wrapper):

```ts
function AppDetailContent({ app }: { app: AppDetailType }) {
  const navigate = useNavigate()
  const { toast, toastNode } = useToast()

  useDocumentTitle(app.appId)

  const copyPath = (path: string) => {
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/AppDetail.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/AppDetail.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/AppDetail.tsx web/src/pages/AppDetail.test.tsx
git commit -m "feat: set document title on the AppDetail page"
```

---

### Task 6: Set the document title on the Workflows page

**Files:**
- Modify: `web/src/pages/Workflows.tsx`
- Modify: `web/src/pages/Workflows.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../lib/useDocumentTitle` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/Workflows.test.tsx` (inside the existing `describe('Workflows', ...)` block, reusing the file's `renderAt()` helper — the `beforeEach` in that file already registers empty-list handlers for `/api/workflows`, `/api/statestores`, `/api/apps`, `/api/workflows/stats`, `/api/workflows/appids`, so no `renderAt()` call needs a workflows list to make this test pass):

```tsx
it('sets the document title to Workflows', async () => {
  server.use(http.get('/api/workflows', () => HttpResponse.json({ items: [] })))
  renderAt()
  await waitFor(() => expect(document.title).toBe('Workflows | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/Workflows.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` never changes.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/Workflows.tsx`, add the import:

```ts
import { useDocumentTitle } from '../lib/useDocumentTitle'
```

and inside `export function Workflows() { ... }`, right after the `useSearchParams()` call:

```ts
export function Workflows() {
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  useDocumentTitle('Workflows')

  // Initialize filter state from URL on mount
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/Workflows.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/Workflows.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/Workflows.tsx web/src/pages/Workflows.test.tsx
git commit -m "feat: set document title on the Workflows page"
```

---

### Task 7: Set the document title on the WorkflowDetail page

**Files:**
- Modify: `web/src/pages/WorkflowDetail.tsx`
- Modify: `web/src/pages/WorkflowDetail.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../lib/useDocumentTitle` (Task 2).

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/WorkflowDetail.test.tsx` (inside the existing `describe('WorkflowDetail', ...)` block, reusing the file's `renderDetail()` helper — it defaults to the route `/workflows/order/abc`):

```tsx
it('sets the document title to Workflow — <instanceId>', async () => {
  server.use(
    http.get('/api/workflows/order/abc', () =>
      HttpResponse.json({
        appId: 'order',
        instanceId: 'abc',
        name: 'OrderWorkflow',
        status: 'Running',
        createdAt: '2026-06-26T10:00:00Z',
        replayCount: 0,
        input: '{"id":1}',
        history: [],
      }),
    ),
  )
  renderDetail()
  await waitFor(() => expect(document.title).toBe('Workflow — abc | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/WorkflowDetail.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` never changes.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/WorkflowDetail.tsx`, add the import:

```ts
import { useDocumentTitle } from '../lib/useDocumentTitle'
```

and inside `export function WorkflowDetail() { ... }`, right after the `useParams` destructure (the title only needs the route param, not the loaded `execution`, so it can be set immediately rather than waiting on the fetch):

```ts
export function WorkflowDetail() {
  const { appId, instanceId } = useParams<{ appId: string; instanceId: string }>()

  useDocumentTitle(`Workflow — ${instanceId ?? ''}`)

  const [searchParams] = useSearchParams()
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/WorkflowDetail.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/WorkflowDetail.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/WorkflowDetail.tsx web/src/pages/WorkflowDetail.test.tsx
git commit -m "feat: set document title on the WorkflowDetail page"
```

---

### Task 8: Set the document title on the ComponentBuilder page

**Files:**
- Modify: `web/src/pages/component-builder/ComponentBuilder.tsx`
- Modify: `web/src/pages/component-builder/ComponentBuilder.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../../lib/useDocumentTitle` (Task 2) — note the extra `../` since this file lives one directory deeper than the other pages.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/component-builder/ComponentBuilder.test.tsx` (inside the existing `describe('ComponentBuilder', ...)` block, reusing the file's `renderBuilder()` helper):

```tsx
it('sets the document title to New component', async () => {
  renderBuilder()
  await waitFor(() => expect(document.title).toBe('New component | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/component-builder/ComponentBuilder.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` never changes.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/component-builder/ComponentBuilder.tsx`, add the import:

```ts
import { useDocumentTitle } from '../../lib/useDocumentTitle'
```

and inside `export function ComponentBuilder() { ... }`, right after the `useReducer` call:

```ts
export function ComponentBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  useDocumentTitle('New component')

  const yaml = useMemo(
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/component-builder/ComponentBuilder.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/component-builder/ComponentBuilder.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/component-builder/ComponentBuilder.tsx web/src/pages/component-builder/ComponentBuilder.test.tsx
git commit -m "feat: set document title on the ComponentBuilder page"
```

---

### Task 9: Set the document title on the ResiliencyBuilder page

**Files:**
- Modify: `web/src/pages/resiliency-builder/ResiliencyBuilder.tsx`
- Modify: `web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`

**Interfaces:**
- Consumes: `useDocumentTitle(title: string): void` from `../../lib/useDocumentTitle` (Task 2) — note the extra `../` since this file lives one directory deeper than the other pages.

- [ ] **Step 1: Write the failing test**

Add to `web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx` (inside the existing `describe('ResiliencyBuilder', ...)` block, reusing the file's `renderBuilder()` helper):

```tsx
it('sets the document title to New resiliency policy', async () => {
  renderBuilder()
  await waitFor(() => expect(document.title).toBe('New resiliency policy | Diagrid Dev Dashboard'))
})
```

- [ ] **Step 2: Run the test and confirm it fails**

Run: `npx vitest run src/pages/resiliency-builder/ResiliencyBuilder.test.tsx -t "sets the document title"`
Expected: FAIL — `document.title` never changes.

- [ ] **Step 3: Add the hook call**

In `web/src/pages/resiliency-builder/ResiliencyBuilder.tsx`, add the import:

```ts
import { useDocumentTitle } from '../../lib/useDocumentTitle'
```

and inside `export function ResiliencyBuilder() { ... }`, right after the `useReducer` call:

```ts
export function ResiliencyBuilder() {
  const navigate = useNavigate()
  const [state, dispatch] = useReducer(reducer, undefined, initialState)

  useDocumentTitle('New resiliency policy')

  const yaml = useMemo(
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `npx vitest run src/pages/resiliency-builder/ResiliencyBuilder.test.tsx -t "sets the document title"`
Expected: PASS

- [ ] **Step 5: Run the full file to check for regressions**

Run: `npx vitest run src/pages/resiliency-builder/ResiliencyBuilder.test.tsx`
Expected: PASS (all tests)

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/resiliency-builder/ResiliencyBuilder.tsx web/src/pages/resiliency-builder/ResiliencyBuilder.test.tsx
git commit -m "feat: set document title on the ResiliencyBuilder page"
```

---

### Task 10: Full suite + manual click-through

**Files:** none (verification only)

**Interfaces:** none — this task only verifies the work of Tasks 1-9.

- [ ] **Step 1: Run the full web test suite**

Run: `npm test` (from `web/`)
Expected: PASS — no regressions in any file touched above or elsewhere.

- [ ] **Step 2: Manual click-through**

Run: `npm run dev` (from `web/`)

In a browser, click through every top-nav route (Applications, an app's detail page, Workflows, a workflow's detail page, Components → New component, Resiliency → New resiliency policy, Actors, Subscriptions, Configurations, Control Plane, Logs) and confirm for each:
- the browser tab title updates to that page's name
- the title ends with ` | Diagrid Dev Dashboard`
- the tab shows the green D-mark favicon

Stop the dev server (Ctrl+C) when done. This step has no commit — it's verification only.

---
