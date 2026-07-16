# CLI Drawer — Design Spec

**Date:** 2026-07-16
**Status:** Approved, ready for implementation planning

## Summary

Add a right-side drawer panel to the dashboard that surfaces context-sensitive
Dapr CLI commands for the current page. The drawer is collapsed by default,
opens as an overlay over page content (it never shifts the layout), and shows
commands relevant to the current view with per-command copy buttons. Command
text is populated from editable YAML content files (one per page context), with
placeholders resolved from the current route (app IDs, workflow instance IDs).

The content model is designed so a second CLI tool (Diagrid Catalyst) can be
added later via tabs, but no tab bar is rendered while only Dapr content exists.

## Goals

- A slim vertical "CLI" tab pinned to the right edge opens/closes the drawer.
- The drawer overlays page content at a higher z-index and is at most 1/3 of the
  viewport width; opening it does not change the layout of the page beneath.
- Drawer content is context-sensitive: it differs per page and uses live values
  from the current view (app ID, workflow instance ID).
- Content is focused on Dapr CLI commands relevant to the current page.
- Every individual command has its own copy button.
- Command content lives in YAML files — one file per page/context — so wording
  and commands can be edited without code changes.
- The design accommodates a future second tool (Diagrid Catalyst) via tabs.

## Non-Goals (YAGNI)

- Diagrid Catalyst commands or content (schema supports it; no content shipped).
- A visible tab bar (rendered automatically only once a second tool exists).
- A non-URL value provider for context values not present in the URL (added only
  when a future command needs data that isn't a path/search param).
- CLI content for pages with only Kubernetes-only commands (Components,
  Configurations, ControlPlane, Logs) or no relevant command (Resiliency). Those
  pages simply do not show the drawer trigger.
- Kubernetes commands (any `-k` / `--kubernetes` command): explicitly excluded —
  the dashboard is not intended to run against Kubernetes.

## Decisions (from brainstorming)

1. **Trigger UI:** a slim vertical "CLI" tab pinned to the right edge. Click to
   slide the panel open; click the tab again (or a close ✕) to collapse.
2. **Tabs:** defer the visible tab bar. Render only Dapr content now. Structure
   the YAML/data model for multiple tools so a tab bar appears automatically once
   a second tool is present.
3. **Pages without CLI content:** hide the trigger entirely. The drawer trigger
   and panel appear only on pages that have content.

## Architecture

A single `CliDrawer` component is mounted once in `web/src/App.tsx`, as a sibling
of `<main className="body">`. It is fully declarative and driven from the current
route — **no page components change**.

- **Context key:** reuse the router's existing `handle.rumView` (e.g.
  `Applications`, `AppDetail`, `Workflows`, `WorkflowDetail`). `App.tsx` already
  derives `rumView` from `useMatches()`; the drawer reuses that value as the
  content lookup key.
- **Route values:** the drawer reads `useParams`-style values from the leaf match
  (`useMatches()` exposes `.params` per match) and `useSearchParams` for the
  Workflows overview app filter. Every value the initial commands need is in the
  URL, so no per-page wiring is required.
- **Trigger visibility:** the vertical "CLI" tab renders only when the current
  context has content in the YAML map. On other pages, nothing renders.
- **Overlay:** `position: fixed`, right-aligned, `width: min(33vw, 33%)`,
  `z-index: 40` — above sidebar (9) and topbar (10), below toast (50) and modal
  (1000). It overlays content and never shifts layout.
