# CLI Drawer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible right-side drawer that surfaces context-sensitive, self-hosted Dapr CLI commands for the current page, each with a copy button, driven by editable per-page YAML content files.

**Architecture:** A pure `CliDrawer` React component (props: `context`, `values`) renders a vertical "CLI" edge tab that slides an overlay panel over page content. `App.tsx` derives `context` (the route's `rumView` handle) and `values` (`appId`/`instanceId` from the leaf route match and the `app` search param) from router hooks and passes them in. Command content lives in YAML files (one per page context), loaded and parsed in `lib/cli.ts`, with `{{token}}` placeholders resolved from `values`.

**Tech Stack:** React 19 + TypeScript, react-router-dom v6, Vite (`?raw` imports), js-yaml, Vitest + @testing-library/react.

## Global Constraints

- **No Kubernetes commands.** No shipped command may contain ` -k` or `--kubernetes`. The dashboard does not target Kubernetes. (`dapr components`, `dapr configurations`, `dapr status`, `dapr logs` are Kubernetes-only and are therefore excluded.)
- **Overlay only.** The drawer must not change the layout of the page beneath it (`position: fixed`, higher z-index, width ≤ 1/3 of viewport).
- **Collapsed by default.** Open/closed state persists to `localStorage` under key `devdash.cliDrawerOpen` via the existing `safeGet`/`safeSet` helpers.
- **z-index:** drawer panel `40`, edge tab `41` (above sidebar `9` / topbar `10`, below toast `50` / modal `1000`).
- **One tool now (Dapr).** The YAML schema is keyed by tool id to allow a future Diagrid Catalyst tool, but no tab bar is rendered while only one tool exists.
- **Only `{{token}}` is substituted.** Literal `<...>` placeholders (e.g. `<method>`) are copied verbatim.
- **Typecheck matters.** Vitest does not typecheck — run `make build` (or `npm --prefix web run build`) after implementation to catch `.ts(x)` type errors.
- All paths below are relative to the repo root; the frontend lives under `web/`.

---

### Task 1: Content layer — YAML files + `lib/cli.ts`

Creates the six per-context YAML content files and the loader/resolver library.

**Files:**
- Create: `web/src/content/cli/applications.yaml`
- Create: `web/src/content/cli/app-detail.yaml`
- Create: `web/src/content/cli/workflows.yaml`
- Create: `web/src/content/cli/workflow-detail.yaml`
- Create: `web/src/content/cli/actors.yaml`
- Create: `web/src/content/cli/subscriptions.yaml`
- Create: `web/src/lib/cli.ts`
- Test: `web/src/lib/cli.test.ts`

**Interfaces:**
- Consumes: nothing (leaf task).
- Produces:
  - `interface CliCommandDef { title: string; command: string; docs?: string }`
  - `interface CliTool { label: string; commands: CliCommandDef[] }`
  - `interface CliContent { context: string; tools: Record<string, CliTool> }`
  - `getCliContent(context: string | undefined): CliContent | undefined`
  - `resolvePlaceholders(command: string, values: Record<string, string | undefined>): string`

- [ ] **Step 1: Create the six YAML content files**

`web/src/content/cli/applications.yaml`:
```yaml
# CLI commands shown in the drawer on the Applications overview page.
# Edit wording/commands here — no code changes needed.
# Constraint: self-hosted only, never a `-k` / `--kubernetes` command.
context: Applications
tools:
  dapr:
    label: Dapr
    commands:
      - title: List running Dapr apps
        command: dapr list
        docs: https://docs.dapr.io/reference/cli/dapr-list/
```

`web/src/content/cli/app-detail.yaml`:
```yaml
context: AppDetail
tools:
  dapr:
    label: Dapr
    commands:
      - title: Stop this app
        command: dapr stop --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-stop/
      - title: Invoke a method on this app
        command: dapr invoke --app-id {{appId}} --method <method> --data '{"key":"value"}'
        docs: https://docs.dapr.io/reference/cli/dapr-invoke/
```

`web/src/content/cli/workflows.yaml`:
```yaml
context: Workflows
tools:
  dapr:
    label: Dapr
    commands:
      - title: List workflows for this app
        command: dapr workflow list --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: List running workflows
        command: dapr workflow list --app-id {{appId}} --filter-status RUNNING
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: List scheduled jobs
        command: dapr scheduler list
        docs: https://docs.dapr.io/reference/cli/dapr-scheduler/
```

`web/src/content/cli/workflow-detail.yaml`:
```yaml
context: WorkflowDetail
tools:
  dapr:
    label: Dapr
    commands:
      - title: View execution history
        command: dapr workflow history {{instanceId}} --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: Terminate this instance
        command: dapr workflow terminate {{instanceId}} --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: Pause (suspend) this instance
        command: dapr workflow suspend {{instanceId}} --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: Resume this instance
        command: dapr workflow resume {{instanceId}} --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: Purge this instance
        command: dapr workflow purge {{instanceId}} --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-workflow/
      - title: Inspect this instance's scheduler reminder
        command: dapr scheduler get workflow/{{appId}}/{{instanceId}}/<reminder-name> -o yaml
        docs: https://docs.dapr.io/reference/cli/dapr-scheduler/
```

`web/src/content/cli/actors.yaml`:
```yaml
context: Actors
tools:
  dapr:
    label: Dapr
    commands:
      - title: List scheduled jobs and reminders
        command: dapr scheduler list
        docs: https://docs.dapr.io/reference/cli/dapr-scheduler/
      - title: Get an actor reminder
        command: dapr scheduler get actor/<actor-type>/<actor-id>/<reminder-name> -o yaml
        docs: https://docs.dapr.io/reference/cli/dapr-scheduler/
```

`web/src/content/cli/subscriptions.yaml`:
```yaml
context: Subscriptions
tools:
  dapr:
    label: Dapr
    commands:
      - title: Publish a test event
        command: dapr publish --publish-app-id <app-id> --pubsub <pubsub> --topic <topic> --data '{"key":"value"}'
        docs: https://docs.dapr.io/reference/cli/dapr-publish/
```

- [ ] **Step 2: Write the failing test**

`web/src/lib/cli.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { getCliContent, resolvePlaceholders } from './cli'

const CONTEXTS = ['Applications', 'AppDetail', 'Workflows', 'WorkflowDetail', 'Actors', 'Subscriptions']

describe('getCliContent', () => {
  it('loads content for every supported context with a dapr tool and commands', () => {
    for (const ctx of CONTEXTS) {
      const content = getCliContent(ctx)
      expect(content, ctx).toBeDefined()
      expect(content!.context).toBe(ctx)
      expect(content!.tools.dapr.label).toBe('Dapr')
      expect(content!.tools.dapr.commands.length).toBeGreaterThan(0)
    }
  })

  it('returns undefined for unknown or missing contexts', () => {
    expect(getCliContent('Logs')).toBeUndefined()
    expect(getCliContent(undefined)).toBeUndefined()
  })

  it('ships no Kubernetes-only commands', () => {
    for (const ctx of CONTEXTS) {
      for (const c of getCliContent(ctx)!.tools.dapr.commands) {
        expect(c.command, c.command).not.toMatch(/(^|\s)(-k|--kubernetes)(\s|$)/)
      }
    }
  })

  it('exposes the expected app-detail commands', () => {
    const cmds = getCliContent('AppDetail')!.tools.dapr.commands.map((c) => c.command)
    expect(cmds).toContain('dapr stop --app-id {{appId}}')
  })
})

describe('resolvePlaceholders', () => {
  it('substitutes present values', () => {
    expect(resolvePlaceholders('dapr stop --app-id {{appId}}', { appId: 'order' })).toBe(
      'dapr stop --app-id order',
    )
    expect(
      resolvePlaceholders('dapr workflow history {{instanceId}} --app-id {{appId}}', {
        appId: 'order',
        instanceId: 'abc-123',
      }),
    ).toBe('dapr workflow history abc-123 --app-id order')
  })

  it('falls back to kebab-cased <token> literals for missing/empty values', () => {
    expect(resolvePlaceholders('dapr workflow list --app-id {{appId}}', {})).toBe(
      'dapr workflow list --app-id <app-id>',
    )
    expect(resolvePlaceholders('history {{instanceId}}', { instanceId: '' })).toBe(
      'history <instance-id>',
    )
  })

  it('leaves literal <...> placeholders untouched', () => {
    const cmd = 'dapr invoke --app-id {{appId}} --method <method>'
    expect(resolvePlaceholders(cmd, { appId: 'order' })).toBe(
      'dapr invoke --app-id order --method <method>',
    )
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix web test -- src/lib/cli.test.ts`
Expected: FAIL — cannot resolve module `./cli` (file does not exist yet).

- [ ] **Step 4: Write `web/src/lib/cli.ts`**

```ts
import { load } from 'js-yaml'
import applicationsRaw from '../content/cli/applications.yaml?raw'
import appDetailRaw from '../content/cli/app-detail.yaml?raw'
import workflowsRaw from '../content/cli/workflows.yaml?raw'
import workflowDetailRaw from '../content/cli/workflow-detail.yaml?raw'
import actorsRaw from '../content/cli/actors.yaml?raw'
import subscriptionsRaw from '../content/cli/subscriptions.yaml?raw'

export interface CliCommandDef {
  title: string
  command: string
  docs?: string
}

export interface CliTool {
  label: string
  commands: CliCommandDef[]
}

export interface CliContent {
  context: string
  tools: Record<string, CliTool>
}

const rawByContext: Record<string, string> = {
  Applications: applicationsRaw,
  AppDetail: appDetailRaw,
  Workflows: workflowsRaw,
  WorkflowDetail: workflowDetailRaw,
  Actors: actorsRaw,
  Subscriptions: subscriptionsRaw,
}

const contentByContext: Record<string, CliContent> = Object.fromEntries(
  Object.entries(rawByContext).map(([ctx, raw]) => [ctx, load(raw) as CliContent]),
)

/** Returns drawer content for a route context (rumView), or undefined if none. */
export function getCliContent(context: string | undefined): CliContent | undefined {
  if (!context) return undefined
  return contentByContext[context]
}

/** camelCase token -> kebab-case literal placeholder, e.g. appId -> <app-id>. */
function tokenToLiteral(token: string): string {
  return `<${token.replace(/([A-Z])/g, '-$1').toLowerCase()}>`
}

/**
 * Substitutes {{token}} placeholders from `values`. Missing/empty values fall
 * back to a readable <kebab-token> literal so the command stays copyable.
 * Literal <...> placeholders in the source command are left untouched.
 */
export function resolvePlaceholders(
  command: string,
  values: Record<string, string | undefined>,
): string {
  return command.replace(/\{\{(\w+)\}\}/g, (_match, token: string) => {
    const value = values[token]
    return value != null && value !== '' ? value : tokenToLiteral(token)
  })
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm --prefix web test -- src/lib/cli.test.ts`
Expected: PASS (all cases).

- [ ] **Step 6: Commit**

```bash
git add web/src/content/cli web/src/lib/cli.ts web/src/lib/cli.test.ts
git commit -m "feat: add CLI drawer content files and loader/resolver"
```

---

### Task 2: `CliCommand` component

A single command row: title, optional docs link, the command in a `<code>` block, and a Copy button.

**Files:**
- Create: `web/src/components/CliCommand.tsx`
- Test: `web/src/components/CliCommand.test.tsx`

**Interfaces:**
- Consumes: `copyText` from `web/src/lib/clipboard.ts`.
- Produces:
  - `interface CliCommandProps { title: string; command: string; docs?: string; onCopied?: () => void }`
  - `function CliCommand(props: CliCommandProps): JSX.Element`
  - Receives the **already-resolved** command string (resolution happens in `CliDrawer`).

- [ ] **Step 1: Write the failing test**

`web/src/components/CliCommand.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliCommand } from './CliCommand'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('CliCommand', () => {
  it('renders the title and command text', () => {
    render(<CliCommand title="Stop this app" command="dapr stop --app-id order" />)
    expect(screen.getByText('Stop this app')).toBeInTheDocument()
    expect(screen.getByText('dapr stop --app-id order')).toBeInTheDocument()
  })

  it('copies the exact command and calls onCopied when Copy is clicked', () => {
    const onCopied = vi.fn()
    render(
      <CliCommand title="Stop this app" command="dapr stop --app-id order" onCopied={onCopied} />,
    )
    fireEvent.click(screen.getByRole('button', { name: /copy/i }))
    expect(copyText).toHaveBeenCalledWith('dapr stop --app-id order')
    expect(onCopied).toHaveBeenCalledTimes(1)
  })

  it('renders a docs link only when docs is set', () => {
    const { rerender } = render(<CliCommand title="A" command="dapr list" />)
    expect(screen.queryByRole('link')).toBeNull()
    rerender(<CliCommand title="A" command="dapr list" docs="https://docs.dapr.io/x/" />)
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://docs.dapr.io/x/')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- src/components/CliCommand.test.tsx`
Expected: FAIL — cannot resolve module `./CliCommand`.

- [ ] **Step 3: Write `web/src/components/CliCommand.tsx`**

```tsx
import { copyText } from '../lib/clipboard'

interface CliCommandProps {
  title: string
  command: string
  docs?: string
  onCopied?: () => void
}

export function CliCommand({ title, command, docs, onCopied }: CliCommandProps) {
  function handleCopy() {
    copyText(command)
    onCopied?.()
  }

  return (
    <div className="cli-command">
      <div className="cli-command-head">
        <span className="cli-command-title">{title}</span>
        {docs && (
          <a
            className="cli-command-docs"
            href={docs}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`${title} — Dapr CLI docs`}
          >
            ↗
          </a>
        )}
      </div>
      <div className="cli-command-row">
        <code className="cli-command-code">{command}</code>
        <button
          type="button"
          className="btn ghost cli-copy"
          aria-label={`Copy command: ${command}`}
          onClick={handleCopy}
        >
          Copy
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- src/components/CliCommand.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/CliCommand.tsx web/src/components/CliCommand.test.tsx
git commit -m "feat: add CliCommand row with copy button"
```

---

### Task 3: `CliDrawer` component

Orchestrates content lookup, placeholder resolution, open/close state (persisted), and renders the edge tab + overlay panel. Pure with respect to routing — takes `context` and `values` as props.

**Files:**
- Create: `web/src/components/CliDrawer.tsx`
- Test: `web/src/components/CliDrawer.test.tsx`

**Interfaces:**
- Consumes:
  - `getCliContent`, `resolvePlaceholders` from `web/src/lib/cli.ts`
  - `CliCommand` from `web/src/components/CliCommand.tsx`
  - `useToast` from `web/src/lib/toast.tsx`
  - `safeGet`, `safeSet` from `web/src/lib/safeStorage.ts`
- Produces:
  - `interface CliDrawerProps { context?: string; values: Record<string, string | undefined> }`
  - `function CliDrawer(props: CliDrawerProps): JSX.Element | null`
  - Renders `null` when `getCliContent(context)` is undefined.

- [ ] **Step 1: Write the failing test**

`web/src/components/CliDrawer.test.tsx`:
```tsx
import { render, screen, fireEvent } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CliDrawer } from './CliDrawer'
import { copyText } from '../lib/clipboard'

vi.mock('../lib/clipboard', () => ({ copyText: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('CliDrawer', () => {
  it('renders nothing for a context with no content', () => {
    const { container } = render(<CliDrawer context="Logs" values={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('renders nothing when context is undefined', () => {
    const { container } = render(<CliDrawer context={undefined} values={{}} />)
    expect(container).toBeEmptyDOMElement()
  })

  it('shows the CLI tab and resolves values into commands on AppDetail', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    expect(screen.getByRole('button', { name: 'CLI commands' })).toBeInTheDocument()
    expect(screen.getByText('dapr stop --app-id order')).toBeInTheDocument()
  })

  it('starts collapsed and toggles open/closed via the tab', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    const drawer = document.querySelector('.cli-drawer')!
    expect(drawer.className).not.toContain('open')
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    expect(document.querySelector('.cli-drawer')!.className).toContain('open')
  })

  it('persists the open state to localStorage', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    expect(localStorage.getItem('devdash.cliDrawerOpen')).toBe('true')
  })

  it('opens collapsed=false initially when localStorage says open', () => {
    localStorage.setItem('devdash.cliDrawerOpen', 'true')
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    expect(document.querySelector('.cli-drawer')!.className).toContain('open')
  })

  it('falls back to a literal <app-id> when appId is absent', () => {
    render(<CliDrawer context="Workflows" values={{}} />)
    expect(screen.getByText('dapr workflow list --app-id <app-id>')).toBeInTheDocument()
  })

  it('copies the resolved command and shows a Copied toast', () => {
    render(<CliDrawer context="AppDetail" values={{ appId: 'order' }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy command: dapr stop --app-id order' }))
    expect(copyText).toHaveBeenCalledWith('dapr stop --app-id order')
    expect(screen.getByText('Copied')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix web test -- src/components/CliDrawer.test.tsx`
Expected: FAIL — cannot resolve module `./CliDrawer`.

- [ ] **Step 3: Write `web/src/components/CliDrawer.tsx`**

```tsx
import { useState } from 'react'
import { getCliContent, resolvePlaceholders } from '../lib/cli'
import { CliCommand } from './CliCommand'
import { useToast } from '../lib/toast'
import { safeGet, safeSet } from '../lib/safeStorage'

const OPEN_KEY = 'devdash.cliDrawerOpen'

interface CliDrawerProps {
  context?: string
  values: Record<string, string | undefined>
}

export function CliDrawer({ context, values }: CliDrawerProps) {
  const content = getCliContent(context)
  const { toast, toastNode } = useToast()
  const [open, setOpen] = useState(() => safeGet(OPEN_KEY) === 'true')

  if (!content) return null

  // Single tool for now (Dapr). The tools map is keyed for a future second
  // tool; a tab bar is intentionally not rendered while only one exists.
  const toolIds = Object.keys(content.tools)
  const tool = content.tools[toolIds[0]]

  function toggle() {
    setOpen((prev) => {
      const next = !prev
      safeSet(OPEN_KEY, String(next))
      return next
    })
  }

  return (
    <div className={`cli-drawer${open ? ' open' : ''}`}>
      <button
        type="button"
        className="cli-tab"
        aria-expanded={open}
        aria-label="CLI commands"
        onClick={toggle}
      >
        CLI
      </button>
      <aside className="cli-panel" aria-hidden={!open} aria-label="CLI commands panel">
        <div className="cli-panel-head">
          <h2>CLI</h2>
          <button type="button" className="cli-close" aria-label="Close CLI drawer" onClick={toggle}>
            ✕
          </button>
        </div>
        <div className="cli-commands">
          {tool.commands.map((c) => (
            <CliCommand
              key={c.title}
              title={c.title}
              command={resolvePlaceholders(c.command, values)}
              docs={c.docs}
              onCopied={() => toast.show('Copied')}
            />
          ))}
        </div>
      </aside>
      {toastNode}
    </div>
  )
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix web test -- src/components/CliDrawer.test.tsx`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/components/CliDrawer.tsx web/src/components/CliDrawer.test.tsx
git commit -m "feat: add CliDrawer overlay panel with edge tab"
```

---

### Task 4: Wire into `App.tsx` and add styling

Mounts the drawer in the app shell, derives `context`/`values` from router hooks, and adds the CSS. Deliverable: the drawer works in the running app on the four+ content pages.

**Files:**
- Modify: `web/src/App.tsx` (imports; derive leaf params + search param; render `<CliDrawer>`)
- Modify: `web/src/styles/theme.css` (append CLI drawer rules)
- Test: `web/src/App.test.tsx` (add drawer integration cases)

**Interfaces:**
- Consumes: `CliDrawer` from `web/src/components/CliDrawer.tsx`; `useMatches`, `useSearchParams` from `react-router-dom`.
- Produces: nothing consumed by later tasks (final task).

- [ ] **Step 1: Inspect the current `App.tsx` render + rumView derivation**

Run: `sed -n '20,60p' web/src/App.tsx`
Expected: confirms `const matches = useMatches()`, the `rumView` reduction, and `<main className="body"><Outlet /></main>`.

- [ ] **Step 2: Write the failing integration test**

Add to `web/src/App.test.tsx` a block that mounts the real `App` at an AppDetail route with the `rumView` handle and asserts the drawer tab appears; and at a no-content route it does not. Use the existing providers pattern from `Applications.test.tsx`.

```tsx
import { screen, fireEvent } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { render } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { App } from './App'
import { makeQueryClient, QueryProvider } from './lib/query'
import { RefreshProvider } from './lib/refresh'

function renderAppAt(path: string) {
  const client = makeQueryClient()
  const router = createMemoryRouter(
    [
      {
        path: '/',
        element: <App />,
        children: [
          { path: 'apps/:appId', element: <div>app detail</div>, handle: { rumView: 'AppDetail' } },
          { path: 'actors', element: <div>actors page</div>, handle: { rumView: 'Actors' } },
          { path: 'configurations', element: <div>configs</div>, handle: { rumView: 'Configurations' } },
        ],
      },
    ],
    { initialEntries: [path], future: { v7_relativeSplatPath: true } },
  )
  return render(
    <QueryProvider client={client}>
      <RefreshProvider>
        <RouterProvider router={router} future={{ v7_startTransition: true }} />
      </RefreshProvider>
    </QueryProvider>,
  )
}

describe('App CLI drawer wiring', () => {
  it('shows the CLI tab with the route appId resolved on AppDetail', () => {
    renderAppAt('/apps/order')
    fireEvent.click(screen.getByRole('button', { name: 'CLI commands' }))
    expect(screen.getByText('dapr stop --app-id order')).toBeInTheDocument()
  })

  it('does not render the CLI tab on a context without content', () => {
    renderAppAt('/configurations')
    expect(screen.queryByRole('button', { name: 'CLI commands' })).toBeNull()
  })
})
```

Note: if `App.test.tsx` already imports some of these symbols, merge rather than duplicate imports. `Actors` has content, so use `Configurations` for the no-content assertion.

- [ ] **Step 3: Run test to verify it fails**

Run: `npm --prefix web test -- src/App.test.tsx`
Expected: FAIL — no button named "CLI commands" (drawer not mounted yet).

- [ ] **Step 4: Wire `CliDrawer` into `App.tsx`**

Add the import alongside the other component imports:
```tsx
import { CliDrawer } from './components/CliDrawer'
```

Add `useSearchParams` to the existing `react-router-dom` import:
```tsx
import { Outlet, useMatches, useSearchParams } from 'react-router-dom'
```

Inside `App()`, after the existing `rumView` derivation, add:
```tsx
  const [searchParams] = useSearchParams()
  const leafParams = (matches[matches.length - 1]?.params ?? {}) as Record<string, string | undefined>
  const cliValues = {
    appId: leafParams.appId ?? searchParams.get('app') ?? undefined,
    instanceId: leafParams.instanceId ?? undefined,
  }
```

Render the drawer as a sibling of `<main>`, inside the app `<div>`:
```tsx
        <main className="body">
          <Outlet />
        </main>
        <CliDrawer context={rumView} values={cliValues} />
```

- [ ] **Step 5: Append CSS to `web/src/styles/theme.css`**

```css
/* ---------- CLI drawer ---------- */
.cli-drawer { position: fixed; inset: 0; pointer-events: none; z-index: 40; }
.cli-tab {
  pointer-events: auto; position: fixed; right: 0; top: calc(var(--topbar-h, 46px) + 40px);
  z-index: 41; writing-mode: vertical-rl; transform: rotate(180deg);
  background: var(--surface-2); color: var(--text); border: 1px solid var(--line);
  border-radius: 8px 0 0 8px; padding: 14px 6px; font-size: 12px; font-weight: 600;
  letter-spacing: .1em; cursor: pointer; box-shadow: var(--shadow);
  transition: right .18s ease;
}
.cli-drawer.open .cli-tab { right: min(33vw, 33%); }
.cli-panel {
  pointer-events: auto; position: fixed; top: var(--topbar-h, 46px); right: 0; bottom: 0;
  width: min(33vw, 33%); z-index: 40; background: var(--surface);
  border-left: 1px solid var(--line); box-shadow: var(--shadow);
  transform: translateX(100%); transition: transform .18s ease;
  display: flex; flex-direction: column; overflow-y: auto;
}
.cli-drawer.open .cli-panel { transform: translateX(0); }
.cli-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--line); }
.cli-panel-head h2 { margin: 0; font-size: 13px; font-weight: 700; letter-spacing: .04em; }
.cli-close { background: none; border: none; color: var(--text); font-size: 15px; line-height: 1; cursor: pointer; padding: 4px; }
.cli-commands { padding: 14px 16px; display: flex; flex-direction: column; gap: 16px; }
.cli-command-head { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; }
.cli-command-title { font-size: 12.5px; font-weight: 600; }
.cli-command-docs { text-decoration: none; opacity: .7; }
.cli-command-docs:hover { opacity: 1; }
.cli-command-row { display: flex; align-items: stretch; gap: 8px; }
.cli-command-code { flex: 1; min-width: 0; background: var(--surface-2); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; font-size: 12px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; word-break: break-all; }
.cli-copy { white-space: nowrap; align-self: flex-start; }
```

Note: `--topbar-h`, `--surface`, `--surface-2`, `--line`, `--shadow`, `--text` are existing tokens (see the sidebar/topbar rules in `theme.css`). If `--topbar-h` is not a real variable there, replace with the literal `46px` used elsewhere.

- [ ] **Step 6: Run the drawer tests + typecheck**

Run: `npm --prefix web test -- src/App.test.tsx src/components/CliDrawer.test.tsx src/components/CliCommand.test.tsx src/lib/cli.test.ts`
Expected: PASS.

Run: `npm --prefix web run build`
Expected: type-checked build succeeds (no TS errors).

- [ ] **Step 7: Verify in the running app**

Run: `npm --prefix web run dev` (or the project's usual run flow), open an app detail page, click the vertical "CLI" tab, confirm the panel slides over content without shifting layout, the command shows the real app ID, Copy shows the "Copied" toast, and the drawer is absent on the Components/Configurations/Logs pages.

- [ ] **Step 8: Commit**

```bash
git add web/src/App.tsx web/src/App.test.tsx web/src/styles/theme.css
git commit -m "feat: mount CLI drawer in app shell with styling"
```

---

## Self-Review

**Spec coverage:**
- Collapsed-by-default edge tab, overlay ≤ 1/3 width, no layout shift → Task 3 (markup/state) + Task 4 (CSS). ✅
- Context-sensitive content per page, using view fields (appId/instanceId) → Task 1 (YAML + resolver) + Task 4 (router-derived values). ✅
- Dapr CLI focus, self-hosted only, no `-k` → Task 1 content + `cli.test.ts` guard. ✅
- Copy button per command → Task 2. ✅
- One YAML file per page/context → Task 1 (six files). ✅
- Specified commands (list; stop; workflow list/RUNNING; workflow history + management) → Task 1 tables. ✅
- Expanded pages (invoke, scheduler, publish; Actors + Subscriptions) → Task 1. ✅
- Future tabs/Diagrid Catalyst accommodated, no tab bar now → Task 3 single-tool render over a tools map. ✅
- Persisted open state → Task 3 (`devdash.cliDrawerOpen`). ✅

**Placeholder scan:** No TBD/TODO; every code step contains complete code. ✅

**Type consistency:** `CliContent`/`CliTool`/`CliCommandDef`, `getCliContent`, `resolvePlaceholders` (Task 1) are consumed with identical signatures in Task 3. `CliCommandProps` (Task 2) matches the props passed by `CliDrawer` (Task 3). `CliDrawerProps` (Task 3) matches the props passed by `App.tsx` (Task 4). ✅