- **Open/closed state:** collapsed by default; persisted to `localStorage` using
  the existing `safeGet`/`safeSet` helpers under key `devdash.cliDrawerOpen`
  (mirroring the sidebar's `devdash.sidebarCollapsed`).

## Content model (YAML)

One file per page context under `web/src/content/cli/<context>.yaml`. The schema
is keyed by tool id so additional tools slot in later:

```yaml
# web/src/content/cli/app-detail.yaml
context: AppDetail
tools:
  dapr:                      # tool id; add `catalyst:` later -> tab bar appears
    label: Dapr
    commands:
      - title: Stop this app
        command: dapr stop --app-id {{appId}}
        docs: https://docs.dapr.io/reference/cli/dapr-stop/
```

### Dapr CLI review findings (self-hosted vs Kubernetes)

The full Dapr CLI reference (https://docs.dapr.io/reference/cli/ and its
subpages) was reviewed. The dashboard is **not** intended to run against
Kubernetes, so **no command that requires the `-k` / `--kubernetes` flag is
included.** This constraint determines which pages get content.

| Command group | Self-hosted? | Used by |
|---------------|--------------|---------|
| `dapr list` | ✅ yes | Applications |
| `dapr stop` | ✅ yes | AppDetail |
| `dapr invoke` | ✅ yes | AppDetail |
| `dapr publish` | ✅ yes | Subscriptions |
| `dapr workflow *` | ✅ yes | Workflows, WorkflowDetail |
| `dapr scheduler *` | ✅ yes | Workflows, WorkflowDetail, Actors |
| `dapr components` | ❌ Kubernetes-only (`-k` required) | — excluded |
| `dapr configurations` | ❌ Kubernetes-only (`-k` required) | — excluded |
| `dapr status` | ❌ Kubernetes-only (`-k` required) | — excluded |
| `dapr logs` | ❌ Kubernetes-only (`-k` required) | — excluded |

Consequence: the **Components**, **Configurations**, **ControlPlane**,
**Resiliency**, and **Logs** pages have no self-hosted Dapr CLI command and
therefore keep the "hide trigger" behavior (no drawer). `dapr components`,
`dapr configurations`, and `dapr status` were considered but excluded solely
because they require `-k`.

### Initial files and commands

Two kinds of placeholder appear in command text:

- **`{{token}}` tokens** are resolved from the current route (see Placeholder
  substitution): `{{appId}}`, `{{instanceId}}`.
- **`<literal>` placeholders** (e.g. `<method>`, `<topic>`, `<reminder-name>`)
  are plain text the user edits by hand — the dashboard has no value for them.
  They are copied verbatim and require no substitution logic.

Command syntax verified against the Dapr CLI docs. Note the workflow management
commands take the instance ID as a **positional argument** and also require
`--app-id`; "pause" is the `suspend` subcommand. Scheduler `get`/`delete` use a
positional key whose format is
`{app|actor|workflow|activity}/<...>` (see the scheduler reference).

**`applications.yaml`** — context `Applications`

| title | command |
|-------|---------|
| List running Dapr apps | `dapr list` |

**`app-detail.yaml`** — context `AppDetail`

| title | command |
|-------|---------|
| Stop this app | `dapr stop --app-id {{appId}}` |
| Invoke a method on this app | `dapr invoke --app-id {{appId}} --method <method> --data '{"key":"value"}'` |

**`workflows.yaml`** — context `Workflows`

| title | command |
|-------|---------|
| List workflows for this app | `dapr workflow list --app-id {{appId}}` |
| List running workflows | `dapr workflow list --app-id {{appId}} --filter-status RUNNING` |
| List scheduled jobs | `dapr scheduler list` |

**`workflow-detail.yaml`** — context `WorkflowDetail`

| title | command |
|-------|---------|
| View execution history | `dapr workflow history {{instanceId}} --app-id {{appId}}` |
| Terminate this instance | `dapr workflow terminate {{instanceId}} --app-id {{appId}}` |
| Pause (suspend) this instance | `dapr workflow suspend {{instanceId}} --app-id {{appId}}` |
| Resume this instance | `dapr workflow resume {{instanceId}} --app-id {{appId}}` |
| Purge this instance | `dapr workflow purge {{instanceId}} --app-id {{appId}}` |
| Inspect this instance's scheduler reminder | `dapr scheduler get workflow/{{appId}}/{{instanceId}}/<reminder-name> -o yaml` |

**`actors.yaml`** — context `Actors`

| title | command |
|-------|---------|
| List scheduled jobs and reminders | `dapr scheduler list` |
| Get an actor reminder | `dapr scheduler get actor/<actor-type>/<actor-id>/<reminder-name> -o yaml` |

**`subscriptions.yaml`** — context `Subscriptions`

| title | command |
|-------|---------|
| Publish a test event | `dapr publish --publish-app-id <app-id> --pubsub <pubsub> --topic <topic> --data '{"key":"value"}'` |

Each command entry may carry an optional `docs` URL to the relevant CLI reference
page, rendered as a small "↗" link next to the command.

## Placeholder substitution

Only `{{token}}` placeholders are substituted. Literal `<...>` placeholders
(e.g. `<method>`, `<topic>`) are ordinary text and pass through untouched.

`{{token}}` placeholders are resolved from the current URL:

- `{{appId}}` ← path param `appId` (AppDetail) **or** the `app` search param
  (`?app=<appId>`) that the Workflows overview page already mirrors to the URL.
- `{{instanceId}}` ← path param `instanceId` (WorkflowDetail).

**Unresolved-token rule:** if a value is absent (e.g. the Workflows overview with
no app selected in the filter), the token renders as a readable literal
placeholder derived from the token name — `dapr workflow list --app-id <app-id>`
— so the command stays copyable and instructive rather than hidden. Resolved
values are substituted inline into the command text. The copy button always
copies exactly the rendered command string (resolved value or literal
placeholder).

`{{appId}}` -> `<app-id>`, `{{instanceId}}` -> `<instance-id>` when unresolved.

## Components

- **`web/src/components/CliDrawer.tsx`** — orchestrator. Resolves context key +
  route values, owns open/closed state (persisted), renders the vertical trigger
  tab + the sliding panel. Renders nothing (no trigger, no panel) when the
  current context has no content. Prepared to render a tool tab bar when more
  than one tool is present, but renders no tab bar for a single tool.
- **`web/src/components/CliCommand.tsx`** — one command row: `title`, the
  resolved command in a `<code>` block, a per-command **Copy** button
  (`copyText()` + `useToast()` "Copied" toast, matching `ShareDialog`), and an
  optional docs "↗" link when `docs` is set.
- **`web/src/lib/cli.ts`** — YAML loading and helpers:
  - Loads all `../content/cli/*.yaml` via
    `import.meta.glob('../content/cli/*.yaml', { query: '?raw', import: 'default', eager: true })`
    and parses each with `js-yaml` `load()`.
  - Types: `CliCommandDef { title; command; docs? }`, `CliTool { label; commands }`,
    `CliContent { context; tools: Record<string, CliTool> }`.
  - `getCliContent(context: string): CliContent | undefined`.
  - `resolvePlaceholders(command: string, values: Record<string, string | undefined>): string`
    — pure function; substitutes present values, falls back to `<token-kebab>`
    literals for missing ones.

## Styling

New rules added to `web/src/styles/theme.css`, reusing existing design tokens
(`--surface`, `--surface-2`, `--line`, `--shadow`, `--text`). The panel slides in
with a `transform` transition (~.18s, matching the sidebar). Light/dark handled
by the existing `data-theme` mechanism (no new theme logic). The vertical trigger
tab uses `writing-mode: vertical-rl` for the "CLI" label. Panel is scrollable
(`overflow-y: auto`) for contexts with many commands.

## Testing (TDD)

- **`web/src/lib/cli.test.ts`**
  - Content loads for all six contexts (`Applications`, `AppDetail`,
    `Workflows`, `WorkflowDetail`, `Actors`, `Subscriptions`) with the expected
    commands.
  - No shipped command contains ` -k` or `--kubernetes` (guards the no-Kubernetes
    constraint against future content edits).
  - `resolvePlaceholders` substitutes present values.
  - `resolvePlaceholders` falls back to `<app-id>` / `<instance-id>` literals for
    missing values.
- **`web/src/components/CliCommand.test.tsx`**
  - Renders title and resolved command text.
  - Copy button writes the exact resolved string to the clipboard and shows the
    "Copied" toast.
  - Docs "↗" link is present only when `docs` is set.
- **`web/src/components/CliDrawer.test.tsx`**
  - Trigger is hidden on a no-content context (e.g. `Components` / `Logs`).
  - Trigger is shown on `AppDetail`; opening reveals `dapr stop --app-id <id>`
    with the real app ID from the route.
  - Workflows overview with `?app=foo` resolves to `--app-id foo`; without it,
    renders the literal `--app-id <app-id>`.
  - Open/closed state persists via `localStorage`.
- Run `make build` (tsc) after implementation — per project note, vitest does not
  typecheck, so a full build is required to catch type errors in `.ts(x)` files.

## Out-of-scope notes for the future

- Adding Diagrid Catalyst: add a `catalyst:` key to the relevant YAML files with
  a `label` and `commands`. The drawer automatically renders a tab bar once any
  context has more than one tool. No component changes expected.
- Context values not in the URL: introduce a small React context/provider that
  pages populate, merged into the substitution `values` map. Deferred until a
  command needs it.
